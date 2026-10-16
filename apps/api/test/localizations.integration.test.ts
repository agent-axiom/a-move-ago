import {
  ArchiveResponseSchema,
  AttemptResultSchema,
  ClueResponseSchema,
  DailyCaseResponseSchema,
  HintResponseSchema,
} from "@a-move-ago/api-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { publicPuzzleId } from "../src/db/puzzle-identity";
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
  it("keeps legacy responses English and masks unearned conditions in every locale", async () => {
    const content = await seedLocalizedContent();
    const guest = await issueGuest();
    for (const headers of [{}, { "accept-language": "ru" }, { "x-content-locales": "0" }]) {
      const daily = await authenticatedJson(`/v1/daily?date=${content.date}`, guest.token, {
        headers,
      });
      expect(daily.response.status).toBe(200);
      expect(JSON.stringify(daily.body)).not.toContain("localizations");
      expect(JSON.stringify(daily.body)).not.toContain(content.puzzle.public.prompt);
    }
    const daily = await authenticatedJson(`/v1/daily?date=${content.date}`, guest.token, {
      headers: localizedHeaders,
    });
    const parsed = DailyCaseResponseSchema.parse(daily.body);
    expect(parsed.title).toBe("Daily case");
    expect(parsed.localizations?.ru?.title).toBe("Задача дня");
    expect(parsed.puzzles[0]?.id).toBe(publicPuzzleId(content.caseId, 1, 1));
    expect(parsed.puzzles[0]?.title).toBe("Puzzle 1");
    expect(parsed.puzzles[0]?.prompt).toBe("Reconstruct the last move.");
    expect(parsed.puzzles[0]?.localizations?.ru?.title).toBe("Задача 1");
    expect(parsed.puzzles[0]?.localizations?.zh?.title).toBe("棋题 1");
    expect(parsed.puzzles[0]?.localizations?.ru?.prompt).toBe("Восстановите последний ход.");
    expect(parsed.puzzles[0]?.localizations?.zh?.prompt).toBe("还原上一步棋。");
    const publicJson = JSON.stringify(daily.body);
    for (const secret of [
      privateHintOne,
      privateHintTwo,
      privateExplanation,
      "previousFen",
      "explanations",
      "hints",
      content.puzzle.public.title,
      content.puzzle.public.prompt,
      content.puzzle.contentKey,
      "Case ru",
      "Case zh",
      "Puzzle ru",
      "Puzzle zh",
      "Prompt ru",
      "Prompt zh",
    ]) {
      expect(publicJson).not.toContain(secret);
    }
    const archive = await authenticatedJson("/v1/archive", guest.token, {
      headers: localizedHeaders,
    });
    expect(ArchiveResponseSchema.parse(archive.body).cases[0]?.localizations?.zh?.title).toBe(
      "每日棋题",
    );
    expect(JSON.stringify(archive.body)).not.toContain(privateExplanation);
  });

  it("unlocks original conditions in all locales with one shared clue charge", async () => {
    const content = await seedLocalizedContent();
    const guest = await issueGuest();
    const path = `/v1/cases/${content.caseId}/puzzles/${publicPuzzleId(content.caseId, 1, 1)}/clue`;
    for (let request = 0; request < 2; request += 1) {
      const response = await authenticatedJson(path, guest.token, {
        method: "POST",
        body: {},
        headers: localizedHeaders,
      });
      const clue = ClueResponseSchema.parse(response.body);
      expect(response.response.status).toBe(200);
      expect(clue.prompt).toBe(content.puzzle.public.prompt);
      expect(clue.localizations?.ru?.prompt).toBe("Prompt ru");
      expect(clue.localizations?.zh?.prompt).toBe("Prompt zh");
      expect(clue.progress).toMatchObject({
        clueUnlocked: true,
        assistanceCount: 1,
        nextAttemptPoints: 50,
      });
    }
    const events = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM gameplay_events WHERE kind = 'clue'",
    ).first<{ count: number }>();
    expect(events?.count).toBe(1);
    const restored = DailyCaseResponseSchema.parse(
      (
        await authenticatedJson(`/v1/daily?date=${content.date}`, guest.token, {
          headers: localizedHeaders,
        })
      ).body,
    );
    expect(restored.puzzles[0]?.prompt).toBe(content.puzzle.public.prompt);
    expect(restored.puzzles[0]?.localizations?.ru?.prompt).toBe("Prompt ru");
    expect(restored.puzzles[0]?.localizations?.zh?.prompt).toBe("Prompt zh");
    const legacy = DailyCaseResponseSchema.parse(
      (await authenticatedJson(`/v1/daily?date=${content.date}`, guest.token)).body,
    );
    expect(legacy.puzzles[0]?.prompt).toBe(content.puzzle.public.prompt);
    expect(legacy.puzzles[0]?.localizations).toBeUndefined();
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
    const daily = DailyCaseResponseSchema.parse(
      (
        await authenticatedJson(`/v1/daily?date=${content.date}`, guest.token, {
          headers: localizedHeaders,
        })
      ).body,
    );
    expect(daily.puzzles[0]?.prompt).toBe(content.puzzle.public.prompt);
    expect(daily.puzzles[0]?.localizations?.ru?.prompt).toBe("Prompt ru");
    expect(daily.puzzles[0]?.localizations?.zh?.prompt).toBe("Prompt zh");
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
    const parsed = DailyCaseResponseSchema.parse(daily.body);
    expect(parsed.localizations?.ru?.title).toBe("Задача дня");
    expect(parsed.puzzles[0]?.localizations).toBeUndefined();
    expect(JSON.stringify(daily.body)).not.toContain("Prompt ru");
    expect(JSON.stringify(daily.body)).not.toContain("Case ru");
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
