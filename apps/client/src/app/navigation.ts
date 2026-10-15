import { parseEntryQuery } from "./entry-query";

export type Screen =
  | { name: "case"; caseDate?: string }
  | { name: "archive"; month?: string }
  | { name: "hint"; attemptId: string }
  | { name: "profile" }
  | { name: "result"; puzzleId: string };

export interface NavigationState {
  stack: readonly Screen[];
}

export type NavigationEvent =
  | { type: "push"; screen: Screen }
  | { type: "replace"; screen: Screen }
  | { type: "back" }
  | { type: "reset"; screen: Screen }
  | { type: "restore"; state: NavigationState };

export function initialNavigation(caseDate: string | null): NavigationState {
  return { stack: [{ name: "case", ...(caseDate ? { caseDate } : {}) }] };
}

export function isArchiveMonth(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

export function initialNavigationFromUrl(url: URL): NavigationState {
  const views = url.searchParams.getAll("view");
  const view = views.length === 1 ? views[0] : null;
  const months = url.searchParams.getAll("month");
  const month = months.length === 1 && isArchiveMonth(months[0]) ? months[0] : null;
  const { caseDate } = parseEntryQuery(url);
  const screen: Screen =
    view === "archive"
      ? { name: "archive", ...(month ? { month } : {}) }
      : view === "profile"
        ? { name: "profile" }
        : { name: "case", ...(caseDate ? { caseDate } : {}) };
  return {
    stack: screen.name === "case" && !screen.caseDate ? [screen] : [{ name: "case" }, screen],
  };
}

export function navigationUrl(state: NavigationState, source: URL): string {
  const url = new URL(source);
  const route = state.stack.findLast(
    (screen) => screen.name === "case" || screen.name === "archive" || screen.name === "profile",
  );
  url.searchParams.delete("case");
  url.searchParams.delete("view");
  url.searchParams.delete("month");
  if (route?.name === "case" && route.caseDate) {
    url.searchParams.set("case", route.caseDate);
  } else if (route?.name === "archive" || route?.name === "profile") {
    url.searchParams.set("view", route.name);
    if (route.name === "archive" && route.month) url.searchParams.set("month", route.month);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function navigationReducer(state: NavigationState, event: NavigationEvent): NavigationState {
  switch (event.type) {
    case "push":
      return { stack: [...state.stack, event.screen] };
    case "replace":
      return { stack: [...state.stack.slice(0, -1), event.screen] };
    case "back":
      return state.stack.length > 1 ? { stack: state.stack.slice(0, -1) } : state;
    case "reset":
      return { stack: [event.screen] };
    case "restore":
      return event.state.stack.length > 0 ? event.state : initialNavigation(null);
  }
}
