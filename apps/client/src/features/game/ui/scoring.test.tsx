import type {
  AcceptedSolution,
  ClueResponse,
  PuzzleProgress,
  PuzzlePublic,
} from "@a-move-ago/api-contract";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RuntimeProvider } from "../../../app/runtime";
import { I18nProvider, LanguageSwitcher } from "../../../i18n";
import { runtimeFixture } from "../../../test/runtime-fixture";
import { PuzzleGame } from "./PuzzleGame";
import { RevealPlayer } from "./RevealPlayer";

const postFen = "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2";
const puzzle: PuzzlePublic = {
  id: "neutral-puzzle",
  version: 1,
  title: "Daily mystery",
  prompt: "White made the last move. Restore it.",
  postFen,
  retractingColor: "w",
  maxHints: 2,
  provenance: "Original composition",
  license: "All Rights Reserved",
  localizations: {
    ru: {
      title: "Задача дня",
      prompt: "Белые сделали последний ход. Отмените его.",
      provenance: "Оригинальная композиция",
      license: "Все права защищены",
    },
    zh: {
      title: "每日谜题",
      prompt: "白方走了最后一步。请撤销该步。",
      provenance: "原创棋题",
      license: "保留所有权利",
    },
  },
};
const solution: AcceptedSolution = {
  retraction: {
    currentSquare: "d5",
    previousSquare: "e4",
    movedPiece: { color: "w", type: "p" },
    restoredPiece: { color: "b", type: "p", square: "d5" },
    special: "normal",
  },
  previousFen: "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2",
  forwardSan: "exd5",
  explanation: "The pawn captured on d5.",
  historyConstraints: [
    { kind: "previous-castling", value: "KQkq" },
    { kind: "previous-en-passant", value: "d6" },
  ],
};
const awardId = "11111111-1111-4111-8111-111111111111";

function progressState(overrides: Partial<PuzzleProgress> = {}): PuzzleProgress {
  return {
    attemptCount: 0,
    assistanceCount: 0,
    clueUnlocked: false,
    highestHintLevel: 0,
    earnedPoints: null,
    nextAttemptPoints: 100,
    legacySolved: false,
    awardAttemptId: null,
    earnedHints: [],
    ...overrides,
  };
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
});

it("shows the clue price before unlocking and preserves the draft when the clue and language change", async () => {
  const user = userEvent.setup();
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  let resolveClue: ((value: ClueResponse) => void) | undefined;
  runtime.api.requestClue = vi.fn(
    () =>
      new Promise<ClueResponse>((resolve) => {
        resolveClue = resolve;
      }),
  );
  render(
    <RuntimeProvider runtime={runtime}>
      <I18nProvider>
        <LanguageSwitcher />
        <PuzzleGame
          caseId="case-day"
          puzzle={puzzle}
          progress={progressState()}
          onSolved={vi.fn()}
        />
      </I18nProvider>
    </RuntimeProvider>,
  );
  expect(screen.getByText("White made the last move. Restore it.")).toBeInTheDocument();
  expect(screen.getByText("Conditions · no point cost")).toBeInTheDocument();
  expect(screen.queryByText("A missing pawn")).not.toBeInTheDocument();
  expect(screen.getByText("Available: 100 points")).toBeInTheDocument();
  await user.click(screen.getByRole("gridcell", { name: "d5, white pawn" }));
  await user.click(screen.getByRole("gridcell", { name: "e4, empty" }));
  await user.selectOptions(screen.getByLabelText("Captured piece"), "p");
  await user.click(screen.getByRole("button", { name: "Reveal clue · 100 → 50 points" }));
  expect(screen.getByRole("button", { name: "Revealing clue…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Check move" })).toBeDisabled();
  expect(screen.queryByText("A missing pawn")).not.toBeInTheDocument();
  await act(async () => {
    resolveClue?.({
      title: "A missing pawn",
      prompt: puzzle.prompt,
      localizations: {
        ru: { title: "Пропавшая пешка", prompt: puzzle.localizations?.ru?.prompt ?? "" },
        zh: { title: "消失的兵", prompt: puzzle.localizations?.zh?.prompt ?? "" },
      },
      progress: progressState({ assistanceCount: 1, clueUnlocked: true, nextAttemptPoints: 50 }),
    });
    await Promise.resolve();
  });
  expect(screen.getByText("A missing pawn")).toBeInTheDocument();
  expect(screen.getByText("Available: 50 points")).toBeInTheDocument();
  expect(screen.getByLabelText("Captured piece")).toHaveValue("p");
  expect(screen.getByRole("button", { name: "Check move" })).toBeEnabled();
  await user.selectOptions(screen.getByLabelText("Language"), "ru");
  expect(screen.getByText("Пропавшая пешка")).toBeInTheDocument();
  expect(screen.getByText("Доступно: 50 очков")).toBeInTheDocument();
  expect(screen.getByLabelText("Взятая фигура")).toHaveValue("p");
  await user.selectOptions(screen.getByLabelText("Язык"), "zh");
  expect(screen.getByText("消失的兵")).toBeInTheDocument();
  expect(screen.getByText("可得：50 分")).toBeInTheDocument();
  expect(runtime.api.requestClue).toHaveBeenCalledOnce();
  expect(runtime.api.submitAttempt).not.toHaveBeenCalled();
});

