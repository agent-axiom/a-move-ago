import { ApiContractError, ApiError } from "@a-move-ago/api-contract";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { RuntimeProvider } from "../../app/runtime";
import { runtimeFixture } from "../../test/runtime-fixture";
import { DailyCaseGate } from "./DailyCaseGate";
import { useDailyCase } from "./use-daily-case";

const daily = {
  id: "case-2026-08-03",
  date: "2026-08-03",
  title: "The missing pawn",
  puzzles: [
    {
      id: "opening-exd5",
      version: 1,
      title: "A pawn vanished",
      prompt: "What happened one move ago?",
      postFen: "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2",
      retractingColor: "w" as const,
      maxHints: 2,
      provenance: "A MOVE AGO sample",
      license: "CC BY 4.0",
    },
  ],
  solvedPuzzleIds: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function DailyProbe(props: { enabled: boolean; caseDate: string | null }) {
  const { state } = useDailyCase(props.enabled, props.caseDate);
  return <output>{state.tag === "ready" ? state.daily.id : state.tag}</output>;
}

afterEach(cleanup);

it("does not request daily content until a session is ready", async () => {
  const runtime = runtimeFixture({ storedToken: null, platformKind: "web" });
  runtime.api.getDaily = vi.fn().mockResolvedValue(daily);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <RuntimeProvider runtime={runtime}>{children}</RuntimeProvider>
  );
  const { rerender, result } = renderHook(({ enabled }) => useDailyCase(enabled, "2026-08-03"), {
    initialProps: { enabled: false },
    wrapper,
  });
  expect(result.current.state.tag).toBe("idle");
  expect(runtime.api.getDaily).not.toHaveBeenCalled();

  rerender({ enabled: true });
  await waitFor(() => expect(result.current.state.tag).toBe("ready"));
  expect(runtime.api.getDaily).toHaveBeenCalledWith("2026-08-03", expect.any(AbortSignal));
  expect(JSON.stringify(daily)).not.toContain("acceptedSolutions");
  expect(JSON.stringify(daily)).not.toContain("previousFen");
});

it("ignores an older response after the requested case date changes", async () => {
  const runtime = runtimeFixture({ storedToken: null, platformKind: "web" });
  const older = deferred<typeof daily>();
  const newer = deferred<typeof daily>();
  const nextDaily = {
    ...daily,
    id: "case-2026-08-04",
    date: "2026-08-04",
    title: "The next case",
  };
  let olderSignal: AbortSignal | undefined;
  runtime.api.getDaily = vi
    .fn()
    .mockImplementationOnce((_date, signal: AbortSignal) => {
      olderSignal = signal;
      return older.promise;
    })
    .mockImplementationOnce(() => newer.promise);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <RuntimeProvider runtime={runtime}>{children}</RuntimeProvider>
  );
  const { rerender, result } = renderHook(({ caseDate }) => useDailyCase(true, caseDate), {
    initialProps: { caseDate: "2026-08-03" },
    wrapper,
  });
  await waitFor(() => expect(runtime.api.getDaily).toHaveBeenCalledTimes(1));

  rerender({ caseDate: "2026-08-04" });
  await waitFor(() => expect(runtime.api.getDaily).toHaveBeenCalledTimes(2));
  expect(olderSignal?.aborted).toBe(true);

  await act(async () => newer.resolve(nextDaily));
  await waitFor(() => {
    expect(result.current.state).toMatchObject({
      tag: "ready",
      daily: { id: "case-2026-08-04" },
    });
  });

  await act(async () => older.resolve(daily));
  expect(result.current.state).toMatchObject({
    tag: "ready",
    daily: { id: "case-2026-08-04" },
  });
});

it("ignores a response from a replaced runtime", async () => {
  const olderRuntime = runtimeFixture({ storedToken: null, platformKind: "web" });
  const newerRuntime = runtimeFixture({ storedToken: null, platformKind: "web" });
  const older = deferred<typeof daily>();
  const nextDaily = {
    ...daily,
    id: "case-new-runtime",
    title: "The replacement case",
  };
  let olderSignal: AbortSignal | undefined;
  olderRuntime.api.getDaily = vi.fn((_date, signal: AbortSignal) => {
    olderSignal = signal;
    return older.promise;
  });
  newerRuntime.api.getDaily = vi.fn().mockResolvedValue(nextDaily);
  const view = render(
    <RuntimeProvider runtime={olderRuntime}>
      <DailyProbe enabled caseDate="2026-08-03" />
    </RuntimeProvider>,
  );
  await waitFor(() => expect(olderRuntime.api.getDaily).toHaveBeenCalledTimes(1));

  view.rerender(
    <RuntimeProvider runtime={newerRuntime}>
      <DailyProbe enabled caseDate="2026-08-03" />
    </RuntimeProvider>,
  );
  await screen.findByText("case-new-runtime");
  expect(olderSignal?.aborted).toBe(true);

  await act(async () => older.resolve(daily));
  expect(screen.getByText("case-new-runtime")).toBeInTheDocument();
});

it("offers an explicit retry after a daily case load failure", async () => {
  const user = userEvent.setup();
  const runtime = runtimeFixture({ storedToken: null, platformKind: "web" });
  runtime.api.getDaily = vi
    .fn()
    .mockRejectedValueOnce(new ApiError(404, "DAILY_NOT_FOUND", "Missing.", "req-9", null))
    .mockResolvedValueOnce(daily);
  render(
    <RuntimeProvider runtime={runtime}>
      <DailyCaseGate enabled caseDate="2026-08-03">
        {(loadedDaily) => <h1>{loadedDaily.title}</h1>}
      </DailyCaseGate>
    </RuntimeProvider>,
  );

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "There is no published case for this date.",
  );
  expect(screen.getByText(/Request ID:/)).toHaveTextContent("req-9");
  await user.click(screen.getByRole("button", { name: "Retry case" }));

  expect(await screen.findByRole("heading", { name: daily.title })).toBeInTheDocument();
  expect(runtime.api.getDaily).toHaveBeenCalledTimes(2);
});

it("offers a session restart instead of retrying with an expired token", async () => {
  const runtime = runtimeFixture({ storedToken: "expired-token", platformKind: "web" });
  runtime.api.getDaily = vi
    .fn()
    .mockRejectedValue(new ApiError(401, "INVALID_SESSION", "Expired.", "req-auth", null));
  render(
    <RuntimeProvider runtime={runtime}>
      <DailyCaseGate enabled caseDate="2026-08-03">
        {(loadedDaily) => <h1>{loadedDaily.title}</h1>}
      </DailyCaseGate>
    </RuntimeProvider>,
  );

  expect(await screen.findByRole("alert")).toHaveTextContent("guest session expired");
  expect(screen.getByRole("button", { name: "Restart guest session" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Retry case" })).not.toBeInTheDocument();
  expect(runtime.api.getDaily).toHaveBeenCalledOnce();
});

it("offers an application reload and page heading after a contract failure", async () => {
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  runtime.api.getDaily = vi.fn().mockRejectedValue(new ApiContractError(new Error("invalid")));
  render(
    <RuntimeProvider runtime={runtime}>
      <DailyCaseGate enabled caseDate="2026-08-03">
        {(loadedDaily) => <h1>{loadedDaily.title}</h1>}
      </DailyCaseGate>
    </RuntimeProvider>,
  );

  expect(
    await screen.findByRole("heading", { level: 1, name: "Case unavailable" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reload application" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Retry case" })).not.toBeInTheDocument();
  expect(runtime.api.getDaily).toHaveBeenCalledOnce();
});
