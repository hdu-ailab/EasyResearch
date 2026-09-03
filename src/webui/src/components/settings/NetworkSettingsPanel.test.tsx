import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NetworkProxySettingsDto, NetworkProxyTestResultDto } from "../../../../web/contracts";
import * as api from "../../api";
import { I18nProvider } from "../../i18n/I18nProvider";
import { STORAGE_KEY } from "../../preferences";
import { PreferencesProvider } from "../../preferences/PreferencesProvider";
import { NetworkSettingsPanel } from "./NetworkSettingsPanel";

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    getNetworkProxySettings: vi.fn(),
    patchNetworkProxySettings: vi.fn(),
    testNetworkProxy: vi.fn(),
  };
});

const emptySettings: NetworkProxySettingsDto = {
  configured: {},
  appliedConfigured: {},
  sources: { all: "direct", llm: "direct", search: "direct" },
  errors: [],
  restartRequired: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function renderPanel({
  onDirtyChange = vi.fn(),
  onSavedRestartRequired = vi.fn(),
}: {
  onDirtyChange?: (dirty: boolean) => void;
  onSavedRestartRequired?: () => void;
} = {}) {
  const view = render(
    <PreferencesProvider>
      <I18nProvider>
        <NetworkSettingsPanel
          onDirtyChange={onDirtyChange}
          onSavingChange={() => {}}
          onSavedRestartRequired={onSavedRestartRequired}
        />
      </I18nProvider>
    </PreferencesProvider>,
  );
  return { ...view, onDirtyChange, onSavedRestartRequired };
}

function proxyInput(name: "All traffic proxy" | "LLM API proxy" | "Search proxy") {
  return screen.getByRole("textbox", { name });
}

function testButton(name: "All traffic proxy" | "LLM API proxy" | "Search proxy") {
  return screen.getByRole("button", { name: `Test ${name}` });
}

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(api.getNetworkProxySettings).mockReset().mockResolvedValue(emptySettings);
  vi.mocked(api.patchNetworkProxySettings)
    .mockReset()
    .mockImplementation(async (patch) => ({
      ...emptySettings,
      configured: Object.fromEntries(
        Object.entries(patch).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      ),
    }));
  vi.mocked(api.testNetworkProxy)
    .mockReset()
    .mockResolvedValue({ ok: true, outcome: "success", status: 204, elapsedMs: 5 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NetworkSettingsPanel", () => {
  it("loads on mount and explains route scope and inheritance without exposing an inherited URL", async () => {
    const pending = deferred<NetworkProxySettingsDto>();
    vi.mocked(api.getNetworkProxySettings).mockReturnValue(pending.promise);
    renderPanel();

    expect(screen.getByText("Loading network settings…")).toBeVisible();

    await act(async () => {
      pending.resolve({
        ...emptySettings,
        sources: { all: "environment", llm: "environment", search: "environment" },
      });
      await pending.promise;
    });

    expect(api.getNetworkProxySettings).toHaveBeenCalledOnce();
    expect(
      screen.getByText(
        "Proxies the EasyResearch daemon and local shell, Python, and npm processes started by Agents. SSH and the external system browser are not affected.",
      ),
    ).toBeVisible();
    expect(screen.getByText("Empty inherits the launch environment.")).toBeVisible();
    expect(screen.getAllByText("Empty inherits All traffic.")).toHaveLength(2);
    expect(testButton("All traffic proxy")).toBeDisabled();
    expect(testButton("LLM API proxy")).toBeDisabled();
    expect(testButton("Search proxy")).toBeDisabled();
    expect(document.body).not.toHaveTextContent("http://inherited.example");
  });

  it("localizes a load failure and retries without retaining server details", async () => {
    vi.mocked(api.getNetworkProxySettings)
      .mockRejectedValueOnce(new Error("private load detail"))
      .mockResolvedValueOnce(emptySettings);
    const user = userEvent.setup();
    renderPanel();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load network settings.");
    expect(alert).not.toHaveTextContent("private load detail");

    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("textbox", { name: "All traffic proxy" })).toBeVisible();
    expect(api.getNetworkProxySettings).toHaveBeenCalledTimes(2);
  });

  it("sends one complete trimmed payload and adopts server pruning and normalization", async () => {
    vi.mocked(api.getNetworkProxySettings).mockResolvedValue({
      ...emptySettings,
      configured: {
        all: "http://old-all.example",
        llm: "https://old-llm.example",
        search: "http://old-search.example",
      },
      sources: { all: "configured", llm: "configured", search: "configured" },
    });
    vi.mocked(api.patchNetworkProxySettings).mockResolvedValue({
      ...emptySettings,
      configured: {
        all: "http://new-all.example",
        search: "https://new-search.example",
      },
      sources: { all: "configured", llm: "all", search: "configured" },
      restartRequired: true,
    });
    const user = userEvent.setup();
    const { onDirtyChange, onSavedRestartRequired } = renderPanel();
    const all = await screen.findByRole("textbox", { name: "All traffic proxy" });
    const llm = proxyInput("LLM API proxy");
    const search = proxyInput("Search proxy");

    fireEvent.change(all, { target: { value: "  HTTP://NEW-ALL.EXAMPLE:80/  " } });
    fireEvent.change(llm, { target: { value: "   " } });
    fireEvent.change(search, { target: { value: "  HTTPS://NEW-SEARCH.EXAMPLE:443/ " } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));

    await user.click(screen.getByRole("button", { name: "Save network settings" }));

    expect(api.patchNetworkProxySettings).toHaveBeenCalledOnce();
    expect(api.patchNetworkProxySettings).toHaveBeenCalledWith({
      all: "HTTP://NEW-ALL.EXAMPLE:80/",
      llm: null,
      search: "HTTPS://NEW-SEARCH.EXAMPLE:443/",
    });
    await waitFor(() => expect(all).toHaveValue("http://new-all.example"));
    expect(llm).toHaveValue("");
    expect(search).toHaveValue("https://new-search.example");
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(onSavedRestartRequired).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Save network settings" })).toBeDisabled();
  });

  it.each([
    "socks5://proxy.example",
    "http://user:secret@proxy.example",
    "http://proxy.example/path",
    "http://proxy.example?route=one",
    "http://proxy.example#route",
    "http://proxy.example/.",
    "http://proxy.example/%2e",
    "http://proxy.example\\",
    "http:proxy.example",
    "https:/proxy.example",
    "proxy.example:8080",
  ])("identifies and blocks the invalid proxy origin %s", async (candidate) => {
    renderPanel();
    const all = await screen.findByRole("textbox", { name: "All traffic proxy" });

    fireEvent.change(all, { target: { value: candidate } });

    expect(all).toHaveAttribute("aria-invalid", "true");
    expect(
      screen.getByText(
        "Enter an unauthenticated HTTP or HTTPS origin without a path, query, fragment, or credentials.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Save network settings" })).toBeDisabled();
    expect(api.patchNetworkProxySettings).not.toHaveBeenCalled();
  });

  it("retains drafts and dirty state when the atomic save fails", async () => {
    vi.mocked(api.patchNetworkProxySettings).mockRejectedValue(new Error("private server failure"));
    const user = userEvent.setup();
    const { onDirtyChange, onSavedRestartRequired } = renderPanel();
    const all = await screen.findByRole("textbox", { name: "All traffic proxy" });
    fireEvent.change(all, { target: { value: "http://candidate.example:8080" } });

    await user.click(screen.getByRole("button", { name: "Save network settings" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save network settings.");
    expect(screen.getByRole("alert")).not.toHaveTextContent("private server failure");
    expect(all).toHaveValue("http://candidate.example:8080");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(onSavedRestartRequired).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save network settings" })).toBeEnabled();
  });

  it("runs all three probes concurrently and ignores only edited or stale field results", async () => {
    const probes = {
      all: deferred<NetworkProxyTestResultDto>(),
      llm: deferred<NetworkProxyTestResultDto>(),
      search: deferred<NetworkProxyTestResultDto>(),
    };
    vi.mocked(api.testNetworkProxy).mockImplementation(({ scope }) => probes[scope].promise);
    const user = userEvent.setup();
    renderPanel();
    await screen.findByRole("textbox", { name: "All traffic proxy" });
    fireEvent.change(proxyInput("All traffic proxy"), { target: { value: "http://all.example" } });
    fireEvent.change(proxyInput("LLM API proxy"), { target: { value: "http://llm.example" } });
    fireEvent.change(proxyInput("Search proxy"), { target: { value: "http://search.example" } });

    await user.click(testButton("All traffic proxy"));
    await user.click(testButton("LLM API proxy"));
    await user.click(testButton("Search proxy"));
    expect(api.testNetworkProxy).toHaveBeenCalledTimes(3);
    expect(screen.getAllByText("Testing…")).toHaveLength(3);

    await act(async () => {
      probes.all.resolve({ ok: true, outcome: "success", status: 204, elapsedMs: 10 });
      probes.search.resolve({ ok: false, outcome: "timeout", elapsedMs: 30 });
      await Promise.all([probes.all.promise, probes.search.promise]);
    });
    expect(screen.getByText("Connection succeeded · HTTP 204 · 10 ms")).toBeVisible();
    expect(screen.getByText("Connection timed out · 30 ms")).toBeVisible();

    fireEvent.change(proxyInput("All traffic proxy"), { target: { value: "http://all-next.example" } });
    expect(screen.queryByText("Connection succeeded · HTTP 204 · 10 ms")).toBeNull();
    expect(screen.getByText("Connection timed out · 30 ms")).toBeVisible();

    fireEvent.change(proxyInput("LLM API proxy"), { target: { value: "http://llm-next.example" } });
    await act(async () => {
      probes.llm.resolve({ ok: true, outcome: "success", status: 200, elapsedMs: 20 });
      await probes.llm.promise;
    });
    expect(screen.queryByText("Connection succeeded · HTTP 200 · 20 ms")).toBeNull();
    expect(screen.getByText("Connection timed out · 30 ms")).toBeVisible();
  });

  it("shows a localized probe warning with safe metadata and still permits Save", async () => {
    vi.mocked(api.testNetworkProxy).mockResolvedValue({
      ok: false,
      outcome: "target-response",
      status: 503,
      elapsedMs: 44,
    });
    const user = userEvent.setup();
    renderPanel();
    const all = await screen.findByRole("textbox", { name: "All traffic proxy" });
    fireEvent.change(all, { target: { value: "http://candidate.example" } });

    await user.click(testButton("All traffic proxy"));

    const outcome = await screen.findByRole("status");
    expect(outcome).toHaveTextContent("Target returned an HTTP error · HTTP 503 · 44 ms");
    expect(outcome).not.toHaveTextContent("candidate.example");
    expect(screen.getByRole("button", { name: "Save network settings" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Save network settings" }));
    expect(api.patchNetworkProxySettings).toHaveBeenCalledOnce();
  });

  it("keeps a loaded restart-required action recoverable until the caller handles it", async () => {
    vi.mocked(api.getNetworkProxySettings).mockResolvedValue({
      ...emptySettings,
      configured: { all: "http://pending.example" },
      restartRequired: true,
    });
    const user = userEvent.setup();
    const { onSavedRestartRequired } = renderPanel();

    const action = await screen.findByRole("button", { name: "Restart required" });
    expect(action).toBeEnabled();
    expect(onSavedRestartRequired).not.toHaveBeenCalled();
    await user.click(action);

    expect(onSavedRestartRequired).toHaveBeenCalledOnce();
    expect(action).toBeVisible();
  });

  it("disables the persistent restart action for an unsaved invalid draft", async () => {
    vi.mocked(api.getNetworkProxySettings).mockResolvedValue({
      ...emptySettings,
      configured: { all: "http://saved.example" },
      restartRequired: true,
    });
    const { onSavedRestartRequired } = renderPanel();
    const all = await screen.findByRole("textbox", { name: "All traffic proxy" });

    fireEvent.change(all, { target: { value: "socks5://draft.example" } });

    const restart = screen.getByRole("button", { name: "Restart required" });
    expect(restart).toBeDisabled();
    fireEvent.click(restart);
    expect(onSavedRestartRequired).not.toHaveBeenCalled();
  });

  it("blocks restart while a diagnostics-only repair Save is in flight", async () => {
    vi.mocked(api.getNetworkProxySettings).mockResolvedValue({
      ...emptySettings,
      errors: [{ code: "NETWORK_PROXY_INVALID", field: "all" }],
      restartRequired: true,
    });
    const pending = deferred<NetworkProxySettingsDto>();
    vi.mocked(api.patchNetworkProxySettings).mockReturnValue(pending.promise);
    const user = userEvent.setup();
    const { onDirtyChange, onSavedRestartRequired } = renderPanel();
    await screen.findByRole("textbox", { name: "All traffic proxy" });

    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
    const restart = screen.getByRole("button", { name: "Restart required" });
    expect(restart).toBeDisabled();
    fireEvent.click(restart);
    expect(onSavedRestartRequired).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save network settings" }));

    expect(api.patchNetworkProxySettings).toHaveBeenCalledOnce();
    expect(restart).toBeDisabled();
    fireEvent.click(restart);
    expect(onSavedRestartRequired).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve({
        ...emptySettings,
        restartRequired: true,
      });
      await pending.promise;
    });

    expect(onSavedRestartRequired).toHaveBeenCalledOnce();
    expect(restart).toBeEnabled();
  });

  it("offers an atomic Save-to-clear for leaf diagnostics without reporting an unsaved draft", async () => {
    vi.mocked(api.getNetworkProxySettings).mockResolvedValue({
      ...emptySettings,
      errors: [{ code: "NETWORK_PROXY_INVALID", field: "all" }],
      restartRequired: true,
    });
    const user = userEvent.setup();
    const { onDirtyChange } = renderPanel();

    const all = await screen.findByRole("textbox", { name: "All traffic proxy" });
    expect(all).toHaveAttribute("aria-invalid", "true");
    expect(
      screen.getByText("The stored All traffic proxy is invalid. Replace it or save empty to clear it."),
    ).toBeVisible();
    const save = screen.getByRole("button", { name: "Save network settings" });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
    expect(save).toBeEnabled();
    await user.click(save);

    expect(api.patchNetworkProxySettings).toHaveBeenCalledWith({ all: null, llm: null, search: null });
  });

  it("localizes the panel copy and outcomes in Chinese", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ language: "zh-CN" }));
    vi.mocked(api.testNetworkProxy).mockResolvedValue({ ok: false, outcome: "tls", elapsedMs: 18 });
    const user = userEvent.setup();
    renderPanel();

    const all = await screen.findByRole("textbox", { name: "全部代理" });
    expect(
      screen.getByText(
        "代理 EasyResearch daemon 以及 Agent 启动的本地 shell、Python 和 npm 进程。SSH 与系统外部浏览器不受影响。",
      ),
    ).toBeVisible();
    expect(screen.getByText("留空则继承启动环境。")).toBeVisible();
    expect(screen.getAllByText("留空则继承全部代理。")).toHaveLength(2);
    fireEvent.change(all, { target: { value: "http://proxy.example" } });
    await user.click(screen.getByRole("button", { name: "测试全部代理" }));
    expect(await screen.findByRole("status")).toHaveTextContent("TLS 连接失败 · 18 毫秒");
  });
});
