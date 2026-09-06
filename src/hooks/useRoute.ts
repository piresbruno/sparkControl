import { useEffect, useCallback, useRef, useState } from "react";
import { OVERVIEW_ID, ANALYSIS_ID, MODELS_ID } from "../constants";

export type RouteMode = "app" | "showcase";

export interface AppRoute {
  mode: RouteMode;
  /** Spark id for showcase mode */
  showcaseSparkId: string | null;
}

function parsePath(pathname: string): AppRoute {
  const showcase = pathname.match(/^\/showcase\/([^/]+)/);
  if (showcase) {
    return {
      mode: "showcase",
      showcaseSparkId: decodeURIComponent(showcase[1]),
    };
  }
  return { mode: "app", showcaseSparkId: null };
}

/**
 * Parse the current URL for showcase vs normal app shell.
 * Call once at App root so showcase skips the dashboard chrome.
 */
export function useAppRoute(): AppRoute {
  const [route, setRoute] = useState(() => parsePath(window.location.pathname));

  useEffect(() => {
    const handler = () => setRoute(parsePath(window.location.pathname));
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  return route;
}

/**
 * Resolve the active view id from a URL path.
 *   /                  → Overview
 *   /analysis[?query]  → Analysis (query kept for ?spark=&port= init)
 *   /models            → Models
 *   /spark/:id         → Spark detail page
 *   anything else      → null (caller decides; popstate defaults to Overview)
 */
export function activeIdFromPath(path: string): string | null {
  if (path === "/analysis" || path.startsWith("/analysis?") || path.startsWith("/analysis/")) {
    return ANALYSIS_ID;
  }
  if (path === "/models" || path.startsWith("/models?") || path.startsWith("/models/")) {
    return MODELS_ID;
  }
  const match = path.match(/^\/spark\/([^/]+)/);
  if (match) return decodeURIComponent(match[1]);
  if (path === "/" || path === "") return OVERVIEW_ID;
  return null;
}

/**
 * useRoute — syncs the browser URL path with the active spark ID.
 *
 * URL scheme:
 *   /             → Overview
 *   /analysis     → Analysis page (sentinel id; query params allowed)
 *   /models       → Models page (sentinel id)
 *   /spark/:id    → Spark detail page
 *   /showcase/:id → full-screen showcase (handled separately via useAppRoute)
 *
 * Call `navigate(id)` to switch views — it updates both the URL and
 * the internal activeId state. Back/forward buttons work via popstate.
 */
export function useRoute(
  setActiveId: (id: string | null) => void
): (id: string | null) => void {
  // Read initial activeId from the URL on mount
  const initialised = useRef(false);

  useEffect(() => {
    if (initialised.current) return;
    initialised.current = true;

    const path = window.location.pathname;
    if (path.startsWith("/showcase/")) return;

    const resolved = activeIdFromPath(path);
    if (resolved != null) {
      setActiveId(resolved);
    } else if (path !== "/spark") {
      setActiveId(OVERVIEW_ID);
    }
  }, [setActiveId]);

  // Sync back/forward navigation
  useEffect(() => {
    const handler = () => {
      const path = window.location.pathname;
      if (path.startsWith("/showcase/")) return;
      const resolved = activeIdFromPath(path);
      setActiveId(resolved ?? OVERVIEW_ID);
    };
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, [setActiveId]);

  // Wrapped navigate function — updates URL + internal state
  const navigate = useCallback(
    (id: string | null) => {
      let url = "/";
      if (id && id !== OVERVIEW_ID) {
        if (id === ANALYSIS_ID) url = "/analysis";
        else if (id === MODELS_ID) url = "/models";
        else url = `/spark/${encodeURIComponent(id)}`;
      }
      window.history.pushState(null, "", url);
      setActiveId(id);
    },
    [setActiveId]
  );

  return navigate;
}
