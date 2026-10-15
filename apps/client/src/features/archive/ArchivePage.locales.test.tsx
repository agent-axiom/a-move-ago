import type { ArchiveResponse } from "@a-move-ago/api-contract";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { RuntimeProvider } from "../../app/runtime";
import { I18nProvider, LanguageSwitcher, localeStorageKey } from "../../i18n";
import { runtimeFixture } from "../../test/runtime-fixture";
import { ArchivePage } from "./ArchivePage";

afterEach(() => {
  cleanup();
  localStorage.removeItem(localeStorageKey);
});

it("localizes archive titles, dates, progress and months without fetching again", async () => {
  const archive: ArchiveResponse = {
    today: "2026-10-15",
    startsOn: "2026-09-10",
    cases: [
      {
        id: "october",
        date: "2026-10-14",
        slug: "october",
        title: "October clue",
        puzzleCount: 1,
        solvedPuzzles: 0,
        completed: false,
      },
      {
        id: "september",
        date: "2026-09-10",
        slug: "september",
        title: "The first clue",
        puzzleCount: 2,
        solvedPuzzles: 1,
        completed: false,
        localizations: { ru: { title: "Первая зацепка" }, zh: { title: "第一条线索" } },
      },
    ],
  };
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  runtime.api.getArchive = vi.fn().mockResolvedValue(archive);
  const onSelect = vi.fn();
  const user = userEvent.setup();
  render(
    <RuntimeProvider runtime={runtime}>
      <I18nProvider>
        <LanguageSwitcher />
        <ArchivePage enabled onSelect={onSelect} onToday={vi.fn()} />
      </I18nProvider>
    </RuntimeProvider>,
  );
  await user.selectOptions(await screen.findByLabelText("Archive month"), "2026-09");
  await user.selectOptions(screen.getByLabelText("Language"), "ru");
  const russian = screen.getByRole("button", {
    name: /Открыть задачу за 10 сентября 2026.*Первая зацепка/,
  });
  expect(russian).toHaveAccessibleDescription("В процессе Решено 1 / 2");
  expect(screen.getByLabelText("Месяц архива")).toHaveValue("2026-09");
  expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("сентябрь");
  await user.selectOptions(screen.getByLabelText("Язык"), "zh");
  const chinese = screen.getByRole("button", { name: "打开 2026年9月10日 的谜题：第一条线索" });
  expect(chinese).toHaveAccessibleDescription("进行中 已解开 1 / 2");
  expect(screen.getByLabelText("档案月份")).toHaveValue("2026-09");
  await user.click(chinese);
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("2026-09-10");
  expect(runtime.api.getArchive).toHaveBeenCalledOnce();
});
