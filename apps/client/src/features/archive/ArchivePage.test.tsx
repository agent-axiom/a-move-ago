import type { ArchiveResponse } from "@a-move-ago/api-contract";
import { ApiError } from "@a-move-ago/api-contract";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { RuntimeProvider } from "../../app/runtime";
import { runtimeFixture } from "../../test/runtime-fixture";
import { ArchivePage } from "./ArchivePage";

const archive = {
  today: "2026-10-15",
  startsOn: "2026-09-10",
  cases: [
    {
      id: "october-case",
      date: "2026-10-14",
      slug: "october-case",
      title: "An unfinished story",
      puzzleCount: 2,
      solvedPuzzles: 1,
      completed: false,
    },
    {
      id: "september-complete",
      date: "2026-09-11",
      slug: "september-complete",
      title: "The familiar knight",
      puzzleCount: 1,
      solvedPuzzles: 1,
      completed: true,
    },
    {
      id: "september-start",
      date: "2026-09-10",
      slug: "september-start",
      title: "The first mystery",
      puzzleCount: 1,
      solvedPuzzles: 0,
      completed: false,
    },
  ],
} satisfies ArchiveResponse;

afterEach(cleanup);

function setup() {
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  const onSelect = vi.fn();
  const onToday = vi.fn();
  runtime.api.getArchive = vi.fn().mockResolvedValue(archive);
  render(
    <RuntimeProvider runtime={runtime}>
      <ArchivePage enabled onSelect={onSelect} onToday={onToday} />
    </RuntimeProvider>,
  );
  return { runtime, onSelect, onToday };
}

it("browses only published case dates and exposes completion and exact date selection", async () => {
  const user = userEvent.setup();
  const { runtime, onSelect } = setup();
  const october = await screen.findByRole("button", {
    name: "Open case for 14 October 2026: An unfinished story",
  });
  expect(october).toHaveAccessibleDescription("In progress 1 / 2 solved");
  expect(screen.getByText("3")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /15 October 2026/ })).not.toBeInTheDocument();

  await user.selectOptions(screen.getByLabelText("Archive month"), "2026-09");
  const first = screen.getByRole("button", {
    name: "Open case for 10 September 2026: The first mystery",
  });
  expect(screen.getByRole("button", { name: /11 September 2026/ })).toHaveAccessibleDescription(
    "✓ Completed 1 / 1 solved",
  );
  expect(screen.queryByRole("button", { name: /12 September 2026/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /14 October 2026/ })).not.toBeInTheDocument();
  first.focus();
  await user.keyboard("{Enter}");

  expect(onSelect).toHaveBeenCalledExactlyOnceWith("2026-09-10");
  expect(runtime.api.getDaily).not.toHaveBeenCalled();
  expect(runtime.api.getArchive).toHaveBeenCalledOnce();
});

it("keeps an empty catalog honest and offers today's case", async () => {
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  const onToday = vi.fn();
  runtime.api.getArchive = vi.fn().mockResolvedValue({
    today: "2026-10-15",
    startsOn: null,
    cases: [],
  });
  const user = userEvent.setup();
  render(
    <RuntimeProvider runtime={runtime}>
      <ArchivePage enabled onSelect={vi.fn()} onToday={onToday} />
    </RuntimeProvider>,
  );

  expect(await screen.findByText("The collection is just beginning.")).toBeInTheDocument();
  expect(screen.queryByLabelText("Archive month")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Back to today" }));
  expect(onToday).toHaveBeenCalledOnce();
});

it("retries a failed catalog without discarding the user's session", async () => {
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  runtime.api.getArchive = vi
    .fn()
    .mockRejectedValueOnce(
      new ApiError(400, "ARCHIVE_UNAVAILABLE", "Unavailable.", "archive-1", null),
    )
    .mockResolvedValueOnce(archive);
  const user = userEvent.setup();
  render(
    <RuntimeProvider runtime={runtime}>
      <ArchivePage enabled onSelect={vi.fn()} onToday={vi.fn()} />
    </RuntimeProvider>,
  );

  expect(await screen.findByRole("alert")).toHaveTextContent("We couldn’t load the collection");
  await user.click(screen.getByRole("button", { name: "Retry archive" }));
  expect(await screen.findByLabelText("Archive month")).toBeInTheDocument();
  expect(runtime.api.getArchive).toHaveBeenCalledTimes(2);
  expect(runtime.api.createGuest).not.toHaveBeenCalled();
  expect(runtime.token.get()).toBe("guest-token");
});

it("refreshes after a suspended day change while preserving the selected month", async () => {
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  let now = Date.parse("2026-10-15T20:00:00Z");
  runtime.now = () => now;
  runtime.api.getArchive = vi
    .fn()
    .mockResolvedValueOnce(archive)
    .mockResolvedValueOnce({
      ...archive,
      today: "2026-10-16",
      cases: [
        {
          id: "new-day",
          date: "2026-10-16",
          slug: "new-day",
          title: "A fresh perspective",
          puzzleCount: 1,
          solvedPuzzles: 0,
          completed: false,
        },
        ...archive.cases,
      ],
    });
  const user = userEvent.setup();
  render(
    <RuntimeProvider runtime={runtime}>
      <ArchivePage enabled onSelect={vi.fn()} onToday={vi.fn()} />
    </RuntimeProvider>,
  );
  await screen.findByLabelText("Archive month");
  await user.selectOptions(screen.getByLabelText("Archive month"), "2026-09");
  now = Date.parse("2026-10-16T09:00:00Z");
  act(() => window.dispatchEvent(new Event("focus")));

  await waitFor(() => expect(screen.getByLabelText("Archive month")).toHaveValue("2026-09"));
  expect(runtime.api.getArchive).toHaveBeenCalledTimes(2);
  await user.selectOptions(screen.getByLabelText("Archive month"), "2026-10");
  expect(screen.getByRole("button", { name: /16 October 2026/ })).toBeInTheDocument();
  expect(screen.getByText("Today")).toBeInTheDocument();
});
