import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  createLocalePreference,
  I18nProvider,
  LanguageSwitcher,
  localeStorageKey,
  localizedSystemMessage,
  localizedText,
  translate,
  useI18n,
} from ".";
import { gameMessages } from "./messages/game";
import { shellMessages } from "./messages/shell";

afterEach(() => {
  cleanup();
  localStorage.removeItem(localeStorageKey);
  vi.restoreAllMocks();
});

function Probe() {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  return (
    <>
      <LanguageSwitcher />
      <h1>{t("shell.archiveTitle")}</h1>
      <input
        aria-label="Draft"
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
      />
    </>
  );
}

it("starts in English regardless of the host language", () => {
  vi.spyOn(navigator, "language", "get").mockReturnValue("ru-RU");
  localStorage.removeItem(localeStorageKey);
  render(
    <I18nProvider>
      <Probe />
    </I18nProvider>,
  );
  expect(screen.getByLabelText("Language")).toHaveValue("en");
  expect(screen.getByRole("heading")).toHaveTextContent("The archive");
  expect(document.documentElement.lang).toBe("en");
});

it("switches all three languages, updates document language, and preserves child state", async () => {
  const user = userEvent.setup();
  render(
    <I18nProvider>
      <Probe />
    </I18nProvider>,
  );
  const draft = screen.getByLabelText("Draft");
  await user.type(draft, "keep this move");
  await user.selectOptions(screen.getByLabelText("Language"), "ru");
  expect(screen.getByRole("heading")).toHaveTextContent("Архив задач");
  expect(document.documentElement.lang).toBe("ru");
  expect(localStorage.getItem(localeStorageKey)).toBe("ru");
  expect(screen.getByLabelText("Draft")).toBe(draft);
  expect(draft).toHaveValue("keep this move");
  await user.selectOptions(screen.getByLabelText("Язык"), "zh");
  expect(screen.getByRole("heading")).toHaveTextContent("谜题档案");
  expect(document.documentElement.lang).toBe("zh-CN");
  expect(localStorage.getItem(localeStorageKey)).toBe("zh");
  await user.selectOptions(screen.getByLabelText("语言"), "en");
  expect(screen.getByRole("heading")).toHaveTextContent("The archive");
  expect(draft).toHaveValue("keep this move");
});

it("restores a saved language and ignores an invalid stored value", () => {
  localStorage.setItem(localeStorageKey, "zh");
  const view = render(
    <I18nProvider>
      <Probe />
    </I18nProvider>,
  );
  expect(screen.getByLabelText("语言")).toHaveValue("zh");
  view.unmount();
  localStorage.setItem(localeStorageKey, "unsupported");
  render(
    <I18nProvider>
      <Probe />
    </I18nProvider>,
  );
  expect(screen.getByLabelText("Language")).toHaveValue("en");
});

it("retains the running choice when storage getters or writes fail", () => {
  const denied = createLocalePreference(() => {
    throw new DOMException("Blocked", "SecurityError");
  });
  expect(denied.read()).toBe("en");
  denied.write("ru");
  expect(denied.read()).toBe("ru");
  const full = createLocalePreference(() => ({
    getItem: () => "en",
    setItem: () => {
      throw new DOMException("Full", "QuotaExceededError");
    },
  }));
  expect(full.read()).toBe("en");
  full.write("zh");
  expect(full.read()).toBe("zh");
});

it("uses Russian and Chinese plural rules and preserves parameter values", () => {
  expect(translate("en", "shell.discoveryDays", { count: 1 })).toBe("day of discovery");
  expect(translate("en", "shell.discoveryDays", { count: 2 })).toBe("days of discovery");
  expect(translate("ru", "shell.discoveryDays", { count: 1 })).toBe("день открытий");
  expect(translate("ru", "shell.discoveryDays", { count: 2 })).toBe("дня открытий");
  expect(translate("ru", "shell.discoveryDays", { count: 5 })).toBe("дней открытий");
  expect(translate("ru", "shell.discoveryDays", { count: 21 })).toBe("день открытий");
  expect(translate("zh", "shell.discoveryDays", { count: 1 })).toBe("天的探索");
  expect(translate("zh", "shell.discoveryDays", { count: 3 })).toBe("天的探索");
  expect(translate("ru", "shell.connectedAs", { name: "$& {name}" })).toBe(
    "Вы вошли как $& {name}",
  );
});

it("localizes authorized content with an English fallback for older responses", () => {
  const content = {
    title: "A clue",
    localizations: { ru: { title: "Зацепка" }, zh: { title: "线索" } },
  };
  expect(localizedText(content, "title", "ru")).toBe("Зацепка");
  expect(localizedText(content, "title", "zh")).toBe("线索");
  expect(localizedText(content, "title", "en")).toBe("A clue");
  expect(localizedText({ title: "A clue" }, "title", "ru")).toBe("A clue");
});

it("localizes session errors and uses a translated fallback for unknown server messages", () => {
  const ru = (key: Parameters<typeof translate>[1]) => translate("ru", key);
  const zh = (key: Parameters<typeof translate>[1]) => translate("zh", key);
  expect(
    localizedSystemMessage(
      "Telegram sign-in was cancelled. Guest progress is still available.",
      "ru",
      ru,
    ),
  ).toBe("Вход через Telegram отменён. Гостевой прогресс сохранён.");
  expect(localizedSystemMessage("Unknown service error", "zh", zh)).toBe("无法完成请求。请重试。");
  expect(localizedSystemMessage("Unknown service error", "en", ru)).toBe("Unknown service error");
});

it("provides every message and interpolation in all three dictionaries", () => {
  for (const catalog of [shellMessages, gameMessages]) {
    const englishKeys = Object.keys(catalog.en).sort();
    for (const locale of ["ru", "zh"] as const) {
      expect(Object.keys(catalog[locale]).sort()).toEqual(englishKeys);
      for (const key of englishKeys) {
        const source = (catalog.en as Record<string, unknown>)[key];
        const target = (catalog[locale] as Record<string, unknown>)[key];
        const values = typeof target === "string" ? [target] : Object.values(target as object);
        expect(values.every((value) => typeof value === "string" && value.trim().length > 0)).toBe(
          true,
        );
        if (typeof source === "string") {
          const parameters = (value: string) =>
            [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
          expect(parameters(String(target))).toEqual(parameters(source));
        }
      }
    }
  }
});
