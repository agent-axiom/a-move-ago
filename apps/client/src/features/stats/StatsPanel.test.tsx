import { ApiContractError, ApiError } from "@a-move-ago/api-contract";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { RuntimeProvider } from "../../app/runtime";
import { runtimeFixture } from "../../test/runtime-fixture";
import { StatsPanel } from "./StatsPanel";

const stats = {
  attempts: 5,
  hintsUsed: 2,
  solvedPuzzles: 3,
  completedCases: 1,
  currentStreak: 1,
  bestStreak: 2,
  lastCompletedDate: "2026-08-03",
};

afterEach(cleanup);

it("renders refreshed statistics", async () => {
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  runtime.api.getStats = vi.fn().mockResolvedValue(stats);
  render(
    <RuntimeProvider runtime={runtime}>
      <StatsPanel title="Statistics" />
    </RuntimeProvider>,
  );

  expect(screen.getByRole("status")).toHaveTextContent("Updating statistics");
  expect(await screen.findByRole("heading", { name: "Statistics" })).toBeInTheDocument();
  expect(screen.getByText("Current streak").nextElementSibling).toHaveTextContent("1");
  expect(screen.getByText("Best streak").nextElementSibling).toHaveTextContent("2");
  expect(screen.getByText("Solved puzzles").nextElementSibling).toHaveTextContent("3");
  expect(screen.getByText("Hints used").nextElementSibling).toHaveTextContent("2");
});

it("requires a guest-session restart after an auth failure", async () => {
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  runtime.api.getStats = vi
    .fn()
    .mockRejectedValue(new ApiError(401, "INVALID_SESSION", "Expired.", "req-1", null));
  render(
    <RuntimeProvider runtime={runtime}>
      <StatsPanel />
    </RuntimeProvider>,
  );

  expect(await screen.findByRole("button", { name: "Restart guest session" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Retry statistics" })).not.toBeInTheDocument();
  expect(screen.getByText("req-1")).toBeInTheDocument();
});

it("offers an explicit retry after a retryable stats failure", async () => {
  const user = userEvent.setup();
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  runtime.api.getStats = vi
    .fn()
    .mockRejectedValueOnce(new ApiError(503, "UNAVAILABLE", "Later.", "req-2", null))
    .mockRejectedValueOnce(new ApiError(503, "UNAVAILABLE", "Later.", "req-2", null))
    .mockRejectedValueOnce(new ApiError(503, "UNAVAILABLE", "Later.", "req-2", null))
    .mockResolvedValueOnce(stats);
  render(
    <RuntimeProvider runtime={runtime}>
      <StatsPanel />
    </RuntimeProvider>,
  );

  const retry = await screen.findByRole("button", { name: "Retry statistics" });
  await user.click(retry);

  await waitFor(() => expect(runtime.api.getStats).toHaveBeenCalledTimes(4));
  expect(await screen.findByRole("heading", { name: "Case complete" })).toBeInTheDocument();
});

it("requires an application reload after a contract failure", async () => {
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  runtime.api.getStats = vi.fn().mockRejectedValue(new ApiContractError(new Error("invalid")));
  render(
    <RuntimeProvider runtime={runtime}>
      <StatsPanel />
    </RuntimeProvider>,
  );

  expect(await screen.findByRole("button", { name: "Reload application" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Retry statistics" })).not.toBeInTheDocument();
});
