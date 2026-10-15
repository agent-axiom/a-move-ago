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

it.each([
  { locale: "en", label: "Archive month", title: "The first clue", since: /Since 10 September 2026/, completed: "0 completed" },
  { locale: "ru", label: "Месяц архива", title: "Первая зацепка", since: /С 10 сентября 2026/, completed: "0 решено" },
  { locale: "zh", label: "档案月份", title: "第一条线索", since: /始于 2026年9月10日/, completed: "已完成 0 道" },
])("shows the collection from September 10 in $locale, excluding legacy and future cases", async ({ locale, label, title, since, completed }) => {
  localStorage.setItem(localeStorageKey, locale);
  const first = {
    id: "first", date: "2026-09-10", slug: "first", title: "The first clue",
    puzzleCount: 1, solvedPuzzles: 0, completed: false,
    localizations: { ru: { title: "Первая зацепка" }, zh: { title: "第一条线索" } },
  };
  const archive: ArchiveResponse = {
    today: "2026-10-15",
    startsOn: "2026-08-03",
    cases: [
      { id: "legacy", date: "2026-08-03", slug: "legacy", title: "Legacy case", puzzleCount: 1, solvedPuzzles: 1, completed: true },
      { ...first, id: "before-launch", date: "2026-09-09", title: "Before launch", solvedPuzzles: 1, completed: true },
      first,
      { ...first, id: "future", date: "2026-11-01", title: "Future case" },
    ],
  };
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  runtime.api.getArchive = vi.fn().mockResolvedValue(archive);
  render(
    <RuntimeProvider runtime={runtime}>
      <I18nProvider>
        <ArchivePage enabled month="2026-08" onSelect={vi.fn()} onToday={vi.fn()} />
      </I18nProvider>
    </RuntimeProvider>,
  );
  expect(await screen.findByLabelText(label)).toHaveValue("2026-09");
  expect(screen.getByText(title)).toBeInTheDocument();
  expect(screen.getAllByRole("option")).toHaveLength(1);
  expect(screen.queryByText("Legacy case")).not.toBeInTheDocument();
  expect(screen.queryByText("Before launch")).not.toBeInTheDocument();
  expect(screen.queryByText("Future case")).not.toBeInTheDocument();
  expect(screen.getByText(since)).toBeInTheDocument();
  expect(screen.getByText(completed)).toBeInTheDocument();
  expect(document.querySelector(".archive-summary strong")).toHaveTextContent("1");
});
