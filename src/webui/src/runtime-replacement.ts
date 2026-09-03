import { type AppRoute, routeToHash, withoutSettings } from "./router";

export interface RuntimeReplacementBrowser {
  history: Pick<History, "state" | "replaceState">;
  location: Pick<Location, "hash">;
  reload(): void;
}

export interface RuntimeReplacementPollDependencies {
  readStatus(signal: AbortSignal): Promise<{ bootId: string }>;
  waitForNextAttempt(signal: AbortSignal): Promise<void>;
  signal: AbortSignal;
  timedOut(): boolean;
}

export type RuntimeReplacementPollResult = "replaced" | "timed-out" | "cancelled";

export async function pollForRuntimeReplacement(
  oldBootId: string,
  dependencies: RuntimeReplacementPollDependencies,
): Promise<RuntimeReplacementPollResult> {
  const interruption = (): Exclude<RuntimeReplacementPollResult, "replaced"> =>
    dependencies.timedOut() ? "timed-out" : "cancelled";

  while (!dependencies.signal.aborted) {
    try {
      const status = await dependencies.readStatus(dependencies.signal);
      if (dependencies.signal.aborted) return interruption();
      if (status.bootId.trim() && status.bootId !== oldBootId) return "replaced";
    } catch {
      if (dependencies.signal.aborted) return interruption();
    }

    try {
      await dependencies.waitForNextAttempt(dependencies.signal);
    } catch {
      if (dependencies.signal.aborted) return interruption();
    }
  }

  return interruption();
}

export function reloadForRuntimeReplacement(
  route: AppRoute,
  browser: RuntimeReplacementBrowser = {
    history: window.history,
    location: window.location,
    reload: () => window.location.reload(),
  },
): void {
  const hostRoute =
    route.page === "config"
      ? route.returnTo === null
        ? { page: "home" as const }
        : withoutSettings(route.returnTo)
      : withoutSettings(route);
  const hash = routeToHash(hostRoute);
  if (browser.location.hash !== hash) browser.history.replaceState(browser.history.state, "", hash);
  browser.reload();
}
