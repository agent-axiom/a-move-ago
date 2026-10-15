import {
  ArchiveResponseSchema,
  AttemptResultSchema,
  DailyCaseResponseSchema,
  HintResponseSchema,
} from "@a-move-ago/api-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { contentDigest, seedContentFixture } from "./fixtures/content";
import { authenticatedJson, issueGuest, resetDatabase, testEnv } from "./helpers/http";

const localizedHeaders = { "x-content-locales": "1" };
const privateHintOne = "Личная подсказка один";
const privateHintTwo = "私密提示二";
const privateExplanation = "私密解答说明";

async function seedLocalizedContent() {
  const content = await seedContentFixture(testEnv.DB);
  await testEnv.DB.prepare(
    "INSERT INTO content_imports (digest, case_id, source_name, imported_at) VALUES (?, ?, 'localization-test', 1)",
  )
    .bind(contentDigest, content.caseId)
    .run();
  for (const locale of ["ru", "zh"]) {
    await testEnv.DB.prepare(
      "INSERT INTO case_localizations (case_id, locale, title, source_digest, content_digest) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(content.caseId, locale, `Case ${locale}`, contentDigest, "a".repeat(64))
      .run();
    await testEnv.DB.prepare(
      "INSERT INTO puzzle_localizations (puzzle_id, locale, public_json, private_json, source_digest, content_digest) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(
        content.puzzle.rowId,
        locale,
        JSON.stringify({
          title: `Puzzle ${locale}`,
          prompt: `Prompt ${locale}`,
          provenance: `Author ${locale}`,
          license: `License ${locale}`,
        }),
        JSON.stringify({
          hints: [privateHintOne, privateHintTwo],
          explanations: [privateExplanation],
          contradictionExplanations: { NOT_THE_LAST_MOVE: `Evidence ${locale}` },
        }),
        contentDigest,
        "b".repeat(64),
      )
      .run();
  }
  return content;
}

function attemptBody(content: Awaited<ReturnType<typeof seedLocalizedContent>>, correct = true) {
  return {
    attemptUuid: crypto.randomUUID(),
    caseId: content.caseId,
    puzzleId: content.puzzle.contentKey,
    retraction: correct
      ? content.puzzle.solution.retraction
      : {
          currentSquare: "d5",
          previousSquare: "d4",
          movedPiece: { color: "w", type: "p" },
          restoredPiece: null,
          special: "normal",
        },
  };
}

beforeEach(resetDatabase);

describe("opt-in content localizations", () => {
  it("keeps legacy responses English and exposes only public translations in daily and archive", async () => {
    const content = await seedLocalizedContent();
    const guest = await issueGuest();
    for (const headers of [{}, { "accept-language": "ru" }, { "x-content-locales": "0" }]) {
      const daily = await authenticatedJson(`/v1/daily?date=${content.date}`, guest.token, {
        headers,
      });
      expect(daily.response.status).toBe(200);
      expect(JSON.stringify(daily.body)).not.toContain("localizations");
    }
    const daily = await authenticatedJson(`/v1/daily?date=${content.date}`, guest.token, {
      headers: localizedHeaders,
    });
    const parsed = DailyCaseResponseSchema.parse(daily.body);
    expect(parsed.title).toBe("The missing pawn");
    expect(parsed.localizations?.ru?.title).toBe("Case ru");
    expect(parsed.puzzles[0]?.localizations?.zh?.prompt).toBe("Prompt zh");
    const publicJson = JSON.stringify(daily.body);
    for (const secret of [
      privateHintOne,
      privateHintTwo,
      privateExplanation,
      "previousFen",
      "explanations",
      "hints",
    ]) {
      expect(publicJson).not.toContain(secret);
    }
    const archive = await authenticatedJson("/v1/archive", guest.token, {
      headers: localizedHeaders,
    });
    expect(ArchiveResponseSchema.parse(archive.body).cases[0]?.localizations?.zh?.title).toBe(
      "Case zh",
    );
    expect(JSON.stringify(archive.body)).not.toContain(privateExplanation);
  });

  it("enriches an existing correct replay without changing its canonical response or stats", async () => {
    const content = await seedLocalizedContent();
    const guest = await issueGuest();
    const body = attemptBody(content);
    const original = await authenticatedJson("/v1/attempts", guest.token, { method: "POST", body });
    const base = AttemptResultSchema.parse(original.body);
    expect(base.correct).toBe(true);
    expect(JSON.stringify(base)).not.toContain("localizations");

    const replay = await authenticatedJson("/v1/attempts", guest.token, {
      method: "POST",
      body,
      headers: localizedHeaders,
    });
    const enriched = AttemptResultSchema.parse(replay.body);
    expect(replay.response.headers.get("idempotency-replayed")).toBe("true");
    expect(enriched.id).toBe(base.id);
    expect(enriched.correct && enriched.reveal.localizations?.zh?.explanation).toBe(
      privateExplanation,
    );
    const stored = await testEnv.DB.prepare("SELECT response_json FROM attempts WHERE id = ?")
      .bind(base.id)
      .first<{ response_json: string }>();
    expect(JSON.parse(stored?.response_json ?? "null")).toEqual(base);
    const count = await testEnv.DB.prepare("SELECT count(*) AS total FROM attempts").first<{
      total: number;
    }>();
    expect(count?.total).toBe(1);
  });

  it("translates only an earned hint level and preserves ownership and sequential hint checks", async () => {
    const content = await seedLocalizedContent();
    const guest = await issueGuest();
    const attempt = await authenticatedJson("/v1/attempts", guest.token, {
      method: "POST",
      body: attemptBody(content, false),
      headers: localizedHeaders,
    });
    const incorrect = AttemptResultSchema.parse(attempt.body);
    expect(incorrect.correct).toBe(false);
    expect(!incorrect.correct && incorrect.contradiction.localizations?.ru?.message).toBe(
      "Evidence ru",
    );
    const hintPath = `/v1/attempts/${incorrect.id}/hints`;
    const initial = await authenticatedJson(hintPath, guest.token, {
      method: "POST",
      body: { level: 1 },
    });
    expect(HintResponseSchema.parse(initial.body).localizations).toBeUndefined();
    const replay = await authenticatedJson(hintPath, guest.token, {
      method: "POST",
      body: { level: 1 },
      headers: localizedHeaders,
    });
    const hint = HintResponseSchema.parse(replay.body);
    expect(hint.localizations?.ru?.text).toBe(privateHintOne);
    expect(JSON.stringify(replay.body)).not.toContain(privateHintTwo);
    expect(JSON.stringify(replay.body)).not.toContain(privateExplanation);
    const stored = await testEnv.DB.prepare(
      "SELECT hint_json FROM hint_events WHERE attempt_id = ?",
    )
      .bind(incorrect.id)
      .all<{ hint_json: string }>();
    expect(stored.results).toHaveLength(1);
    expect(JSON.parse(stored.results[0]?.hint_json ?? "null")).toEqual(initial.body);

    const other = await issueGuest();
    const denied = await authenticatedJson(hintPath, other.token, {
      method: "POST",
      body: { level: 1 },
      headers: localizedHeaders,
    });
    expect(denied.response.status).toBe(404);
    const outOfOrder = await authenticatedJson(hintPath, guest.token, {
      method: "POST",
      body: { level: 3 },
      headers: localizedHeaders,
    });
    expect(outOfOrder.response.status).toBe(409);
    expect(JSON.stringify(denied.body)).not.toContain(privateHintOne);
    expect(JSON.stringify(outOfOrder.body)).not.toContain(privateHintTwo);
  });

  it("ignores stale translations whose source digest differs from the imported case", async () => {
    const content = await seedLocalizedContent();
    const guest = await issueGuest();
    await testEnv.DB.batch([
      testEnv.DB.prepare("UPDATE case_localizations SET source_digest = ?").bind("c".repeat(64)),
      testEnv.DB.prepare("UPDATE puzzle_localizations SET source_digest = ?").bind("c".repeat(64)),
    ]);
    const daily = await authenticatedJson(`/v1/daily?date=${content.date}`, guest.token, {
      headers: localizedHeaders,
    });
    expect(daily.response.status).toBe(200);
    expect(JSON.stringify(daily.body)).not.toContain("localizations");
  });

  it("translates default contradiction codes while keeping private hints and explanations hidden", async () => {
    const content = await seedLocalizedContent();
    const guest = await issueGuest();
    const body = attemptBody(content, false);
    const response = await authenticatedJson("/v1/attempts", guest.token, {
      method: "POST",
      body: {
        ...body,
        retraction: { ...body.retraction, currentSquare: "a3", previousSquare: "a4" },
      },
      headers: localizedHeaders,
    });
    const attempt = AttemptResultSchema.parse(response.body);
    expect(attempt.correct).toBe(false);
    expect(!attempt.correct && attempt.contradiction.code).toBe("NO_PIECE_ON_CURRENT_SQUARE");
    expect(!attempt.correct && attempt.contradiction.localizations?.zh?.message).toBe(
      "该格上没有可以退回的棋子。",
    );
    expect(JSON.stringify(response.body)).not.toContain(privateExplanation);
    expect(JSON.stringify(response.body)).not.toContain(privateHintOne);
  });
});
