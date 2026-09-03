import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  type AppRoute,
  type ConfigRoute,
  type HomeRoute,
  isSettingsHostRoute,
  parseHashRoute,
  routeToHash,
  type SettingsHostRoute,
  sameHostRoute,
  type WorkRoute,
  withoutSettings,
  withSettings,
} from "../router";

type NavigationMarker = { kind: "settings"; baseHash: string } | { kind: "config"; returnToHash: string };

interface EasyResearchHistoryState {
  easyresearchNavigation?: NavigationMarker;
  [key: string]: unknown;
}

export interface SettingsCloseGuard {
  shouldBlock(): boolean;
  requestClose(): void;
}

export interface HashRouter {
  route: AppRoute;
  navigate(next: AppRoute): void;
  openSettings(host: HomeRoute | WorkRoute): void;
  closeSettings(settings: SettingsHostRoute, options?: { replace?: boolean }): void;
  openConfig(returnTo: SettingsHostRoute): void;
  returnToSettings(config: ConfigRoute): void;
  registerSettingsCloseGuard(guard: SettingsCloseGuard): () => void;
}

interface PendingSettingsRestore {
  route: SettingsHostRoute;
  guard: SettingsCloseGuard;
}

function routeFromLocation(): AppRoute {
  return parseHashRoute(window.location.hash) ?? { page: "home" };
}

function historyStateRecord(state: unknown): EasyResearchHistoryState {
  return state !== null && typeof state === "object" && !Array.isArray(state)
    ? (state as EasyResearchHistoryState)
    : {};
}

function withMarker(state: unknown, marker: NavigationMarker): EasyResearchHistoryState {
  return { ...historyStateRecord(state), easyresearchNavigation: marker };
}

function clearMarker(state: unknown): EasyResearchHistoryState {
  const next = { ...historyStateRecord(state) };
  delete next.easyresearchNavigation;
  return next;
}

function readMarker(state: unknown): NavigationMarker | null {
  const marker = historyStateRecord(state).easyresearchNavigation;
  if (!marker || typeof marker !== "object") return null;
  if (marker.kind === "settings" && typeof marker.baseHash === "string") return marker;
  if (marker.kind === "config" && typeof marker.returnToHash === "string") return marker;
  return null;
}

function settingsMarker(route: SettingsHostRoute): Extract<NavigationMarker, { kind: "settings" }> {
  return { kind: "settings", baseHash: routeToHash(withoutSettings(route)) };
}

function hasSettingsMarker(route: SettingsHostRoute): boolean {
  const marker = readMarker(window.history.state);
  return marker?.kind === "settings" && marker.baseHash === routeToHash(withoutSettings(route));
}

function pushSettings(route: SettingsHostRoute): void {
  window.history.pushState(withMarker(window.history.state, settingsMarker(route)), "", routeToHash(route));
}

function replaceWithSettings(route: SettingsHostRoute): void {
  const baseHash = routeToHash(withoutSettings(route));
  window.history.replaceState(clearMarker(window.history.state), "", baseHash);
  window.history.pushState(withMarker(window.history.state, settingsMarker(route)), "", routeToHash(route));
}

function sameRoute(a: AppRoute, b: AppRoute): boolean {
  return routeToHash(a) === routeToHash(b);
}

/**
 * React binding for the hash router (ADR-076/099). Settings and Config use
 * marked history entries so Back can restore the exact underlying host while
 * ordinary route navigation remains hash-backed and refresh-safe.
 */
