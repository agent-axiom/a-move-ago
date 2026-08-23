import { ApiError } from "@a-move-ago/api-contract";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { parseEntryQuery, stripAuthReturn } from "../../app/entry-query";
import { type AppRuntime, useRuntime } from "../../app/runtime";
import {
  bootstrapSession,
  deleteProfile as deleteTelegramProfile,
  retryHandoff as exchangePendingHandoff,
  RetryableHandoffError,
  saveProgress,
  TelegramAuthDeniedError,
} from "./session-service";
import type { SessionState } from "./session-state";

interface SessionContextValue {
  state: SessionState;
  save(): Promise<void>;
  retryHandoff(): Promise<void>;
  deleteProfile(): Promise<boolean>;
}

interface ActionSlot {
  controller: AbortController;
  lifecycle: number;
  runtime: AppRuntime;
}

const SessionContext = createContext<SessionContextValue | null>(null);

function authReturnKey(source: URL): string {
  const { handoff, authError } = parseEntryQuery(source);
  if (authError) return `auth-error:${authError}`;
  if (handoff) return `handoff:${handoff}`;
  if (source.searchParams.has("handoff") || source.searchParams.has("authError")) {
    return "invalid-auth-return";
  }
  return "bootstrap";
}

function sessionFailure(error: unknown, setState: (state: SessionState) => void): void {
  if (error instanceof TelegramAuthDeniedError) {
    setState({ tag: "auth-error", me: error.me, message: error.message });
    return;
  }
  if (error instanceof RetryableHandoffError) {
    setState({
      tag: "handoff-retry",
      me: { kind: "guest", profile: null },
      handoffCode: error.pending.handoffCode,
      message: error.message,
    });
    return;
  }
  const apiError = error instanceof ApiError ? error : null;
  if (apiError?.status === 401) {
    setState({
      tag: "auth-error",
      me: { kind: "guest", profile: null },
      message: "Telegram return expired or was already consumed. Start Save progress again.",
      requestId: apiError.requestId,
    });
    return;
  }
  setState({
    tag: "fatal",
    message: apiError?.message ?? "Could not start a guest session.",
    ...(apiError ? { requestId: apiError.requestId } : {}),
  });
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const runtime = useRuntime();
  const [state, setState] = useState<SessionState>({ tag: "booting" });
  const lifecycleRef = useRef(0);
  const actionRef = useRef<ActionSlot | null>(null);
  const sessionWorkLifecycleRef = useRef<number | null>(null);
  const handledReturnKeysRef = useRef(new Set<string>());
  const handledRuntimeRef = useRef(runtime);
  const hasTelegramIdentityRef = useRef(false);
  const currentRuntimeRef = useRef(runtime);
  const currentStateRef = useRef(state);
  const providerMountedRef = useRef(false);
  currentRuntimeRef.current = runtime;
  currentStateRef.current = state;

  useEffect(() => {
    providerMountedRef.current = true;
    if (handledRuntimeRef.current !== runtime) {
      handledRuntimeRef.current = runtime;
      handledReturnKeysRef.current.clear();
      hasTelegramIdentityRef.current = false;
      setState({ tag: "booting" });
    }
    const lifecycle = lifecycleRef.current + 1;
    lifecycleRef.current = lifecycle;
    sessionWorkLifecycleRef.current = lifecycle;
    const controller = new AbortController();
    const pendingKeys = new Set<string>();
    let acceptedAuthReturn = false;
    let disposed = false;
    let setupPending = true;
    let unsubscribe: () => void = () => undefined;
    let queue = Promise.resolve();

    const active = () => !controller.signal.aborted && lifecycleRef.current === lifecycle;
    const releaseSessionWork = () => {
      if (
        sessionWorkLifecycleRef.current === lifecycle &&
        !setupPending &&
        pendingKeys.size === 0
      ) {
        sessionWorkLifecycleRef.current = null;
      }
    };

    function schedule(rawUrl: string) {
      if (!active()) return;
      let source: URL;
      try {
        source = new URL(rawUrl, window.location.href);
      } catch (error) {
        if (active()) sessionFailure(error, setState);
        return;
      }
      const key = authReturnKey(source);
      const browser = new URL(window.location.href);
      const sameDocument = source.origin === browser.origin && source.pathname === browser.pathname;
      if (
        sameDocument &&
        (source.searchParams.has("handoff") || source.searchParams.has("authError"))
      ) {
        window.history.replaceState(null, "", stripAuthReturn(source));
      }
      if (hasTelegramIdentityRef.current) return;
      if (pendingKeys.has(key) || handledReturnKeysRef.current.has(key)) return;
      actionRef.current?.controller.abort();
      actionRef.current = null;
      sessionWorkLifecycleRef.current = lifecycle;
      if (key !== "bootstrap") {
        acceptedAuthReturn = true;
      }
      pendingKeys.add(key);
      queue = queue.then(async () => {
        try {
          if (!active() || hasTelegramIdentityRef.current) return;
          const me = await bootstrapSession(
            runtime,
            source,
            (url) => {
              if (sameDocument) window.history.replaceState(null, "", url);
            },
            controller.signal,
          );
          if (!active()) return;
          hasTelegramIdentityRef.current = me.kind === "telegram";
          handledReturnKeysRef.current.add(key);
          setState({ tag: "ready", me });
        } catch (error) {
          if (!active()) return;
          handledReturnKeysRef.current.add(key);
          sessionFailure(error, setState);
        } finally {
          pendingKeys.delete(key);
          releaseSessionWork();
        }
      });
    }

    void (async () => {
      const stop = await runtime.platform.authReturn.subscribe(schedule);
      if (disposed) {
        stop();
        return;
      }
      unsubscribe = stop;
      const initial = await runtime.platform.authReturn.initialUrl();
      if (!disposed && !acceptedAuthReturn) schedule(initial ?? window.location.href);
    })()
      .catch((error: unknown) => {
        if (active()) sessionFailure(error, setState);
      })
      .finally(() => {
        setupPending = false;
        releaseSessionWork();
      });

    return () => {
      providerMountedRef.current = false;
      disposed = true;
      controller.abort();
      if (sessionWorkLifecycleRef.current === lifecycle) {
        sessionWorkLifecycleRef.current = null;
      }
      const action = actionRef.current;
      if (action?.lifecycle === lifecycle) {
        action.controller.abort();
        actionRef.current = null;
      }
      unsubscribe();
    };
  }, [runtime]);

  const value = useMemo<SessionContextValue>(() => {
    function beginAction(): ActionSlot | null {
      if (
        !providerMountedRef.current ||
        handledRuntimeRef.current !== runtime ||
        currentRuntimeRef.current !== runtime ||
        currentStateRef.current !== state ||
        actionRef.current ||
        sessionWorkLifecycleRef.current !== null
      ) {
        return null;
      }
      const action = {
        controller: new AbortController(),
        lifecycle: lifecycleRef.current,
        runtime,
      };
      actionRef.current = action;
      return action;
    }

    function actionIsCurrent(action: ActionSlot): boolean {
      return (
        actionRef.current === action &&
        !action.controller.signal.aborted &&
        lifecycleRef.current === action.lifecycle &&
        providerMountedRef.current &&
        currentRuntimeRef.current === action.runtime
      );
    }

    function finishAction(action: ActionSlot): void {
      if (actionRef.current === action) actionRef.current = null;
    }

    return {
      state,
      async save() {
        if (state.tag !== "ready" && state.tag !== "auth-error") return;
        const action = beginAction();
        if (!action) return;
        handledReturnKeysRef.current.delete("auth-error:access_denied");
        handledReturnKeysRef.current.delete("invalid-auth-return");
        const previous = state.me;
        setState({ tag: "authenticating", me: previous });
        try {
          const me = await saveProgress(runtime, action.controller.signal);
          if (actionIsCurrent(action)) {
            const next = me ?? previous;
            hasTelegramIdentityRef.current = next.kind === "telegram";
            setState({ tag: "ready", me: next });
          }
        } catch (error) {
          if (!actionIsCurrent(action)) return;
          const apiError = error instanceof ApiError ? error : null;
          setState({
            tag: "auth-error",
            me: previous,
            message: apiError?.message ?? "Telegram sign-in did not finish.",
            ...(apiError ? { requestId: apiError.requestId } : {}),
          });
        } finally {
          finishAction(action);
        }
      },
      async retryHandoff() {
        if (state.tag !== "handoff-retry") return;
        const action = beginAction();
        if (!action) return;
        const handoffCode = state.handoffCode;
        setState({ tag: "authenticating", me: state.me });
        try {
          const me = await exchangePendingHandoff(
            runtime,
            { handoffCode },
            action.controller.signal,
          );
          if (actionIsCurrent(action)) {
            hasTelegramIdentityRef.current = true;
            setState({ tag: "ready", me });
          }
        } catch (error) {
          if (!actionIsCurrent(action)) return;
          if (error instanceof RetryableHandoffError) {
            setState({
              tag: "handoff-retry",
              me: { kind: "guest", profile: null },
              handoffCode,
              message: error.message,
            });
            return;
          }
          const apiError = error instanceof ApiError ? error : null;
          setState({
            tag: "auth-error",
            me: { kind: "guest", profile: null },
            message: "Telegram return expired or was already consumed. Start Save progress again.",
            ...(apiError ? { requestId: apiError.requestId } : {}),
          });
        } finally {
          finishAction(action);
        }
      },
      async deleteProfile() {
        if (state.tag !== "ready" || state.me.kind !== "telegram") return false;
        const action = beginAction();
        if (!action) return false;
        try {
          const me = await deleteTelegramProfile(runtime, action.controller.signal);
          if (!actionIsCurrent(action)) return false;
          hasTelegramIdentityRef.current = false;
          setState({ tag: "ready", me });
          return true;
        } catch (error) {
          if (!actionIsCurrent(action)) return false;
          throw error;
        } finally {
          finishAction(action);
        }
      },
    };
  }, [runtime, state]);

  return <SessionContext value={value}>{children}</SessionContext>;
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("SessionProvider is missing.");
  return value;
}
