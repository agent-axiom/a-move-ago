import { expect, type Page } from "@playwright/test";

export function languageSelect(page: Page) {
  return page.locator(".app-menu-dialog .language-switcher select");
}

export async function openMenu(page: Page) {
  const menu = page.locator(".app-menu-dialog");
  if (!(await menu.isVisible())) await page.locator(".app-menu-trigger").click();
  await expect(menu).toBeVisible();
  return menu;
}

export async function closeMenu(page: Page) {
  await page.locator(".app-menu-close").click();
  await expect(page.locator(".app-menu-dialog")).toHaveCount(0);
}

export async function setLanguage(page: Page, locale: "en" | "ru" | "zh") {
  await openMenu(page);
  await languageSelect(page).selectOption(locale);
  await closeMenu(page);
}
