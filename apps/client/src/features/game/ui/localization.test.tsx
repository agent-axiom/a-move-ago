import type { AcceptedSolution, PuzzlePublic } from "@a-move-ago/api-contract";
import { parseFen } from "@a-move-ago/game-core";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RuntimeProvider } from "../../../app/runtime";
import { I18nProvider, useI18n } from "../../../i18n";
import { runtimeFixture } from "../../../test/runtime-fixture";
import { PuzzleGame } from "./PuzzleGame";
import { RetractionComposer } from "./RetractionComposer";
import { RevealPlayer } from "./RevealPlayer";

const postFen = "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2";
const puzzle = {
  id: "localized-capture",
  version: 1,
  title: "A pawn changed files",
  prompt: "Restore the last capture.",
  postFen,
  retractingColor: "w",
  maxHints: 2,
  provenance: "Original composition",
  license: "All Rights Reserved",
  localizations: {
    ru: {
      title: "Пешка сменила вертикаль",
      prompt: "Восстановите последнее взятие.",
      provenance: "Оригинальная композиция",
      license: "Все права защищены",
    },
    zh: {
      title: "兵换了直线",
      prompt: "还原最后一次吃子。",
      provenance: "原创棋题",
      license: "保留所有权利",
    },
  },
} satisfies PuzzlePublic;

const solution = {
  retraction: {
    currentSquare: "d5",
    previousSquare: "e4",
    movedPiece: { color: "w", type: "p" },
    restoredPiece: { color: "b", type: "p", square: "d5" },
    special: "normal",
  },
  previousFen: "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2",
  forwardSan: "exd5",
  explanation: "The white pawn captured on d5.",
  historyConstraints: [
    { kind: "previous-castling", value: "KQkq" },
    { kind: "previous-en-passant", value: "d6" },
  ],
  localizations: {
    ru: { explanation: "Белая пешка взяла фигуру на d5." },
    zh: { explanation: "白兵在 d5 吃子。" },
  },
} satisfies AcceptedSolution;

function LocaleControls() {
  const { setLocale } = useI18n();
  return (
    <div>
      <button type="button" onClick={() => setLocale("en")}>
        English
      </button>
      <button type="button" onClick={() => setLocale("ru")}>
        Русский
      </button>
      <button type="button" onClick={() => setLocale("zh")}>
        中文
      </button>
    </div>
  );
}

