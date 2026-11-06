import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, cleanup, render } from "@testing-library/react";
import { type ReactNode, useEffect } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readDesktopPreferenceBlob, writeDesktopPreferenceBlob } from "../../../desktop/preferences-store";
import {
  clearDesktopSmokeSessionTabsStorage,
  type DesktopSmokeSessionTabsReceipt,
  prepareDesktopSmokeSessionTabs,
  verifyDesktopSmokeSessionTabs,
} from "../../../desktop/smoke-session-tabs";
import * as api from "../api";
import { SessionTabBar } from "../components/SessionTabBar";
import { useSessionShell } from "../hooks/useSessionShell";
import { I18nProvider } from "../i18n/I18nProvider";
import { messages } from "../i18n/messages";
import { WorkPage } from "../pages/WorkPage";
import { STORAGE_KEY } from "../preferences";
import { PreferencesProvider } from "../preferences/PreferencesProvider";
import type { SessionTab } from "../session-tabs";
import { hydrateTranscript } from "./transcriptTest";

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  listStatus: vi.fn(),
  openSession: vi.fn(),
  getSnapshot: vi.fn(),
  connectSessionEvents: vi.fn(),
  listAgents: vi.fn(),
  listModels: vi.fn(),
  listEntries: vi.fn(),
  getSessionCommands: vi.fn(),
  getSessionTree: vi.fn(),
  getApiUsageSettings: vi.fn(),
  replaceFileWatchDirectories: vi.fn(),
}));

const root: SessionTab = { id: "d9b55a31-d495-454a-ac11-c5959eec08df", cwd: "/isolated/paper", name: "" };
const dormant: SessionTab = {
  id: "c6aa6344-0148-4217-9494-a1d060e2c5a4",
  cwd: root.cwd,
  name: "Dormant fixture bookmark",
};
const origin = "http://127.0.0.1:43123";
const hash = `#/work/${root.id}?cwd=${encodeURIComponent(root.cwd)}`;
const transcriptUser = "Keep this deterministic desktop smoke request active until the host exits.";
const preferences = {
  chatFontSize: 13,
  filesFontSize: 12,
  language: "en",
  studioTheme: "light",
  autoExpandThinking: false,
  autoExpandTools: false,
  expandSubagentOutput: false,
};
const noop = () => {};
let userDataDir: string;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function snapshot(name?: string) {
  return {
    session: {
      id: root.id,
      cwd: root.cwd,
      status: "ready",
      isStreaming: false,
      sessionName: name,
      sessionFile: "/isolated/history.jsonl",
    },
    timeline: [
      {
        kind: "message",
        entryId: "fixture-user",
        message: { role: "user", content: [{ type: "text", text: transcriptUser }] },
      },
      {
        kind: "message",
        entryId: "fixture-assistant",
        message: { role: "assistant", content: [{ type: "text", text: "running" }] },
      },
    ],
  } as Awaited<ReturnType<typeof api.getSnapshot>>;
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <PreferencesProvider>
      <I18nProvider>{children}</I18nProvider>
    </PreferencesProvider>
  );
}

/** Use the real resolver, real Work metadata callback, real provider and real tab strip. */
function ResolvedWork() {
  const shell = useSessionShell(() => root.id, noop);
  useEffect(() => {
    shell.resolve(root);
  }, [shell.resolve]);
  const view = shell.views[root.id];
  return (
    <>
      <SessionTabBar
        tabs={shell.tabs.map((tab) => ({
          ...tab,
          loading: shell.views[tab.id]?.phase === "loading",
          error: shell.views[tab.id]?.phase === "error",
        }))}
        activeId={root.id}
        onSelect={noop}
        onClose={noop}
        onNew={noop}
      />
      {view?.phase === "ready" && (
        <div data-session-surface={root.id} data-session-active="true">
          <WorkPage
            id={root.id}
            cwd={root.cwd}
            onBack={noop}
            onOpenSettings={noop}
            onSessionMetadata={(metadata) => shell.metadata(metadata, view.generation)}
          />
        </div>
      )}
    </>
  );
}

function installPreferences(tabs: SessionTab[]) {
  const raw = JSON.stringify({ ...preferences, sessionTabs: tabs });
  localStorage.setItem(STORAGE_KEY, raw);
  writeDesktopPreferenceBlob(userDataDir, raw);
  const persist = vi.fn((value: string | null) => writeDesktopPreferenceBlob(userDataDir, value));
  window.easyresearchDesktop = { platform: "linux", version: "test", persistWebUiPreferences: persist };
  return persist;
}

