import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LATEST_RELEASE_PAGE, type UpdateSnapshot } from "../../../runtime/update-contract";
import * as updates from "../api/update";
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
  vi.mocked(updates.subscribeUpdates).mockImplementation((listener) => {
    publish = listener;
    return unsubscribe;
  });
  unsubscribe.mockClear();
});
afterEach(() => {
  cleanup();
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
