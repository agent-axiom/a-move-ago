import { readFile } from "node:fs/promises";
import { Chess } from "chess.js";
import { describe, expect, it, vi } from "vitest";
import type { runContentImport } from "./content-import";
import { encryptContentEnvelope, runPrivateContentTransfer } from "./private-content";

const keyId = "launch-2026-10-15-v1";
const archiveRequest = {
  keyId: "archive-2026-09-10-2026-10-14-v1",
  purpose: "archive",
  from: "2026-09-10",
  through: "2026-10-14",
};
const scheduleRequest = {
  keyId: "schedule-2026-11-14-2027-01-31-v1",
  purpose: "schedule",
  from: "2026-11-14",
  through: "2027-01-31",
};
const now = Date.parse("2026-10-15T12:00:00Z") / 1000;
const canary = "PRIVATE_SOLUTION_CANARY_NEVER_PRINT";
const env = {
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  D1_DATABASE_ID: "00000000-0000-0000-0000-000000000001",
  CLOUDFLARE_API_TOKEN: "private-cloudflare-token",
};

async function corpus(from = "2026-10-15", count = 8) {
  // Reuse the explicitly public CC BY fixture only in these synthetic tests.
  const sample = JSON.parse(
    await readFile(new URL("../../content/samples/2026-08-03.json", import.meta.url), "utf8"),
  );
  return {
    cases: Array.from({ length: count }, (_, index) => {
      const content = structuredClone(sample);
      const date = new Date(Date.parse(`${from}T00:00:00Z`) + index * 86_400_000)
        .toISOString()
        .slice(0, 10);
      content.case = {
        id: `original-${date}`,
        date,
        slug: `original-${date}`,
        title: "Original composition",
        generatedAt: now,
      };
      content.puzzles[0].public.id = `original-${index}`;
      content.puzzles[0].public.provenance = "Synthetic original composition";
      content.puzzles[0].acceptedSolutions[0].explanation = canary;
      return content;
    }),
  };
}

async function scheduledCorpus(from = scheduleRequest.from, count = 79) {
  // Public, reachable fixture also used by retro-audit.test.ts, never production.
  const game = new Chess();
  for (const move of ["c4", "d5", "a3", "d4", "a4", "Kd7", "h3", "Kd6"]) game.move(move);
  const previousFen = game.fen();
  game.move("c5+");
  const payload = await corpus(from, count);
  for (const content of payload.cases) {
    const puzzle = content.puzzles[0];
    puzzle.public.postFen = game.fen();
    puzzle.public.maxHints = 0;
    puzzle.hints = [];
    puzzle.acceptedSolutions = [{
      retraction: {
        currentSquare: "c5", previousSquare: "c4", movedPiece: { color: "w", type: "p" },
        restoredPiece: null, special: "normal",
      },
      previousFen, forwardSan: "c5+", explanation: canary, historyConstraints: [],
    }];
  }
  return payload;
}

type MemoryKey = Record<string, string | number | null>;

