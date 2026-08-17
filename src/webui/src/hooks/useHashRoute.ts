import { useCallback, useEffect, useState } from "react";
import { type AppRoute, parseHashRoute, routeToHash } from "../router";

function routeFromLocation(): AppRoute {
  return parseHashRoute(window.location.hash) ?? { page: "home" };
}

/**
 * React binding for the hash router (ADR-076). The current route mirrors
 * `location.hash`; navigating to the already-current hash is a no-op so
 * repeated Home clicks never push duplicate history or reset the scroll.
 */
export function useHashRoute(): {
  route: AppRoute;
  navigate: (route: AppRoute) => void;
} {
  const [route, setRoute] = useState<AppRoute>(routeFromLocation);

  useEffect(() => {
    const onHashChange = () => setRoute(routeFromLocation());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = useCallback((next: AppRoute) => {
    const hash = routeToHash(next);
    if (window.location.hash !== hash) window.location.hash = hash;
  }, []);

  return { route, navigate };
}
