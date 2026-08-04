import { useEffect } from "react";
import type { NavigationEvent, NavigationState } from "./navigation";
import { useRuntime } from "./runtime";

export function useHostBack(
  navigation: NavigationState,
  dispatch: (event: NavigationEvent) => void,
) {
  const { platform } = useRuntime();
  useEffect(() => {
    void platform.setBackHandler(
      navigation.stack.length > 1 ? () => dispatch({ type: "back" }) : null,
    );
    return () => {
      void platform.setBackHandler(null);
    };
  }, [dispatch, navigation.stack.length, platform]);
}
