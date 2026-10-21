import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { gameMessages } from "./messages/game";
import { shellMessages } from "./messages/shell";

export type Locale = "en" | "ru" | "zh";
export const intlLocales: Record<Locale, string> = { en: "en", ru: "ru", zh: "zh-CN" };
export const localeStorageKey = "a-move-ago.locale";
const messages = {
  en: { ...shellMessages.en, ...gameMessages.en },
  ru: { ...shellMessages.ru, ...gameMessages.ru },
  zh: { ...shellMessages.zh, ...gameMessages.zh },
};
export type TranslationKey = keyof typeof messages.en;
export type TranslationParams = Readonly<Record<string, string | number>>;
export type Translate = (key: TranslationKey, params?: TranslationParams) => string;

type LocaleStorage = Pick<Storage, "getItem" | "setItem">;
export function isLocale(value: unknown): value is Locale {
  return value === "en" || value === "ru" || value === "zh";
}

// A blocked or full storage area must not prevent changing language in the running app.
export function createLocalePreference(
  getStorage: () => LocaleStorage | null = () =>
    typeof window === "undefined" ? null : window.localStorage,
) {
  let memory: Locale = "en";
  let persistenceFailed = false;
  return {
    read(): Locale {
      if (persistenceFailed) return memory;
      try {
        const storage = getStorage();
        if (!storage) return memory;
        const value = storage.getItem(localeStorageKey);
        memory = isLocale(value) ? value : "en";
      } catch {
        persistenceFailed = true;
        // Keep the choice in memory when the host denies storage access.
      }
      return memory;
    },
    write(locale: Locale): void {
      memory = locale;
      try {
        const storage = getStorage();
        if (!storage) {
          persistenceFailed = true;
          return;
        }
        storage.setItem(localeStorageKey, locale);
        persistenceFailed = false;
      } catch {
        persistenceFailed = true;
        // The selected language remains active even if persistence is unavailable.
      }
    },
  };
}

const browserPreference = createLocalePreference();

export function readPreferredLocale(): Locale {
  return browserPreference.read();
}

export function translate(
  locale: Locale,
  key: TranslationKey,
  params: TranslationParams = {},
): string {
  const value = messages[locale][key] ?? messages.en[key];
  let template: string;
  if (typeof value === "string") {
    template = value;
  } else {
    const category = new Intl.PluralRules(intlLocales[locale]).select(Number(params.count ?? 0));
    const forms = value as Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };
    template = forms[category] ?? forms.other;
  }
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    params[name] === undefined ? placeholder : String(params[name]),
  );
}

interface I18nContextValue {
  locale: Locale;
  intlLocale: string;
  setLocale(locale: Locale): void;
  t: Translate;
}

// Standalone components and existing consumers retain the English default.
const I18nContext = createContext<I18nContextValue>({
  locale: "en",
  intlLocale: "en",
  setLocale: () => undefined,
  t: (key, params) => translate("en", key, params),
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, updateLocale] = useState<Locale>(() => browserPreference.read());
  const setLocale = useCallback((next: Locale) => {
    browserPreference.write(next);
    updateLocale(next);
  }, []);
  useEffect(() => {
    document.documentElement.lang = intlLocales[locale];
  }, [locale]);
  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      intlLocale: intlLocales[locale],
      setLocale,
      t: (key, params) => translate(locale, key, params),
    }),
    [locale, setLocale],
  );
  return <I18nContext value={value}>{children}</I18nContext>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

/** Localizations accompany public or already-authorized content; English is always the fallback. */
export function localizedText<T, K extends keyof T>(object: T, field: K, locale: Locale): T[K] {
  const localized = object as T & {
    localizations?: Partial<Record<Locale, Partial<Record<K, T[K]>>>>;
  };
  return (
    (locale !== "en" ? localized.localizations?.[locale]?.[field] : undefined) ?? object[field]
  );
}

export function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();
  return (
    <label className="language-switcher">
      <span>{t("shell.language")}</span>
      <select
        aria-label={t("shell.language")}
        value={locale}
        onChange={(event) => {
          const next = event.currentTarget.value;
          if (isLocale(next)) setLocale(next);
        }}
      >
        <option value="en" lang="en">
          English
        </option>
        <option value="ru" lang="ru">
          Русский
        </option>
        <option value="zh" lang="zh-CN">
          中文
        </option>
      </select>
    </label>
  );
}

const systemMessages: Readonly<Record<string, TranslationKey>> = {
  "Telegram profile deletion could not be confirmed. Retry to check the current profile state.":
    "shell.deleteUnconfirmed",
  "Profile deletion could not be confirmed because this app session is no longer active. Reload, then choose Save progress with Telegram to verify the profile.":
    "shell.inactiveSession",
  "Telegram return expired or was already consumed. Start Save progress again.":
    "shell.telegramExpired",
  "Could not start a guest session.": "shell.guestStartupFailed",
  "Telegram sign-in did not finish.": "shell.telegramIncomplete",
  "Telegram sign-in could not be exchanged. Retry when the connection recovers.":
    "shell.telegramRetry",
  "Telegram sign-in was cancelled. Guest progress is still available.": "shell.telegramCancelled",
};

const systemErrorCodes = new Map<string, TranslationKey>([
  ["TELEGRAM_PROOF_EXPIRED", "shell.telegramMiniAppExpired"],
  ["TELEGRAM_PROOF_INVALID", "shell.telegramMiniAppInvalid"],
  ["RATE_LIMITED", "shell.dailyRateLimit"],
]);

export function localizedSystemMessage(
  message: string,
  locale: Locale,
  t: Translate,
  errorCode?: string,
): string {
  const key = systemErrorCodes.get(errorCode ?? "") ?? systemMessages[message];
  return key ? t(key) : locale === "en" ? message : t("shell.operationFailed");
}