export function useHashRoute(): HashRouter {
  const [route, setRoute] = useState<AppRoute>(routeFromLocation);
  const routeRef = useRef(route);
  const closeGuardRef = useRef<SettingsCloseGuard | null>(null);
  const pendingSettingsRestoreRef = useRef<PendingSettingsRestore | null>(null);
  routeRef.current = route;

  const publishRoute = useCallback((next: AppRoute) => {
    routeRef.current = next;
    setRoute((current) => (sameRoute(current, next) ? current : next));
  }, []);

  useLayoutEffect(() => {
    if (!isSettingsHostRoute(route)) return;
    if (window.location.hash === routeToHash(route) && hasSettingsMarker(route)) return;
    replaceWithSettings(route);
  }, [route]);

  useEffect(() => {
    const onLocationChange = (event: Event) => {
      const pending = pendingSettingsRestoreRef.current;
      if (pending) {
        if (window.location.hash === routeToHash(pending.route) && hasSettingsMarker(pending.route)) {
          pendingSettingsRestoreRef.current = null;
          publishRoute(pending.route);
          pending.guard.requestClose();
        }
        return;
      }

      const current = routeRef.current;
      const next = routeFromLocation();
      const guard = closeGuardRef.current;

      if (isSettingsHostRoute(current) && window.location.hash !== routeToHash(current) && guard?.shouldBlock()) {
        const base = withoutSettings(current);
        const baseHash = routeToHash(base);
        if (window.location.hash === baseHash && next.page !== "config" && sameHostRoute(base, next)) {
          pushSettings(current);
          guard.requestClose();
          return;
        }

        const marker = readMarker(window.history.state);
        const matchingConfigForward =
          next.page === "config" && marker?.kind === "config" && marker.returnToHash === routeToHash(current);
        if (matchingConfigForward || event.type === "hashchange") {
          pendingSettingsRestoreRef.current = { route: current, guard };
          window.history.back();
          return;
        }

        replaceWithSettings(current);
        guard.requestClose();
        return;
      }

      publishRoute(next);
    };

    window.addEventListener("hashchange", onLocationChange);
    window.addEventListener("popstate", onLocationChange);
    return () => {
      pendingSettingsRestoreRef.current = null;
      window.removeEventListener("hashchange", onLocationChange);
      window.removeEventListener("popstate", onLocationChange);
    };
  }, [publishRoute]);

  const navigate = useCallback(
    (next: AppRoute) => {
      const hash = routeToHash(next);
      if (window.location.hash === hash) return;
      window.history.pushState(clearMarker(window.history.state), "", hash);
      publishRoute(next);
    },
    [publishRoute],
  );

  const openSettings = useCallback(
    (host: HomeRoute | WorkRoute) => {
      const base = withoutSettings(host);
      const baseHash = routeToHash(base);
      const settings = withSettings(base);
      if (window.location.hash === routeToHash(settings)) {
        if (!hasSettingsMarker(settings)) replaceWithSettings(settings);
      } else {
        if (window.location.hash !== baseHash) {
          window.history.replaceState(clearMarker(window.history.state), "", baseHash);
        }
        pushSettings(settings);
      }
      publishRoute(settings);
    },
    [publishRoute],
  );

  const closeSettings = useCallback(
    (settings: SettingsHostRoute, options: { replace?: boolean } = {}) => {
      if (options.replace) {
        const base = withoutSettings(settings);
        window.history.replaceState(clearMarker(window.history.state), "", routeToHash(base));
        publishRoute(base);
        return;
      }
      if (window.location.hash === routeToHash(settings) && hasSettingsMarker(settings)) {
        window.history.back();
        return;
      }

      const base = withoutSettings(settings);
      window.history.replaceState(clearMarker(window.history.state), "", routeToHash(base));
      publishRoute(base);
    },
    [publishRoute],
  );

  const openConfig = useCallback(
    (returnTo: SettingsHostRoute) => {
      const config: ConfigRoute = { page: "config", returnTo };
      const returnToHash = routeToHash(returnTo);
      window.history.pushState(
        withMarker(window.history.state, { kind: "config", returnToHash }),
        "",
        routeToHash(config),
      );
      publishRoute(config);
    },
    [publishRoute],
  );

  const returnToSettings = useCallback(
    (config: ConfigRoute) => {
      const marker = readMarker(window.history.state);
      const returnToHash = config.returnTo ? routeToHash(config.returnTo) : null;
      if (
        config.returnTo &&
        window.location.hash === routeToHash(config) &&
        marker?.kind === "config" &&
        marker.returnToHash === returnToHash
      ) {
        window.history.back();
        return;
      }

      const target: SettingsHostRoute = config.returnTo ?? { page: "home", settingsOpen: true };
      replaceWithSettings(target);
      publishRoute(target);
    },
    [publishRoute],
  );

  const registerSettingsCloseGuard = useCallback((guard: SettingsCloseGuard) => {
    closeGuardRef.current = guard;
    return () => {
      if (closeGuardRef.current === guard) closeGuardRef.current = null;
    };
  }, []);

  return {
    route,
    navigate,
    openSettings,
    closeSettings,
    openConfig,
    returnToSettings,
    registerSettingsCloseGuard,
  };
}
