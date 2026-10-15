import { useCallback, useEffect, useRef, useState } from "react";
import {
  initialNavigationFromUrl,
  isArchiveMonth,
  type NavigationEvent,
  type NavigationState,
  navigationReducer,
  navigationUrl,
  type Screen,
} from "./navigation";

const HISTORY_KEY = "aMoveAgoNavigation";

interface HistoryEntry {
  version: 1;
  chain: string;
  position: number;
  navigation: NavigationState;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isScreen(value: unknown): value is Screen {
  const screen = record(value);
  if (!screen) return false;
  switch (screen.name) {
    case "case":
      return screen.caseDate === undefined || typeof screen.caseDate === "string";
    case "archive":
      return screen.month === undefined || isArchiveMonth(screen.month);
    case "profile":
      return true;
    case "hint":
      return typeof screen.attemptId === "string";
    case "result":
      return typeof screen.puzzleId === "string";
    default:
      return false;
  }
}

function readEntry(value: unknown, url: URL): HistoryEntry | null {
  const entry = record(record(value)?.[HISTORY_KEY]);
  const navigation = record(entry?.navigation);
  if (
    !entry ||
    entry.version !== 1 ||
    typeof entry.chain !== "string" ||
    typeof entry.position !== "number" ||
    !Number.isSafeInteger(entry.position) ||
    entry.position < 0 ||
    !navigation ||
    !Array.isArray(navigation.stack) ||
    navigation.stack.length === 0 ||
    !navigation.stack.every(isScreen)
  ) {
    return null;
  }
  const snapshot = { stack: navigation.stack };
  if (navigationUrl(snapshot, url) !== navigationUrl(initialNavigationFromUrl(url), url)) {
    return null;
  }
  return {
    version: 1,
    chain: entry.chain,
    position: entry.position,
    navigation: snapshot,
  };
}

function newEntry(navigation: NavigationState): HistoryEntry {
  return { version: 1, chain: crypto.randomUUID(), position: 0, navigation };
}

function historyState(entry: HistoryEntry): Record<string, unknown> {
  return { ...record(window.history.state), [HISTORY_KEY]: entry };
}

export function useAppNavigation(): {
  navigation: NavigationState;
  dispatch: (event: NavigationEvent) => void;
} {
  const [navigation, setNavigation] = useState(() => {
    const url = new URL(window.location.href);
    return readEntry(window.history.state, url)?.navigation ?? initialNavigationFromUrl(url);
  });
  const navigationRef = useRef(navigation);
  const entryRef = useRef<HistoryEntry | null>(null);
  const backPendingRef = useRef(false);

  useEffect(() => {
    const url = new URL(window.location.href);
    const saved = readEntry(window.history.state, url);
    entryRef.current = saved ?? newEntry(navigationRef.current);
    if (!saved) window.history.replaceState(historyState(entryRef.current), "");

    const restore = (event: PopStateEvent) => {
      const source = new URL(window.location.href);
      const savedEntry = readEntry(event.state, source);
      const entry = savedEntry ?? newEntry(initialNavigationFromUrl(source));
      entryRef.current = entry;
      navigationRef.current = entry.navigation;
      backPendingRef.current = false;
      setNavigation(entry.navigation);
      if (!savedEntry) window.history.replaceState(historyState(entry), "");
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);

  const dispatch = useCallback((event: NavigationEvent) => {
    if (backPendingRef.current) return;
    const current = navigationRef.current;
    const entry = entryRef.current ?? newEntry(current);
    if (event.type === "back" && entry.position > 0) {
      backPendingRef.current = true;
      window.history.back();
      return;
    }
    const next = navigationReducer(current, event);
    if (next === current) return;
    const nextEntry: HistoryEntry = {
      ...entry,
      position: entry.position + (event.type === "push" ? 1 : 0),
      navigation: next,
    };
    const url = navigationUrl(next, new URL(window.location.href));
    if (event.type === "push") {
      window.history.pushState(historyState(nextEntry), "", url);
    } else {
      window.history.replaceState(historyState(nextEntry), "", url);
    }
    entryRef.current = nextEntry;
    navigationRef.current = next;
    setNavigation(next);
  }, []);

  return { navigation, dispatch };
}