it("restores purchased hints and server score without charging or revealing another clue", async () => {
  const user = userEvent.setup();
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  runtime.api.requestClue = vi.fn();
  const progress = progressState({
    attemptCount: 2,
    assistanceCount: 1,
    highestHintLevel: 1,
    nextAttemptPoints: 1,
    earnedHints: [{ level: 1, text: "A previously earned hint.", exhausted: false }],
  });
  render(
    <RuntimeProvider runtime={runtime}>
      <I18nProvider>
        <LanguageSwitcher />
        <PuzzleGame caseId="case-day" puzzle={puzzle} progress={progress} onSolved={vi.fn()} />
      </I18nProvider>
    </RuntimeProvider>,
  );
  expect(screen.getByText("A previously earned hint.")).toBeInTheDocument();
  expect(screen.getByText("Attempt 3")).toBeInTheDocument();
  expect(screen.getByText("Available: 1 point")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reveal clue · 1 → 1 point" })).toBeEnabled();
  await user.selectOptions(screen.getByLabelText("Language"), "ru");
  expect(screen.getByText("Доступно: 1 очко")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Открыть улику · 1 → 1 очко" })).toBeEnabled();
  expect(runtime.api.requestClue).not.toHaveBeenCalled();
  expect(runtime.api.requestHint).not.toHaveBeenCalled();
});

it("announces only the original award and correctly labels tiny rewards, replay and legacy solves", async () => {
  const user = userEvent.setup();
  const progress = progressState({
    attemptCount: 2,
    earnedPoints: 35,
    nextAttemptPoints: 0,
    assistanceCount: 1,
    awardAttemptId: awardId,
  });
  const tree = (attemptId: string, state: PuzzleProgress) => (
    <I18nProvider>
      <LanguageSwitcher />
      <RevealPlayer
        postFen={postFen}
        solution={solution}
        onComplete={vi.fn()}
        attemptId={attemptId}
        progress={state}
      />
    </I18nProvider>
  );
  const view = render(tree(awardId, progress));
  expect(screen.getByText("+35 points earned")).toBeInTheDocument();
  expect(screen.getByText("Solved on attempt 2")).toBeInTheDocument();
  view.rerender(tree("22222222-2222-4222-8222-222222222222", progress));
  expect(screen.queryByText("+35 points earned")).not.toBeInTheDocument();
  expect(screen.getByText("Already counted · 35 points")).toBeInTheDocument();
  view.rerender(
    tree(awardId, { ...progress, earnedPoints: 0, awardAttemptId: null, legacySolved: true }),
  );
  expect(screen.getByText("Previously solved · unrated")).toBeInTheDocument();
  expect(screen.queryByText(/points earned/)).not.toBeInTheDocument();

  view.rerender(tree(awardId, { ...progress, earnedPoints: 1 }));
  expect(screen.getByText("+1 point earned")).toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText("Language"), "ru");
  expect(screen.getByText("Начислено: +1 очко")).toBeInTheDocument();
  expect(screen.getByText("Решено с 2-й попытки")).toBeInTheDocument();
});
