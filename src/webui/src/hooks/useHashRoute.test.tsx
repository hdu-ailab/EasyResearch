import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AppRoute,
  type ConfigRoute,
  type HomeRoute,
  isSettingsHostRoute,
  type SettingsHostRoute,
  type WorkRoute,
  withoutSettings,
} from "../router";
import { type SettingsCloseGuard, useHashRoute } from "./useHashRoute";

const workRoute: WorkRoute = { page: "work", session: { id: "s1", cwd: "/p" } };
const homeSettings: SettingsHostRoute = { page: "home", settingsOpen: true };

function Harness({ guard, onRoute }: { guard?: SettingsCloseGuard; onRoute?: (route: AppRoute) => void }) {
  const router = useHashRoute();

  useEffect(() => {
    if (!guard) return;
    return router.registerSettingsCloseGuard(guard);
  }, [guard, router.registerSettingsCloseGuard]);

  useEffect(() => {
    onRoute?.(router.route);
  }, [onRoute, router.route]);

  const host: HomeRoute | WorkRoute = router.route.page === "config" ? { page: "home" } : withoutSettings(router.route);
  const settings = isSettingsHostRoute(router.route) ? router.route : homeSettings;
  const config: ConfigRoute = router.route.page === "config" ? router.route : { page: "config", returnTo: settings };

  return (
    <>
      <output data-testid="route">{JSON.stringify(router.route)}</output>
      <button type="button" onClick={() => router.navigate({ page: "home" })}>
        navigate-home
      </button>
      <button type="button" onClick={() => router.navigate(workRoute)}>
        navigate-work
      </button>
      <button type="button" onClick={() => router.openSettings(host)}>
        open-settings
      </button>
      <button type="button" onClick={() => router.closeSettings(settings)}>
        close-settings
      </button>
      <button type="button" onClick={() => router.openConfig(settings)}>
        open-config
      </button>
      <button type="button" onClick={() => router.returnToSettings(config)}>
        return-to-settings
      </button>
    </>
  );
}

function setLocation(hash: string, state: unknown = null) {
  window.history.replaceState(state, "", hash);
}

function expectRoute(route: AppRoute) {
  expect(screen.getByTestId("route").textContent).toBe(JSON.stringify(route));
}