function Localized({ children }: { children: ReactNode }) {
  return (
    <I18nProvider>
      <LocaleControls />
      {children}
    </I18nProvider>
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("switches an earned hint and feedback without reposting or losing the configured capture", async () => {
  const user = userEvent.setup();
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  runtime.api.submitAttempt = vi.fn().mockResolvedValue({
    id: "11111111-1111-4111-8111-111111111111",
    attemptUuid: "22222222-2222-4222-8222-222222222222",
    correct: false,
    contradiction: {
      code: "NOT_THE_LAST_MOVE",
      message: "Try a different starting square.",
      localizations: {
        ru: { message: "Попробуйте другое исходное поле." },
        zh: { message: "请尝试其他起始格。" },
      },
    },
  });
  runtime.api.requestHint = vi.fn().mockResolvedValue({
    level: 1,
    text: "Look at the pawn's file.",
    exhausted: false,
    localizations: {
      ru: { text: "Обратите внимание на вертикаль пешки." },
      zh: { text: "留意兵所在的直线。" },
    },
  });
  render(
    <RuntimeProvider runtime={runtime}>
      <Localized>
        <PuzzleGame caseId="case-2026-08-03" puzzle={puzzle} onSolved={vi.fn()} />
      </Localized>
    </RuntimeProvider>,
  );

  expect(screen.getByText("Reconstruct the last move.")).toBeInTheDocument();
  expect(screen.queryByText(puzzle.title)).not.toBeInTheDocument();
  expect(screen.queryByText(puzzle.prompt)).not.toBeInTheDocument();

  await user.click(screen.getByRole("gridcell", { name: "d5, white pawn" }));
  await user.click(screen.getByRole("gridcell", { name: "e4, empty" }));
  await user.click(screen.getByText("Capture or special move", { exact: true }));
  await user.selectOptions(screen.getByLabelText("Captured piece"), "p");
  await user.click(screen.getByRole("button", { name: "Check move" }));
  await screen.findByText("Try a different starting square.");
  expect(screen.getByRole("region", { name: "Attempt feedback" })).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Get hint" }));
  await screen.findByText("Look at the pawn's file.");

  await user.click(screen.getByRole("button", { name: "Русский" }));
  expect(screen.getByText("Восстановите последний ход.")).toBeInTheDocument();
  expect(screen.queryByText(puzzle.localizations.ru.title)).not.toBeInTheDocument();
  expect(screen.queryByText(puzzle.localizations.ru.prompt)).not.toBeInTheDocument();
  expect(screen.getByText("Попробуйте другое исходное поле.")).toBeInTheDocument();
  expect(screen.getByText("Обратите внимание на вертикаль пешки.")).toBeInTheDocument();
  expect(screen.getByLabelText("Взятая фигура")).toHaveValue("p");
  expect(screen.getByLabelText("Выбранный возврат хода")).toHaveTextContent("d5");
  expect(screen.getByLabelText("Выбранный возврат хода")).toHaveTextContent("e4");
  expect(screen.getByRole("gridcell", { name: "d5, белая пешка" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await user.click(screen.getByRole("button", { name: "中文" }));
  expect(screen.getByText("还原上一步棋。")).toBeInTheDocument();
  expect(screen.queryByText(puzzle.localizations.zh.title)).not.toBeInTheDocument();
  expect(screen.queryByText(puzzle.localizations.zh.prompt)).not.toBeInTheDocument();
  expect(screen.getByText("请尝试其他起始格。")).toBeInTheDocument();
  expect(screen.getByText("留意兵所在的直线。")).toBeInTheDocument();
  expect(screen.getByLabelText("被吃的棋子")).toHaveValue("p");
  expect(screen.getByRole("gridcell", { name: "d5, 白兵" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(runtime.api.submitAttempt).toHaveBeenCalledOnce();
  expect(runtime.api.requestHint).toHaveBeenCalledOnce();
  expect(runtime.api.getDaily).not.toHaveBeenCalled();
});

it("updates preview validation in place while retaining the selected special move", async () => {
  const user = userEvent.setup();
  render(
    <Localized>
      <RetractionComposer
        disabled={false}
        onSubmit={vi.fn()}
        post={parseFen("2N5/4k3/8/8/8/8/8/K7 b - - 0 40")}
        retractingColor="w"
      />
    </Localized>,
  );
  await user.click(screen.getByRole("gridcell", { name: "c8, white knight" }));
  await user.click(screen.getByRole("gridcell", { name: "c7, empty" }));
  await user.click(screen.getByText("Capture or special move", { exact: true }));
  await user.selectOptions(screen.getByLabelText("Special move"), "en-passant");
  expect(screen.getByRole("alert")).toHaveTextContent(
    "The retraction details do not match the selected squares.",
  );
  await user.click(screen.getByRole("button", { name: "Русский" }));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Детали возврата хода не соответствуют выбранным полям.",
  );
  expect(screen.getByLabelText("Особый ход")).toHaveValue("en-passant");
  expect(screen.getByRole("button", { name: "Проверить ход" })).toBeDisabled();
});

it("translates a running reveal without restarting its timer or clearing inspected positions", () => {
  vi.useFakeTimers();
  const complete = vi.fn();
  render(
    <Localized>
      <RevealPlayer postFen={postFen} solution={solution} onComplete={complete} />
    </Localized>,
  );
  act(() => vi.advanceTimersByTime(800));
  expect(screen.getByRole("status")).toHaveTextContent("Playing exd5 forward.");
  fireEvent.click(screen.getByRole("button", { name: "Русский" }));
  expect(screen.getByRole("status")).toHaveTextContent("Проигрываем ход exd5.");
  expect(screen.getByText("Белая пешка взяла фигуру на d5.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Продолжить" })).toBeDisabled();
  act(() => vi.advanceTimersByTime(750));
  expect(screen.getByRole("status")).toHaveTextContent("Показ решения завершён.");
  expect(screen.getByRole("button", { name: "Продолжить" })).toBeEnabled();

  fireEvent.click(screen.getByRole("button", { name: "До хода" }));
  fireEvent.click(screen.getByRole("button", { name: "中文" }));
  expect(screen.getByRole("grid", { name: "还原的上一步之前的局面" })).toBeInTheDocument();
  expect(screen.getByRole("gridcell", { name: "e4, 白兵" })).toBeInTheDocument();
  expect(screen.getByText("白兵在 d5 吃子。")).toBeInTheDocument();
  expect(complete).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "继续" }));
  expect(complete).toHaveBeenCalledOnce();
});
