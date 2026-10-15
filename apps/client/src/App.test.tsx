import type { AcceptedSolution } from "@a-move-ago/api-contract";
import { ApiContractError, ApiError, ApiTransportError } from "@a-move-ago/api-contract";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "./App";
import { type AppRuntime, RuntimeProvider } from "./app/runtime";
import { runtimeFixture } from "./test/runtime-fixture";

const postFen = "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2";

const puzzle = {
  id: "opening-exd5",
  version: 1,
  title: "A pawn vanished",
  prompt: "What happened one move ago?",
  postFen,
  retractingColor: "w" as const,
  maxHints: 2,
  provenance: "A MOVE AGO sample",
  license: "CC BY 4.0",
};

const daily = {
  id: "case-2026-08-03",
  date: "2026-08-03",
  title: "The missing pawn",
  puzzles: [puzzle],
  solvedPuzzleIds: [],
};

const reveal = {
  retraction: {
    currentSquare: "d5",
    previousSquare: "e4",
    movedPiece: { color: "w", type: "p" },
    restoredPiece: { color: "b", type: "p", square: "d5" },
    special: "normal",
  },
  previousFen: "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2",
  forwardSan: "exd5",
  explanation: "The white e-pawn captured the black pawn on d5.",
  historyConstraints: [
    { kind: "previous-castling", value: "KQkq" },
    { kind: "previous-en-passant", value: "d6" },
  ],
} satisfies AcceptedSolution;

const incorrectAttempt = {
  id: "11111111-1111-4111-8111-111111111111",
  attemptUuid: "22222222-2222-4222-8222-222222222222",
  correct: false as const,
  contradiction: { code: "NOT_THE_LAST_MOVE" as const, message: "Try another move." },
};

const stats = {
  attempts: 1,
  hintsUsed: 0,
  solvedPuzzles: 1,
  completedCases: 1,
  currentStreak: 1,
  bestStreak: 1,
  lastCompletedDate: "2026-08-03",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function renderApp(runtime: AppRuntime) {
  return render(
    <RuntimeProvider runtime={runtime}>
      <App />
    </RuntimeProvider>,
  );
}

async function composeCapture(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("gridcell", { name: "d5, white pawn" }));
  await user.click(screen.getByRole("gridcell", { name: "e4, empty" }));
  await user.selectOptions(screen.getByLabelText("Captured piece"), "p");
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

it("creates a guest before daily and requests no Telegram proof without consent", async () => {
  const runtime = runtimeFixture({ storedToken: null, platformKind: "telegram" });
  const issued = deferred<{
    token: string;
    expiresAt: string;
    kind: "guest";
  }>();
  const order: string[] = [];
  runtime.api.createGuest = vi.fn(() => {
    order.push("guest");
    return issued.promise;
  });
  runtime.api.getDaily = vi.fn(async () => {
    order.push("daily");
    return daily;
  });

  renderApp(runtime);
  await waitFor(() => expect(runtime.api.createGuest).toHaveBeenCalledOnce());
  expect(runtime.api.getDaily).not.toHaveBeenCalled();
  expect(runtime.platform.requestTelegramProof).not.toHaveBeenCalled();
  expect(runtime.api.loginMiniApp).not.toHaveBeenCalled();

  await act(async () => {
    issued.resolve({
      token: "g".repeat(43),
      expiresAt: "2026-11-01T00:00:00.000Z",
      kind: "guest",
    });
    await issued.promise;
  });
  await waitFor(() => expect(runtime.api.getDaily).toHaveBeenCalledOnce());

  expect(order).toEqual(["guest", "daily"]);
  expect(runtime.platform.ready).toHaveBeenCalledOnce();
  expect(runtime.platform.installLayoutVars).toHaveBeenCalledWith(document.documentElement);
  expect(runtime.platform.requestTelegramProof).not.toHaveBeenCalled();
  expect(runtime.api.loginMiniApp).not.toHaveBeenCalled();
});

it("resets and reloads daily state when the session identity changes", async () => {
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  const listeners: Array<(url: string) => void> = [];
  const mergedDaily = {
    ...daily,
    puzzles: [
      { ...puzzle, title: "Progress merged from Telegram" },
      { ...puzzle, id: "telegram-second-puzzle" },
    ],
  };
  runtime.platform.authReturn.subscribe = vi.fn(async (listener) => {
    listeners.push(listener);
    return () => undefined;
  });
  runtime.api.getDaily = vi.fn().mockResolvedValueOnce(daily).mockResolvedValueOnce(mergedDaily);

  renderApp(runtime);
  expect(await screen.findByText("Reconstruct the last move.")).toBeInTheDocument();
  expect(screen.getByText("Act 1 of 1")).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: puzzle.title })).not.toBeInTheDocument();
  expect(runtime.api.getDaily).toHaveBeenCalledOnce();
  expect(listeners).toHaveLength(1);

  act(() =>
    listeners[0]?.("amoveago-debug://auth?handoff=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"),
  );
  await waitFor(() =>
    expect(runtime.api.exchangeHandoff).toHaveBeenCalledWith(
      "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
      expect.any(AbortSignal),
    ),
  );
  expect(await screen.findByText("Act 1 of 2")).toBeInTheDocument();
  expect(screen.getByText("Reconstruct the last move.")).toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "Progress merged from Telegram" }),
  ).not.toBeInTheDocument();
  expect(runtime.api.getDaily).toHaveBeenCalledTimes(2);
  expect(runtime.token.get()).toBe("t".repeat(43));

  act(() =>
    listeners[0]?.("amoveago-debug://auth?handoff=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"),
  );
  await waitFor(() => expect(runtime.api.exchangeHandoff).toHaveBeenCalledOnce());
  expect(runtime.api.getDaily).toHaveBeenCalledTimes(2);
});

