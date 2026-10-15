import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../../App";
import { RuntimeProvider } from "../../app/runtime";
import { runtimeFixture } from "../../test/runtime-fixture";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

it("opens a published archive case in the running game and returns to today without losing the host fragment", async () => {
  window.history.replaceState(null, "", "/?keep=1#tgWebAppData=host-proof");
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  const today = await runtime.api.getDaily();
  runtime.api.getDaily = vi.fn(async (date) =>
    date
      ? {
          ...today,
          id: `case-${date}`,
          date,
          title: "A September mystery",
        }
      : today,
  );
  runtime.api.getArchive = vi.fn().mockResolvedValue({
    today: "2026-10-15",
    startsOn: "2026-09-10",
    cases: [
      {
        id: "september-case",
        date: "2026-09-10",
        slug: "september-case",
        title: "A September mystery",
        puzzleCount: 1,
        solvedPuzzles: 0,
        completed: false,
      },
    ],
  });
  const user = userEvent.setup();
  render(
    <RuntimeProvider runtime={runtime}>
      <App />
    </RuntimeProvider>,
  );
  await screen.findByRole("heading", { name: "The missing pawn", level: 1 });

  await user.click(screen.getByRole("button", { name: "Archive", exact: true }));
  await user.click(
    await screen.findByRole("button", {
      name: "Open case for 10 September 2026: A September mystery",
    }),
  );
  expect(
    await screen.findByRole("heading", { name: "A September mystery", level: 1 }),
  ).toBeInTheDocument();
  expect(runtime.api.getDaily).toHaveBeenLastCalledWith("2026-09-10", expect.any(AbortSignal));
  expect(new URL(window.location.href).searchParams.get("case")).toBe("2026-09-10");
  expect(window.location.hash).toBe("#tgWebAppData=host-proof");
  expect(runtime.api.createGuest).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "Back to today", exact: true }));
  await waitFor(() =>
    expect(runtime.api.getDaily).toHaveBeenLastCalledWith(undefined, expect.any(AbortSignal)),
  );
  expect(new URL(window.location.href).searchParams.get("case")).toBeNull();
  expect(new URL(window.location.href).searchParams.get("keep")).toBe("1");
  expect(window.location.hash).toBe("#tgWebAppData=host-proof");
});