function storedTabs(): SessionTab[] {
  return (JSON.parse(readDesktopPreferenceBlob(userDataDir)!) as { sessionTabs: SessionTab[] }).sessionTabs;
}

function probeOptions() {
  return {
    userDataDir,
    timeoutMs: 1_000,
    observationMs: 50,
    webContents: {
      executeJavaScript: async (code: string) =>
        new Function("window", "document", "location", "localStorage", `return ${code}`)(
          window,
          document,
          { origin, hash },
          localStorage,
        ),
    },
  };
}

function prepare() {
  return prepareDesktopSmokeSessionTabs({
    ...probeOptions(),
    origin,
    hash,
    sessionId: root.id,
    cwd: root.cwd,
    transcriptUser,
  });
}
function verify(receipt: DesktopSmokeSessionTabsReceipt) {
  return verifyDesktopSmokeSessionTabs({ ...probeOptions(), origin, bootId: "new-boot", receipt });
}
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), "easyresearch-desktop-real-work-"));
  localStorage.clear();
  vi.useFakeTimers();
  vi.mocked(api.listStatus)
    .mockReset()
    .mockResolvedValue({
      bootId: "boot",
      agentDir: "/isolated/agent",
      homeDir: "/isolated",
      activeSessions: [],
      sessions: [
        {
          id: root.id,
          cwd: root.cwd,
          path: "/isolated/history.jsonl",
          created: "",
          modified: "",
          messageCount: 2,
          firstMessage: transcriptUser,
        },
      ],
    });
  vi.mocked(api.openSession)
    .mockReset()
    .mockResolvedValue({ id: root.id, cwd: root.cwd, status: "ready", isStreaming: false });
  vi.mocked(api.getSnapshot).mockReset();
  // The real connection hook receives no stream data until the test supplies a snapshot.
  vi.mocked(api.connectSessionEvents).mockReset().mockReturnValue(noop);
  vi.mocked(api.listAgents).mockResolvedValue([]);
  vi.mocked(api.listModels).mockResolvedValue([]);
  vi.mocked(api.listEntries).mockResolvedValue([]);
  vi.mocked(api.getSessionCommands).mockResolvedValue([]);
  vi.mocked(api.getSessionTree).mockResolvedValue({
    tree: [],
    leafId: null,
    filterMode: "default",
    skipBranchSummaryPrompt: false,
  });
  vi.mocked(api.getApiUsageSettings).mockResolvedValue({ showApiUsageDetails: false });
  vi.mocked(api.replaceFileWatchDirectories).mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  delete window.easyresearchDesktop;
  localStorage.clear();
  vi.useRealTimers();
  rmSync(userDataDir, { recursive: true, force: true });
});

