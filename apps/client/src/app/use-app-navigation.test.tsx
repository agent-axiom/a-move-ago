import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppNavigation } from "./use-app-navigation";

beforeEach(() => {
  window.history.replaceState(null, "", "/a-move-ago/");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("browser navigation", () => {
  it("initializes a deep link once under StrictMode without adding a history entry", () => {
    window.history.replaceState({ foreign: "kept" }, "", "/a-move-ago/?view=archive");
    const push = vi.spyOn(window.history, "pushState");
    const replace = vi.spyOn(window.history, "replaceState");
    const length = window.history.length;
    const { result } = renderHook(() => useAppNavigation(), { wrapper: StrictMode });

    expect(result.current.navigation.stack).toEqual([{ name: "case" }, { name: "archive" }]);
    expect(window.history.length).toBe(length);
    expect(push).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledOnce();
    expect(window.history.state).toMatchObject({ foreign: "kept" });
  });

  it("restores archive and dated case screens through browser back and forward", async () => {
    window.history.replaceState(
      null,
      "",
      "/a-move-ago/?campaign=summer&handoff=raw%2Bproof#tgWebAppData=kept%2Braw",
    );
    const { result } = renderHook(() => useAppNavigation());
    act(() => result.current.dispatch({ type: "push", screen: { name: "archive" } }));
    expect(window.location.search).toContain("view=archive");
    act(() =>
      result.current.dispatch({
        type: "replace",
        screen: { name: "archive", month: "2026-09" },
      }),
    );
    expect(new URL(window.location.href).searchParams.get("month")).toBe("2026-09");
    act(() =>
      result.current.dispatch({
        type: "push",
        screen: { name: "case", caseDate: "2026-08-03" },
      }),
    );
    act(() => result.current.dispatch({ type: "push", screen: { name: "profile" } }));
    expect(new URL(window.location.href).searchParams.get("view")).toBe("profile");
    expect(new URL(window.location.href).searchParams.has("case")).toBe(false);
    expect(new URL(window.location.href).searchParams.has("month")).toBe(false);
    expect(window.location.hash).toBe("#tgWebAppData=kept%2Braw");
    expect(new URL(window.location.href).searchParams.get("campaign")).toBe("summer");
    expect(new URL(window.location.href).searchParams.get("handoff")).toBe("raw+proof");

    act(() => window.history.back());
    await waitFor(() =>
      expect(result.current.navigation.stack).toEqual([
        { name: "case" },
        { name: "archive", month: "2026-09" },
        { name: "case", caseDate: "2026-08-03" },
      ]),
    );
    expect(new URL(window.location.href).searchParams.get("case")).toBe("2026-08-03");
    act(() => window.history.back());
    await waitFor(() =>
      expect(result.current.navigation.stack.at(-1)).toEqual({
        name: "archive",
        month: "2026-09",
      }),
    );
    expect(new URL(window.location.href).searchParams.get("view")).toBe("archive");
    expect(new URL(window.location.href).searchParams.get("month")).toBe("2026-09");
    act(() => window.history.forward());
    await waitFor(() =>
      expect(result.current.navigation.stack.at(-1)).toEqual({
        name: "case",
        caseDate: "2026-08-03",
      }),
    );
  });

  it("uses browser history for host Back and ignores a second Back until restoration", async () => {
    const { result } = renderHook(() => useAppNavigation());
    act(() => result.current.dispatch({ type: "push", screen: { name: "archive" } }));
    act(() => result.current.dispatch({ type: "push", screen: { name: "profile" } }));
    const back = vi.spyOn(window.history, "back");

    act(() => {
      result.current.dispatch({ type: "back" });
      result.current.dispatch({ type: "back" });
    });
    expect(back).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(result.current.navigation.stack.at(-1)).toEqual({ name: "archive" }),
    );
    expect(new URL(window.location.href).searchParams.get("view")).toBe("archive");
  });

  it.each(["?view=archive", "?case=2026-08-03", "?view=profile"])(
    "returns from deep link %s to today without leaving the app",
    (query) => {
      window.history.replaceState(null, "", `/a-move-ago/${query}&campaign=summer#kept`);
      const back = vi.spyOn(window.history, "back");
      const { result } = renderHook(() => useAppNavigation());

      act(() => result.current.dispatch({ type: "back" }));

      expect(back).not.toHaveBeenCalled();
      expect(result.current.navigation.stack).toEqual([{ name: "case" }]);
      expect(window.location.pathname + window.location.search + window.location.hash).toBe(
        "/a-move-ago/?campaign=summer#kept",
      );
    },
  );

  it("replaces and resets the current browser entry", () => {
    const { result } = renderHook(() => useAppNavigation());
    act(() => result.current.dispatch({ type: "push", screen: { name: "archive" } }));
    const length = window.history.length;
    act(() =>
      result.current.dispatch({
        type: "replace",
        screen: { name: "case", caseDate: "2026-08-03" },
      }),
    );
    expect(result.current.navigation.stack).toEqual([
      { name: "case" },
      { name: "case", caseDate: "2026-08-03" },
    ]);
    expect(new URL(window.location.href).searchParams.get("case")).toBe("2026-08-03");
    act(() => result.current.dispatch({ type: "reset", screen: { name: "case" } }));
    expect(result.current.navigation.stack).toEqual([{ name: "case" }]);
    expect(window.location.search).toBe("");
    expect(window.history.length).toBe(length);
  });

  it("restores a saved stack after remount", () => {
    const mounted = renderHook(() => useAppNavigation());
    act(() => mounted.result.current.dispatch({ type: "push", screen: { name: "archive" } }));
    act(() =>
      mounted.result.current.dispatch({
        type: "push",
        screen: { name: "case", caseDate: "2026-08-03" },
      }),
    );
    mounted.unmount();
    const { result } = renderHook(() => useAppNavigation());

    expect(result.current.navigation.stack).toEqual([
      { name: "case" },
      { name: "archive" },
      { name: "case", caseDate: "2026-08-03" },
    ]);
  });

  it("parses an unmarked popstate URL and keeps foreign history state", () => {
    const { result } = renderHook(() => useAppNavigation());
    act(() => result.current.dispatch({ type: "push", screen: { name: "profile" } }));

    act(() => {
      window.history.replaceState({ foreign: "kept" }, "", "/a-move-ago/?case=2024-02-29#kept");
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    });

    expect(result.current.navigation.stack).toEqual([
      { name: "case" },
      { name: "case", caseDate: "2024-02-29" },
    ]);
    expect(window.history.state).toMatchObject({ foreign: "kept" });
    expect(window.location.hash).toBe("#kept");
  });

  it("ignores a saved snapshot that disagrees with the actual URL", () => {
    const mounted = renderHook(() => useAppNavigation());
    act(() => mounted.result.current.dispatch({ type: "push", screen: { name: "archive" } }));
    mounted.unmount();
    window.history.replaceState(window.history.state, "", "/a-move-ago/?case=2026-08-03");

    const { result } = renderHook(() => useAppNavigation());
    expect(result.current.navigation.stack).toEqual([
      { name: "case" },
      { name: "case", caseDate: "2026-08-03" },
    ]);
  });
});