it("bootstraps a replacement runtime before loading its daily state", async () => {
  const firstRuntime = runtimeFixture({ storedToken: "first-guest", platformKind: "web" });
  const secondRuntime = runtimeFixture({ storedToken: null, platformKind: "web" });
  const issued = deferred<{ token: string; expiresAt: string; kind: "guest" }>();
  const replacementDaily = {
    ...daily,
    id: "case-replacement-runtime",
    title: "Replacement runtime case",
  };
  firstRuntime.api.getDaily = vi.fn().mockResolvedValue(daily);
  secondRuntime.api.createGuest = vi.fn(() => issued.promise);
  secondRuntime.api.getDaily = vi.fn().mockResolvedValue(replacementDaily);
  const view = renderApp(firstRuntime);
  expect(await screen.findByText("Reconstruct the last move.")).toBeInTheDocument();
  expect(screen.getByText("Act 1 of 1")).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: puzzle.title })).not.toBeInTheDocument();

  view.rerender(
    <RuntimeProvider runtime={secondRuntime}>
      <App />
    </RuntimeProvider>,
  );
  await waitFor(() => expect(secondRuntime.api.createGuest).toHaveBeenCalledOnce());
  expect(secondRuntime.api.getDaily).not.toHaveBeenCalled();

  await act(async () => {
    issued.resolve({
      token: "g".repeat(43),
      expiresAt: "2026-11-01T00:00:00.000Z",
      kind: "guest",
    });
    await issued.promise;
  });
  expect(await screen.findByRole("heading", { name: replacementDaily.title })).toBeInTheDocument();
  expect(screen.getByText("Reconstruct the last move.")).toBeInTheDocument();
  expect(screen.getByText("Act 1 of 1")).toBeInTheDocument();
  expect(secondRuntime.api.getDaily).toHaveBeenCalledOnce();
});

it("renders fatal startup exclusively without game or loading content", async () => {
  const runtime = runtimeFixture({ storedToken: null, platformKind: "web" });
  runtime.api.createGuest = vi
    .fn()
    .mockRejectedValue(
      new ApiError(503, "UNAVAILABLE", "Guest service unavailable.", "req-fatal", null),
    );

  renderApp(runtime);

  expect(await screen.findByRole("alert")).toHaveTextContent("Guest service unavailable.");
  expect(
    screen.getByRole("heading", { level: 1, name: "Startup unavailable" }),
  ).toBeInTheDocument();
  expect(screen.getByText("req-fatal")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry startup" })).toBeInTheDocument();
  expect(screen.queryByText(/Loading today’s case/i)).not.toBeInTheDocument();
  expect(screen.queryByRole("grid")).not.toBeInTheDocument();
  expect(runtime.api.getDaily).not.toHaveBeenCalled();
  expect(runtime.platform.requestTelegramProof).not.toHaveBeenCalled();
});

it("fetches stats only after the player continues from the solved reveal", async () => {
  const user = userEvent.setup();
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  runtime.api.getDaily = vi.fn().mockResolvedValue(daily);
  runtime.api.submitAttempt = vi.fn().mockResolvedValue({
    id: "11111111-1111-4111-8111-111111111111",
    attemptUuid: "22222222-2222-4222-8222-222222222222",
    correct: true as const,
    reveal,
  });
  runtime.api.getStats = vi.fn().mockResolvedValue(stats);

  renderApp(runtime);
  await composeCapture(user);
  await user.click(screen.getByRole("button", { name: "Check move" }));

  expect(await screen.findByRole("status")).toHaveTextContent("Rewinding the last move");
  await waitFor(() => expect(runtime.platform.haptic).toHaveBeenCalledWith("success"));
  expect(runtime.api.getStats).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled(), {
    timeout: 3_000,
  });
  expect(screen.getByText(reveal.explanation, { exact: false })).toBeInTheDocument();
  expect(runtime.api.getStats).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(runtime.api.getStats).toHaveBeenCalledOnce());
  expect(screen.getByRole("heading", { level: 1, name: daily.title })).toBeInTheDocument();
  expect(await screen.findByRole("heading", { name: "Case complete" })).toBeInTheDocument();
});

