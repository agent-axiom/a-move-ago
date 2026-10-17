import { useEffect } from "react";
import type { NavigationEvent, NavigationState } from "./navigation";
import { useRuntime } from "./runtime";

export function useHostBack(
  navigation: NavigationState,
  dispatch: (event: NavigationEvent) => void,
  dismissOverlay?: () => void,
) {
  const { platform } = useRuntime();
  useEffect(() => {
    void platform.setBackHandler(
      dismissOverlay ?? (navigation.stack.length > 1 ? () => dispatch({ type: "back" }) : null),
    );
    return () => {
      void platform.setBackHandler(null);
    };
  }, [dismissOverlay, dispatch, navigation.stack.length, platform]);
}
