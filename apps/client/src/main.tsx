import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createBrowserRuntime, RuntimeProvider } from "./app/runtime";
import { intlLocales, readPreferredLocale, translate } from "./i18n";
import "./styles/base.css";

const loadAndroid =
  import.meta.env.MODE === "android"
    ? async () => {
        const { createCapacitorAndroidAdapter } = await import("@a-move-ago/platform/android");
        return createCapacitorAndroidAdapter({
          apiOrigin: import.meta.env.VITE_API_BASE_URL,
          allowDebugScheme: import.meta.env.VITE_ANDROID_ALLOW_DEBUG_SCHEME === "true",
        });
      }
    : undefined;

async function main() {
  const element = document.getElementById("root");
  if (!element) throw new Error("Missing #root element");
  const runtime = await createBrowserRuntime(window, loadAndroid);
  createRoot(element).render(
    <StrictMode>
      <RuntimeProvider runtime={runtime}>
        <App />
      </RuntimeProvider>
    </StrictMode>,
  );
}

void main().catch(() => {
  const element = document.getElementById("root");
  if (element) {
    const locale = readPreferredLocale();
    document.documentElement.lang = intlLocales[locale];
    element.textContent = translate(locale, "shell.startupUnavailable");
  }
});
