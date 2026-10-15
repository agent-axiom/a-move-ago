import { expect, test } from "@playwright/test";
import { installApiMock } from "./api-mock";

test("Telegram ready/layout/back work while identity waits for explicit consent", async ({
  page,
}) => {
  const observed = await installApiMock(page);
  await page.route("https://telegram.org/js/telegram-web-app.js?63", async (route) => {
    await route.fulfill({
      contentType: "application/javascript",
      body: `
        window.__tgReady = 0;
        window.__tgBack = null;
        window.Telegram = { WebApp: {
          platform: "android",
          initData: "query_id=raw%2Bproof&hash=unchanged",
          viewportStableHeight: 640,
          safeAreaInset: { top: 24, right: 0, bottom: 16, left: 0 },
          contentSafeAreaInset: { top: 48, right: 0, bottom: 20, left: 0 },
          ready() { window.__tgReady += 1; },
          openLink() {},
          BackButton: {
            show() {}, hide() {},
            onClick(handler) { window.__tgBack = handler; },
            offClick(handler) { if (window.__tgBack === handler) window.__tgBack = null; }
          },
          HapticFeedback: { selectionChanged() {}, notificationOccurred() {} },
          onEvent() {}, offEvent() {}
        }};
      `,
    });
  });
  await page.goto("./?case=2026-08-03#tgWebAppData=kept");
  await expect(page.getByRole("heading", { name: "Daily case" })).toBeVisible();
  expect(observed.guestChannels).toEqual(["telegram"]);
  expect(observed.miniAppProofs).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { __tgReady: number }).__tgReady)).toBe(1);
  expect(
    await page.evaluate(() =>
      document.documentElement.style.getPropertyValue("--host-content-safe-top"),
    ),
  ).toBe("48px");
  expect(
    await page.locator(".app-shell").evaluate((element) => {
      const style = window.getComputedStyle(element);
      return { minHeight: style.minHeight, paddingTop: style.paddingTop };
    }),
  ).toEqual({ minHeight: "640px", paddingTop: "48px" });

  await page.getByRole("button", { name: "Progress" }).click();
  await expect.poll(() => observed.statsRequests).toBe(1);
  await page.getByRole("button", { name: "Save progress with Telegram" }).click();
  await expect.poll(() => observed.miniAppProofs.length).toBe(1);
  await expect.poll(() => observed.statsRequests).toBe(2);
  expect(observed.miniAppProofs[0]).toBe("query_id=raw%2Bproof&hash=unchanged");
  await page.evaluate(() => (window as unknown as { __tgBack: null | (() => void) }).__tgBack?.());
  await expect(page.getByRole("heading", { name: "Daily case" })).toBeVisible();
  expect(new URL(page.url()).hash).toBe("#tgWebAppData=kept");
});
