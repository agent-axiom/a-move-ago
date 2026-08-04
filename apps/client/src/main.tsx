import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createBrowserRuntime, RuntimeProvider } from "./app/runtime";
import "./styles/base.css";

async function main() {
  const element = document.getElementById("root");
  if (!element) throw new Error("Missing #root element");
  const runtime = await createBrowserRuntime(window);
  createRoot(element).render(
    <StrictMode>
      <RuntimeProvider runtime={runtime}>
        <App />
      </RuntimeProvider>
    </StrictMode>,
  );
}

void main().catch((error: unknown) => {
  const element = document.getElementById("root");
  if (element) {
    element.textContent = error instanceof Error ? error.message : "App startup failed.";
  }
});