describe("Desktop smoke against actual Work hydration and session metadata", () => {
  it.each(["initial", "successor"] as const)(
    "rejects the review's static pre-effect real Work false pass in %s",
    async (phase) => {
      installPreferences([dormant, root]);
      document.body.innerHTML = renderToStaticMarkup(
        <Providers>
          <SessionTabBar tabs={[dormant, root]} activeId={root.id} onSelect={noop} onClose={noop} onNew={noop} />
          <div data-session-surface={root.id} data-session-active="true">
            <WorkPage id={root.id} cwd={root.cwd} onBack={noop} onOpenSettings={noop} />
          </div>
        </Providers>,
      );
      expect(document.querySelector<HTMLTextAreaElement>("[data-chat-composer] textarea")?.disabled).toBe(false);
      expect(document.querySelector('[data-message-body="user"]')).toBeNull();
      expect(api.getSnapshot).not.toHaveBeenCalled(); // Static rendering executed no snapshot effects.
      const task =
        phase === "initial"
          ? prepare()
          : verify({ origin, hash, transcriptUser, tabs: [dormant, root], storageCleared: true });
      const rejection = expect(task).rejects.toThrow(/deadline/);
      await advance(1_000);
      await rejection;
    },
  );

  it("round-trips real resolver omitted names and delayed Work snapshot empty names through preferences and disk", async () => {
    const persist = installPreferences([root]);
    const initial = deferred<ReturnType<typeof snapshot>>();
    vi.mocked(api.getSnapshot).mockReturnValueOnce(initial.promise);
    const mounted = render(<ResolvedWork />, { wrapper: Providers });
    await advance(25);
    hydrateTranscript(mounted.container);
    expect(storedTabs()[0]).toEqual({ id: root.id, cwd: root.cwd }); // Actual open resolver omitted sessionName.
    expect(document.querySelector<HTMLTextAreaElement>("[data-chat-composer] textarea")?.disabled).toBe(false);
    let prepared = false;
    const preparing = prepare().then((value) => {
      prepared = true;
      return value;
    });
    await advance(200);
    expect(prepared).toBe(false);
    expect(storedTabs()).toHaveLength(1);
    await act(async () => {
      initial.resolve(snapshot());
    });
    hydrateTranscript(mounted.container);
    await advance(200);
    const receipt = await preparing;
    expect(receipt.tabs[1]).toEqual(root); // Actual Work hydration reports name:"".
    expect(document.querySelector('[data-message-body="user"]')?.textContent).toBe(transcriptUser);
    const seededWrites = persist.mock.calls.filter(
      ([raw]) => raw && JSON.parse(raw).sessionTabs?.some((tab: SessionTab) => tab.id === receipt.tabs[0].id),
    );
    expect(seededWrites).toHaveLength(1);
    const clearing = clearDesktopSmokeSessionTabsStorage({ ...probeOptions(), receipt });
    await advance(100);
    const cleared = await clearing;
    mounted.unmount();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    // Simulate only preload read IPC; all following metadata writes come from real product hooks.
    localStorage.setItem(STORAGE_KEY, readDesktopPreferenceBlob(userDataDir)!);
    const successor = deferred<ReturnType<typeof snapshot>>();
    vi.mocked(api.getSnapshot).mockReturnValueOnce(successor.promise);
    const restored = render(<ResolvedWork />, { wrapper: Providers });
    await advance(25);
    hydrateTranscript(restored.container);
    expect(storedTabs()[1]).toEqual({ id: root.id, cwd: root.cwd });
    expect(document.querySelector('[data-message-body="user"]')).toBeNull();
    let accepted = false;
    const verifying = verify(cleared).then((event) => {
      accepted = true;
      return event;
    });
    await advance(200);
    expect(accepted).toBe(false); // Omitted name is normal, but no transcript means no acceptance.
    await act(async () => {
      successor.resolve(snapshot());
    });
    hydrateTranscript(restored.container);
    await advance(200);
    expect(await verifying).toMatchObject({
      snapshotTranscriptVerified: true,
      selectedRootVerified: true,
      originChanged: false,
    });
    expect(storedTabs()).toEqual(receipt.tabs);
    expect(document.querySelector(`[data-session-surface="${receipt.tabs[0].id}"]`)).toBeNull();
    expect(api.getSnapshot).toHaveBeenCalledTimes(2);
    expect(api.openSession).toHaveBeenCalledTimes(2);
  });

  it.each(["initial", "successor"] as const)(
    "rejects a failed real snapshot despite the enabled %s composer",
    async (phase) => {
      installPreferences([dormant, root]);
      const response = deferred<ReturnType<typeof snapshot>>();
      vi.mocked(api.getSnapshot).mockReturnValueOnce(response.promise);
      render(<ResolvedWork />, { wrapper: Providers });
      await advance(25);
      await act(async () => {
        response.reject(new Error("Fixture snapshot unavailable"));
      });
      expect(document.querySelector<HTMLTextAreaElement>("[data-chat-composer] textarea")?.disabled).toBe(false);
      expect(document.querySelector('[data-message-body="user"]')).toBeNull();
      const rejection = expect(
        phase === "initial"
          ? prepare()
          : verify({ origin, hash, transcriptUser, tabs: [dormant, root], storageCleared: true }),
      ).rejects.toThrow(/deadline/);
      await advance(1_000);
      await rejection;
    },
  );

  it.each([undefined, "", "Named root", "   "])(
    "matches the actual tab label and hydrated metadata for name %j",
    async (name) => {
      installPreferences([{ ...root, name }]);
      vi.mocked(api.openSession).mockResolvedValue({
        id: root.id,
        cwd: root.cwd,
        status: "ready",
        isStreaming: false,
        sessionName: name,
      });
      vi.mocked(api.getSnapshot).mockResolvedValue(snapshot(name));
      const mounted = render(<ResolvedWork />, { wrapper: Providers });
      await advance(25);
      hydrateTranscript(mounted.container);
      await advance(50);
      const selected = document.querySelector(`[data-session-tab-id="${root.id}"]`)!;
      expect(selected.getAttribute("aria-label")).toBe(name || messages.en["sessionTabs.untitled"]);
      const preparing = prepare();
      await advance(200);
      const receipt = await preparing;
      expect(receipt.tabs[1].name).toBe(name ?? "");
      // A malformed actual label still fails even with hydrated transcript and valid cached metadata.
      selected.setAttribute("aria-label", name ? messages.en["sessionTabs.untitled"] : " ");
      const rejection = expect(prepare()).rejects.toThrow(/deadline/);
      await advance(1_000);
      await rejection;
    },
  );
});
