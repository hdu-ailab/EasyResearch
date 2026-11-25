import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopUpdateOpenIntent } from "../../../desktop/contracts";
import { LATEST_RELEASE_PAGE, type UpdateActionResult, type UpdateSnapshot } from "../../../runtime/update-contract";
import * as updates from "../api/update";
import { useModalLayer } from "../hooks/useModalLayer";
import { I18nProvider } from "../i18n/I18nProvider";
import { PreferencesProvider } from "../preferences/PreferencesProvider";
import { UpdateControl } from "./UpdateControl";

vi.mock("../api/update", () => ({
  getUpdateSnapshot: vi.fn(),
  requestUpdateAction: vi.fn(),
  subscribeUpdates: vi.fn(),
}));

const available: UpdateSnapshot = {
  owner: "cli",
  revision: 1,
  operationId: "operation-a",
  currentVersion: "1.0.0",
  latestVersion: "1.0.1",
  phase: "available",
  canDownload: false,
  canInstall: true,
  canActivate: false,
  canCancel: false,
  releaseUrl: LATEST_RELEASE_PAGE,
  manualCommand:
    "npm install --global --prefix '/home/user/my npm' easyresearch@1.0.1 --registry=https://registry.npmjs.org/",
};
const desktopIdle: UpdateSnapshot = {
  ...available,
  owner: "desktop",
  operationId: null,
  latestVersion: null,
  phase: "idle",
  canInstall: false,
  manualCommand: undefined,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function desktopBridge(initialIntent?: DesktopUpdateOpenIntent) {
  let listener!: (intent: DesktopUpdateOpenIntent) => void;
  const unsubscribeIntent = vi.fn();
  const onOpenUpdates = vi.fn((callback: typeof listener) => {
    listener = callback;
    if (initialIntent) callback(initialIntent);
    return unsubscribeIntent;
  });
  window.easyresearchDesktop = {
    platform: "win32",
    version: "1.0.0",
    persistWebUiPreferences: vi.fn(),
    onOpenUpdates,
  };
  return { emit: (intent: DesktopUpdateOpenIntent) => listener(intent), onOpenUpdates, unsubscribeIntent };
}

let publish: (snapshot: UpdateSnapshot) => void;
const unsubscribe = vi.fn();
const mount = () =>
  render(
    <PreferencesProvider>
      <I18nProvider>
        <UpdateControl currentVersion="1.0.0" />
      </I18nProvider>
    </PreferencesProvider>,
  );

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("easyresearch:webui", JSON.stringify({ language: "en" }));
  vi.mocked(updates.getUpdateSnapshot).mockReset().mockResolvedValue(available);
  vi.mocked(updates.requestUpdateAction).mockReset().mockResolvedValue(available);
  vi.mocked(updates.subscribeUpdates)
    .mockReset()
    .mockImplementation((listener) => {
      publish = listener;
      return unsubscribe;
    });
  unsubscribe.mockClear();
});
afterEach(() => {
  cleanup();
  delete window.easyresearchDesktop;
  vi.unstubAllGlobals();
});