function harness() {
  const state = {
    row: undefined as MemoryKey | undefined,
    request: { keyId } as Record<string, string>,
    envelope: undefined as unknown,
    now,
    writes: 0,
    failImportAt: 0,
    conflictAt: -1,
    conflictCase: undefined as string | undefined,
    coverageMissing: 0,
    coverageChecks: 0,
    imports: [] as string[],
  };
  const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    expect(init?.redirect).toBe("error");
    expect(init?.cache).toBe("no-store");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const { batch } = JSON.parse(String(init?.body)) as {
      batch: { sql: string; params: string[] }[];
    };
    const result = batch.map(({ sql, params }, index) => {
      if (sql.startsWith("SELECT COUNT(*) AS covered")) {
        state.coverageChecks += 1;
        const required = (Date.parse(params[1] ?? "") - Date.parse(params[0] ?? "")) / 86_400_000;
        return { success: true, results: [{ covered: required - state.coverageMissing }] };
      }
      if (sql.startsWith("SELECT (") && sql.endsWith("AS conflict")) {
        return { success: true, results: [{
          conflict: index === state.conflictAt || params[0] === state.conflictCase ? 1 : 0,
        }] };
      }
      if (sql.startsWith("SELECT")) {
        return { success: true, results: state.row ? [{ ...state.row }] : [] };
      }
      state.writes += 1;
      if (sql.startsWith("INSERT")) {
        state.row ??= {
          key_id: params[0] ?? "",
          private_key: params[1] ?? "",
          public_key: params[2] ?? "",
          fingerprint: params[3] ?? "",
          expires_at: Number(params[5]),
          envelope_digest: null,
          completed_digest: null,
          completed_summary: null,
        };
      } else if (sql.startsWith("UPDATE") && sql.includes("SET envelope_digest")) {
        if (
          state.row &&
          (state.row.envelope_digest === null || state.row.envelope_digest === params[2])
        ) {
          state.row.envelope_digest = params[0] ?? "";
        }
      } else if (sql.startsWith("UPDATE") && sql.includes("private_key = NULL")) {
        if (
          state.row &&
          state.row.envelope_digest === params[3] &&
          state.row.completed_digest === null
        ) {
          state.row.private_key = null;
          state.row.completed_digest = params[0] ?? "";
          state.row.completed_summary = params[1] ?? "";
        }
      } else {
        expect(sql).toContain("CREATE TABLE IF NOT EXISTS ops_content_transfer_keys");
      }
      // D1 permits successful DDL/DML results without a results array.
      return { success: true };
    });
    return new Response(JSON.stringify({ success: true, result }), {
      headers: { "content-type": "application/json" },
    });
  });
  const importCase = vi.fn<typeof runContentImport>(async (_args, overrides) => {
    const source = await overrides?.readFile?.("memory.json", "utf8");
    expect(source).toContain(canary);
    expect(overrides?.log).toBeTypeOf("function");
    overrides?.log?.(canary);
    state.imports.push(source ?? "");
    if (state.failImportAt === state.imports.length) throw new Error(canary);
    return {
      digest: "b".repeat(64),
      caseId: "synthetic",
      puzzleIds: [],
      draftStatementCount: 1,
      publishStatementCount: 1,
    };
  });
  const overrides = {
    cwd: "/repo",
    env,
    fetch: fetchMock as typeof fetch,
    now: () => state.now,
    importCase,
    readFile: async (path: string) => {
      if (path === "/repo/ops/content-key-request.json") return JSON.stringify(state.request);
      expect(path).toBe("/repo/ops/content-envelope.json");
      if (state.envelope !== undefined) return JSON.stringify(state.envelope);
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  };
  async function bootstrap() {
    const result = await runPrivateContentTransfer(overrides);
    if (result.mode !== "bootstrap") throw new Error("Expected bootstrap");
    return result;
  }
  async function prepare(payload?: unknown) {
    const publicKey = await bootstrap();
    state.envelope = encryptContentEnvelope(payload ?? (await corpus()), publicKey);
    return publicKey;
  }
  return { state, overrides, fetchMock, importCase, bootstrap, prepare };
}

