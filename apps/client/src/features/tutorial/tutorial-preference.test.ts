import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  completeTutorial,
  dismissTutorialInvitation,
  shouldOfferTutorial,
  tutorialPreferenceKey,
} from "./tutorial-preference";

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());

it("remembers dismissal and completion across later visits", () => {
  expect(shouldOfferTutorial()).toBe(true);
  dismissTutorialInvitation();
  expect(shouldOfferTutorial()).toBe(false);
  expect(window.localStorage.getItem(tutorialPreferenceKey)).toBe("dismissed");
  completeTutorial();
  dismissTutorialInvitation();
  expect(window.localStorage.getItem(tutorialPreferenceKey)).toBe("completed");
  expect(shouldOfferTutorial()).toBe(false);
});

it("ignores a malformed saved preference", () => {
  window.localStorage.setItem(tutorialPreferenceKey, "null");
  expect(shouldOfferTutorial()).toBe(true);
});

it("keeps the lesson available when browser storage is blocked", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new DOMException("Storage denied", "SecurityError");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Storage denied", "SecurityError");
  });
  expect(shouldOfferTutorial()).toBe(true);
  expect(dismissTutorialInvitation).not.toThrow();
  expect(completeTutorial).not.toThrow();
});