describe("global update controls", () => {
  it("does not advertise the running or older release as a new version", async () => {
    vi.mocked(updates.getUpdateSnapshot).mockResolvedValue({
      ...available,
      phase: "current",
      latestVersion: available.currentVersion,
      canInstall: false,
    });
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Updates/ }));
    await screen.findByText("Up to date");
    expect(screen.queryByText("New version available")).not.toBeInTheDocument();
  });
  it("keeps installation explicit and does not cancel host work when the dialog closes", async () => {
    const view = mount();
    fireEvent.click(screen.getByRole("button", { name: /Updates/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Install update" }));
    expect(updates.requestUpdateAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm install" }));
    await waitFor(() =>
      expect(updates.requestUpdateAction).toHaveBeenCalledWith({ action: "install", operationId: "operation-a" }),
    );
    act(() => publish({ ...available, revision: 2, phase: "installing", canInstall: false, canCancel: true }));
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("value");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(updates.requestUpdateAction).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("does not regress progress when an earlier snapshot arrives after a live event", async () => {
    let complete!: (value: UpdateSnapshot) => void;
    vi.mocked(updates.getUpdateSnapshot).mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Updates/ }));
    act(() =>
      publish({
        ...available,
        revision: 3,
        phase: "downloading",
        canInstall: false,
        canCancel: true,
        bytesReceived: 50,
        bytesTotal: 100,
      }),
    );
    await act(async () => complete(available));
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "50");
    expect(screen.queryByRole("button", { name: "Install update" })).not.toBeInTheDocument();
  });

  it("reports measured download bytes without announcing every byte delta", async () => {
    const downloading: UpdateSnapshot = {
      ...desktopIdle,
      revision: 2,
      phase: "downloading",
      operationId: "download",
      canCancel: true,
      bytesReceived: 1.5 * 1024 ** 2,
      bytesTotal: 4 * 1024 ** 2,
    };
    vi.mocked(updates.getUpdateSnapshot).mockResolvedValue(downloading);
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Updates/ }));
    const detail = await screen.findByText("1.5 MiB of 4 MiB");
    const progress = screen.getByRole("progressbar", { name: "Downloading…" });
    expect(progress).toHaveAttribute("value", String(downloading.bytesReceived));
    expect(progress).toHaveAttribute("max", String(downloading.bytesTotal));
    expect(progress).toHaveAccessibleDescription("1.5 MiB of 4 MiB 37%");
    expect(detail.closest('[role="status"], [role="alert"], [aria-live]')).toBeNull();
    act(() => publish({ ...downloading, revision: 3, bytesTotal: undefined }));
    expect(progress).not.toHaveAttribute("value");
    expect(screen.getByText("1.5 MiB downloaded")).toBeInTheDocument();
    expect(screen.queryByText("37%")).toBeNull();
    act(() => publish({ ...downloading, revision: 4, bytesReceived: undefined }));
    expect(progress).not.toHaveAttribute("value");
    expect(screen.queryByText(/MiB/)).toBeNull();
  });

  it("requires renewed explicit force consent when work became busy", async () => {
    vi.mocked(updates.requestUpdateAction).mockResolvedValueOnce({
      code: "RUNTIME_BUSY",
      activeSessions: 2,
      authFlowActive: false,
    });
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Updates/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Install update" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm install" }));
    await screen.findByText(/2 active/);
    expect(updates.requestUpdateAction).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Stop work and continue" }));
    await waitFor(() =>
      expect(updates.requestUpdateAction).toHaveBeenLastCalledWith({
        action: "install",
        operationId: "operation-a",
        force: true,
      }),
    );
  });

  it("keeps the exact manual command selectable after clipboard denial", async () => {
    vi.mocked(updates.getUpdateSnapshot).mockResolvedValue({
      ...available,
      phase: "failed",
      canInstall: false,
      message: "Permission denied",
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Updates/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Copy command" }));
    expect(await screen.findByText(/Select and copy/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Manual installation command" })).toHaveValue(available.manualCommand);
  });

  it("offers the official release fallback when desktop installation fails", async () => {
    vi.mocked(updates.getUpdateSnapshot).mockResolvedValue({
      ...available,
      owner: "desktop",
      phase: "failed",
      canInstall: false,
      manualCommand: undefined,
      message: "Installer failed",
    });
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Updates/ }));
    expect(await screen.findByRole("link", { name: "Open latest Release" })).toHaveAttribute(
      "href",
      LATEST_RELEASE_PAGE,
    );
    expect(screen.getByText("Installer failed")).toBeInTheDocument();
  });

  it("reveals a verified manual Desktop download without accepting a browser path", async () => {
    vi.mocked(updates.getUpdateSnapshot).mockResolvedValue({
      ...available,
      owner: "desktop",
      phase: "downloaded",
      canInstall: false,
      canReveal: true,
      manualCommand: undefined,
    });
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Updates/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Show downloaded file" }));
    expect(screen.getByText("Download verified")).toBeInTheDocument();
    expect(screen.queryByText(/Installed/)).toBeNull();
    await waitFor(() =>
      expect(updates.requestUpdateAction).toHaveBeenCalledWith({ action: "reveal", operationId: "operation-a" }),
    );
  });

  it("expires an install confirmation when another view has already started installation", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Updates/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Install update" }));
    act(() => publish({ ...available, revision: 2, phase: "installing", canInstall: false, canCancel: true }));
    expect(screen.queryByRole("button", { name: "Confirm install" })).not.toBeInTheDocument();
    expect(updates.requestUpdateAction).not.toHaveBeenCalled();
  });

  it("ignores a late busy acknowledgement after live state has revoked installation", async () => {
    let finish!: (value: { code: "RUNTIME_BUSY"; activeSessions: number; authFlowActive: boolean }) => void;
    vi.mocked(updates.requestUpdateAction).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Updates/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Install update" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm install" }));
    act(() => publish({ ...available, revision: 3, phase: "ready", canInstall: false, canActivate: true }));
    await act(async () => finish({ code: "RUNTIME_BUSY", activeSessions: 2, authFlowActive: false }));
    expect(screen.queryByRole("button", { name: "Stop work and continue" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restart to update" })).toBeEnabled();
  });

  it("accepts a Desktop busy result after that operation republishes its install capability", async () => {
    const desktop = { ...available, owner: "desktop" as const, phase: "downloaded" as const };
    vi.mocked(updates.getUpdateSnapshot).mockResolvedValue(desktop);
    let finish!: (value: { code: "RUNTIME_BUSY"; activeSessions: number; authFlowActive: boolean }) => void;
    vi.mocked(updates.requestUpdateAction).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Updates/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Install update" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm install" }));
    act(() => publish({ ...desktop, revision: 2, canInstall: false, canCancel: true }));
    act(() => publish({ ...desktop, revision: 3, canInstall: true, canCancel: false }));
    await act(async () => finish({ code: "RUNTIME_BUSY", activeSessions: 2, authFlowActive: false }));
    expect(screen.getByRole("button", { name: "Stop work and continue" })).toBeEnabled();
  });

  it("can cancel from live state while the install acknowledgement is pending", async () => {
    let finish!: (value: UpdateSnapshot) => void;
    const cancelled = { ...available, revision: 4, phase: "cancelled" as const, canInstall: false };
    vi.mocked(updates.requestUpdateAction)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      )
      .mockResolvedValueOnce(cancelled);
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Updates/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Install update" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm install" }));
    act(() => publish({ ...available, revision: 2, phase: "installing", canInstall: false, canCancel: true }));
    expect(screen.getByRole("button", { name: "Cancel update" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel update" }));
    await screen.findByText("Update cancelled");
    await act(async () =>
      finish({ ...available, revision: 2, phase: "installing", canInstall: false, canCancel: true }),
    );
    expect(screen.getByText("Update cancelled")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeEnabled();
  });

  it("exposes the dialog outside the inert app and restores keyboard focus on Escape", async () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <div inert={open || undefined} aria-hidden={open || undefined}>
          <UpdateControl currentVersion="1.0.0" onOpenChange={setOpen} />
        </div>
      );
    }
    render(
      <PreferencesProvider>
        <I18nProvider>
          <Host />
        </I18nProvider>
      </PreferencesProvider>,
    );
    const trigger = screen.getByRole("button", { name: /Updates/ });
    trigger.focus();
    fireEvent.click(trigger);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Updates/ })).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });
});