beforeEach(() => {
  setLocation("#/");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useHashRoute", () => {
  it("opens Settings over Home with a marked entry and closes it through browser Back", async () => {
    setLocation("#/", { preserved: "yes" });
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "open-settings" }));

    expect(window.location.hash).toBe("#/?settings=1");
    expect(window.history.state).toEqual({
      preserved: "yes",
      easyresearchNavigation: { kind: "settings", baseHash: "#/" },
    });
    expectRoute(homeSettings);

    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    await user.click(screen.getByRole("button", { name: "close-settings" }));

    expect(back).toHaveBeenCalledTimes(1);
  });

  it("canonicalizes an empty Home base before opening Settings so guarded Back stays in-app", async () => {
    window.history.replaceState({ preserved: "yes" }, "", window.location.pathname);
    expect(window.location.hash).toBe("");
    const replaceState = vi.spyOn(window.history, "replaceState");
    const pushState = vi.spyOn(window.history, "pushState");
    const shouldBlock = vi.fn(() => true);
    const requestClose = vi.fn();
    const user = userEvent.setup();
    render(<Harness guard={{ shouldBlock, requestClose }} />);

    await user.click(screen.getByRole("button", { name: "open-settings" }));

    expect(replaceState).toHaveBeenCalledWith({ preserved: "yes" }, "", "#/");
    expect(pushState).toHaveBeenNthCalledWith(
      1,
      {
        preserved: "yes",
        easyresearchNavigation: { kind: "settings", baseHash: "#/" },
      },
      "",
      "#/?settings=1",
    );
    expect(replaceState.mock.invocationCallOrder[0]).toBeLessThan(pushState.mock.invocationCallOrder[0]!);

    act(() => window.history.back());
    await waitFor(() => expect(requestClose).toHaveBeenCalledTimes(1));

    expect(shouldBlock).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe("#/?settings=1");
    expect(window.history.state).toEqual({
      preserved: "yes",
      easyresearchNavigation: { kind: "settings", baseHash: "#/" },
    });
    expectRoute(homeSettings);
  });

  it("navigates explicitly, clears stale markers, and opens Settings over the exact Work host", async () => {
    setLocation("#/", {
      preserved: "yes",
      easyresearchNavigation: { kind: "config", returnToHash: "#/?settings=1" },
    });
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "navigate-work" }));

    expect(window.location.hash).toBe("#/work/s1?cwd=%2Fp");
    expect(window.history.state).toEqual({ preserved: "yes" });
    expectRoute(workRoute);

    await user.click(screen.getByRole("button", { name: "open-settings" }));

    expect(window.location.hash).toBe("#/work/s1?cwd=%2Fp&settings=1");
    expect(window.history.state).toEqual({
      preserved: "yes",
      easyresearchNavigation: { kind: "settings", baseHash: "#/work/s1?cwd=%2Fp" },
    });
    expectRoute({ ...workRoute, settingsOpen: true });
  });

  it("does not push an already-current route", async () => {
    setLocation("#/", { preserved: "yes" });
    const pushState = vi.spyOn(window.history, "pushState");
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "navigate-home" }));

    expect(pushState).not.toHaveBeenCalled();
    expect(window.history.state).toEqual({ preserved: "yes" });
    expectRoute({ page: "home" });
  });

  it("normalizes a direct legacy Settings entry into base then canonical marked overlay", () => {
    setLocation("#/settings");
    const replaceState = vi.spyOn(window.history, "replaceState");
    const pushState = vi.spyOn(window.history, "pushState");

    render(<Harness />);

    expect(replaceState).toHaveBeenCalledWith(expect.anything(), "", "#/");
    expect(pushState).toHaveBeenCalledWith(
      expect.objectContaining({
        easyresearchNavigation: { kind: "settings", baseHash: "#/" },
      }),
      "",
      "#/?settings=1",
    );
    expect(replaceState.mock.invocationCallOrder[0]).toBeLessThan(pushState.mock.invocationCallOrder[0]!);
    expect(window.location.hash).toBe("#/?settings=1");
    expectRoute(homeSettings);
  });

  it("normalizes an unmarked Work overlay without losing unrelated state", () => {
    setLocation("#/work/s1?cwd=%2Fp&settings=1", { preserved: "yes" });
    const replaceState = vi.spyOn(window.history, "replaceState");
    const pushState = vi.spyOn(window.history, "pushState");

    render(<Harness />);

    expect(replaceState).toHaveBeenCalledWith({ preserved: "yes" }, "", "#/work/s1?cwd=%2Fp");
    expect(pushState).toHaveBeenCalledWith(
      {
        preserved: "yes",
        easyresearchNavigation: { kind: "settings", baseHash: "#/work/s1?cwd=%2Fp" },
      },
      "",
      "#/work/s1?cwd=%2Fp&settings=1",
    );
    expectRoute({ ...workRoute, settingsOpen: true });
  });

  it("leaves a canonical marked Settings refresh unchanged", () => {
    const state = {
      preserved: "yes",
      easyresearchNavigation: { kind: "settings", baseHash: "#/" },
    };
    setLocation("#/?settings=1", state);
    const replaceState = vi.spyOn(window.history, "replaceState");
    const pushState = vi.spyOn(window.history, "pushState");

    render(<Harness />);

    expect(replaceState).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    expect(window.history.state).toEqual(state);
    expectRoute(homeSettings);
  });

  it("uses the current route and current guard when browser Back encounters a nested layer", async () => {
    const staleGuard = {
      shouldBlock: vi.fn(() => false),
      requestClose: vi.fn(),
    };
    const shouldBlock = vi.fn(() => true);
    const requestClose = vi.fn();
    const currentGuard = { shouldBlock, requestClose };
    const user = userEvent.setup();
    const { rerender } = render(<Harness guard={staleGuard} />);

    await user.click(screen.getByRole("button", { name: "open-settings" }));
    rerender(<Harness guard={currentGuard} />);

    act(() => {
      setLocation("#/", { preserved: "yes" });
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    expect(staleGuard.shouldBlock).not.toHaveBeenCalled();
    expect(shouldBlock).toHaveBeenCalledTimes(1);
    expect(requestClose).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe("#/?settings=1");
    expect(window.history.state).toEqual({
      preserved: "yes",
      easyresearchNavigation: { kind: "settings", baseHash: "#/" },
    });
    expectRoute(homeSettings);

    shouldBlock.mockReturnValue(false);
    act(() => {
      setLocation("#/", { preserved: "yes" });
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    });

    expect(shouldBlock).toHaveBeenCalledTimes(2);
    expect(requestClose).toHaveBeenCalledTimes(1);
    expectRoute({ page: "home" });
  });

  it("guards direct hash navigation that would remove Settings", async () => {
    const shouldBlock = vi.fn(() => true);
    const requestClose = vi.fn();
    const user = userEvent.setup();
    render(<Harness guard={{ shouldBlock, requestClose }} />);
    await user.click(screen.getByRole("button", { name: "open-settings" }));

    act(() => {
      window.location.hash = "#/unknown";
    });

    await waitFor(() => expect(requestClose).toHaveBeenCalledTimes(1));
    expect(shouldBlock).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe("#/?settings=1");
    expect(window.history.state.easyresearchNavigation).toEqual({ kind: "settings", baseHash: "#/" });
    expectRoute(homeSettings);
  });

  it("does not republish a route when popstate and hashchange observe the same URL", () => {
    const onRoute = vi.fn();
    render(<Harness onRoute={onRoute} />);
    expect(onRoute).toHaveBeenCalledTimes(1);

    act(() => {
      setLocation("#/work/s1?cwd=%2Fp", { preserved: "yes" });
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    });
    expect(onRoute).toHaveBeenCalledTimes(2);
    expectRoute(workRoute);

    act(() => {
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(onRoute).toHaveBeenCalledTimes(2);
  });

  it("accepts Back and reopens only the marked outer Settings route on Forward", async () => {
    setLocation("#/", { preserved: "yes" });
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "open-settings" }));
    const markedState = window.history.state;

    act(() => {
      setLocation("#/", { preserved: "yes" });
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    });
    expectRoute({ page: "home" });

    setLocation("#/?settings=1", markedState);
    const replaceState = vi.spyOn(window.history, "replaceState");
    const pushState = vi.spyOn(window.history, "pushState");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    });

    expect(replaceState).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    expectRoute(homeSettings);
  });

  it("opens Config with its exact marker and returns through browser Back", async () => {
    setLocation("#/", { preserved: "yes" });
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "open-settings" }));

    await user.click(screen.getByRole("button", { name: "open-config" }));

    expect(window.location.hash).toBe("#/config?returnTo=%23%2F%3Fsettings%3D1");
    expect(window.history.state).toEqual({
      preserved: "yes",
      easyresearchNavigation: { kind: "config", returnToHash: "#/?settings=1" },
    });
    expectRoute({ page: "config", returnTo: homeSettings });

    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    await user.click(screen.getByRole("button", { name: "return-to-settings" }));
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("synthesizes base then marked Settings for an unmatched direct Work Config return", async () => {
    setLocation("#/config?returnTo=%23%2Fwork%2Fs1%3Fcwd%3D%252Fp%26settings%3D1", {
      preserved: "yes",
    });
    const replaceState = vi.spyOn(window.history, "replaceState");
    const pushState = vi.spyOn(window.history, "pushState");
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "return-to-settings" }));

    expect(replaceState).toHaveBeenLastCalledWith({ preserved: "yes" }, "", "#/work/s1?cwd=%2Fp");
    expect(pushState).toHaveBeenLastCalledWith(
      {
        preserved: "yes",
        easyresearchNavigation: {
          kind: "settings",
          baseHash: "#/work/s1?cwd=%2Fp",
        },
      },
      "",
      "#/work/s1?cwd=%2Fp&settings=1",
    );
    const replaceOrder = replaceState.mock.invocationCallOrder.at(-1)!;
    const pushOrder = pushState.mock.invocationCallOrder.at(-1)!;
    expect(replaceOrder).toBeLessThan(pushOrder);
    expectRoute({ ...workRoute, settingsOpen: true });

    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    await user.click(screen.getByRole("button", { name: "close-settings" }));
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("keeps an invalid Config route mounted and synthesizes the Home Settings fallback on request", async () => {
    const invalidConfigHash = "#/config?returnTo=%23%2Fsettings";
    setLocation(invalidConfigHash, { preserved: "yes" });
    const replaceState = vi.spyOn(window.history, "replaceState");
    const pushState = vi.spyOn(window.history, "pushState");
    const user = userEvent.setup();

    render(<Harness />);

    expect(window.location.hash).toBe(invalidConfigHash);
    expect(replaceState).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    expectRoute({ page: "config", returnTo: null });

    await user.click(screen.getByRole("button", { name: "return-to-settings" }));

    expect(replaceState).toHaveBeenLastCalledWith({ preserved: "yes" }, "", "#/");
    expect(pushState).toHaveBeenLastCalledWith(
      {
        preserved: "yes",
        easyresearchNavigation: { kind: "settings", baseHash: "#/" },
      },
      "",
      "#/?settings=1",
    );
    expectRoute(homeSettings);
  });

  it("replaces an unmatched Settings entry with its base instead of leaving it in history", async () => {
    setLocation("#/?settings=1", {
      preserved: "yes",
      easyresearchNavigation: { kind: "settings", baseHash: "#/" },
    });
    const user = userEvent.setup();
    render(<Harness />);
    setLocation("#/?settings=1", { preserved: "yes" });
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const replaceState = vi.spyOn(window.history, "replaceState");

    await user.click(screen.getByRole("button", { name: "close-settings" }));

    expect(back).not.toHaveBeenCalled();
    expect(replaceState).toHaveBeenCalledWith({ preserved: "yes" }, "", "#/");
    expectRoute({ page: "home" });
  });
});
