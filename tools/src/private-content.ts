import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { canonicalJson } from "./canonical-json";
import { runContentImport } from "./content-import";
import { executeD1Batch } from "./d1-http";
import type { D1Statement } from "./import-plan";
import { type ContentCase, validateContentDocument } from "./validate-content";

const requestPath = "ops/content-key-request.json";
const envelopePath = "ops/content-envelope.json";
const maxEnvelopeBytes = 5 * 1024 * 1024;
const keyLifetimeSeconds = 48 * 60 * 60;
const keyIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const base64Schema = z
  .string()
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const envelopeSchema = z
  .object({
    version: z.literal(1),
    keyId: keyIdSchema,
    wrappedKey: base64Schema,
    iv: base64Schema,
    tag: base64Schema,
    ciphertext: base64Schema,
  })
  .strict();
export type ContentEnvelope = z.infer<typeof envelopeSchema>;
type ArchiveRequest = {
  keyId: string;
  purpose: "archive";
  from: string;
  through: string;
};
type TransferRequest = { keyId: string; purpose: "launch" } | ArchiveRequest;
type Corpus = { cases: ContentCase[] };
type PublishedSummary = {
  mode: "published";
  keyId: string;
  digest: string;
  cases: number;
  puzzles: number;
  dates: string[];
};
type BootstrapSummary = {
  mode: "bootstrap";
  keyId: string;
  publicKey: string;
  fingerprint: string;
  expiresAt: number;
};
type CompletedSummary = PublishedSummary & { alreadyCompleted: true };
type KeyRow = {
  key_id: string;
  private_key: string | null;
  public_key: string;
  fingerprint: string;
  expires_at: number;
  envelope_digest: string | null;
  completed_digest: string | null;
  completed_summary: string | null;
};
type Runtime = {
  cwd: string;
  env: Record<string, string | undefined>;
  readFile: (path: string, encoding: "utf8") => Promise<string>;
  fetch: typeof fetch;
  now: () => number;
  importCase: typeof runContentImport;
};

class TransferError extends Error {}

function ensure(condition: unknown, code: string): asserts condition {
  if (!condition) throw new TransferError(code);
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseRequest(text: string): TransferRequest {
  ensure(Buffer.byteLength(text) <= 1024, "INVALID_KEY_REQUEST");
  const parsed = z
    .union([
      z.object({ keyId: keyIdSchema, purpose: z.literal("launch").optional() }).strict(),
      z
        .object({
          keyId: keyIdSchema,
          purpose: z.literal("archive"),
          from: z.iso.date(),
          through: z.iso.date(),
        })
        .strict(),
    ])
    .parse(JSON.parse(text));
  if (parsed.purpose === "archive") {
    // The key ID is authenticated by the envelope and fixed in D1. Encoding the
    // exact archive range binds purpose and dates without altering legacy rows.
    const prefix = `archive-${parsed.from}-${parsed.through}-`;
    ensure(
      parsed.keyId.startsWith(prefix) && /^v[1-9]\d*$/.test(parsed.keyId.slice(prefix.length)),
      "REQUEST_KEY_MISMATCH",
    );
    return parsed;
  }
  ensure(!parsed.keyId.startsWith("archive-"), "REQUEST_KEY_MISMATCH");
  return { keyId: parsed.keyId, purpose: "launch" };
}

function archiveDates(request: ArchiveRequest, now: number): string[] {
  const today = new Date(now * 1000).toISOString().slice(0, 10);
  ensure(request.from <= request.through, "INVALID_ARCHIVE_RANGE");
  ensure(request.through < today, "ARCHIVE_MUST_BE_HISTORICAL");
  const start = Date.parse(`${request.from}T00:00:00Z`);
  const count = (Date.parse(`${request.through}T00:00:00Z`) - start) / 86_400_000 + 1;
  ensure(Number.isInteger(count) && count >= 1 && count <= 60, "INVALID_ARCHIVE_RANGE");
  return Array.from({ length: count }, (_, index) =>
    new Date(start + index * 86_400_000).toISOString().slice(0, 10),
  );
}

function aad(keyId: string): Buffer {
  return Buffer.from(JSON.stringify({ version: 1, keyId }));
}

function decode(value: string, expectedLength?: number): Buffer {
  const bytes = Buffer.from(value, "base64");
  ensure(bytes.toString("base64") === value, "INVALID_ENVELOPE");
  ensure(expectedLength === undefined || bytes.length === expectedLength, "INVALID_ENVELOPE");
  return bytes;
}

function parseEnvelope(text: string, keyId: string): ContentEnvelope {
  ensure(Buffer.byteLength(text) <= maxEnvelopeBytes, "ENVELOPE_TOO_LARGE");
  const envelope = envelopeSchema.parse(JSON.parse(text));
  ensure(envelope.keyId === keyId, "KEY_ID_MISMATCH");
  decode(envelope.wrappedKey, 384);
  decode(envelope.iv, 12);
  decode(envelope.tag, 16);
  ensure(decode(envelope.ciphertext).length > 0, "INVALID_ENVELOPE");
  return envelope;
}

/** Encrypt outside the public repository; only the returned envelope may be committed. */
export function encryptContentEnvelope(
  payload: unknown,
  recipient: { keyId: string; publicKey: string },
): ContentEnvelope {
  keyIdSchema.parse(recipient.keyId);
  const publicKey = createPublicKey({
    key: decode(recipient.publicKey),
    format: "der",
    type: "spki",
  });
  ensure(publicKey.asymmetricKeyType === "rsa", "INVALID_PUBLIC_KEY");
  ensure(publicKey.asymmetricKeyDetails?.modulusLength === 3072, "INVALID_PUBLIC_KEY");
  const secret = randomBytes(32);
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", secret, iv);
    cipher.setAAD(aad(recipient.keyId));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(payload), "utf8"),
      cipher.final(),
    ]);
    const wrappedKey = publicEncrypt(
      { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      secret,
    );
    const envelope: ContentEnvelope = {
      version: 1,
      keyId: recipient.keyId,
      wrappedKey: wrappedKey.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    ensure(Buffer.byteLength(JSON.stringify(envelope)) <= maxEnvelopeBytes, "ENVELOPE_TOO_LARGE");
    return envelope;
  } finally {
    secret.fill(0);
  }
}

