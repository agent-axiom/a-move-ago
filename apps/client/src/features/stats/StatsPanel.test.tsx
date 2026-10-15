import { ApiContractError, ApiError } from "@a-move-ago/api-contract";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { RuntimeProvider } from "../../app/runtime";
import { I18nProvider, LanguageSwitcher, localeStorageKey } from "../../i18n";
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

afterEach(() => {
  cleanup();
  localStorage.removeItem(localeStorageKey);
});

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


it("shows the personal rating returned by the service and the scoring rules", async () => {
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  runtime.api.getStats = vi.fn().mockResolvedValue({ ...stats, points: 140 });
  render(
    <RuntimeProvider runtime={runtime}>
      <StatsPanel title="Statistics" />
    </RuntimeProvider>,
  );

  const rating = await screen.findByRole("region", { name: "Personal rating" });
  expect(within(rating).getByText("140")).toBeInTheDocument();
  expect(within(rating).getByText("points")).toBeInTheDocument();
  expect(within(rating).getByText("1st try")).toBeInTheDocument();
  expect(within(rating).getByText("4th try or later")).toBeInTheDocument();
  for (const award of ["100", "70", "40", "20"]) {
    expect(within(rating).getByText(award)).toBeInTheDocument();
  }
  expect(rating).toHaveTextContent("Each revealed clue or hint halves the points, rounded down to a minimum of 1.");
  expect(runtime.api.getStats).toHaveBeenCalledOnce();
});

it("keeps earlier solves visible while showing their unrated zero honestly", async () => {
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  runtime.api.getStats = vi.fn().mockResolvedValue({ ...stats, points: 0 });
  render(
    <RuntimeProvider runtime={runtime}>
      <StatsPanel />
    </RuntimeProvider>,
  );

  const rating = await screen.findByRole("region", { name: "Personal rating" });
  expect(within(rating).getByText("0")).toBeInTheDocument();
  expect(rating).toHaveTextContent("New solves earn points. Earlier progress stays in your history.");
  expect(screen.getByText("Solved puzzles").nextElementSibling).toHaveTextContent("3");
});

it("keeps older statistics responses usable without inventing a rating", async () => {
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  runtime.api.getStats = vi.fn().mockResolvedValue(stats);
  render(
    <RuntimeProvider runtime={runtime}>
      <StatsPanel title="Statistics" />
    </RuntimeProvider>,
  );

  await screen.findByRole("heading", { name: "Statistics" });
  expect(screen.queryByRole("region", { name: "Personal rating" })).not.toBeInTheDocument();
  expect(screen.getByText("Solved puzzles").nextElementSibling).toHaveTextContent("3");
});

it("switches the personal rating, point plurals and scoring copy without fetching again", async () => {
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  runtime.api.getStats = vi.fn().mockResolvedValue({ ...stats, points: 21 });
  const user = userEvent.setup();
  render(
    <RuntimeProvider runtime={runtime}>
      <I18nProvider>
        <LanguageSwitcher />
        <StatsPanel />
      </I18nProvider>
    </RuntimeProvider>,
  );

  await screen.findByRole("region", { name: "Personal rating" });
  await user.selectOptions(screen.getByLabelText("Language"), "ru");
  const russian = screen.getByRole("region", { name: "Личный рейтинг" });
  expect(within(russian).getByText("21")).toBeInTheDocument();
  expect(within(russian).getByText("балл")).toBeInTheDocument();
  expect(russian).toHaveTextContent("Каждая открытая улика или подсказка уменьшает баллы вдвое");
  await user.selectOptions(screen.getByLabelText("Язык"), "zh");
  const chinese = screen.getByRole("region", { name: "个人评分" });
  expect(within(chinese).getByText("21")).toBeInTheDocument();
  expect(within(chinese).getByText("分")).toBeInTheDocument();
  expect(chinese).toHaveTextContent("每揭示一条线索或提示，得分减半");
  await user.selectOptions(screen.getByLabelText("语言"), "en");
  expect(screen.getByRole("region", { name: "Personal rating" })).toHaveTextContent("21 points");
  expect(runtime.api.getStats).toHaveBeenCalledOnce();
});