describe("private production content transfer", () => {
  it("bootstraps one private key in D1 and returns only a reusable public key", async () => {
    const h = harness();
    const first = await h.bootstrap();
    const second = await h.bootstrap();
    expect(second).toEqual(first);
    expect(first).toMatchObject({ mode: "bootstrap", keyId, expiresAt: now + 48 * 3600 });
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(h.state.row?.private_key).toContain("BEGIN PRIVATE KEY");
    expect(JSON.stringify(first)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(first)).not.toContain(env.CLOUDFLARE_API_TOKEN);
    expect(h.importCase).not.toHaveBeenCalled();
  });

  it("decrypts in memory, imports all validated dates, and destroys the private key", async () => {
    const h = harness();
    await h.prepare();
    const result = await runPrivateContentTransfer(h.overrides);
    expect(result).toMatchObject({ mode: "published", cases: 8, puzzles: 8 });
    expect(h.state.imports).toHaveLength(8);
    expect(h.state.row?.private_key).toBeNull();
    expect(h.state.row?.completed_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(JSON.stringify(h.state.envelope)).not.toContain(canary);
    expect(h.state.row?.completed_summary).not.toContain(canary);
    expect(result.mode === "published" && result.dates).toEqual([
      "2026-10-15",
      "2026-10-16",
      "2026-10-17",
      "2026-10-18",
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
    ]);
  });

  it("recognizes completed imports after key deletion and expiry", async () => {
    const h = harness();
    await h.prepare();
    const published = await runPrivateContentTransfer(h.overrides);
    h.state.now += 10 * 24 * 3600;
    h.importCase.mockClear();
    const writes = h.state.writes;
    expect(await runPrivateContentTransfer(h.overrides)).toEqual({
      ...published,
      alreadyCompleted: true,
    });
    expect(h.importCase).not.toHaveBeenCalled();
    expect(h.state.writes).toBe(writes);
  });

  it("resumes the same envelope after failure and UTC midnight", async () => {
    const h = harness();
    const recipient = await h.prepare();
    h.state.failImportAt = 3;
    await expect(runPrivateContentTransfer(h.overrides)).rejects.toThrow(
      "PRIVATE_CONTENT_TRANSFER_FAILED",
    );
    expect(h.state.row?.private_key).toContain("BEGIN PRIVATE KEY");
    expect(h.state.row?.completed_digest).toBeNull();
    const savedEnvelope = h.state.envelope;
    h.state.envelope = encryptContentEnvelope(await corpus(), recipient);
    await expect(runPrivateContentTransfer(h.overrides)).rejects.toThrow(
      "TRANSFER_ENVELOPE_MISMATCH",
    );
    h.state.envelope = savedEnvelope;
    h.state.failImportAt = 0;
    h.state.now += 24 * 3600;
    expect(await runPrivateContentTransfer(h.overrides)).toMatchObject({
      mode: "published",
      cases: 8,
    });
    expect(h.state.imports).toHaveLength(11);
    expect(h.state.row?.private_key).toBeNull();
  });

  it("validates every case before writes and hides private errors", async () => {
    const h = harness();
    const payload = await corpus();
    payload.cases[7].puzzles[0].acceptedSolutions[0].previousFen = canary;
    await h.prepare(payload);
    const writes = h.state.writes;
    const error = await runPrivateContentTransfer(h.overrides).catch((failure: unknown) => failure);
    expect(String(error)).toBe("Error: PRIVATE_CONTENT_TRANSFER_FAILED");
    expect(String(error)).not.toContain(canary);
    expect(h.importCase).not.toHaveBeenCalled();
    expect(h.state.writes).toBe(writes);
  });

  it("checks every remote case for conflicts before the first publication write", async () => {
    const h = harness();
    await h.prepare();
    h.state.conflictAt = 7;
    const writes = h.state.writes;
    await expect(runPrivateContentTransfer(h.overrides)).rejects.toThrow(
      "EXISTING_CONTENT_CONFLICT",
    );
    expect(h.importCase).not.toHaveBeenCalled();
    expect(h.state.writes).toBe(writes);
    expect(h.state.row?.envelope_digest).toBeNull();
  });

  it.each(["duplicate-id", "sample", "coverage"])(
    "rejects %s corpus before importing",
    async (kind) => {
      const h = harness();
      const payload = await corpus();
      if (kind === "duplicate-id") {
        payload.cases[7].puzzles[0].public.id = payload.cases[0].puzzles[0].public.id;
      }
      if (kind === "sample") {
        payload.cases[7].puzzles[0].public.provenance = "Original A MOVE AGO sample";
      }
      if (kind === "coverage") payload.cases[7].case.date = "2026-11-01";
      await h.prepare(payload);
      const writes = h.state.writes;
      await expect(runPrivateContentTransfer(h.overrides)).rejects.toThrow();
      expect(h.importCase).not.toHaveBeenCalled();
      expect(h.state.writes).toBe(writes);
    },
  );

  it("rejects authenticated ciphertext tampering before a write", async () => {
    const h = harness();
    await h.prepare();
    const envelope = h.state.envelope as { tag: string };
    const tag = Buffer.from(envelope.tag, "base64");
    tag[0] = (tag[0] ?? 0) ^ 1;
    envelope.tag = tag.toString("base64");
    const writes = h.state.writes;
    await expect(runPrivateContentTransfer(h.overrides)).rejects.toThrow(
      "PRIVATE_CONTENT_TRANSFER_FAILED",
    );
    expect(h.importCase).not.toHaveBeenCalled();
    expect(h.state.writes).toBe(writes);
  });

  it("refuses an expired pending key without importing", async () => {
    const h = harness();
    await h.prepare();
    h.state.now += 48 * 3600;
    await expect(runPrivateContentTransfer(h.overrides)).rejects.toThrow("KEY_UNAVAILABLE");
    expect(h.importCase).not.toHaveBeenCalled();
    expect(h.state.row?.private_key).toContain("BEGIN PRIVATE KEY");
  });

  it("sanitizes transport errors without exposing upstream details or credentials", async () => {
    const h = harness();
    h.fetchMock.mockRejectedValue(new Error(`${canary} ${env.CLOUDFLARE_API_TOKEN}`));
    await expect(runPrivateContentTransfer(h.overrides)).rejects.toThrow(
      "PRIVATE_CONTENT_TRANSFER_FAILED",
    );
  });
});

describe("historical archive content transfer", () => {
  it("publishes the exact 35 historical dates without requiring launch coverage", async () => {
    const h = harness();
    h.state.request = { ...archiveRequest };
    await h.prepare(await corpus("2026-09-10", 35));
    const result = await runPrivateContentTransfer(h.overrides);
    expect(result).toMatchObject({ mode: "published", cases: 35, puzzles: 35 });
    expect(result.mode === "published" && result.dates[0]).toBe("2026-09-10");
    expect(result.mode === "published" && result.dates.at(-1)).toBe("2026-10-14");
    expect(h.state.imports).toHaveLength(35);
    expect(h.state.row?.private_key).toBeNull();
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  it("resumes after midnight and recognizes the archive receipt after expiry", async () => {
    const h = harness();
    h.state.request = { ...archiveRequest };
    await h.prepare(await corpus("2026-09-10", 35));
    h.state.failImportAt = 34;
    await expect(runPrivateContentTransfer(h.overrides)).rejects.toThrow(
      "PRIVATE_CONTENT_TRANSFER_FAILED",
    );
    expect(h.state.row?.private_key).toContain("BEGIN PRIVATE KEY");
    h.state.failImportAt = 0;
    h.state.now += 24 * 3600;
    const published = await runPrivateContentTransfer(h.overrides);
    expect(published).toMatchObject({ mode: "published", cases: 35 });
    expect(h.state.row?.private_key).toBeNull();
    h.state.now += 10 * 24 * 3600;
    h.importCase.mockClear();
    const writes = h.state.writes;
    expect(await runPrivateContentTransfer(h.overrides)).toEqual({
      ...published,
      alreadyCompleted: true,
    });
    expect(h.importCase).not.toHaveBeenCalled();
    expect(h.state.writes).toBe(writes);
  });

  it.each(["missing", "outside", "extra"])(
    "rejects an archive with a %s date before any publication write",
    async (kind) => {
      const h = harness();
      h.state.request = { ...archiveRequest };
      const payload = await corpus("2026-09-10", kind === "extra" ? 36 : 35);
      if (kind === "missing") payload.cases.splice(17, 1);
      if (kind === "outside") payload.cases[0].case.date = "2026-10-15";
      await h.prepare(payload);
      const writes = h.state.writes;
      await expect(runPrivateContentTransfer(h.overrides)).rejects.toThrow(
        "ARCHIVE_RANGE_MISMATCH",
      );
      expect(h.importCase).not.toHaveBeenCalled();
      expect(h.state.writes).toBe(writes);
      expect(h.state.row?.envelope_digest).toBeNull();
    },
  );

  it("checks the final historical remote case before writing", async () => {
    const h = harness();
    h.state.request = { ...archiveRequest };
    await h.prepare(await corpus("2026-09-10", 35));
    h.state.conflictAt = 34;
    const writes = h.state.writes;
    await expect(runPrivateContentTransfer(h.overrides)).rejects.toThrow(
      "EXISTING_CONTENT_CONFLICT",
    );
    expect(h.importCase).not.toHaveBeenCalled();
    expect(h.state.writes).toBe(writes);
    expect(h.state.row?.envelope_digest).toBeNull();
  });

  it("rejects changing purpose or either date with the same archive key before D1", async () => {
    const h = harness();
    h.state.request = { ...archiveRequest };
    await h.prepare(await corpus("2026-09-10", 35));
    h.fetchMock.mockClear();
    const changes: Record<string, string>[] = [
      { keyId: archiveRequest.keyId },
      { keyId: archiveRequest.keyId, purpose: "launch" },
      { ...archiveRequest, from: "2026-09-11" },
      { ...archiveRequest, through: "2026-10-13" },
    ];
    for (const request of changes) {
      h.state.request = request;
      await expect(runPrivateContentTransfer(h.overrides)).rejects.toThrow("REQUEST_KEY_MISMATCH");
    }
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.importCase).not.toHaveBeenCalled();
  });

  it("rejects converting a launch key into an archive before D1", async () => {
    const h = harness();
    h.state.request = { ...archiveRequest, keyId };
    await expect(runPrivateContentTransfer(h.overrides)).rejects.toThrow("REQUEST_KEY_MISMATCH");
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["2026-10-15", "2026-10-15"],
    ["2026-10-14", "2026-10-16"],
    ["2026-10-14", "2026-09-10"],
    ["2026-08-15", "2026-10-14"],
    ["2026-09-31", "2026-10-14"],
  ])("rejects an invalid historical range %s through %s before D1", async (from, through) => {
    const h = harness();
    h.state.request = {
      keyId: `archive-${from}-${through}-v1`,
      purpose: "archive",
      from,
      through,
    };
    await expect(runPrivateContentTransfer(h.overrides)).rejects.toThrow();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.importCase).not.toHaveBeenCalled();
  });

  it("keeps the default launch limit when no archive purpose is requested", async () => {
    const h = harness();
    await h.prepare(await corpus("2026-10-15", 35));
    const writes = h.state.writes;
    await expect(runPrivateContentTransfer(h.overrides)).rejects.toThrow("INVALID_CORPUS_SIZE");
    expect(h.importCase).not.toHaveBeenCalled();
    expect(h.state.writes).toBe(writes);
  });
});

describe("future schedule content transfer", () => {
  it("publishes all 79 future days in date order after verifying the existing bridge", async () => {
    const h = harness();
    h.state.request = { ...scheduleRequest };
    const payload = await scheduledCorpus();
    payload.cases.reverse();
    await h.prepare(payload);
    const result = await runPrivateContentTransfer(h.overrides);
    expect(result).toMatchObject({ mode: "published", cases: 79, puzzles: 79 });
    expect(result.mode === "published" && result.dates[0]).toBe("2026-11-14");
    expect(result.mode === "published" && result.dates.at(-1)).toBe("2027-01-31");
    expect(h.state.imports.map((source) => JSON.parse(source).case.date)).toEqual(
      result.mode === "published" && result.dates,
    );
    expect(h.state.coverageChecks).toBe(1);
    expect(h.state.row?.private_key).toBeNull();
    expect(JSON.stringify(result)).not.toContain(canary);
  }, 30_000);

  it.each([1, 120])("accepts the %i-day schedule boundary and bounds D1 batches", async (count) => {
    const h = harness();
    const payload = await scheduledCorpus(scheduleRequest.from, count);
    const through = payload.cases.at(-1).case.date;
    h.state.request = {
      ...scheduleRequest, through,
      keyId: `schedule-${scheduleRequest.from}-${through}-v1`,
    };
    await h.prepare(payload);
    expect(await runPrivateContentTransfer(h.overrides)).toMatchObject({ cases: count });
    expect(h.state.imports).toHaveLength(count);
    for (const [, init] of h.fetchMock.mock.calls) {
      expect(JSON.parse(String(init?.body)).batch.length).toBeLessThanOrEqual(100);
    }
  }, 30_000);

  it("rejects a gap before the scheduled range without binding or importing", async () => {
    const h = harness();
    h.state.request = { ...scheduleRequest };
    await h.prepare(await scheduledCorpus());
    h.state.coverageMissing = 1;
    const writes = h.state.writes;
    await expect(runPrivateContentTransfer(h.overrides)).rejects.toThrow("SCHEDULE_PRECEDING_GAP");
    expect(h.state.writes).toBe(writes);
    expect(h.state.row?.envelope_digest).toBeNull();
    expect(h.importCase).not.toHaveBeenCalled();
  }, 30_000);

  it("checks that the range is still future at the initial claim", async () => {
    const h = harness();
    h.state.now = Date.parse("2026-11-13T23:59:00Z") / 1000;
    h.state.request = { ...scheduleRequest };
    await h.prepare(await scheduledCorpus());
    h.state.now += 120;
    const writes = h.state.writes;
    await expect(runPrivateContentTransfer(h.overrides)).rejects.toThrow("SCHEDULE_MUST_BE_FUTURE");
    expect(h.state.writes).toBe(writes);
    expect(h.state.row?.envelope_digest).toBeNull();
    expect(h.importCase).not.toHaveBeenCalled();
  }, 30_000);

  it("resumes identical bound ciphertext across the first midnight and later returns its receipt", async () => {
    const h = harness();
    h.state.now = Date.parse("2026-11-13T23:59:00Z") / 1000;
    h.state.request = { ...scheduleRequest };
    const payload = await scheduledCorpus();
    const recipient = await h.prepare(payload);
    h.state.failImportAt = 2;
    await expect(runPrivateContentTransfer(h.overrides)).rejects.toThrow("PRIVATE_CONTENT_TRANSFER_FAILED");
    expect(h.state.coverageChecks).toBe(1);
    const envelope = h.state.envelope;
    h.state.now += 120;
    h.state.envelope = encryptContentEnvelope(payload, recipient);
    await expect(runPrivateContentTransfer(h.overrides)).rejects.toThrow("TRANSFER_ENVELOPE_MISMATCH");
    h.state.envelope = envelope;
    h.state.failImportAt = 0;
    const published = await runPrivateContentTransfer(h.overrides);
    expect(published).toMatchObject({ mode: "published", cases: 79 });
    expect(h.state.coverageChecks).toBe(1);
    h.state.now = Date.parse("2027-03-01T12:00:00Z") / 1000;
    h.importCase.mockClear();
    const writes = h.state.writes;
    expect(await runPrivateContentTransfer(h.overrides)).toEqual({ ...published, alreadyCompleted: true });
    expect(h.state.writes).toBe(writes);
    expect(h.importCase).not.toHaveBeenCalled();
  }, 30_000);

  it.each(["missing", "outside", "extra"])("rejects a %s date before writing", async (kind) => {
    const h = harness();
    h.state.request = { ...scheduleRequest };
    const payload = await scheduledCorpus(scheduleRequest.from, kind === "extra" ? 80 : 79);
    if (kind === "missing") payload.cases.splice(17, 1);
    if (kind === "outside") payload.cases[0].case.date = "2026-11-13";
    await h.prepare(payload);
    const writes = h.state.writes;
    await expect(runPrivateContentTransfer(h.overrides)).rejects.toThrow("SCHEDULE_RANGE_MISMATCH");
    expect(h.state.writes).toBe(writes);
    expect(h.importCase).not.toHaveBeenCalled();
  }, 30_000);

  it("requires unique answers from visible board evidence before any writes", async () => {
    const h = harness();
    h.state.request = { ...scheduleRequest };
    const payload = await scheduledCorpus();
    const ambiguous = await corpus("2027-01-31", 1);
    ambiguous.cases[0].puzzles[0].public.id = "ambiguous-original";
    payload.cases[78] = ambiguous.cases[0];
    await h.prepare(payload);
    const writes = h.state.writes;
    await expect(runPrivateContentTransfer(h.overrides)).rejects.toThrow("SCHEDULE_RETRO_NOT_UNIQUE");
    expect(h.state.writes).toBe(writes);
    expect(h.state.row?.envelope_digest).toBeNull();
    expect(h.importCase).not.toHaveBeenCalled();
  }, 30_000);

  it("preflights conflicts in the second D1 batch before publishing anything", async () => {
    const h = harness();
    const payload = await scheduledCorpus(scheduleRequest.from, 120);
    const through = payload.cases.at(-1).case.date;
    h.state.request = {
      ...scheduleRequest, through,
      keyId: `schedule-${scheduleRequest.from}-${through}-v1`,
    };
    await h.prepare(payload);
    h.state.conflictCase = payload.cases[119].case.id;
    const writes = h.state.writes;
    await expect(runPrivateContentTransfer(h.overrides)).rejects.toThrow("EXISTING_CONTENT_CONFLICT");
    expect(h.state.writes).toBe(writes);
    expect(h.importCase).not.toHaveBeenCalled();
  }, 30_000);

  it("binds purpose and both schedule dates to the key before contacting D1", async () => {
    const h = harness();
    const changes: Record<string, string>[] = [
      { keyId: scheduleRequest.keyId },
      { keyId: scheduleRequest.keyId, purpose: "launch" },
      { ...scheduleRequest, purpose: "archive" },
      { ...scheduleRequest, from: "2026-11-15" },
      { ...scheduleRequest, through: "2027-01-30" },
      { ...scheduleRequest, keyId },
      { ...scheduleRequest, keyId: "schedule-2026-11-14-2027-01-31-v01" },
    ];
    for (const request of changes) {
      h.state.request = request;
      await expect(runPrivateContentTransfer(h.overrides)).rejects.toThrow("REQUEST_KEY_MISMATCH");
    }
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["2026-10-15", "2026-10-15"],
    ["2026-10-14", "2026-10-20"],
    ["2026-11-15", "2026-11-14"],
    ["2026-11-14", "2027-03-14"],
    ["2026-11-31", "2027-01-31"],
  ])("rejects invalid schedule %s through %s before D1", async (from, through) => {
    const h = harness();
    h.state.request = { purpose: "schedule", keyId: `schedule-${from}-${through}-v1`, from, through };
    await expect(runPrivateContentTransfer(h.overrides)).rejects.toThrow();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.importCase).not.toHaveBeenCalled();
  });
});