it("requires a guest-session restart instead of retrying an expired attempt", async () => {
  const user = userEvent.setup();
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  runtime.api.getDaily = vi.fn().mockResolvedValue(daily);
  runtime.api.submitAttempt = vi
    .fn()
    .mockRejectedValue(new ApiError(401, "INVALID_SESSION", "Expired.", "req-attempt", null));

  renderApp(runtime);
  await composeCapture(user);
  await user.click(screen.getByRole("button", { name: "Check move" }));

  expect(await screen.findByRole("button", { name: "Restart guest session" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Retry attempt" })).not.toBeInTheDocument();
  expect(runtime.api.submitAttempt).toHaveBeenCalledOnce();
});

it("exposes attempt retry as an explicit UI action using the frozen request", async () => {
  const user = userEvent.setup();
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  runtime.api.getDaily = vi.fn().mockResolvedValue(daily);
  runtime.api.submitAttempt = vi
    .fn()
    .mockRejectedValueOnce(new ApiTransportError(new TypeError("offline")))
    .mockResolvedValueOnce(incorrectAttempt);

  renderApp(runtime);
  await composeCapture(user);
  await user.click(screen.getByRole("button", { name: "Check move" }));

  const retry = await screen.findByRole("button", { name: "Retry attempt" });
  expect(runtime.api.submitAttempt).toHaveBeenCalledOnce();
  await user.click(retry);
  expect(await screen.findByText("Try another move.")).toBeInTheDocument();

  const first = vi.mocked(runtime.api.submitAttempt).mock.calls[0]?.[0];
  const second = vi.mocked(runtime.api.submitAttempt).mock.calls[1]?.[0];
  expect(runtime.api.submitAttempt).toHaveBeenCalledTimes(2);
  expect(second).toBe(first);
  expect(first?.attemptUuid).toBe("22222222-2222-4222-8222-222222222222");
  await waitFor(() => expect(runtime.platform.haptic).toHaveBeenCalledWith("error"));
  expect(runtime.api.getStats).not.toHaveBeenCalled();
});

it("exposes hint retry as an explicit UI action using the same level", async () => {
  const user = userEvent.setup();
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  runtime.api.getDaily = vi.fn().mockResolvedValue(daily);
  runtime.api.submitAttempt = vi.fn().mockResolvedValue(incorrectAttempt);
  runtime.api.requestHint = vi
    .fn()
    .mockRejectedValueOnce(new ApiTransportError(new TypeError("offline")))
    .mockResolvedValueOnce({ level: 1, text: "A pawn changed files.", exhausted: false });

  renderApp(runtime);
  await composeCapture(user);
  await user.click(screen.getByRole("button", { name: "Check move" }));
  await user.click(await screen.findByRole("button", { name: "Get hint" }));

  const retry = await screen.findByRole("button", { name: "Retry hint" });
  expect(runtime.api.requestHint).toHaveBeenCalledOnce();
  await user.click(retry);

  expect(await screen.findByText("A pawn changed files.")).toBeInTheDocument();
  expect(
    vi.mocked(runtime.api.requestHint).mock.calls.map(([attemptId, level]) => [attemptId, level]),
  ).toEqual([
    ["11111111-1111-4111-8111-111111111111", 1],
    ["11111111-1111-4111-8111-111111111111", 1],
  ]);
  expect(runtime.api.getStats).not.toHaveBeenCalled();
});

it("requires an application reload instead of retrying an invalid hint response", async () => {
  const user = userEvent.setup();
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  runtime.api.getDaily = vi.fn().mockResolvedValue(daily);
  runtime.api.submitAttempt = vi.fn().mockResolvedValue(incorrectAttempt);
  runtime.api.requestHint = vi.fn().mockRejectedValue(new ApiContractError(new Error("invalid")));

  renderApp(runtime);
  await composeCapture(user);
  await user.click(screen.getByRole("button", { name: "Check move" }));
  await user.click(await screen.findByRole("button", { name: "Get hint" }));

  expect(await screen.findByRole("button", { name: "Reload application" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Retry hint" })).not.toBeInTheDocument();
  expect(runtime.api.requestHint).toHaveBeenCalledOnce();
});

it("advances acts on Continue and fetches stats after acknowledging the final reveal", async () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true })),
  );
  const user = userEvent.setup();
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  const secondPuzzle = { ...puzzle, id: "second-act", title: "The second act" };
  runtime.api.getDaily = vi.fn().mockResolvedValue({
    ...daily,
    puzzles: [puzzle, secondPuzzle],
  });
  runtime.api.submitAttempt = vi.fn(async (request) => ({
    id: crypto.randomUUID(),
    attemptUuid: request.attemptUuid,
    correct: true as const,
    reveal,
  }));
  runtime.api.getStats = vi.fn().mockResolvedValue(stats);

  renderApp(runtime);
  expect(await screen.findByText("Act 1 of 2")).toBeInTheDocument();
  expect(screen.getByText("Reconstruct the last move.")).toBeInTheDocument();
  await composeCapture(user);
  await user.click(screen.getByRole("button", { name: "Check move" }));

  expect(await screen.findByRole("heading", { name: "Solved" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: secondPuzzle.title })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByText("Act 2 of 2")).toBeInTheDocument();
  expect(screen.getByText("Reconstruct the last move.")).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: secondPuzzle.title })).not.toBeInTheDocument();
  expect(runtime.api.getStats).not.toHaveBeenCalled();

  await composeCapture(user);
  await user.click(screen.getByRole("button", { name: "Check move" }));

  expect(await screen.findByRole("heading", { name: "Solved" })).toBeInTheDocument();
  expect(runtime.api.getStats).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByRole("heading", { name: "Case complete" })).toBeInTheDocument();
  await waitFor(() => expect(runtime.api.getStats).toHaveBeenCalledOnce());
  expect(
    vi.mocked(runtime.api.submitAttempt).mock.calls.map(([request]) => request.puzzleId),
  ).toEqual([puzzle.id, secondPuzzle.id]);
  expect(runtime.platform.haptic).toHaveBeenCalledTimes(2);
});

