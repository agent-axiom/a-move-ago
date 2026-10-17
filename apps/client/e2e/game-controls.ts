import type { Page } from "@playwright/test";

const captureLabels = {
  en: { disclosure: "Capture or special move", captured: "Captured piece" },
  ru: { disclosure: "Взятие или особый ход", captured: "Взятая фигура" },
  zh: { disclosure: "吃子或特殊走法", captured: "被吃的棋子" },
};

export async function selectCapturedPiece(
  page: Page,
  piece: string,
  locale: keyof typeof captureLabels = "en",
) {
  const labels = captureLabels[locale];
  const capture = page.getByLabel(labels.captured, { exact: true });
  if (!(await capture.isVisible())) {
    await page.getByText(labels.disclosure, { exact: true }).click();
  }
  await capture.selectOption(piece);
}
