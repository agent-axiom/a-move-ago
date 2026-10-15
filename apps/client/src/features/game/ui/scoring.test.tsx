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
const puzzle = {
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
} satisfies PuzzlePublic;
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
const fullClue = {
  title: "A missing pawn",
  prompt: "The last move was a non-capturing pawn move. Undo it.",
  localizations: {
    ru: {
      title: "Пропавшая пешка",
      prompt: "Последним ходом белых был ход пешкой без взятия. Отмените его.",
    },
    zh: {
      title: "消失的兵",
      prompt: "白方上一步走兵且没有吃子。请撤销该步。",
    },
  },
};

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

it("hides the full clue until purchase and preserves the draft when the clue and language change", async () => {
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
  expect(screen.getByText("Reconstruct the last move.")).toBeInTheDocument();
  expect(screen.queryByText(puzzle.title)).not.toBeInTheDocument();
  expect(screen.queryByText(puzzle.prompt)).not.toBeInTheDocument();
  expect(screen.queryByText(fullClue.title)).not.toBeInTheDocument();
  expect(screen.queryByText(fullClue.prompt)).not.toBeInTheDocument();
  expect(screen.queryByText("Conditions · no point cost")).not.toBeInTheDocument();
  expect(screen.getByText("Available: 100 points")).toBeInTheDocument();
  await user.click(screen.getByRole("gridcell", { name: "d5, white pawn" }));
  await user.click(screen.getByRole("gridcell", { name: "e4, empty" }));
  await user.selectOptions(screen.getByLabelText("Captured piece"), "p");
  await user.click(screen.getByRole("button", { name: "Reveal clue · 100 → 50 points" }));
  expect(screen.getByRole("button", { name: "Revealing clue…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Check move" })).toBeDisabled();
  expect(screen.queryByText(fullClue.title)).not.toBeInTheDocument();
  expect(screen.queryByText(fullClue.prompt)).not.toBeInTheDocument();
  await act(async () => {
    resolveClue?.({
      ...fullClue,
      progress: progressState({ assistanceCount: 1, clueUnlocked: true, nextAttemptPoints: 50 }),
    });
    await Promise.resolve();
  });
  expect(screen.getByText(fullClue.title)).toBeInTheDocument();
  expect(screen.getByText(fullClue.prompt)).toBeInTheDocument();
  expect(screen.getAllByText("Reconstruct the last move.")).toHaveLength(1);
  expect(screen.queryByText(puzzle.prompt)).not.toBeInTheDocument();
  expect(screen.getByText("Available: 50 points")).toBeInTheDocument();
  expect(screen.getByLabelText("Captured piece")).toHaveValue("p");
  expect(screen.getByRole("button", { name: "Check move" })).toBeEnabled();
  await user.selectOptions(screen.getByLabelText("Language"), "ru");
  expect(screen.getByText(fullClue.localizations.ru.title)).toBeInTheDocument();
  expect(screen.getByText(fullClue.localizations.ru.prompt)).toBeInTheDocument();
  expect(screen.getAllByText("Восстановите последний ход.")).toHaveLength(1);
  expect(screen.getByText("Доступно: 50 очков")).toBeInTheDocument();
  expect(screen.getByLabelText("Взятая фигура")).toHaveValue("p");
  await user.selectOptions(screen.getByLabelText("Язык"), "zh");
  expect(screen.getByText(fullClue.localizations.zh.title)).toBeInTheDocument();
  expect(screen.getByText(fullClue.localizations.zh.prompt)).toBeInTheDocument();
  expect(screen.getAllByText("还原上一步棋。")).toHaveLength(1);
  expect(screen.getByText("可得：50 分")).toBeInTheDocument();
  expect(runtime.api.requestClue).toHaveBeenCalledOnce();
  expect(runtime.api.submitAttempt).not.toHaveBeenCalled();
});

