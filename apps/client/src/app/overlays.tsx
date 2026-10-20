import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

type Dismiss = () => void;
interface Overlay {
  id: symbol;
  dismiss: Dismiss;
}
interface OverlayContextValue {
  register(dismiss: Dismiss): () => void;
  dismiss: Dismiss | undefined;
}

const OverlayContext = createContext<OverlayContextValue>({
  register: () => () => {},
  dismiss: undefined,
});

export function OverlayProvider({ children }: { children: ReactNode }) {
  const [overlays, setOverlays] = useState<Overlay[]>([]);
  const register = useCallback((dismiss: Dismiss) => {
    const id = Symbol("overlay");
    setOverlays((current) => [...current, { id, dismiss }]);
    return () => setOverlays((current) => current.filter((overlay) => overlay.id !== id));
  }, []);
  const dismiss = overlays.at(-1)?.dismiss;
  const value = useMemo(() => ({ register, dismiss }), [register, dismiss]);
  return <OverlayContext value={value}>{children}</OverlayContext>;
}

/** Route native Back to the topmost overlay without changing the current puzzle. */
export function useOverlayDismiss(dismiss: Dismiss, active = true) {
  const { register } = useContext(OverlayContext);
  useEffect(() => (active ? register(dismiss) : undefined), [active, dismiss, register]);
}

export function useActiveOverlayDismiss() {
  return useContext(OverlayContext).dismiss;
}