it("keeps deletion mounted through Telegram-to-guest success and refreshes identity data", async () => {
  const user = userEvent.setup();
  const storedToken = "t".repeat(43);
  const runtime = runtimeFixture({ storedToken, platformKind: "web" });
  const markerProfile = {
    telegramUserId: "42",
    displayName: "Deletion marker",
    username: null,
    avatarUrl: null,
  };
  const guestDaily = { ...daily, title: "Guest case after deletion" };
  const emptyStats = {
    attempts: 0,
    hintsUsed: 0,
    solvedPuzzles: 0,
    completedCases: 0,
    currentStreak: 0,
    bestStreak: 0,
    lastCompletedDate: null,
  };
  runtime.api.getMe = vi.fn(async () => ({ kind: "telegram" as const, profile: markerProfile }));
  runtime.api.getDaily = vi.fn().mockResolvedValueOnce(daily).mockResolvedValueOnce(guestDaily);
  runtime.api.getStats = vi.fn().mockResolvedValueOnce(stats).mockResolvedValueOnce(emptyStats);
  const runtimeTokenSnapshot = runtime.token.get();
  const storedTokenSnapshot = await runtime.platform.tokenStore.read();

  renderApp(runtime);
  expect(await screen.findByText("Reconstruct the last move.")).toBeInTheDocument();
  expect(screen.getByText("Act 1 of 1")).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: puzzle.title })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Delete Telegram profile" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Progress" }));
  expect(await screen.findByText("Connected as Deletion marker")).toBeInTheDocument();
  await waitFor(() => expect(runtime.api.getStats).toHaveBeenCalledOnce());

  const opener = screen.getByRole("button", { name: "Delete Telegram profile" });
  await user.click(opener);
  expect(runtime.api.deleteProfile).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Delete permanently" }));
  await waitFor(() => expect(runtime.api.deleteProfile).toHaveBeenCalledOnce());

  const success = await screen.findByText(
    "Telegram profile deleted. You are now playing as a guest.",
  );
  expect(success).toHaveAttribute("role", "status");
  expect(success).toHaveFocus();
  expect(screen.getByText("Playing as a guest")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save progress with Telegram" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Delete Telegram profile" })).not.toBeInTheDocument();
  expect(screen.queryByText("Connected as Deletion marker")).not.toBeInTheDocument();

  await waitFor(() => expect(runtime.api.getStats).toHaveBeenCalledTimes(2));
  await waitFor(() => {
    expect(screen.getByText("Current streak").nextElementSibling).toHaveTextContent("0");
    expect(screen.getByText("Best streak").nextElementSibling).toHaveTextContent("0");
  });
  expect(runtime.token.get()).toBe(runtimeTokenSnapshot);
  expect(await runtime.platform.tokenStore.read()).toBe(storedTokenSnapshot);
  expect(runtime.platform.tokenStore.write).not.toHaveBeenCalled();
  expect(runtime.platform.tokenStore.clear).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "Back to case" }));
  expect(
    await screen.findByRole("heading", { level: 1, name: "Guest case after deletion" }),
  ).toBeInTheDocument();
  expect(runtime.api.getDaily).toHaveBeenCalledTimes(2);
});