function decrypt(envelope: ContentEnvelope, privateKey: string): unknown {
  const secret = privateDecrypt(
    {
      key: createPrivateKey(privateKey),
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    decode(envelope.wrappedKey, 384),
  );
  try {
    ensure(secret.length === 32, "INVALID_ENVELOPE");
    const decipher = createDecipheriv("aes-256-gcm", secret, decode(envelope.iv, 12));
    decipher.setAAD(aad(envelope.keyId));
    decipher.setAuthTag(decode(envelope.tag, 16));
    const plaintext = Buffer.concat([
      decipher.update(decode(envelope.ciphertext)),
      decipher.final(),
    ]);
    try {
      return JSON.parse(plaintext.toString("utf8"));
    } finally {
      plaintext.fill(0);
    }
  } finally {
    secret.fill(0);
  }
}

/** Validate every case before the first import can write draft or published rows. */
function validateCorpus(
  payload: unknown,
  now: number,
  requireCoverage: boolean,
  request: TransferRequest,
): Corpus {
  ensure(
    payload !== null && typeof payload === "object" && !Array.isArray(payload),
    "INVALID_CORPUS",
  );
  const record = payload as Record<string, unknown>;
  ensure(Object.keys(record).length === 1 && Array.isArray(record.cases), "INVALID_CORPUS");
  const expectedDates = request.purpose === "archive" ? archiveDates(request, now) : undefined;
  ensure(
    record.cases.length >= (expectedDates ? 1 : 8) &&
      record.cases.length <= (expectedDates ? 60 : 31),
    "INVALID_CORPUS_SIZE",
  );
  const caseIds = new Set<string>();
  const dates = new Set<string>();
  const slugs = new Set<string>();
  const puzzleIds = new Set<string>();
  const cases = record.cases.map((source) => {
    const content = validateContentDocument(JSON.stringify(source));
    ensure(content.puzzles.length <= 10, "INVALID_CORPUS_SIZE");
    ensure(!caseIds.has(content.case.id), "DUPLICATE_CASE_ID");
    ensure(!dates.has(content.case.date), "DUPLICATE_CASE_DATE");
    ensure(!slugs.has(content.case.slug), "DUPLICATE_CASE_SLUG");
    caseIds.add(content.case.id);
    dates.add(content.case.date);
    slugs.add(content.case.slug);
    ensure(
      !/\b(?:sample|development|demo|fixture|test)\b/i.test(
        `${content.case.id} ${content.case.slug} ${content.case.title}`,
      ),
      "NON_PRODUCTION_CONTENT",
    );
    for (const puzzle of content.puzzles) {
      ensure(!puzzleIds.has(puzzle.public.id), "DUPLICATE_PUZZLE_ID");
      puzzleIds.add(puzzle.public.id);
      ensure(
        !/\b(?:sample|development|demo|fixture|test)\b/i.test(
          `${puzzle.public.id} ${puzzle.public.provenance}`,
        ),
        "NON_PRODUCTION_CONTENT",
      );
    }
    return content;
  });
  if (expectedDates) {
    ensure(
      dates.size === expectedDates.length && expectedDates.every((date) => dates.has(date)),
      "ARCHIVE_RANGE_MISMATCH",
    );
  } else if (requireCoverage) {
    // Coverage is checked before the initial launch claim. A bound retry may
    // cross midnight and must finish the identical, validated publication.
    const today = new Date(now * 1000);
    for (let offset = 0; offset <= 7; offset += 1) {
      const date = new Date(today);
      date.setUTCDate(date.getUTCDate() + offset);
      ensure(dates.has(date.toISOString().slice(0, 10)), "INSUFFICIENT_DAILY_COVERAGE");
    }
  }
  return { cases };
}

function conflictCheck(content: ContentCase): D1Statement {
  const metadata = content.case;
  const digest = hash(canonicalJson(content));
  const params = [
    metadata.id,
    metadata.date,
    metadata.slug,
    metadata.id,
    metadata.date,
    metadata.slug,
    metadata.title,
    String(metadata.generatedAt),
    digest,
    metadata.id,
    digest,
    metadata.id,
    metadata.slug,
    String(metadata.generatedAt),
  ];
  const conditions = [
    `EXISTS (SELECT 1 FROM daily_cases d
      WHERE (d.id = ? OR d.case_date = ? OR d.slug = ?)
        AND NOT (d.id = ? AND d.case_date = ? AND d.slug = ? AND d.title = ?
          AND d.created_at = ? AND d.status IN ('draft', 'published')))`,
    `EXISTS (SELECT 1 FROM content_imports i
      WHERE (i.digest = ? OR i.case_id = ?)
        AND NOT (i.digest = ? AND i.case_id = ? AND i.source_name = ? AND i.imported_at = ?))`,
  ];
  for (const puzzle of content.puzzles) {
    const rowId = `${puzzle.public.id}:v${puzzle.public.version}`;
    conditions.push(`EXISTS (SELECT 1 FROM puzzles p
      WHERE ((p.content_key = ? AND p.version = ?) OR p.id = ?)
        AND NOT (p.id = ? AND p.content_key = ? AND p.version = ? AND p.content_digest = ?
          AND p.status IN ('draft', 'published')))`);
    params.push(
      puzzle.public.id,
      String(puzzle.public.version),
      rowId,
      rowId,
      puzzle.public.id,
      String(puzzle.public.version),
      hash(canonicalJson(puzzle)),
    );
  }
  return { sql: `SELECT (${conditions.join(" OR ")}) AS conflict`, params };
}

function keyRow(value: unknown, keyId: string): KeyRow {
  const row = z
    .object({
      key_id: keyIdSchema,
      private_key: z.string().min(1).nullable(),
      public_key: base64Schema,
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      expires_at: z.int().nonnegative(),
      envelope_digest: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable(),
      completed_digest: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable(),
      completed_summary: z.string().nullable(),
    })
    .strict()
    .parse(value);
  ensure(row.key_id === keyId, "INVALID_KEY_RECORD");
  ensure(hash(decode(row.public_key)) === row.fingerprint, "INVALID_KEY_RECORD");
  ensure(
    (row.private_key !== null && row.completed_digest === null && row.completed_summary === null) ||
      (row.private_key === null &&
        row.completed_digest !== null &&
        row.completed_summary !== null &&
        row.envelope_digest === row.completed_digest),
    "INVALID_KEY_RECORD",
  );
  return row;
}

const createTable = `CREATE TABLE IF NOT EXISTS ops_content_transfer_keys (
  key_id TEXT PRIMARY KEY,
  private_key TEXT,
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  envelope_digest TEXT,
  completed_digest TEXT,
  completed_summary TEXT
)`;
const selectKey = `SELECT key_id, private_key, public_key, fingerprint, expires_at, envelope_digest,
  completed_digest, completed_summary FROM ops_content_transfer_keys WHERE key_id = ?`;

async function runTransfer(
  runtime: Runtime,
): Promise<BootstrapSummary | PublishedSummary | CompletedSummary> {
  const requestText = await runtime.readFile(resolve(runtime.cwd, requestPath), "utf8");
  const transferRequest = parseRequest(requestText);
  const { keyId } = transferRequest;
  const now = Math.floor(runtime.now());
  ensure(Number.isSafeInteger(now) && now >= 0, "INVALID_TIME");
  if (transferRequest.purpose === "archive") archiveDates(transferRequest, now);
  let envelopeText: string | undefined;
  try {
    envelopeText = await runtime.readFile(resolve(runtime.cwd, envelopePath), "utf8");
  } catch (error) {
    ensure(
      error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT",
      "ENVELOPE_READ_FAILED",
    );
  }
  const envelope = envelopeText === undefined ? undefined : parseEnvelope(envelopeText, keyId);
  const {
    CLOUDFLARE_ACCOUNT_ID: accountId,
    D1_DATABASE_ID: databaseId,
    CLOUDFLARE_API_TOKEN: apiToken,
  } = runtime.env;
  ensure(accountId && /^[a-f0-9]{32}$/i.test(accountId), "MISSING_CLOUDFLARE_BINDINGS");
  ensure(databaseId && /^[a-f0-9-]{32,36}$/i.test(databaseId), "MISSING_CLOUDFLARE_BINDINGS");
  ensure(apiToken && /^[A-Za-z0-9_-]+$/.test(apiToken), "MISSING_CLOUDFLARE_BINDINGS");
  const connection = { accountId, databaseId, apiToken };
  const request: typeof fetch = (input, init) =>
    runtime.fetch(input, {
      ...init,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  async function query(statements: D1Statement[]): Promise<unknown[][]> {
    const response: unknown = await executeD1Batch({
      ...connection,
      statements,
      fetch: request,
    });
    const parsed = z
      .object({
        success: z.literal(true),
        result: z.array(
          z.object({
            success: z.literal(true),
            results: z.array(z.unknown()).max(1).optional(),
          }),
        ),
      })
      .parse(response);
    ensure(parsed.result.length === statements.length, "INVALID_D1_RESPONSE");
    return parsed.result.map((result, index) => {
      if (statements[index]?.sql.startsWith("SELECT")) {
        ensure(result.results !== undefined, "INVALID_D1_RESPONSE");
      }
      return result.results ?? [];
    });
  }
  async function loadKey(): Promise<KeyRow | undefined> {
    const rows = (await query([{ sql: selectKey, params: [keyId] }]))[0];
    ensure(rows, "INVALID_D1_RESPONSE");
    return rows.length === 0 ? undefined : keyRow(rows[0], keyId);
  }

  if (envelope === undefined) {
    await query([{ sql: createTable, params: [] }]);
    let row = await loadKey();
    if (row === undefined) {
      const pair = generateKeyPairSync("rsa", { modulusLength: 3072 });
      const publicKey = pair.publicKey.export({ format: "der", type: "spki" });
      const privateKey = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
      await query([
        {
          sql: `INSERT INTO ops_content_transfer_keys
          (key_id, private_key, public_key, fingerprint, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(key_id) DO NOTHING`,
          params: [
            keyId,
            privateKey,
            publicKey.toString("base64"),
            hash(publicKey),
            String(now),
            String(now + keyLifetimeSeconds),
          ],
        },
      ]);
      row = await loadKey();
    }
    ensure(row, "KEY_NOT_FOUND");
    ensure(row.completed_digest === null && row.expires_at > now, "KEY_UNAVAILABLE");
    return {
      mode: "bootstrap",
      keyId,
      publicKey: row.public_key,
      fingerprint: row.fingerprint,
      expiresAt: row.expires_at,
    };
  }

  const digest = hash(canonicalJson(envelope));
  const row = await loadKey();
  ensure(row, "KEY_NOT_FOUND");
  if (row.completed_digest !== null) {
    ensure(
      row.completed_digest === digest && row.completed_summary !== null,
      "COMPLETED_TRANSFER_MISMATCH",
    );
    const summary = z
      .object({
        mode: z.literal("published"),
        keyId: keyIdSchema,
        digest: z.string(),
        cases: z.int().positive(),
        puzzles: z.int().positive(),
        dates: z.array(z.iso.date()),
      })
      .strict()
      .parse(JSON.parse(row.completed_summary));
    ensure(summary.keyId === keyId && summary.digest === digest, "INVALID_KEY_RECORD");
    return { ...summary, alreadyCompleted: true };
  }
  ensure(row.private_key !== null && row.expires_at > now, "KEY_UNAVAILABLE");
  ensure(
    row.envelope_digest === null || row.envelope_digest === digest,
    "TRANSFER_ENVELOPE_MISMATCH",
  );
  const corpus = validateCorpus(
    decrypt(envelope, row.private_key),
    now,
    row.envelope_digest === null,
    transferRequest,
  );
  const conflicts = await query(corpus.cases.map(conflictCheck));
  for (const rows of conflicts) {
    ensure(rows.length === 1, "INVALID_D1_RESPONSE");
    const result = z
      .object({ conflict: z.union([z.literal(0), z.literal(1)]) })
      .strict()
      .parse(rows[0]);
    ensure(result.conflict === 0, "EXISTING_CONTENT_CONFLICT");
  }
  const summary: PublishedSummary = {
    mode: "published",
    keyId,
    digest,
    cases: corpus.cases.length,
    puzzles: corpus.cases.reduce((total, content) => total + content.puzzles.length, 0),
    dates: corpus.cases.map((content) => content.case.date).sort(),
  };
  await query([
    {
      sql: `UPDATE ops_content_transfer_keys SET envelope_digest = ?
      WHERE key_id = ? AND (envelope_digest IS NULL OR envelope_digest = ?)`,
      params: [digest, keyId, digest],
    },
  ]);
  ensure((await loadKey())?.envelope_digest === digest, "TRANSFER_ENVELOPE_MISMATCH");
  for (const content of corpus.cases) {
    await runtime.importCase(["--file", "memory.json", "--publish"], {
      cwd: runtime.cwd,
      env: runtime.env,
      fetch: request,
      readFile: async () => JSON.stringify(content),
      log: () => {},
    });
  }
  await query([
    {
      sql: `UPDATE ops_content_transfer_keys SET private_key = NULL,
      completed_digest = ?, completed_summary = ? WHERE key_id = ?
      AND completed_digest IS NULL AND envelope_digest = ?`,
      params: [digest, JSON.stringify(summary), keyId, digest],
    },
  ]);
  const completed = await loadKey();
  ensure(
    completed?.private_key === null && completed.completed_digest === digest,
    "COMPLETION_FAILED",
  );
  return summary;
}

export async function runPrivateContentTransfer(
  overrides: Partial<Runtime> = {},
): Promise<BootstrapSummary | PublishedSummary | CompletedSummary> {
  try {
    return await runTransfer({
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: process.env,
      readFile: async (path, encoding) => readFile(path, encoding),
      fetch: globalThis.fetch,
      now: () => Date.now() / 1000,
      importCase: runContentImport,
      ...overrides,
    });
  } catch (error) {
    throw new TransferError(
      error instanceof TransferError ? error.message : "PRIVATE_CONTENT_TRANSFER_FAILED",
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    ensure(process.argv.length === 2, "UNEXPECTED_ARGUMENTS");
    console.log(JSON.stringify(await runPrivateContentTransfer()));
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        code: error instanceof TransferError ? error.message : "PRIVATE_CONTENT_TRANSFER_FAILED",
      }),
    );
    process.exitCode = 1;
  }
}