it("restores the purchased title and full prompt from daily state without purchasing them again", async () => {
  const user = userEvent.setup();
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  runtime.api.requestClue = vi.fn();
  const restoredPuzzle: PuzzlePublic = {
    ...puzzle,
    ...fullClue,
    localizations: {
      ru: { ...puzzle.localizations.ru, ...fullClue.localizations.ru },
      zh: { ...puzzle.localizations.zh, ...fullClue.localizations.zh },
    },
  };
  render(
    <RuntimeProvider runtime={runtime}>
      <I18nProvider>
        <LanguageSwitcher />
        <PuzzleGame
          caseId="case-day"
          puzzle={restoredPuzzle}
          progress={progressState({
            assistanceCount: 1,
            clueUnlocked: true,
            nextAttemptPoints: 50,
          })}
          onSolved={vi.fn()}
        />
      </I18nProvider>
    </RuntimeProvider>,
  );
  expect(screen.getByText(fullClue.title)).toBeInTheDocument();
  expect(screen.getByText(fullClue.prompt)).toBeInTheDocument();
  expect(screen.getAllByText("Reconstruct the last move.")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: /Reveal clue/ })).not.toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText("Language"), "ru");
  expect(screen.getByText(fullClue.localizations.ru.title)).toBeInTheDocument();
  expect(screen.getByText(fullClue.localizations.ru.prompt)).toBeInTheDocument();
  expect(screen.getAllByText("Восстановите последний ход.")).toHaveLength(1);
  await user.selectOptions(screen.getByLabelText("Язык"), "zh");
  expect(screen.getByText(fullClue.localizations.zh.title)).toBeInTheDocument();
  expect(screen.getByText(fullClue.localizations.zh.prompt)).toBeInTheDocument();
  expect(screen.getAllByText("还原上一步棋。")).toHaveLength(1);
  expect(runtime.api.requestClue).not.toHaveBeenCalled();
});

it.each(["locked", "legacy"] as const)(
  "keeps cached spoiler text out of the DOM and accessibility labels in %s mode",
  async (mode) => {
    const user = userEvent.setup();
    const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
    render(
      <RuntimeProvider runtime={runtime}>
        <I18nProvider>
          <LanguageSwitcher />
          <PuzzleGame
            caseId="case-day"
            puzzle={puzzle}
            progress={mode === "locked" ? progressState() : undefined}
            onSolved={vi.fn()}
          />
        </I18nProvider>
      </RuntimeProvider>,
    );
    const assertHidden = (title: string, prompt: string) => {
      expect(document.body.innerHTML).not.toContain(title);
      expect(document.body.innerHTML).not.toContain(prompt);
    };
    expect(screen.getByText("Reconstruct the last move.")).toBeInTheDocument();
    assertHidden(puzzle.title, puzzle.prompt);
    await user.selectOptions(screen.getByLabelText("Language"), "ru");
    expect(screen.getByText("Восстановите последний ход.")).toBeInTheDocument();
    assertHidden(puzzle.localizations.ru.title, puzzle.localizations.ru.prompt);
    await user.selectOptions(screen.getByLabelText("Язык"), "zh");
    expect(screen.getByText("还原上一步棋。")).toBeInTheDocument();
    assertHidden(puzzle.localizations.zh.title, puzzle.localizations.zh.prompt);
  },
);

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

  runtime.api.submitAttempt = vi.fn().mockResolvedValue({
    id: "22222222-2222-4222-8222-222222222222",
    attemptUuid: "22222222-2222-4222-8222-222222222222",
    correct: false,
    contradiction: { code: "NOT_THE_LAST_MOVE", message: "The puzzle was solved in another tab." },
    progress: { ...progress, earnedPoints: 35, nextAttemptPoints: 0, awardAttemptId: awardId },
  });
  await user.click(screen.getByRole("gridcell", { name: "d5, белая пешка" }));
  await user.click(screen.getByRole("gridcell", { name: "e4, пусто" }));
  await user.selectOptions(screen.getByLabelText("Взятая фигура"), "p");
  await user.click(screen.getByRole("button", { name: "Проверить ход" }));
  await screen.findByText("The puzzle was solved in another tab.");
  const clueButton = screen.getByRole("button", { name: "Открыть улику · 0 → 0 очков" });
  const hintButton = screen.getByRole("button", { name: "Подсказка · 0 → 0 очков" });
  expect(clueButton).toBeDisabled();
  expect(hintButton).toBeDisabled();
  expect(screen.queryByRole("button", { name: /0 → 1/ })).not.toBeInTheDocument();
  await user.click(clueButton);
  await user.click(hintButton);
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
