export type Screen =
  | { name: "case"; caseDate?: string }
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
  | { type: "reset"; screen: Screen };

export function initialNavigation(caseDate: string | null): NavigationState {
  return { stack: [{ name: "case", ...(caseDate ? { caseDate } : {}) }] };
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
  }
}