describe("Desktop update intents", () => {
  it("opens before the startup snapshot and coalesces checks through completion", async () => {
    const read = deferred<UpdateSnapshot>();
    const check = deferred<UpdateActionResult>();
    const bridge = desktopBridge("check");
    vi.mocked(updates.getUpdateSnapshot).mockReturnValue(read.promise);
    vi.mocked(updates.requestUpdateAction).mockReturnValue(check.promise);
    mount();
    expect(screen.getByRole("dialog", { name: "Updates" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeDisabled();
    expect(screen.getByRole("progressbar", { name: "Loading update status…" })).not.toHaveAttribute("value");
    act(() => {
      bridge.emit("check");
      bridge.emit("check");
    });
    expect(updates.getUpdateSnapshot).toHaveBeenCalledOnce();
    expect(updates.subscribeUpdates).toHaveBeenCalledOnce();
    expect(vi.mocked(updates.subscribeUpdates).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(updates.getUpdateSnapshot).mock.invocationCallOrder[0]!,
    );
    expect(updates.requestUpdateAction).not.toHaveBeenCalled();
    await act(async () => read.resolve(desktopIdle));
    expect(updates.requestUpdateAction).toHaveBeenCalledExactlyOnceWith({ action: "check" });
    act(() => bridge.emit("check"));
    await act(async () => check.resolve({ ...desktopIdle, revision: 2, phase: "current" }));
    expect(screen.getByText("Up to date")).toBeInTheDocument();
    act(() => bridge.emit("check"));
    expect(updates.requestUpdateAction).toHaveBeenCalledOnce();
    expect(updates.getUpdateSnapshot).toHaveBeenCalledOnce();
    expect(bridge.onOpenUpdates).toHaveBeenCalledOnce();
  });

  it.each(["current", "failed", "cancelled"] as const)("checks a fresh eligible %s snapshot once", async (phase) => {
    const bridge = desktopBridge();
    vi.mocked(updates.getUpdateSnapshot).mockResolvedValue({ ...desktopIdle, phase });
    vi.mocked(updates.requestUpdateAction).mockResolvedValue({
      ...desktopIdle,
      revision: 2,
      operationId: "new-release",
      phase: "available",
      latestVersion: "1.2.0",
      canDownload: true,
    });
    mount();
    act(() => bridge.emit("check"));
    expect(await screen.findByRole("button", { name: "Download update" })).toBeEnabled();
    expect(within(screen.getByRole("dialog")).getByText("v1.2.0")).toBeInTheDocument();
    expect(updates.requestUpdateAction).toHaveBeenCalledExactlyOnceWith({ action: "check" });
  });

  it.each([
    "checking",
    "downloading",
    "installing",
    "verifying",
    "activating",
    "available",
    "downloaded",
    "ready",
  ] as const)("shows the authoritative %s operation without starting another check", async (phase) => {
    const bridge = desktopBridge();
    vi.mocked(updates.getUpdateSnapshot).mockResolvedValue({
      ...desktopIdle,
      phase,
      operationId: "existing-work",
      canInstall: phase === "downloaded",
      canActivate: phase === "ready",
      canDownload: phase === "available",
      message: `Existing ${phase} operation`,
    });
    mount();
    act(() => {
      bridge.emit("check");
      bridge.emit("check");
    });
    await screen.findByText(`Existing ${phase} operation`);
    act(() => bridge.emit("check"));
    expect(updates.requestUpdateAction).not.toHaveBeenCalled();
    expect(updates.getUpdateSnapshot).toHaveBeenCalledOnce();
    expect(updates.subscribeUpdates).toHaveBeenCalledOnce();
  });

  it("keeps an existing install confirmation when the tray opens the same downloaded operation", async () => {
    const bridge = desktopBridge();
    vi.mocked(updates.getUpdateSnapshot).mockResolvedValue({
      ...available,
      owner: "desktop",
      phase: "downloaded",
      manualCommand: undefined,
    });
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Updates/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Install update" }));
    expect(screen.getByRole("button", { name: "Back" })).toHaveFocus();
    act(() => bridge.emit("check"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm install" })).toBeEnabled());
    expect(updates.requestUpdateAction).not.toHaveBeenCalled();
    expect(updates.subscribeUpdates).toHaveBeenCalledOnce();
  });

  it("does not check during a pending install and keeps cancellation independently available", async () => {
    const bridge = desktopBridge();
    const install = deferred<UpdateActionResult>();
    const current: UpdateSnapshot = { ...available, owner: "desktop", phase: "downloaded", manualCommand: undefined };
    vi.mocked(updates.getUpdateSnapshot).mockResolvedValueOnce(current).mockResolvedValue(desktopIdle);
    vi.mocked(updates.requestUpdateAction)
      .mockReturnValueOnce(install.promise)
      .mockResolvedValueOnce({ ...desktopIdle, revision: 3, phase: "cancelled" });
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Updates/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Install update" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm install" }));
    act(() => publish({ ...current, revision: 2, phase: "installing", canInstall: false, canCancel: true }));
    act(() => {
      bridge.emit("check");
      bridge.emit("check");
    });
    await act(async () => {});
    expect(updates.requestUpdateAction).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Cancel update" }));
    await screen.findByText("Update cancelled");
    await act(async () =>
      install.resolve({ ...current, revision: 2, phase: "installing", canInstall: false, canCancel: true }),
    );
    expect(screen.getByText("Update cancelled")).toBeInTheDocument();
    expect(updates.requestUpdateAction).toHaveBeenLastCalledWith({
      action: "cancel",
      operationId: current.operationId,
    });
    expect(updates.requestUpdateAction).toHaveBeenCalledTimes(2);
  });

  it("does not defer a tray check until a pending action later settles", async () => {
    const bridge = desktopBridge();
    const check = deferred<UpdateActionResult>();
    const read = deferred<UpdateSnapshot>();
    vi.mocked(updates.getUpdateSnapshot).mockResolvedValueOnce(desktopIdle).mockReturnValueOnce(read.promise);
    vi.mocked(updates.requestUpdateAction).mockReturnValueOnce(check.promise);
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Updates/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Check for updates" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    act(() => bridge.emit("check"));
    await act(async () => check.resolve({ ...desktopIdle, revision: 2, phase: "current" }));
    await act(async () => read.resolve({ ...desktopIdle, revision: 2, phase: "current" }));
    expect(updates.requestUpdateAction).toHaveBeenCalledOnce();
  });

  it("prioritizes recovery and discards an older intent's snapshot even if it resolves last", async () => {
    const oldRead = deferred<UpdateSnapshot>();
    const bridge = desktopBridge();
    const failure: UpdateSnapshot = {
      ...desktopIdle,
      revision: 2,
      phase: "failed",
      message: "Installer failed; the previous version was restored.",
    };
    vi.mocked(updates.getUpdateSnapshot).mockReturnValueOnce(oldRead.promise).mockResolvedValueOnce(failure);
    mount();
    act(() => bridge.emit("check"));
    act(() => bridge.emit("recovery"));
    expect(await screen.findByText(failure.message!)).toBeInTheDocument();
    await act(async () => oldRead.resolve({ ...desktopIdle, revision: 10, phase: "current" }));
    act(() => {
      bridge.emit("check");
      bridge.emit("recovery");
    });
    const dialog = screen.getByRole("dialog", { name: "Updates" });
    expect(within(dialog).getByText("Update failed")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "Open latest Release" })).toHaveAttribute(
      "href",
      LATEST_RELEASE_PAGE,
    );
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeEnabled();
    expect(updates.requestUpdateAction).not.toHaveBeenCalled();
    expect(updates.getUpdateSnapshot).toHaveBeenCalledTimes(2);
    expect(updates.subscribeUpdates).toHaveBeenCalledOnce();
  });

  it.each(["close", "unmount"] as const)("never checks after %s while its initial read is pending", async (end) => {
    const bridge = desktopBridge();
    const read = deferred<UpdateSnapshot>();
    vi.mocked(updates.getUpdateSnapshot).mockReturnValueOnce(read.promise);
    const view = mount();
    act(() => bridge.emit("check"));
    if (end === "close") fireEvent.click(screen.getByRole("button", { name: "Close" }));
    else view.unmount();
    await act(async () => read.resolve(desktopIdle));
    expect(updates.requestUpdateAction).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Updates" })).toBeNull();
    if (end === "unmount") {
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(bridge.unsubscribeIntent).toHaveBeenCalledOnce();
      act(() => bridge.emit("check"));
      expect(updates.getUpdateSnapshot).toHaveBeenCalledOnce();
    }
  });

  it.each([
    { element: "body", dismiss: "Close" },
    { element: "body", dismiss: "Escape" },
    { element: "html", dismiss: "Close" },
    { element: "html", dismiss: "Escape" },
  ] as const)(
    "restores the header after tray opening from $element and $dismiss dismissal",
    async ({ element, dismiss }) => {
      function Host() {
        const [open, setOpen] = useState(false);
        return (
          <div inert={open || undefined} aria-hidden={open || undefined}>
            <UpdateControl currentVersion="1.0.0" onOpenChange={setOpen} />
          </div>
        );
      }
      const bridge = desktopBridge();
      vi.mocked(updates.getUpdateSnapshot).mockResolvedValue({ ...desktopIdle, phase: "failed" });
      render(
        <PreferencesProvider>
          <I18nProvider>
            <Host />
          </I18nProvider>
        </PreferencesProvider>,
      );
      const trigger = screen.getByRole("button", { name: /Updates/ });
      const root = element === "body" ? document.body : document.documentElement;
      const previousTabIndex = root.getAttribute("tabindex");
      try {
        if (element === "html") root.tabIndex = -1;
        root.focus();
        expect(document.activeElement).toBe(root);
        act(() => bridge.emit("recovery"));
        expect(await screen.findByRole("dialog", { name: "Updates" })).toBeInTheDocument();
        expect(trigger.closest("[inert]")).not.toBeNull();
        if (dismiss === "Close") fireEvent.click(screen.getByRole("button", { name: "Close" }));
        else fireEvent.keyDown(document, { key: "Escape" });
        expect(screen.queryByRole("dialog", { name: "Updates" })).toBeNull();
        expect(trigger.closest("[inert]")).toBeNull();
        expect(trigger).toHaveFocus();
      } finally {
        if (previousTabIndex === null) root.removeAttribute("tabindex");
        else root.setAttribute("tabindex", previousTabIndex);
      }
    },
  );

  it("opens above a retained Settings modal and unwinds focus one layer at a time", async () => {
    function Settings({ onClose }: { onClose(): void }) {
      const ref = useRef<HTMLElement>(null);
      const layer = useModalLayer(onClose, ref);
      return (
        <div {...layer.layerProps}>
          <section ref={ref} role="dialog" aria-label="Settings" {...layer.dialogProps}>
            <button type="button">Settings field</button>
            <button type="button" onClick={onClose}>
              Close settings
            </button>
          </section>
        </div>
      );
    }
    function Host() {
      const [settings, setSettings] = useState(true);
      const [update, setUpdate] = useState(false);
      return (
        <>
          <div inert={settings || update || undefined} aria-hidden={settings || update || undefined}>
            <UpdateControl currentVersion="1.0.0" onOpenChange={setUpdate} />
          </div>
          {settings && <Settings onClose={() => setSettings(false)} />}
        </>
      );
    }
    const bridge = desktopBridge();
    vi.mocked(updates.getUpdateSnapshot).mockResolvedValue({ ...desktopIdle, phase: "failed" });
    render(
      <PreferencesProvider>
        <I18nProvider>
          <Host />
        </I18nProvider>
      </PreferencesProvider>,
    );
    const field = screen.getByRole("button", { name: "Settings field" });
    field.focus();
    act(() => bridge.emit("recovery"));
    const dialog = await screen.findByRole("dialog", { name: "Updates" });
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Close" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    expect(field).toHaveFocus();
    expect(bridge.unsubscribeIntent).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("restores the active Config control after its inert wrapper becomes interactive again", async () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <div inert aria-hidden="true">
            <UpdateControl currentVersion="1.0.0" onOpenChange={setOpen} />
          </div>
          <div inert={open || undefined} aria-hidden={open || undefined}>
            <input aria-label="Configuration draft" defaultValue="Keep this draft" />
          </div>
        </>
      );
    }
    const bridge = desktopBridge();
    vi.mocked(updates.getUpdateSnapshot).mockResolvedValue({ ...desktopIdle, phase: "failed" });
    render(
      <PreferencesProvider>
        <I18nProvider>
          <Host />
        </I18nProvider>
      </PreferencesProvider>,
    );
    const field = screen.getByRole("textbox", { name: "Configuration draft" });
    field.focus();
    act(() => bridge.emit("recovery"));
    expect(await screen.findByRole("dialog", { name: "Updates" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Configuration draft" })).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(field).toHaveFocus();
    expect(field).toHaveValue("Keep this draft");
  });
});
