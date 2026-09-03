import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { connect as connectTcp, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FIRST_RUN_CEILING_MS,
  assertSmokeRuntimeReplacement,
  assertPathFreeSessionEvent,
  buildWindowsShutdownLauncherScript,
  buildWindowsShutdownScript,
  captureSmokeCompletionActivityBaseline,
  classifySmokeProxyRoutes,
  collectLaunchOutput,
  createCompiledChildEnv,
  fetchSessionEventsBeforeDeadline,
  finishSmokeCleanup,
  formatSmokeProxyDiagnostics,
  isSmokeFirstRunPipRecord,
  isSmokeSessionReadyAfter,
  observeFirstRunStartup,
  parseSmokeDaemonIdentity,
  parseRecordedPid,
  parseSmokeInitialSessionSnapshot,
  readTextFileWithRetry,
  recordSmokeAcceptanceMilestone,
  recordSmokeNetworkMilestone,
  recordSmokeSessionActivityReplacement,
  requestSmokeJsonBeforeDeadline,
  requireZeroProcessStatus,
  resolveSmokePowerShell,
  resolveSmokePython,
  resolveSmokeWindowsSystem32,
  runVenvValidation,
  selectSmokeModelAction,
  selectSmokeWebFetchAction,
  type SmokeModelScenario,
  type SmokeModelState,
  type SmokeNetworkState,
  type SmokeProxyRecord,
  type SmokeSessionActivityTracker,
  type SmokeWebFetchScenario,
  type SmokeWebFetchState,
  settleProcess,
  skillVenvPython,
  startRecordingHttpProxy,
  venvToolCommand,
  writeVenvValidationScript,
} from "../../scripts/smoke-release-support";
import type { NativeLocalShellTool } from "./platform-tools";

const tempDirs: string[] = [];
const asyncCleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of asyncCleanups.splice(0).reverse()) await cleanup();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "smoke-release-support-"));
  tempDirs.push(dir);
  return dir;
}

function findPythonOnPath(): string | undefined {
  for (const name of ["python3", "python"]) {
    const executable = process.platform === "win32" ? `${name}.exe` : name;
    const found = process.env.PATH?.split(delimiter)
      .map((dir) => join(dir, executable))
      .find(existsSync);
    if (found) return found;
  }
  return undefined;
}

const systemPython = findPythonOnPath();

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  asyncCleanups.push(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function requestViaProxy(proxyUrl: string, targetUrl: string): Promise<{
  status: number;
  body: string;
}> {
  const proxy = new URL(proxyUrl);
  const target = new URL(targetUrl);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: proxy.hostname,
      port: proxy.port,
      method: "GET",
      path: targetUrl,
      headers: { Host: target.host },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.once("error", reject);
      response.once("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.end();
  });
}

async function requestThroughConnect(proxyUrl: string, targetUrl: string): Promise<{
  connectStatus: number;
  body: string;
}> {
  const proxy = new URL(proxyUrl);
  const target = new URL(targetUrl);
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ host: proxy.hostname, port: Number(proxy.port) });
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`CONNECT ${target.host} HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      response += chunk;
      if (!response.includes("\r\n\r\n")) return;
      const status = Number.parseInt(response.match(/^HTTP\/1\.1\s+(\d{3})/u)?.[1] ?? "0", 10);
      socket.destroy();
      resolve({ connectStatus: status, body: "" });
    });
    socket.once("error", reject);
  });
}

describe("parseRecordedPid", () => {
  it("accepts both legacy numeric files and structured daemon records", () => {
    expect(parseRecordedPid("4242\n")).toBe(4242);
    expect(parseRecordedPid(`${JSON.stringify({ schema: 1, pid: 5151 })}\n`)).toBe(5151);
    expect(parseRecordedPid("not-a-record")).toBeUndefined();
  });
});

describe("native smoke recording proxy", () => {
  it("notifies an observer when proxy evidence is recorded", async () => {
    const observed: SmokeProxyRecord[] = [];
    const proxy = await startRecordingHttpProxy({
      name: "all",
      onRecord: (record) => observed.push(record),
    });
    asyncCleanups.push(() => proxy.close());

    await requestViaProxy(proxy.url, "http://localhost:1/evidence");

    expect(observed).toEqual(proxy.records());
  });

  it("serves a fake-public HTTP target without DNS and records only its safe classification", async () => {
    const upstream = createServer((request, response) => {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end(`fake target ${request.url}`);
    });
    const upstreamUrl = await listen(upstream);
    const proxy = await startRecordingHttpProxy({
      name: "llm",
      fakeTargets: { "llm.native-smoke.invalid": upstreamUrl },
    });
    asyncCleanups.push(() => proxy.close());

    const result = await requestViaProxy(
      proxy.url,
      "http://llm.native-smoke.invalid/v1/chat/completions?token=MODEL_SECRET",
    );

    expect(result).toEqual({
      status: 200,
      body: "fake target /v1/chat/completions?token=MODEL_SECRET",
    });
    expect(proxy.records()).toEqual([{
      sequence: 1,
      proxy: "llm",
      kind: "fake-target",
      method: "GET",
      host: "llm.native-smoke.invalid",
      port: 80,
    }]);
    expect(formatSmokeProxyDiagnostics(proxy.records())).not.toContain("MODEL_SECRET");
  });

  it("forwards ordinary HTTP and CONNECT traffic needed by first-run installers", async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("forwarded-ok");
    });
    const upstreamUrl = await listen(upstream);
    const proxy = await startRecordingHttpProxy({ name: "all" });
    asyncCleanups.push(() => proxy.close());

    await expect(requestViaProxy(proxy.url, `${upstreamUrl}/plain`)).resolves.toEqual({
      status: 200,
      body: "forwarded-ok",
    });
    const tunnel = await requestThroughConnect(proxy.url, `${upstreamUrl}/tunnel`);
    expect(tunnel.connectStatus).toBe(200);
    expect(proxy.records().map((record) => record.kind)).toEqual([
      "forward",
      "connect-forward",
    ]);
  });

  it("records and rejects a selected CONNECT host without contacting it", async () => {
    const proxy = await startRecordingHttpProxy({
      name: "llm",
      blockedConnectHosts: ["auth.openai.com"],
    });
    asyncCleanups.push(() => proxy.close());

    const result = await requestThroughConnect(proxy.url, "https://auth.openai.com/device");

    expect(result).toEqual({ connectStatus: 502, body: "" });
    expect(proxy.records()).toEqual([{
      sequence: 1,
      proxy: "llm",
      kind: "connect-blocked",
      method: "CONNECT",
      host: "auth.openai.com",
      port: 443,
    }]);
  });

  it("redacts URLs, userinfo, authorization values, and explicit secrets from diagnostics", () => {
    const records: SmokeProxyRecord[] = [{
      sequence: 1,
      proxy: "llm",
      kind: "connect-blocked",
      method: "CONNECT",
      host: "auth.openai.com",
      port: 443,
    }];
    const diagnostics = formatSmokeProxyDiagnostics(records, [
      new Error(
        "proxy http://alice:URL_PASSWORD@127.0.0.1:9000/path?token=QUERY_SECRET "
        + "Authorization: Bearer ACCESS_SECRET proxy-authorization=PROXY_SECRET "
        + "api_key=API_KEY_SECRET password=PLAIN_PASSWORD detail=EXPLICIT_SECRET "
        + "payload={\"token\":\"JSON_TOKEN_SECRET\"}",
      ),
    ], ["EXPLICIT_SECRET"]);

    expect(diagnostics).toContain("auth.openai.com");
    for (const secret of [
      "alice",
      "URL_PASSWORD",
      "QUERY_SECRET",
      "ACCESS_SECRET",
      "PROXY_SECRET",
      "API_KEY_SECRET",
      "PLAIN_PASSWORD",
      "JSON_TOKEN_SECRET",
      "EXPLICIT_SECRET",
      "http://",
    ]) {
      expect(diagnostics).not.toContain(secret);
    }
  });
});

describe("native smoke proxy route acceptance", () => {
  const expected = {
    allHost: "child.native-smoke.invalid",
    gaxiosHost: "gaxios.native-smoke.invalid",
    llmHost: "llm.native-smoke.invalid",
    searchHost: "search.native-smoke.invalid",
    oauthHost: "auth.openai.com",
    candidateHost: "example.com",
  };
  const loopbackEvidence = {
    firstRunAllProxyBaselineSequence: 0,
    gaxiosRequests: 1,
    ipv6Requests: 1,
    ipv6Supported: true,
    providerRequests: 1,
    searchRequests: 1,
    directRequests: 1,
  };
  const record = (
    proxy: string,
    host: string,
    kind: SmokeProxyRecord["kind"] = "fake-target",
  ): SmokeProxyRecord => ({
    sequence: 1,
    proxy,
    kind,
    method: kind.startsWith("connect-") ? "CONNECT" : "GET",
    host,
    port: kind.startsWith("connect-") ? 443 : 80,
  });

  it("classifies distinct All, LLM, Search, OAuth, candidate, and loopback-bypass evidence", () => {
    expect(classifySmokeProxyRoutes([
      record("all", "pypi.org", "connect-forward"),
      record("all", expected.allHost),
      record("llm", expected.gaxiosHost),
      record("llm", expected.llmHost),
      record("llm", expected.oauthHost, "connect-blocked"),
      record("search", expected.searchHost),
      record("candidate", expected.candidateHost, "connect-blocked"),
    ], expected, loopbackEvidence)).toEqual({
      allTarget: true,
      firstRunPipTarget: true,
      gaxiosTarget: true,
      llmTarget: true,
      searchTarget: true,
      oauthTarget: true,
      candidateTarget: true,
      loopbackBypassed: true,
      routesSeparated: true,
    });
  });

  it("accepts first-run pip evidence only from a new outbound All-proxy request", () => {
    const beforeBaseline = { ...record("all", "pypi.org", "connect-forward"), sequence: 4 };
    const afterBaseline = { ...record("all", "files.pythonhosted.org", "connect-forward"), sequence: 6 };
    const evidence = { ...loopbackEvidence, firstRunAllProxyBaselineSequence: 4 };

    expect(classifySmokeProxyRoutes([
      beforeBaseline,
      { ...record("llm", "pypi.org", "connect-forward"), sequence: 5 },
      { ...record("all", "127.0.0.1", "connect-forward"), sequence: 5 },
      { ...record("all", expected.allHost), sequence: 5 },
    ], expected, evidence).firstRunPipTarget).toBe(false);
    expect(classifySmokeProxyRoutes([
      beforeBaseline,
      afterBaseline,
    ], expected, evidence).firstRunPipTarget).toBe(true);
  });

  it("identifies only post-baseline public All-proxy installer records", () => {
    expect(isSmokeFirstRunPipRecord({
      ...record("all", "pypi.org", "connect-forward"),
      sequence: 6,
    }, 5)).toBe(true);
    for (const candidate of [
      { ...record("all", "pypi.org", "connect-forward"), sequence: 5 },
      { ...record("llm", "pypi.org", "connect-forward"), sequence: 6 },
      { ...record("all", "pypi.org"), sequence: 6 },
      { ...record("all", "localhost." , "forward"), sequence: 6 },
      { ...record("all", "[::1]", "connect-forward"), sequence: 6 },
    ]) {
      expect(isSmokeFirstRunPipRecord(candidate, 5)).toBe(false);
    }
  });

  it("does not infer Google/Gaxios routing without a real recorded request", () => {
    expect(classifySmokeProxyRoutes([
      record("all", expected.allHost),
      record("llm", expected.llmHost),
      record("search", expected.searchHost),
    ], expected, { ...loopbackEvidence, gaxiosRequests: 0 }).gaxiosTarget).toBe(false);
  });

  it("requires a real IPv6 request only when the host can bind IPv6 loopback", () => {
    const records = [
      record("all", "pypi.org", "connect-forward"),
      record("all", expected.allHost),
      record("llm", expected.gaxiosHost),
      record("llm", expected.llmHost),
      record("search", expected.searchHost),
    ];

    expect(classifySmokeProxyRoutes(records, expected, {
      ...loopbackEvidence,
      ipv6Requests: 0,
      ipv6Supported: true,
    }).loopbackBypassed).toBe(false);
    expect(classifySmokeProxyRoutes(records, expected, {
      ...loopbackEvidence,
      ipv6Requests: 0,
      ipv6Supported: false,
    }).loopbackBypassed).toBe(true);
  });

  it.each([
    ["provider", 0, 1, 1],
    ["Search", 1, 0, 1],
    ["direct child", 1, 1, 0],
  ] as const)(
    "does not infer loopback bypass without a real %s request",
    (_transport, providerRequests, searchRequests, directRequests) => {
      expect(classifySmokeProxyRoutes([
        record("all", expected.allHost),
        record("llm", expected.llmHost),
        record("search", expected.searchHost),
      ], expected, {
        ...loopbackEvidence,
        providerRequests,
        searchRequests,
        directRequests,
      }).loopbackBypassed).toBe(false);
    },
  );

  it("rejects cross-routed fake targets and any loopback proxy record", () => {
    expect(classifySmokeProxyRoutes([
      record("search", expected.llmHost),
      record("all", "127.0.0.1", "forward"),
    ], expected, loopbackEvidence)).toMatchObject({
      loopbackBypassed: false,
      routesSeparated: false,
    });
  });

  it("does not accept forwarding or an unblocked CONNECT as deterministic target evidence", () => {
    expect(classifySmokeProxyRoutes([
      record("all", expected.allHost, "forward"),
      record("llm", expected.llmHost, "forward"),
      record("search", expected.searchHost, "forward"),
      record("llm", expected.oauthHost, "connect-forward"),
    ], expected, loopbackEvidence)).toMatchObject({
      allTarget: false,
      llmTarget: false,
      searchTarget: false,
      oauthTarget: false,
      routesSeparated: false,
    });
  });
});

describe("native smoke first-run observation", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((accept) => { resolve = accept; });
    return { promise, resolve };
  }

  it("starts both watches and accepts proxy evidence observed before authenticated readiness", async () => {
    const pip = deferred<{ host: string }>();
    const readiness = deferred<{ bootId: string }>();
    let pipStarted = false;
    let readinessStarted = false;
    const result = observeFirstRunStartup({
      observeSetupPip: () => {
        pipStarted = true;
        return pip.promise;
      },
      observeAuthenticatedReadiness: () => {
        readinessStarted = true;
        return readiness.promise;
      },
    });

    await Promise.resolve();
    expect(pipStarted).toBe(true);
    expect(readinessStarted).toBe(true);
    pip.resolve({ host: "pypi.org" });
    await Promise.resolve();
    readiness.resolve({ bootId: "boot-a" });

    await expect(result).resolves.toEqual({
      setupPip: { host: "pypi.org" },
      authenticatedReadiness: { bootId: "boot-a" },
    });
  });

  it("rejects authenticated readiness observed before first-run pip evidence", async () => {
    const pip = deferred<{ host: string }>();
    const readiness = deferred<{ bootId: string }>();
    const result = observeFirstRunStartup({
      observeSetupPip: () => pip.promise,
      observeAuthenticatedReadiness: () => readiness.promise,
    });

    readiness.resolve({ bootId: "boot-a" });
    await expect(Promise.race([
      result,
      new Promise((resolve) => setTimeout(() => resolve("still pending"), 25)),
    ])).rejects.toThrow(/pip.*before.*authenticated readiness/i);
    pip.resolve({ host: "pypi.org" });
  });
});

describe("native smoke runtime replacement", () => {
  const record = (overrides: Record<string, unknown> = {}) => JSON.stringify({
    schema: 1,
    pid: 101,
    host: "127.0.0.1",
    port: 3210,
    token: "token-old",
    runtimeId: "runtime-stamp",
    owner: "cli",
    ...overrides,
  });

  it("accepts only a fresh boot, token, and PID on the same CLI endpoint/runtime", () => {
    const before = parseSmokeDaemonIdentity(record());
    const after = parseSmokeDaemonIdentity(record({ pid: 202, token: "token-new" }));

    expect(assertSmokeRuntimeReplacement({
      before,
      after,
      oldBootId: "boot-old",
      newBootId: "boot-new",
    })).toEqual({
      oldBootId: "boot-old",
      newBootId: "boot-new",
      host: "127.0.0.1",
      port: 3210,
      runtimeId: "runtime-stamp",
    });
  });

  it.each([
    ["boot id", {}, "boot-old"],
    ["ownership token", { pid: 202 }, "boot-new"],
    ["PID", { token: "token-new" }, "boot-new"],
    ["endpoint", { pid: 202, token: "token-new", port: 3211 }, "boot-new"],
    ["runtime", { pid: 202, token: "token-new", runtimeId: "other" }, "boot-new"],
  ])("rejects a replacement without a fresh matching %s", (_name, afterOverrides, newBootId) => {
    expect(() => assertSmokeRuntimeReplacement({
      before: parseSmokeDaemonIdentity(record()),
      after: parseSmokeDaemonIdentity(record(afterOverrides)),
      oldBootId: "boot-old",
      newBootId,
    })).toThrow(/successor|replacement|fresh|endpoint|runtime/i);
  });

  it("never includes a malformed ownership token in parser diagnostics", () => {
    const secret = "OWNERSHIP_TOKEN_SECRET";
    expect(() => parseSmokeDaemonIdentity(JSON.stringify({ token: secret }))).toThrow();
    try {
      parseSmokeDaemonIdentity(JSON.stringify({ token: secret }));
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});

describe("native smoke network milestone order", () => {
  const initial = (): SmokeNetworkState => ({
    setupPipObserved: false,
    initialBootId: undefined,
    routesObserved: false,
    oauthObserved: false,
    restartAccepted: false,
    successorBootId: undefined,
    successorSessionReady: false,
    invalidSearchRejected: false,
    invalidLlmRejected: false,
  });

  it("requires route and OAuth evidence before restart, then both fail-closed probes", () => {
    let state = recordSmokeNetworkMilestone(initial(), { kind: "setup-pip-observed" });
    state = recordSmokeNetworkMilestone(state, { kind: "initial-ready", bootId: "boot-a" });
    state = recordSmokeNetworkMilestone(state, { kind: "routes-observed" });
    state = recordSmokeNetworkMilestone(state, { kind: "oauth-observed" });
    state = recordSmokeNetworkMilestone(state, { kind: "restart-accepted", bootId: "boot-a" });
    state = recordSmokeNetworkMilestone(state, { kind: "successor-ready", bootId: "boot-b" });
    state = recordSmokeNetworkMilestone(state, { kind: "successor-session-ready" });
    state = recordSmokeNetworkMilestone(state, { kind: "invalid-search-rejected" });
    state = recordSmokeNetworkMilestone(state, { kind: "invalid-llm-rejected" });

    expect(state).toEqual({
      setupPipObserved: true,
      initialBootId: "boot-a",
      routesObserved: true,
      oauthObserved: true,
      restartAccepted: true,
      successorBootId: "boot-b",
      successorSessionReady: true,
      invalidSearchRejected: true,
      invalidLlmRejected: true,
    });
  });

  it("requires first-run pip proxy evidence before daemon readiness and rejects late evidence", () => {
    expect(() => recordSmokeNetworkMilestone(initial(), {
      kind: "initial-ready",
      bootId: "boot-a",
    })).toThrow(/pip|setup|before/i);

    let state = recordSmokeNetworkMilestone(initial(), { kind: "setup-pip-observed" });
    state = recordSmokeNetworkMilestone(state, { kind: "initial-ready", bootId: "boot-a" });
    expect(() => recordSmokeNetworkMilestone(state, { kind: "setup-pip-observed" }))
      .toThrow(/pip|setup|order|duplicate/i);
  });

  it.each([
    { kind: "routes-observed" },
    { kind: "restart-accepted", bootId: "boot-a" },
    { kind: "successor-ready", bootId: "boot-b" },
    { kind: "invalid-search-rejected" },
    { kind: "invalid-llm-rejected" },
  ] as const)("rejects an out-of-order $kind milestone", (milestone) => {
    expect(() => recordSmokeNetworkMilestone(initial(), milestone)).toThrow(/order|before|initial/i);
  });

  it("rejects a successor with the initial boot id", () => {
    let state = recordSmokeNetworkMilestone(initial(), { kind: "setup-pip-observed" });
    state = recordSmokeNetworkMilestone(state, { kind: "initial-ready", bootId: "boot-a" });
    state = recordSmokeNetworkMilestone(state, { kind: "routes-observed" });
    state = recordSmokeNetworkMilestone(state, { kind: "oauth-observed" });
    state = recordSmokeNetworkMilestone(state, { kind: "restart-accepted", bootId: "boot-a" });
    expect(() => recordSmokeNetworkMilestone(state, {
      kind: "successor-ready",
      bootId: "boot-a",
    })).toThrow(/fresh|boot/i);
  });
});

describe("assertPathFreeSessionEvent", () => {
  it.each(["sessionPath", "session_path"])("rejects a child %s leak", (field) => {
    expect(() => assertPathFreeSessionEvent({
      type: "subagent_supervisor",
      [field]: "/private/child.jsonl",
    })).toThrow("session path");
  });

  it("rejects a hidden handoff", () => {
    expect(() => assertPathFreeSessionEvent({ content: "<agent_handoff>hidden</agent_handoff>" }))
      .toThrow("hidden handoff");
  });

  it("preserves allowed root-session and public path fields", () => {
    expect(assertPathFreeSessionEvent({
      type: "snapshot",
      session: { sessionFile: "/sessions/root.jsonl" },
      path: "/project/paper.md",
    })).toContain('"sessionFile":"/sessions/root.jsonl"');
  });

  it.each([
    {
      type: "subagent_supervisor",
      event: { type: "session_activity_changed", active: true },
    },
    {
      type: "subagent_supervisor",
      event: {
        type: "subagent_supervisor",
        event: { type: "session_activity_changed", status: "ready", isStreaming: true },
      },
    },
    {
      type: "subagent_supervisor",
      event: { type: "session_activity_changed", status: "running", isStreaming: "true" },
    },
  ])("rejects a private or malformed nested activity frame: %j", (event) => {
    expect(() => assertPathFreeSessionEvent(event)).toThrow(/activity|private/i);
  });

  it("accepts valid nested activity without treating its wrapper as a root replacement", () => {
    const event = {
      type: "subagent_supervisor",
      event: {
        type: "subagent_supervisor",
        event: { type: "session_activity_changed", status: "running", isStreaming: false },
      },
    };
    expect(() => assertPathFreeSessionEvent(event)).not.toThrow();
    const state: SmokeSessionActivityTracker = { sequence: 4 };
    expect(() => recordSmokeSessionActivityReplacement(state, event)).toThrow(/replacement.*type/i);
    expect(state.sequence).toBe(4);
  });
});

describe("native smoke public session activity", () => {
  it("accepts a timeline snapshot with a valid public session state", () => {
    expect(parseSmokeInitialSessionSnapshot({
      type: "snapshot",
      session: { id: "root", status: "ready", isStreaming: false },
      timeline: [],
    })).toEqual({ status: "ready", isStreaming: false });
    expect(parseSmokeInitialSessionSnapshot({
      type: "snapshot",
      session: { id: "root", status: "running", isStreaming: true },
      timeline: [
        {
          kind: "message",
          entryId: "user-entry",
          message: { role: "user", content: "hello" },
        },
        {
          kind: "compaction",
          entryId: "compaction-entry",
          timestamp: "2026-09-01T00:00:00.000Z",
          summary: "Earlier context",
        },
        {
          kind: "branch-summary",
          entryId: "branch-entry",
          timestamp: "2026-09-01T00:01:00.000Z",
        },
      ],
    })).toEqual({ status: "running", isStreaming: true });
  });

  it("rejects legacy messages and malformed initial snapshot state", () => {
    expect(() => parseSmokeInitialSessionSnapshot({
      type: "snapshot",
      session: { status: "ready", isStreaming: false },
      messages: [],
    })).toThrow(/timeline/i);
    expect(() => parseSmokeInitialSessionSnapshot({
      type: "snapshot",
      session: { status: "ready", isStreaming: false },
      timeline: [],
      messages: [],
    })).toThrow(/legacy messages/i);
    expect(() => parseSmokeInitialSessionSnapshot({
      type: "snapshot",
      session: { status: "ready", isStreaming: true },
      timeline: [],
    })).toThrow(/activity|streaming/i);
  });

  it.each([
    { kind: "message", message: { role: "user" } },
    { kind: "message", entryId: "", message: { role: "user" } },
    { kind: "message", entryId: "message", message: null },
    { kind: "message", entryId: "message", message: {} },
    { kind: "message", entryId: "message", message: { role: "" } },
    { kind: "message", entryId: "message", message: { role: 1 } },
    { kind: "compaction", entryId: "compaction", timestamp: "" },
    { kind: "compaction", entryId: "compaction", timestamp: "not-a-date" },
    {
      kind: "compaction",
      entryId: "compaction",
      timestamp: "2026-09-01T00:00:00.000Z",
      summary: 42,
    },
    { kind: "branch-summary", entryId: "", timestamp: "2026-09-01T00:00:00.000Z" },
    { kind: "branch-summary", entryId: "branch" },
    { kind: "unknown", entryId: "unknown" },
  ])("rejects a malformed initial timeline entry: %j", (entry) => {
    expect(() => parseSmokeInitialSessionSnapshot({
      type: "snapshot",
      session: { status: "ready", isStreaming: false },
      timeline: [entry],
    })).toThrow(/timeline/i);
  });

  it("tracks ordered public replacements and requires a post-baseline ready pair", () => {
    let state: SmokeSessionActivityTracker = {
      sequence: 0,
      latest: { status: "ready", isStreaming: false },
    };

    state = recordSmokeSessionActivityReplacement(state, {
      type: "session_activity_changed",
      status: "running",
      isStreaming: true,
    });
    const baseline = state.sequence;
    expect(isSmokeSessionReadyAfter(state, baseline)).toBe(false);

    state = recordSmokeSessionActivityReplacement(state, {
      type: "session_activity_changed",
      status: "running",
      isStreaming: false,
    });
    expect(isSmokeSessionReadyAfter(state, baseline)).toBe(false);

    state = recordSmokeSessionActivityReplacement(state, {
      type: "session_activity_changed",
      status: "ready",
      isStreaming: false,
    });
    expect(state).toEqual({
      sequence: baseline + 2,
      latest: { status: "ready", isStreaming: false },
    });
    expect(isSmokeSessionReadyAfter(state, baseline)).toBe(true);
  });

  it("captures completion after an early ready and requires a later ready replacement", () => {
    let state: SmokeSessionActivityTracker = { sequence: 0 };
    state = recordSmokeSessionActivityReplacement(state, {
      type: "session_activity_changed",
      status: "running",
      isStreaming: true,
    });
    const dispatchBaseline = state.sequence;
    state = recordSmokeSessionActivityReplacement(state, {
      type: "session_activity_changed",
      status: "ready",
      isStreaming: false,
    });
    expect(isSmokeSessionReadyAfter(state, dispatchBaseline)).toBe(true);

    let completionBaseline = captureSmokeCompletionActivityBaseline({
      baseline: undefined,
      activitySequence: state.sequence,
      milestonesComplete: false,
    });
    expect(completionBaseline).toBeUndefined();
    completionBaseline = captureSmokeCompletionActivityBaseline({
      baseline: completionBaseline,
      activitySequence: state.sequence,
      milestonesComplete: true,
    });
    expect(completionBaseline).toBe(state.sequence);
    expect(isSmokeSessionReadyAfter(state, completionBaseline!)).toBe(false);

    state = recordSmokeSessionActivityReplacement(state, {
      type: "session_activity_changed",
      status: "ready",
      isStreaming: false,
    });
    expect(captureSmokeCompletionActivityBaseline({
      baseline: completionBaseline,
      activitySequence: state.sequence,
      milestonesComplete: true,
    })).toBe(completionBaseline);
    expect(isSmokeSessionReadyAfter(state, completionBaseline!)).toBe(true);
  });

  it.each([
    { type: "session_activity_changed", active: true },
    { type: "session_activity_changed", active: false, status: "ready", isStreaming: false },
    { type: "session_activity_changed", status: "ready", isStreaming: true },
    { type: "session_activity_changed", status: "ready" },
    { type: "session_activity_changed", status: "running", isStreaming: "true" },
    { type: "session_activity_changed", status: "stopped", isStreaming: false },
  ])("rejects a private or malformed activity replacement: %j", (event) => {
    expect(() => recordSmokeSessionActivityReplacement({ sequence: 0 }, event))
      .toThrow(/activity|private|replacement/i);
  });
});

describe("fetchSessionEventsBeforeDeadline", () => {
  it("aborts an SSE fetch that has not produced a response before the smoke deadline", async () => {
    let observedSignal: AbortSignal | undefined;
    const pending = fetchSessionEventsBeforeDeadline({
      url: "http://127.0.0.1:3000/api/sessions/session-1/events",
      deadline: Date.now() + 20,
      fetch: async (_input, init) => {
        observedSignal = init?.signal instanceof AbortSignal ? init.signal : undefined;
        return await new Promise<Response>((_resolve, reject) => {
          observedSignal?.addEventListener("abort", () => reject(observedSignal?.reason), { once: true });
        });
      },
    });

    await expect(pending).rejects.toThrow("session SSE subscription did not finish before the native smoke deadline");
    expect(observedSignal?.aborted).toBe(true);
  });

  it("bounds a stalled final dispatch POST with its request inputs and deadline message", async () => {
    let observedInit: RequestInit | undefined;
    let observedSignal: AbortSignal | undefined;
    const timeoutMessage = "post-reload custom Agent dispatch did not finish before the native smoke deadline";
    const pending = fetchSessionEventsBeforeDeadline({
      url: "http://127.0.0.1:3000/api/sessions/root/messages",
      deadline: Date.now() + 20,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "launch smoke-reviewer" }),
      },
      timeoutMessage,
      fetch: async (_input, init) => {
        observedInit = init;
        observedSignal = init?.signal instanceof AbortSignal ? init.signal : undefined;
        return await new Promise<Response>((_resolve, reject) => {
          observedSignal?.addEventListener("abort", () => reject(observedSignal?.reason), { once: true });
        });
      },
    });

    await expect(pending).rejects.toThrow(timeoutMessage);
    expect(observedInit).toMatchObject({
      method: "POST",
      body: JSON.stringify({ message: "launch smoke-reviewer" }),
    });
    expect(new Headers(observedInit?.headers).get("Content-Type")).toBe("application/json");
    expect(observedSignal?.aborted).toBe(true);
  });
});

describe("requestSmokeJsonBeforeDeadline", () => {
  it("aborts and rejects when headers arrive but the response body never completes", async () => {
    let observedSignal: AbortSignal | undefined;
    const pending = requestSmokeJsonBeforeDeadline({
      url: "http://127.0.0.1:3000/api/sessions/root/messages",
      deadline: Date.now() + 20,
      label: "post-reload custom Agent dispatch",
      init: { method: "POST", body: "{}" },
      fetch: async (_input, init) => {
        observedSignal = init?.signal instanceof AbortSignal ? init.signal : undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    await expect(pending).rejects.toThrow(
      "post-reload custom Agent dispatch did not finish before the native smoke deadline",
    );
    expect(observedSignal?.aborted).toBe(true);
  });

  it("parses a successful JSON body and accepts an empty success body", async () => {
    await expect(requestSmokeJsonBeforeDeadline({
      url: "http://127.0.0.1:3000/json",
      deadline: Date.now() + 1_000,
      label: "JSON smoke request",
      fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    })).resolves.toEqual({ ok: true });
    await expect(requestSmokeJsonBeforeDeadline({
      url: "http://127.0.0.1:3000/empty",
      deadline: Date.now() + 1_000,
      label: "empty smoke request",
      fetch: async () => new Response(null, { status: 204 }),
    })).resolves.toBeUndefined();
  });

  it("retains labeled HTTP status and body diagnostics", async () => {
    await expect(requestSmokeJsonBeforeDeadline({
      url: "http://127.0.0.1:3000/failure",
      deadline: Date.now() + 1_000,
      label: "post-reload custom Agent dispatch",
      fetch: async () => new Response("preflight rejected", { status: 503 }),
    })).rejects.toThrow(
      "post-reload custom Agent dispatch failed (503): preflight rejected",
    );
  });
});

function validationFixture(python: string): { python: string; script: string; prefix: string; root: string } {
  const root = tempDir();
  for (const module of ["arxiv", "markitdown"]) writeFileSync(join(root, `${module}.py`), "");
  const script = join(root, "validate.py");
  writeVenvValidationScript(script);
  const prefixResult = spawnSync(python, ["-c", "import sys; print(sys.prefix)"], { encoding: "utf8" });
  if (prefixResult.status !== 0) throw new Error(`failed to inspect Python prefix: ${prefixResult.stderr}`);
  return { python, script, prefix: prefixResult.stdout.trim(), root };
}

describe("resolveSmokePython", () => {
  it("prefers an explicit absolute smoke Python", () => {
    expect(resolveSmokePython({
      explicit: "/toolcache/python/bin/python",
      which: () => undefined,
      exists: () => true,
    })).toBe("/toolcache/python/bin/python");
  });

  it("falls back from python3 to python", () => {
    expect(resolveSmokePython({
      which: (name) => name === "python" ? "/python/python" : undefined,
      exists: () => true,
    })).toBe("/python/python");
  });

  it.each([undefined, "python3"])(
    "rejects an absent or relative explicit interpreter (%s)",
    (explicit) => {
      expect(() => resolveSmokePython({
        explicit,
        which: () => undefined,
        exists: () => false,
      })).toThrow("EASYRESEARCH_SMOKE_PYTHON");
    },
  );
});

describe("resolveSmokePowerShell", () => {
  it("prefers pwsh.exe over Windows PowerShell", () => {
    expect(resolveSmokePowerShell({
      which: (name) => name === "pwsh.exe"
        ? "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
        : "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      exists: () => true,
    })).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  });

  it("falls back to an existing absolute powershell.exe", () => {
    expect(resolveSmokePowerShell({
      which: (name) => name === "powershell.exe"
        ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
        : undefined,
      exists: () => true,
    })).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  });

  it.each([
    ["missing", undefined, false],
    ["relative", "PowerShell\\7\\pwsh.exe", true],
    ["nonexistent", "C:\\Program Files\\PowerShell\\7\\pwsh.exe", false],
  ] as const)("rejects a %s PowerShell executable", (_name, candidate, candidateExists) => {
    expect(() => resolveSmokePowerShell({
      which: () => candidate,
      exists: () => candidateExists,
    }))
      .toThrow("Windows native smoke requires an existing absolute pwsh.exe or powershell.exe");
  });
});

describe("resolveSmokeWindowsSystem32", () => {
  it("finds SystemRoot case-insensitively and requires its exact where.exe", () => {
    const checked: string[] = [];

    const system32 = resolveSmokeWindowsSystem32(
      { sYsTeMrOoT: "C:\\Windows" },
      (path) => {
        checked.push(path);
        return path === "C:\\Windows\\System32\\where.exe";
      },
    );

    expect(system32).toBe("C:\\Windows\\System32");
    expect(checked).toEqual(["C:\\Windows\\System32\\where.exe"]);
  });

  it.each([
    ["missing", {}],
    ["relative", { SystemRoot: "Windows" }],
  ] as const)("rejects a %s SystemRoot", (_name, env) => {
    expect(() => resolveSmokeWindowsSystem32(env, () => true))
      .toThrow("Windows native smoke requires a non-empty absolute SystemRoot");
  });

  it("reports the required where.exe path when it is absent", () => {
    expect(() => resolveSmokeWindowsSystem32(
      { SYSTEMROOT: "C:\\Windows" },
      () => false,
    )).toThrow("Windows native smoke requires where.exe at C:\\Windows\\System32\\where.exe");
  });
});

describe("createCompiledChildEnv", () => {
  it.each(["linux", "darwin"] as const)(
    "constructs a CPython-only child PATH with bounded pip retries on %s",
    (platform) => {
      const env = createCompiledChildEnv({
        base: { PATH: "/node:/bun", SECRET: "kept" },
        python: "/toolcache/python/bin/python",
        platform,
      });

      expect(env.PATH).toBe("/toolcache/python/bin");
      expect(env.PIP_RETRIES).toBe("3");
      expect(env.PIP_DEFAULT_TIMEOUT).toBe("30");
      expect(env.PIP_NO_CACHE_DIR).toBe("1");
      expect(env.PATH).not.toContain("node");
      expect(env.PATH).not.toContain("bun");
      expect(env.SECRET).toBe("kept");
    },
  );

  it("exposes exactly the Python, preflight PowerShell, and validated System32 directories on Windows", () => {
    const env = createCompiledChildEnv({
      base: { Path: "C:\\node", PATH: "C:\\bun", SAFE: "kept" },
      python: "C:\\hostedtoolcache\\Python\\3.12\\x64\\python.exe",
      powershellExecutable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      windowsSystem32: "C:\\Windows\\System32",
      platform: "win32",
      exists: (path) => path === "C:\\Windows\\System32\\where.exe",
    });

    expect(env.PATH).toBe(
      "C:\\hostedtoolcache\\Python\\3.12\\x64;C:\\Program Files\\PowerShell\\7;C:\\Windows\\System32",
    );
    expect(Object.keys(env).filter((key) => key.toUpperCase() === "PATH")).toEqual(["PATH"]);
    expect(env.SAFE).toBe("kept");
  });

  it.each([
    ["missing", undefined],
    ["relative", "PowerShell\\7\\pwsh.exe"],
  ] as const)("rejects a %s PowerShell executable on Windows", (_name, powershellExecutable) => {
    expect(() => createCompiledChildEnv({
      base: {},
      python: "C:\\hostedtoolcache\\Python\\3.12\\x64\\python.exe",
      platform: "win32",
      powershellExecutable,
      windowsSystem32: "C:\\Windows\\System32",
      exists: () => true,
    })).toThrow("Windows native smoke requires an absolute PowerShell executable");
  });

  it.each([
    ["missing", undefined],
    ["relative", "Windows\\System32"],
  ] as const)("rejects a %s System32 directory on Windows", (_name, windowsSystem32) => {
    expect(() => createCompiledChildEnv({
      base: {},
      python: "C:\\hostedtoolcache\\Python\\3.12\\x64\\python.exe",
      platform: "win32",
      powershellExecutable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      windowsSystem32,
      exists: () => true,
    })).toThrow("Windows native smoke requires an absolute System32 directory");
  });

  it("rejects a System32 directory without where.exe", () => {
    expect(() => createCompiledChildEnv({
      base: {},
      python: "C:\\hostedtoolcache\\Python\\3.12\\x64\\python.exe",
      platform: "win32",
      powershellExecutable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      windowsSystem32: "C:\\Windows\\System32",
      exists: () => false,
    })).toThrow("Windows native smoke requires where.exe at C:\\Windows\\System32\\where.exe");
  });

  it.each(["linux", "darwin"] as const)(
    "rejects a supplied PowerShell executable on %s",
    (platform) => {
      expect(() => createCompiledChildEnv({
        base: {},
        python: "/toolcache/python/bin/python",
        platform,
        powershellExecutable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      })).toThrow("PowerShell executable is only valid for Windows native smoke");
    },
  );

  it.each(["linux", "darwin"] as const)(
    "rejects a supplied Windows System32 directory on %s",
    (platform) => {
      expect(() => createCompiledChildEnv({
        base: {},
        python: "/toolcache/python/bin/python",
        platform,
        windowsSystem32: "C:\\Windows\\System32",
        exists: () => true,
      })).toThrow("System32 directory is only valid for Windows native smoke");
    },
  );

  it("removes ambient Python import contamination case-insensitively", () => {
    const env = createCompiledChildEnv({
      base: {
        PYTHONPATH: "/ambient/modules",
        PythonHome: "/ambient/python",
        SAFE_VALUE: "kept",
      },
      python: "/toolcache/python/bin/python",
      platform: "linux",
      overrides: { PYTHONUSERBASE: "/ambient/user-site" },
    });

    expect(Object.keys(env).map((key) => key.toUpperCase())).not.toEqual(
      expect.arrayContaining(["PYTHONPATH", "PYTHONHOME", "PYTHONUSERBASE"]),
    );
    expect(env.SAFE_VALUE).toBe("kept");
  });
});

describe("skillVenvPython", () => {
  it("uses the POSIX venv interpreter", () => {
    expect(skillVenvPython("/agent", "linux")).toBe("/agent/venv/bin/python");
  });

  it("uses the Windows venv interpreter", () => {
    expect(skillVenvPython("C:\\agent", "win32")).toBe("C:\\agent\\venv\\Scripts\\python.exe");
  });
});

describe("runVenvValidation", () => {
  it("accepts only the sentinel from the expected venv prefix", () => {
    const result = runVenvValidation({
      python: "/agent/venv/bin/python",
      script: "/tmp/validate.py",
      spawn: () => ({ status: 0, stdout: "easyresearch-venv-ok\n", stderr: "" }),
    });

    expect(result.stdout).toContain("easyresearch-venv-ok");
  });

  it("runs Python in isolated mode", () => {
    let actualArgs: readonly string[] = [];
    runVenvValidation({
      python: "/agent/venv/bin/python",
      script: "/tmp/validate.py",
      spawn: (_command, args) => {
        actualArgs = args;
        return { status: 0, stdout: "easyresearch-venv-ok\n", stderr: "" };
      },
    });

    expect(actualArgs).toEqual(["-I", "/tmp/validate.py"]);
  });

  it("rejects a missing interpreter with its path and stderr", () => {
    const python = join(tempDir(), "missing", "python");
    const escapedPython = python.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    expect(() => runVenvValidation({
      python,
      script: "/tmp/validate.py",
      exists: () => false,
      spawn: () => ({ status: 0, stdout: "", stderr: "not started" }),
    })).toThrow(new RegExp(`${escapedPython}.*stderr`, "s"));
  });

  it("reports spawn errors with the interpreter path and captured stderr", () => {
    expect(() => runVenvValidation({
      python: "/agent/venv/bin/python",
      script: "/tmp/validate.py",
      exists: () => true,
      spawn: () => ({
        status: null,
        stdout: "partial output",
        stderr: "spawn stderr",
        error: new Error("spawn failed"),
      }),
    })).toThrow(/\/agent\/venv\/bin\/python.*spawn stderr/s);
  });

  it("reports non-zero status with the interpreter path and captured stderr", () => {
    expect(() => runVenvValidation({
      python: "/agent/venv/bin/python",
      script: "/tmp/validate.py",
      exists: () => true,
      spawn: () => ({ status: 9, stdout: "", stderr: "import failed" }),
    })).toThrow(/\/agent\/venv\/bin\/python.*import failed/s);
  });

  it("rejects successful output without the sentinel and includes stderr", () => {
    expect(() => runVenvValidation({
      python: "/agent/venv/bin/python",
      script: "/tmp/validate.py",
      exists: () => true,
      spawn: () => ({ status: 0, stdout: "unexpected", stderr: "validation warning" }),
    })).toThrow(/\/agent\/venv\/bin\/python.*validation warning/s);
  });

  it("rejects a near-match sentinel line", () => {
    expect(() => runVenvValidation({
      python: "/agent/venv/bin/python",
      script: "/tmp/validate.py",
      exists: () => true,
      spawn: () => ({ status: 0, stdout: "easyresearch-venv-ok-invalid\n", stderr: "near match" }),
    })).toThrow(/\/agent\/venv\/bin\/python.*near match/s);
  });
});

it("validates an isolated release venv without a search package", () => {
  const script = join(tempDir(), "validate.py");
  writeVenvValidationScript(script);
  const text = readFileSync(script, "utf8");
  expect(text).toContain("import arxiv");
  expect(text).toContain("import markitdown");
  expect(text).not.toContain("import ddgr");
});

describe.skipIf(systemPython === undefined)(
  "writeVenvValidationScript (skipped: no Python interpreter on PATH)",
  () => {
    it("imports the skill packages and emits the sentinel for the expected prefix", () => {
      const fixture = validationFixture(systemPython!);
      const result = spawnSync(fixture.python, [fixture.script], {
        encoding: "utf8",
        env: {
          ...process.env,
          EASYRESEARCH_VENV: fixture.prefix,
          PYTHONPATH: fixture.root,
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("easyresearch-venv-ok");
    });

    it("rejects packages supplied only through ambient PYTHONPATH", () => {
      const fixture = validationFixture(systemPython!);
      const contaminatedEnv = {
        ...process.env,
        EASYRESEARCH_VENV: fixture.prefix,
        PYTHONPATH: fixture.root,
      };
      const ambientResult = spawnSync(fixture.python, [fixture.script], {
        encoding: "utf8",
        env: contaminatedEnv,
      });
      expect(ambientResult.status, ambientResult.stderr).toBe(0);

      expect(() => runVenvValidation({
        python: fixture.python,
        script: fixture.script,
        spawn: (command, args, options) => spawnSync(command, [...args], {
          ...options,
          env: contaminatedEnv,
        }),
      })).toThrow(/No module named/u);
    });

    it("rejects packages supplied only through the ambient Python user site", () => {
      const fixture = validationFixture(systemPython!);
      const userBase = join(fixture.root, "user-base");
      const userSiteResult = spawnSync(fixture.python, ["-c", "import site; print(site.getusersitepackages())"], {
        encoding: "utf8",
        env: { ...process.env, PYTHONUSERBASE: userBase },
      });
      if (userSiteResult.status !== 0) throw new Error(`failed to inspect Python user site: ${userSiteResult.stderr}`);
      const userSite = userSiteResult.stdout.trim();
      mkdirSync(userSite, { recursive: true });
      for (const module of ["arxiv", "markitdown"]) writeFileSync(join(userSite, `${module}.py`), "");
      const contaminatedEnv = {
        ...process.env,
        EASYRESEARCH_VENV: fixture.prefix,
        PYTHONUSERBASE: userBase,
      };
      const ambientResult = spawnSync(fixture.python, [fixture.script], {
        encoding: "utf8",
        env: contaminatedEnv,
      });
      expect(ambientResult.status, ambientResult.stderr).toBe(0);

      expect(() => runVenvValidation({
        python: fixture.python,
        script: fixture.script,
        spawn: (command, args, options) => spawnSync(command, [...args], {
          ...options,
          env: contaminatedEnv,
        }),
      })).toThrow(/No module named/u);
    });

    it("rejects a Python process outside EASYRESEARCH_VENV", () => {
      const fixture = validationFixture(systemPython!);
      const result = spawnSync(fixture.python, [fixture.script], {
        encoding: "utf8",
        env: {
          ...process.env,
          EASYRESEARCH_VENV: join(fixture.root, "another-venv"),
          PYTHONPATH: fixture.root,
        },
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("wrong venv prefix");
    });

    it("validates npm-visible proxy variables, Playwright Search variables, and a real Python All-route request", async () => {
      let loopbackRequests = 0;
      const upstream = createServer((_request, response) => {
        if (_request.url === "/loopback") loopbackRequests += 1;
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.end(_request.url === "/loopback" ? "python-loopback-route-ok" : "python-child-route-ok");
      });
      const upstreamUrl = await listen(upstream);
      const proxy = await startRecordingHttpProxy({
        name: "all",
        fakeTargets: { "child.native-smoke.invalid": upstreamUrl },
      });
      asyncCleanups.push(() => proxy.close());
      const root = tempDir();
      for (const module of ["arxiv", "markitdown"]) writeFileSync(join(root, `${module}.py`), "");
      const prefixResult = spawnSync(systemPython!, ["-c", "import sys; print(sys.prefix)"], { encoding: "utf8" });
      expect(prefixResult.status, prefixResult.stderr).toBe(0);
      const script = join(root, "validate-network.py");
      const searchProxy = "http://127.0.0.1:45678";
      const requiredBypass = "localhost,127.0.0.1,::1";
      const actualBypass = "internal.example,localhost,127.0.0.1,::1,localhost.,[::1]";
      writeVenvValidationScript(script, {
        allProxy: proxy.url,
        searchProxy,
        bypass: requiredBypass,
        targetUrl: "http://child.native-smoke.invalid/probe?credential=DO_NOT_RECORD",
        targetSentinel: "python-child-route-ok",
        loopbackTargetUrl: `${upstreamUrl}/loopback`,
        loopbackTargetSentinel: "python-loopback-route-ok",
      });
      const child = spawn(systemPython!, [script], {
        env: {
          ...process.env,
          EASYRESEARCH_VENV: prefixResult.stdout.trim(),
          PYTHONPATH: root,
          HTTP_PROXY: proxy.url,
          http_proxy: proxy.url,
          HTTPS_PROXY: proxy.url,
          https_proxy: proxy.url,
          ALL_PROXY: proxy.url,
          all_proxy: proxy.url,
          PIP_PROXY: proxy.url,
          NO_PROXY: actualBypass,
          no_proxy: actualBypass,
          PLAYWRIGHT_MCP_PROXY_SERVER: searchProxy,
          PLAYWRIGHT_MCP_PROXY_BYPASS: actualBypass,
          npm_config_proxy: proxy.url,
          NPM_CONFIG_PROXY: proxy.url,
          npm_config_https_proxy: proxy.url,
          NPM_CONFIG_HTTPS_PROXY: proxy.url,
          npm_config_noproxy: actualBypass,
          NPM_CONFIG_NOPROXY: actualBypass,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => { stdout += chunk; });
      child.stderr?.on("data", (chunk) => { stderr += chunk; });
      const status = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });

      expect(status, stderr).toBe(0);
      expect(stdout).toContain("easyresearch-venv-ok");
      expect(stdout).toContain("easyresearch-network-route-ok");
      expect(loopbackRequests).toBe(1);
      expect(proxy.records()).toEqual([{
        sequence: 1,
        proxy: "all",
        kind: "fake-target",
        method: "GET",
        host: "child.native-smoke.invalid",
        port: 80,
      }]);
      expect(formatSmokeProxyDiagnostics(proxy.records())).not.toContain("DO_NOT_RECORD");

      const wrongNpmRoute = spawn(systemPython!, [script], {
        env: {
          ...process.env,
          EASYRESEARCH_VENV: prefixResult.stdout.trim(),
          PYTHONPATH: root,
          HTTP_PROXY: proxy.url,
          http_proxy: proxy.url,
          HTTPS_PROXY: proxy.url,
          https_proxy: proxy.url,
          ALL_PROXY: proxy.url,
          all_proxy: proxy.url,
          PIP_PROXY: proxy.url,
          NO_PROXY: actualBypass,
          no_proxy: actualBypass,
          PLAYWRIGHT_MCP_PROXY_SERVER: searchProxy,
          PLAYWRIGHT_MCP_PROXY_BYPASS: actualBypass,
          npm_config_proxy: "http://wrong-npm-route.invalid",
          NPM_CONFIG_PROXY: proxy.url,
          npm_config_https_proxy: proxy.url,
          NPM_CONFIG_HTTPS_PROXY: proxy.url,
          npm_config_noproxy: actualBypass,
          NPM_CONFIG_NOPROXY: actualBypass,
        },
      });
      let wrongNpmStdout = "";
      let wrongNpmStderr = "";
      wrongNpmRoute.stdout?.setEncoding("utf8");
      wrongNpmRoute.stderr?.setEncoding("utf8");
      wrongNpmRoute.stdout?.on("data", (chunk) => { wrongNpmStdout += chunk; });
      wrongNpmRoute.stderr?.on("data", (chunk) => { wrongNpmStderr += chunk; });
      const wrongNpmStatus = await new Promise<number | null>((resolve, reject) => {
        wrongNpmRoute.once("error", reject);
        wrongNpmRoute.once("close", resolve);
      });
      expect(wrongNpmStatus, wrongNpmStdout).not.toBe(0);
      expect(wrongNpmStderr).toContain("wrong npm_config_proxy proxy route");

      const wrongPipRoute = spawn(systemPython!, [script], {
        env: {
          ...process.env,
          EASYRESEARCH_VENV: prefixResult.stdout.trim(),
          PYTHONPATH: root,
          HTTP_PROXY: proxy.url,
          http_proxy: proxy.url,
          HTTPS_PROXY: proxy.url,
          https_proxy: proxy.url,
          ALL_PROXY: proxy.url,
          all_proxy: proxy.url,
          PIP_PROXY: "http://wrong-pip-route.invalid",
          NO_PROXY: actualBypass,
          no_proxy: actualBypass,
          PLAYWRIGHT_MCP_PROXY_SERVER: searchProxy,
          PLAYWRIGHT_MCP_PROXY_BYPASS: actualBypass,
          npm_config_proxy: proxy.url,
          NPM_CONFIG_PROXY: proxy.url,
          npm_config_https_proxy: proxy.url,
          NPM_CONFIG_HTTPS_PROXY: proxy.url,
          npm_config_noproxy: actualBypass,
          NPM_CONFIG_NOPROXY: actualBypass,
        },
      });
      let wrongPipStdout = "";
      let wrongPipStderr = "";
      wrongPipRoute.stdout?.setEncoding("utf8");
      wrongPipRoute.stderr?.setEncoding("utf8");
      wrongPipRoute.stdout?.on("data", (chunk) => { wrongPipStdout += chunk; });
      wrongPipRoute.stderr?.on("data", (chunk) => { wrongPipStderr += chunk; });
      const wrongPipStatus = await new Promise<number | null>((resolve, reject) => {
        wrongPipRoute.once("error", reject);
        wrongPipRoute.once("close", resolve);
      });
      expect(wrongPipStatus, wrongPipStdout).not.toBe(0);
      expect(wrongPipStderr).toContain("wrong PIP_PROXY proxy route");
    });
  },
);

describe("first-run process support", () => {
  it("allows the 600-second setup child timeout to return first", () => {
    expect(FIRST_RUN_CEILING_MS).toBeGreaterThan(600_000);
  });

  it("waits for a process to exit without terminating it", async () => {
    let checks = 0;
    let terminateCalls = 0;

    await expect(settleProcess({
      pid: 42,
      deadline: 100,
      now: () => 0,
      isAlive: () => ++checks < 3,
      terminateTree: () => { terminateCalls += 1; },
      sleep: async () => {},
    })).resolves.toBe("exited");
    expect(terminateCalls).toBe(0);
  });

  it("terminates and settles a process that reaches its deadline", async () => {
    let alive = true;
    let terminateCalls = 0;

    await expect(settleProcess({
      pid: 42,
      deadline: 100,
      now: () => 100,
      isAlive: () => alive,
      terminateTree: () => {
        terminateCalls += 1;
        alive = false;
      },
      sleep: async () => {},
    })).rejects.toThrow("exceeded first-run deadline");
    expect(terminateCalls).toBe(1);
    expect(alive).toBe(false);
  });

  it("terminates immediately after an earlier smoke failure", async () => {
    let alive = true;

    await expect(settleProcess({
      pid: 42,
      deadline: 100,
      terminateImmediately: true,
      now: () => 0,
      isAlive: () => alive,
      terminateTree: () => { alive = false; },
      sleep: async () => {},
    })).resolves.toBe("terminated");
    expect(alive).toBe(false);
  });
});

describe("readTextFileWithRetry", () => {
  it("retries a transient capture-file lock", async () => {
    let reads = 0;
    let sleeps = 0;

    const content = await readTextFileWithRetry({
      path: "/tmp/first-run-stdout.txt",
      attempts: 3,
      read: () => {
        reads += 1;
        if (reads < 3) throw new Error("file is locked");
        return "pip output";
      },
      sleep: async () => { sleeps += 1; },
    });

    expect(content).toBe("pip output");
    expect(reads).toBe(3);
    expect(sleeps).toBe(2);
  });

  it("returns the final capture error after the bounded attempts", async () => {
    let reads = 0;
    const content = await readTextFileWithRetry({
      path: "/tmp/first-run-stderr.txt",
      attempts: 2,
      read: () => {
        reads += 1;
        throw new Error("still locked");
      },
      sleep: async () => {},
    });

    expect(content).toContain("capture unavailable");
    expect(content).toContain("still locked");
    expect(reads).toBe(2);
  });
});

describe("collectLaunchOutput", () => {
  it("does not read captures for an asynchronous launch", () => {
    const reads: string[] = [];

    const output = collectLaunchOutput({
      asynchronous: true,
      stdoutPath: "/tmp/first-run-stdout.txt",
      stderrPath: "/tmp/first-run-stderr.txt",
      read: (path) => {
        reads.push(path);
        throw new Error("async capture is still owned by the client");
      },
    });

    expect(output).toEqual({ stdout: "", stderr: "" });
    expect(reads).toEqual([]);
  });

  it("reads both captures after a synchronous launch", () => {
    const reads: string[] = [];

    const output = collectLaunchOutput({
      asynchronous: false,
      stdoutPath: "/tmp/first-run-stdout.txt",
      stderrPath: "/tmp/first-run-stderr.txt",
      read: (path) => {
        reads.push(path);
        return path.endsWith("stdout.txt") ? "setup stdout" : "setup stderr";
      },
    });

    expect(output).toEqual({ stdout: "setup stdout", stderr: "setup stderr" });
    expect(reads).toEqual(["/tmp/first-run-stdout.txt", "/tmp/first-run-stderr.txt"]);
  });
});

describe("buildWindowsShutdownScript", () => {
  const options = {
    binary: "C:\\release\\O'Brien\\easyresearch.exe",
    args: ["ex'it", "--reason=can't stop"],
    stdoutPath: "C:\\smoke\\O'Brien\\shutdown-stdout.txt",
    stderrPath: "C:\\smoke\\O'Brien\\shutdown-stderr.txt",
    statusPath: "C:\\smoke\\O'Brien\\shutdown-status.txt",
    powershellErrorPath: "C:\\smoke\\O'Brien\\shutdown-powershell-error.txt",
  };
  const invocation = "  & 'C:\\release\\O''Brien\\easyresearch.exe' 'ex''it' '--reason=can''t stop' 1> 'C:\\smoke\\O''Brien\\shutdown-stdout.txt' 2> 'C:\\smoke\\O''Brien\\shutdown-stderr.txt'";

  it("directly invokes the shutdown binary with PowerShell-escaped paths and arguments", () => {
    const script = buildWindowsShutdownScript(options);

    expect(script).toContain(invocation);
    expect(script).toContain("'C:\\smoke\\O''Brien\\shutdown-powershell-error.txt'");
    expect(script).not.toContain("Start-Process");
  });

  it("captures the native exit status immediately and fails without Process.ExitCode", () => {
    const script = buildWindowsShutdownScript(options);
    const statusFlow = [
      invocation,
      "  $status = $LASTEXITCODE",
      "  Set-Content -LiteralPath 'C:\\smoke\\O''Brien\\shutdown-status.txt' -Value ([string]$status) -Encoding ascii",
      "  if ($status -ne 0) { throw \"Windows shutdown client exited with status $status\" }",
    ].join("; ");

    expect(script).toContain(statusFlow);
    expect(script).not.toContain(".ExitCode");
    expect(script).not.toContain("WaitForExit");
  });
});

describe("buildWindowsShutdownLauncherScript", () => {
  const options = {
    powershell: "C:\\Windows\\O'Brien\\powershell.exe",
    wrapperPath: "C:\\smoke root\\O'Brien\\shutdown-wrapper.ps1",
    pidPath: "C:\\smoke root\\O'Brien\\shutdown-wrapper.pid",
    taskkill: "C:\\Windows\\O'Brien\\taskkill.exe",
    powershellErrorPath: "C:\\smoke root\\O'Brien\\shutdown-powershell-error.txt",
  };

  it("starts only the inner wrapper through the absolute PowerShell executable", () => {
    const script = buildWindowsShutdownLauncherScript(options);
    const invocation = "  $process = Start-Process -FilePath 'C:\\Windows\\O''Brien\\powershell.exe' -ArgumentList @('-NoProfile', '-NonInteractive', '-File', '\"C:\\smoke root\\O''Brien\\shutdown-wrapper.ps1\"') -WindowStyle Hidden -PassThru";

    expect(script).toContain(invocation);
    expect(script.match(/Start-Process/g)).toHaveLength(1);
    expect(script).toContain("  Set-Content -LiteralPath 'C:\\smoke root\\O''Brien\\shutdown-wrapper.pid' -Value $process.Id -Encoding ascii");
    expect(script).toContain("'C:\\smoke root\\O''Brien\\shutdown-powershell-error.txt'");
    expect(script).not.toContain("easyresearch.exe");
    expect(script).not.toContain(".ExitCode");
  });

  it("waits 30000ms then kills the wrapper process tree without reading ExitCode", () => {
    const script = buildWindowsShutdownLauncherScript(options);
    const timeoutFlow = [
      "  if (-not $process.WaitForExit(30000)) {",
      "    & 'C:\\Windows\\O''Brien\\taskkill.exe' /PID $($process.Id) /T /F | Out-Null",
      "    throw 'Windows shutdown wrapper timed out after 30000ms'",
      "  }",
    ].join("; ");

    expect(script).toContain(timeoutFlow);
    expect(script).not.toContain("WaitForExit()");
    expect(script).not.toContain(".ExitCode");
  });
});

describe("requireZeroProcessStatus", () => {
  it("accepts a durable zero exit status", () => {
    expect(() => requireZeroProcessStatus({
      label: "Windows shutdown client",
      statusText: "0\r\n",
      stdout: "service stopped",
      stderr: "",
    })).not.toThrow();
  });

  it("reports a nonzero exit status with captured diagnostics", () => {
    expect(() => requireZeroProcessStatus({
      label: "Windows shutdown client",
      statusText: "7",
      stdout: "partial output",
      stderr: "shutdown failed",
    })).toThrow(/Windows shutdown client.*status 7.*partial output.*shutdown failed/s);
  });

  it("rejects a missing timeout/status result", () => {
    expect(() => requireZeroProcessStatus({
      label: "Windows shutdown client",
      statusText: "timeout",
      stdout: "",
      stderr: "",
    })).toThrow(/valid exit status/);
  });
});

describe("finishSmokeCleanup", () => {
  function successfulCleanup(overrides: Partial<Parameters<typeof finishSmokeCleanup>[0]> = {}) {
    return {
      shutdown: vi.fn(),
      stopAuxiliary: vi.fn(),
      verifyDaemonStopped: vi.fn(),
      removeRoot: vi.fn(),
      ...overrides,
    };
  }

  it("waits for shutdown and daemon verification before deleting the root", async () => {
    const order: string[] = [];
    await finishSmokeCleanup(successfulCleanup({
      shutdown: () => { order.push("shutdown"); },
      stopAuxiliary: () => { order.push("auxiliary"); },
      verifyDaemonStopped: () => { order.push("daemon-stopped"); },
      removeRoot: () => { order.push("root-removed"); },
    }));

    expect(order).toEqual(["shutdown", "auxiliary", "daemon-stopped", "root-removed"]);
  });

  it("does not silently accept a cleanup failure", async () => {
    await expect(finishSmokeCleanup(successfulCleanup({
      removeRoot: () => { throw new Error("root is still locked"); },
    }))).rejects.toThrow(/temporary root removal.*root is still locked/);
  });

  it("preserves the primary failure and attaches cleanup diagnostics", async () => {
    const primary = new Error("stage dispatch failed");
    let thrown: unknown;
    try {
      await finishSmokeCleanup(successfulCleanup({
        primaryError: primary,
        shutdown: () => { throw new Error("exit client timed out"); },
      }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(primary);
    expect(primary.message).toMatch(/^stage dispatch failed/);
    expect(primary.message).toContain("shutdown: exit client timed out");
    expect(primary.stack).toContain("Cleanup diagnostics");
  });

  it("rethrows the primary failure after otherwise successful cleanup", async () => {
    const primary = new Error("model request failed");
    await expect(finishSmokeCleanup(successfulCleanup({ primaryError: primary }))).rejects.toBe(primary);
  });

  it("does not delete the root when daemon termination was not verified", async () => {
    const removeRoot = vi.fn();
    await expect(finishSmokeCleanup(successfulCleanup({
      verifyDaemonStopped: () => { throw new Error("daemon 42 is still alive"); },
      removeRoot,
    }))).rejects.toThrow("daemon 42 is still alive");
    expect(removeRoot).not.toHaveBeenCalled();
  });
});

describe("venvToolCommand", () => {
  it("uses the runtime POSIX venv interpreter", () => {
    const command = venvToolCommand("linux", "/tmp/native validate.py");
    expect(command).toContain("$EASYRESEARCH_VENV/bin/python");
    expect(command).toContain('"/tmp/native validate.py"');
    expect(command).not.toContain("/agent/venv");
  });

  it("uses the runtime Windows venv interpreter", () => {
    const command = venvToolCommand("win32", "C:\\temp\\native validate.py");
    expect(command).toContain("Join-Path $env:EASYRESEARCH_VENV 'Scripts\\python.exe'");
    expect(command).toContain("'C:\\temp\\native validate.py'");
    expect(command).not.toContain("${EASYRESEARCH_VENV}");
    expect(command).not.toContain("C:\\agent\\venv");
  });

  it("PowerShell-quotes apostrophes in the Windows validation path", () => {
    expect(venvToolCommand("win32", "C:\\O'Brien\\validate.py"))
      .toContain("'C:\\O''Brien\\validate.py'");
  });
});

describe("recordSmokeAcceptanceMilestone", () => {
  const initialState = (): SmokeModelState => ({
    baselineConfigurationGeneration: undefined,
    externalResourcesWritten: false,
    acceptedConfigurationGeneration: undefined,
    rootAppliedConfigurationGeneration: undefined,
    customDispatchIssued: false,
    parentWorkingObserved: false,
    childSkillObserved: false,
    stageShellIssued: false,
    venvValidated: false,
    stageCompleted: false,
    terminalHandoffObserved: false,
    complete: false,
    completedRequests: 0,
  });

  it("records baseline, external writes, accepted generation, and root application in that order", () => {
    let state = recordSmokeAcceptanceMilestone(initialState(), {
      kind: "baseline-snapshot",
      generation: 7,
    });
    state = recordSmokeAcceptanceMilestone(state, { kind: "external-resources-written" });
    state = recordSmokeAcceptanceMilestone(state, {
      kind: "accepted-generation",
      generation: 8,
    });
    state = recordSmokeAcceptanceMilestone(state, {
      kind: "root-applied-generation",
      generation: 8,
    });

    expect(state).toMatchObject({
      baselineConfigurationGeneration: 7,
      externalResourcesWritten: true,
      acceptedConfigurationGeneration: 8,
      rootAppliedConfigurationGeneration: 8,
      customDispatchIssued: false,
      completedRequests: 0,
    });
  });

  it.each([
    ["external write before baseline", { kind: "external-resources-written" }],
    ["accepted generation before external write", { kind: "accepted-generation", generation: 8 }],
    ["root application before acceptance", { kind: "root-applied-generation", generation: 8 }],
  ] as const)("rejects %s", (_name, milestone) => {
    expect(() => recordSmokeAcceptanceMilestone(initialState(), milestone)).toThrow(/order|baseline|external|accepted/i);
  });

  it("rejects accepted or applied generations that do not advance the baseline", () => {
    let state = recordSmokeAcceptanceMilestone(initialState(), {
      kind: "baseline-snapshot",
      generation: 7,
    });
    state = recordSmokeAcceptanceMilestone(state, { kind: "external-resources-written" });
    expect(() => recordSmokeAcceptanceMilestone(state, {
      kind: "accepted-generation",
      generation: 7,
    })).toThrow(/greater than.*baseline/i);

    state = recordSmokeAcceptanceMilestone(state, {
      kind: "accepted-generation",
      generation: 8,
    });
    expect(() => recordSmokeAcceptanceMilestone(state, {
      kind: "root-applied-generation",
      generation: 7,
    })).toThrow(/greater than.*baseline/i);
  });
});

describe("selectSmokeWebFetchAction", () => {
  const scenario: SmokeWebFetchScenario = {
    targetUrl: "http://search.native-smoke.invalid/article",
    expectedResultText: "deterministic-search-result",
    completionText: "Search route complete.",
    forbiddenResultText: ["http://127.0.0.1:9876", "SEARCH_PROXY_SECRET"],
  };
  const initial = (): SmokeWebFetchState => ({
    toolIssued: false,
    resultObserved: false,
    completedRequests: 0,
  });
  const request = (...messages: Array<{ role: string; tool_call_id?: string; content: unknown }>) => ({
    tools: [{ function: { name: "webfetch" } }],
    messages,
  });

  it("issues one deterministic webfetch and completes only after its correlated result", () => {
    const issued = selectSmokeWebFetchAction(request(), scenario, initial());
    const completed = selectSmokeWebFetchAction(request({
      role: "tool",
      tool_call_id: "call_native_webfetch",
      content: "source\ndeterministic-search-result\n",
    }), scenario, issued.state);

    expect(issued).toEqual({
      action: {
        kind: "tool",
        id: "call_native_webfetch",
        name: "webfetch",
        arguments: JSON.stringify({
          url: "http://search.native-smoke.invalid/article",
          format: "text",
          timeout: 30,
        }),
      },
      state: { toolIssued: true, resultObserved: false, completedRequests: 1 },
    });
    expect(completed).toEqual({
      action: { kind: "text", text: "Search route complete." },
      state: { toolIssued: true, resultObserved: true, completedRequests: 2 },
    });
  });

  it("uses the same strict transition for a fail-closed bundled web-search probe", () => {
    const searchScenario: SmokeWebFetchScenario = {
      ...scenario,
      toolName: "web-search",
      toolCallId: "call_native_invalid_search",
      toolArguments: {
        query: "native smoke fail closed",
        engines: ["duckduckgo"],
        limit: 1,
      },
      expectedResultText: "NETWORK_PROXY_INVALID",
      completionText: "Invalid Search route failed closed.",
    };
    const issued = selectSmokeWebFetchAction({
      tools: [{ function: { name: "web-search" } }],
      messages: [],
    }, searchScenario, initial());
    const completed = selectSmokeWebFetchAction({
      tools: [{ function: { name: "web-search" } }],
      messages: [
        {
          role: "tool",
          tool_call_id: "call_native_webfetch",
          content: "prior resumed-session result",
        },
        {
          role: "tool",
          tool_call_id: "call_native_invalid_search",
          content: "Search failed: NETWORK_PROXY_INVALID",
        },
      ],
    }, searchScenario, issued.state);

    expect(issued.action).toEqual({
      kind: "tool",
      id: "call_native_invalid_search",
      name: "web-search",
      arguments: JSON.stringify(searchScenario.toolArguments),
    });
    expect(completed.action).toEqual({
      kind: "text",
      text: "Invalid Search route failed closed.",
    });
  });

  it("rejects missing, duplicate, unexpected, or sensitive tool results", () => {
    const issued = { ...initial(), toolIssued: true };
    expect(() => selectSmokeWebFetchAction(request(), scenario, issued)).toThrow(/exactly one/i);
    expect(() => selectSmokeWebFetchAction(request(
      { role: "tool", tool_call_id: "call_native_webfetch", content: "deterministic-search-result" },
      { role: "tool", tool_call_id: "call_native_webfetch", content: "deterministic-search-result" },
    ), scenario, issued)).toThrow(/exactly one/i);
    expect(() => selectSmokeWebFetchAction(request({
      role: "tool",
      tool_call_id: "call_native_webfetch",
      content: "wrong result",
    }), scenario, issued)).toThrow(/expected result/i);
    expect(() => selectSmokeWebFetchAction(request({
      role: "tool",
      tool_call_id: "call_native_webfetch",
      content: "deterministic-search-result http://127.0.0.1:9876",
    }), scenario, issued)).toThrow(/sensitive/i);
  });

  it("rejects a missing tool, an out-of-order state, or a request after completion", () => {
    expect(() => selectSmokeWebFetchAction({ tools: [], messages: [] }, scenario, initial()))
      .toThrow(/exactly one webfetch/i);
    expect(() => selectSmokeWebFetchAction(request(), scenario, {
      toolIssued: false,
      resultObserved: true,
      completedRequests: 1,
    })).toThrow(/state|order/i);
    expect(() => selectSmokeWebFetchAction(request(), scenario, {
      toolIssued: true,
      resultObserved: true,
      completedRequests: 2,
    })).toThrow(/complete/i);
  });
});

describe("selectSmokeModelAction", () => {
  const completedStage = "complete\nArtifacts: none\nGaps: none\nNext action: none";
  function scenarioFor(shellToolName: NativeLocalShellTool): SmokeModelScenario {
    const skillName = "native-smoke-resource";
    const skillPromptMarker = "NATIVE_SMOKE_UNIQUE_SKILL_MARKER";
    return {
      shellToolName,
      toolCommand: "validate-command",
      agentName: "smoke-reviewer",
      agentPath: "/agent/agents/smoke-reviewer.md",
      agentContent: [
        "---",
        "name: smoke-reviewer",
        "tools:",
        "  - read",
        `  - ${shellToolName}`,
        "skills:",
        `  - ${skillName}`,
        "subagents: []",
        "---",
        "SMOKE_ROLE_MARKER",
        "",
      ].join("\n"),
      agentPromptMarker: "SMOKE_ROLE_MARKER",
      skillName,
      skillPath: `/agent/skills/${skillName}/SKILL.md`,
      skillContent: [
        "---",
        `name: ${skillName}`,
        `description: ${skillPromptMarker}`,
        "---",
        "",
        "# Native smoke resource",
        "",
      ].join("\n"),
      skillPromptMarker,
    };
  }
  const scenario = scenarioFor("bash");
  const agentPromptMarker = scenario.agentPromptMarker;
  const childSystemPrompt = `${agentPromptMarker}\n${scenario.skillPromptMarker}`;
  const oldSubagentDescription = "Available subagents: search, experiment, writing, figures, review.";
  const refreshedSubagentDescription = `${oldSubagentDescription.slice(0, -1)}, smoke-reviewer.`;
  const tool = (name: string, description?: string) => ({
    function: { name, ...(description === undefined ? {} : { description }) },
  });
  const unreadyState = (): SmokeModelState => ({
    baselineConfigurationGeneration: undefined,
    externalResourcesWritten: false,
    acceptedConfigurationGeneration: undefined,
    rootAppliedConfigurationGeneration: undefined,
    customDispatchIssued: false,
    parentWorkingObserved: false,
    childSkillObserved: false,
    stageShellIssued: false,
    venvValidated: false,
    stageCompleted: false,
    terminalHandoffObserved: false,
    complete: false,
    completedRequests: 0,
  });
  const initialState = (): SmokeModelState => {
    let state = recordSmokeAcceptanceMilestone(unreadyState(), {
      kind: "baseline-snapshot",
      generation: 7,
    });
    state = recordSmokeAcceptanceMilestone(state, { kind: "external-resources-written" });
    state = recordSmokeAcceptanceMilestone(state, { kind: "accepted-generation", generation: 8 });
    return recordSmokeAcceptanceMilestone(state, { kind: "root-applied-generation", generation: 8 });
  };
  const toolResult = (toolCallId: string | undefined, content: unknown) => ({
    role: "tool" as const,
    ...(toolCallId === undefined ? {} : { tool_call_id: toolCallId }),
    content,
  });
  const parentRequestFor = (
    modelScenario: SmokeModelScenario,
    refreshed: boolean,
    ...messages: Array<ReturnType<typeof toolResult> | { role: "user"; content: string }>
  ) => ({
    tools: [
      tool(modelScenario.shellToolName),
      tool("read"),
      tool("write"),
      tool("web-search"),
      tool("subagent", refreshed ? refreshedSubagentDescription : oldSubagentDescription),
    ],
    messages,
  });
  const parentRequest = (
    refreshed: boolean,
    ...messages: Array<ReturnType<typeof toolResult> | { role: "user"; content: string }>
  ) => parentRequestFor(scenario, refreshed, ...messages);
  const stageRequestFor = (
    modelScenario: SmokeModelScenario,
    prompt = `${modelScenario.agentPromptMarker}\n${modelScenario.skillPromptMarker}`,
    tools = [tool("read"), tool(modelScenario.shellToolName)],
    ...messages: Array<ReturnType<typeof toolResult>>
  ) => ({
    tools,
    messages: [{ role: "system" as const, content: prompt }, ...messages],
  });
  const stageRequest = (
    prompt = childSystemPrompt,
    tools = [tool("read"), tool(scenario.shellToolName)],
    ...messages: Array<ReturnType<typeof toolResult>>
  ) => stageRequestFor(scenario, prompt, tools, ...messages);
  const terminalNotice = (result = completedStage) => ({
    role: "user" as const,
    content: [
      "<agent_status>",
      "Current time: 2026-08-20T00:00:00.000Z",
      "Complete subagent:smoke-reviewer_0",
      "</agent_status>",
      "<agent_handoff>",
      "Agent: smoke-reviewer_0",
      `Result: ${result}`,
      "</agent_handoff>",
    ].join("\n"),
  });

  it("rejects a parent request without the registered web-search tool", () => {
    const request = parentRequest(false);
    request.tools = request.tools.filter((entry) => entry.function.name !== "web-search");

    expect(() => selectSmokeModelAction(request, scenario, initialState()))
      .toThrow(/exactly one web-search tool/i);
  });

  it.each(["bash", "powershell"] as const)(
    "completes the post-reload custom-stage chain with the %s venv tool and referenced Skill",
    (shellToolName) => {
      const modelScenario = scenarioFor(shellToolName);
      let current = initialState();

      const dispatch = selectSmokeModelAction(
        parentRequestFor(modelScenario, true),
        modelScenario,
        current,
      );
      current = dispatch.state;
      const shell = selectSmokeModelAction(stageRequestFor(modelScenario), modelScenario, current);
      current = shell.state;
      const parentWaiting = selectSmokeModelAction(
        parentRequestFor(
          modelScenario,
          true,
          toolResult("call_native_reviewer", "smoke-reviewer_0 is working."),
        ),
        modelScenario,
        current,
      );
      current = parentWaiting.state;
      const shellResult = selectSmokeModelAction(
        stageRequestFor(
          modelScenario,
          `${modelScenario.agentPromptMarker}\n${modelScenario.skillPromptMarker}`,
          [tool("read"), tool(shellToolName)],
          toolResult("call_native_venv", "log\neasyresearch-venv-ok\n"),
        ),
        modelScenario,
        current,
      );
      current = shellResult.state;
      const complete = selectSmokeModelAction(
        parentRequestFor(
          modelScenario,
          true,
          toolResult("call_native_reviewer", "smoke-reviewer_0 is working."),
          terminalNotice(),
        ),
        modelScenario,
        current,
      );

      expect(modelScenario.shellToolName).toBe(shellToolName);
      expect(dispatch.action).toEqual({
        kind: "tool",
        id: "call_native_reviewer",
        name: "subagent",
        arguments: JSON.stringify({
          agent: "smoke-reviewer",
          task: `Run the native venv validation command with the ${shellToolName} tool and return a complete handoff.`,
        }),
      });
      expect(shell.action).toEqual({
        kind: "tool",
        id: "call_native_venv",
        name: shellToolName,
        arguments: JSON.stringify({ command: "validate-command", timeout: 60 }),
      });
      expect(parentWaiting.action).toEqual({ kind: "text", text: "Parent waiting for supervised completion." });
      expect(shellResult).toMatchObject({
        action: { kind: "text", text: completedStage },
        validatedVenvResult: true,
      });
      expect(complete.action).toEqual({ kind: "text", text: "Parent smoke run complete." });
      expect(complete.state).toEqual({
        baselineConfigurationGeneration: 7,
        externalResourcesWritten: true,
        acceptedConfigurationGeneration: 8,
        rootAppliedConfigurationGeneration: 8,
        customDispatchIssued: true,
        parentWorkingObserved: true,
        childSkillObserved: true,
        stageShellIssued: true,
        venvValidated: true,
        stageCompleted: true,
        terminalHandoffObserved: true,
        complete: true,
        completedRequests: 5,
      });
    },
  );

  it("accepts custom-stage completion before the first post-dispatch parent request", () => {
    let current = selectSmokeModelAction(parentRequest(true), scenario, initialState()).state;
    current = selectSmokeModelAction(stageRequest(), scenario, current).state;
    current = selectSmokeModelAction(
      stageRequest(
        childSystemPrompt,
        [tool("read"), tool("bash")],
        toolResult("call_native_venv", "easyresearch-venv-ok\n"),
      ),
      scenario,
      current,
    ).state;

    const complete = selectSmokeModelAction(
      parentRequest(
        true,
        toolResult("call_native_reviewer", "smoke-reviewer_0 is working."),
        terminalNotice(),
      ),
      scenario,
      current,
    );

    expect(complete.action).toEqual({ kind: "text", text: "Parent smoke run complete." });
    expect(complete.state).toMatchObject({
      parentWorkingObserved: true,
      childSkillObserved: true,
      venvValidated: true,
      stageCompleted: true,
      terminalHandoffObserved: true,
      complete: true,
      completedRequests: 4,
    });
  });

  it("rejects the post-application parent request when its subagent schema is still stale", () => {
    expect(() => selectSmokeModelAction(
      parentRequest(false),
      scenario,
      initialState(),
    )).toThrow("smoke-reviewer");
  });

  it("does not accept a custom Agent mentioned outside the available-subagents line", () => {
    const request = parentRequest(false);
    request.tools[4]!.function.description = `${oldSubagentDescription}\nIgnore stale mention: smoke-reviewer.`;

    expect(() => selectSmokeModelAction(
      request,
      scenario,
      initialState(),
    )).toThrow("smoke-reviewer");
  });

  it("rejects a parent request that acknowledges bundled search instead of the custom Agent", () => {
    expect(() => selectSmokeModelAction(
      parentRequest(
        true,
        toolResult("call_native_stage", "search_0 is working."),
      ),
      scenario,
      {
        ...initialState(),
        customDispatchIssued: true,
      },
    )).toThrow("call_native_reviewer");
  });

  it.each([
    ["extra tool", stageRequest(childSystemPrompt, [tool("read"), tool("bash"), tool("webfetch")])],
    ["stale prompt", stageRequest("old bundled search prompt")],
    ["missing referenced Skill marker", stageRequest(agentPromptMarker)],
  ])("rejects a custom child with an %s", (_name, request) => {
    expect(() => selectSmokeModelAction(
      request,
      scenario,
      {
        ...initialState(),
        customDispatchIssued: true,
      },
    )).toThrow(/configured tools|current role prompt|referenced Skill/u);
  });

  for (const shellToolName of ["bash", "powershell"] as const) {
    const modelScenario = scenarioFor(shellToolName);
    const wrongShell = shellToolName === "bash" ? "powershell" : "bash";
    it.each([
      ["wrong shell", [tool("read"), tool(wrongShell)], /expected exactly one local shell tool/u],
      ["both shells", [tool("read"), tool("bash"), tool("powershell")], /expected exactly one local shell tool/u],
      ["no shell", [tool("read")], /expected exactly one local shell tool/u],
      ["missing read", [tool(shellToolName)], /configured tools/u],
      ["extra strict child tool", [tool("read"), tool(shellToolName), tool("webfetch")], /configured tools/u],
    ] as const)(`rejects %s when ${shellToolName} is required`, (_name, tools, error) => {
      expect(() => selectSmokeModelAction(
        stageRequestFor(
          modelScenario,
          `${modelScenario.agentPromptMarker}\n${modelScenario.skillPromptMarker}`,
          [...tools],
        ),
        modelScenario,
        {
          ...initialState(),
          customDispatchIssued: true,
        },
      )).toThrow(error);
    });
  }

  it("rejects a parent provider request before root application of the external resources", () => {
    expect(() => selectSmokeModelAction(
      parentRequest(true),
      scenario,
      unreadyState(),
    )).toThrow(/baseline|external|accepted|root/i);
  });

  it.each([
    ["custom launch", parentRequest(
      true,
      toolResult("call_native_reviewer", "smoke-reviewer_0 is working."),
      toolResult("call_native_reviewer", "smoke-reviewer_0 is working."),
    ), {
      customDispatchIssued: true,
    }],
    ["stage shell", stageRequest(
      childSystemPrompt,
      [tool("read"), tool("bash")],
      toolResult("call_native_venv", "easyresearch-venv-ok"),
      toolResult("call_native_venv", "easyresearch-venv-ok"),
    ), {
      customDispatchIssued: true,
      stageShellIssued: true,
    }],
  ] as const)("rejects duplicate correlated %s tool results", (_name, request, flags) => {
    expect(() => selectSmokeModelAction(
      request,
      scenario,
      { ...initialState(), ...flags },
    )).toThrow("exactly one");
  });

  it.each([
    "wrong interpreter",
    " easyresearch-venv-ok  ",
    "easyresearch-venv-ok-invalid",
    "prefix easyresearch-venv-ok suffix",
    "easyresearch-venv-ok\neasyresearch-venv-ok",
  ])("rejects a failed, inexact, or repeated local-shell sentinel: %s", (content) => {
    expect(() => selectSmokeModelAction(
      stageRequest(childSystemPrompt, [tool("read"), tool("bash")], toolResult("call_native_venv", content)),
      scenario,
      {
        ...initialState(),
        customDispatchIssued: true,
        stageShellIssued: true,
      },
    )).toThrow("easyresearch-venv-ok");
  });

  it.each(["bash", "powershell"] as const)(
    "names %s in failed sentinel diagnostics",
    (shellToolName) => {
      const modelScenario = scenarioFor(shellToolName);
      expect(() => selectSmokeModelAction(
        stageRequestFor(
          modelScenario,
          `${modelScenario.agentPromptMarker}\n${modelScenario.skillPromptMarker}`,
          [tool("read"), tool(shellToolName)],
          toolResult("call_native_venv", "wrong interpreter"),
        ),
        modelScenario,
        {
          ...initialState(),
          customDispatchIssued: true,
          stageShellIssued: true,
        },
      )).toThrow(`${shellToolName} tool result`);
    },
  );

  it.each(["bash", "powershell"] as const)(
    "rejects a terminal handoff before successful %s validation",
    (shellToolName) => {
      const modelScenario = scenarioFor(shellToolName);
      expect(() => selectSmokeModelAction(
        parentRequestFor(
          modelScenario,
          true,
          toolResult("call_native_reviewer", "smoke-reviewer_0 is working."),
          terminalNotice(),
        ),
        modelScenario,
        {
          ...initialState(),
          customDispatchIssued: true,
        },
      )).toThrow(`${shellToolName} stage validation`);
    },
  );

  it.each([
    "smoke-reviewer_0 is working",
    " smoke-reviewer_0 is working. ",
    "smoke-reviewer_0 is working. Session history JSONL: /sessions/reviewer.jsonl",
    "smoke-reviewer_1 is working.",
  ])("rejects an inexact or path-bearing custom launch acknowledgement: %s", (content) => {
    expect(() => selectSmokeModelAction(
      parentRequest(
        true,
        toolResult("call_native_reviewer", content),
      ),
      scenario,
      {
        ...initialState(),
        customDispatchIssued: true,
      },
    )).toThrow("smoke-reviewer_0 is working.");
  });

  it.each([
    ["missing handoff", {
      role: "user" as const,
      content: "<agent_status>\nComplete subagent:smoke-reviewer_0\n</agent_status>",
    }],
    ["handoff without Complete status", {
      role: "user" as const,
      content: `<agent_handoff>\nAgent: smoke-reviewer_0\nResult: ${completedStage}\n</agent_handoff>`,
    }],
    ["wrong handoff agent", terminalNotice().content.replace("Agent: smoke-reviewer_0", "Agent: search_0")],
    ["unsuccessful handoff", terminalNotice("blocked\nArtifacts: none\nGaps: validation failed\nNext action: retry")],
  ] as const)("rejects a malformed custom atomic terminal notification: %s", (_name, notice) => {
    const message = typeof notice === "string" ? { role: "user" as const, content: notice } : notice;
    expect(() => selectSmokeModelAction(
      parentRequest(
        true,
        toolResult("call_native_reviewer", "smoke-reviewer_0 is working."),
        message,
      ),
      scenario,
      {
        ...initialState(),
        customDispatchIssued: true,
        stageShellIssued: true,
        venvValidated: true,
        stageCompleted: true,
      },
    )).toThrow("atomic terminal");
  });

  it("rejects custom status and handoff split across model-visible messages", () => {
    expect(() => selectSmokeModelAction(
      parentRequest(
        true,
        toolResult("call_native_reviewer", "smoke-reviewer_0 is working."),
        { role: "user", content: "<agent_status>\nComplete subagent:smoke-reviewer_0\n</agent_status>" },
        { role: "user", content: `<agent_handoff>\nAgent: smoke-reviewer_0\nResult: ${completedStage}\n</agent_handoff>` },
      ),
      scenario,
      {
        ...initialState(),
        customDispatchIssued: true,
        stageShellIssued: true,
        venvValidated: true,
        stageCompleted: true,
      },
    )).toThrow("atomic terminal");
  });

  it("rejects duplicate custom terminal notifications", () => {
    expect(() => selectSmokeModelAction(
      parentRequest(
        true,
        toolResult("call_native_reviewer", "smoke-reviewer_0 is working."),
        terminalNotice(),
        terminalNotice(),
      ),
      scenario,
      {
        ...initialState(),
        customDispatchIssued: true,
        stageShellIssued: true,
        venvValidated: true,
        stageCompleted: true,
      },
    )).toThrow("exactly one atomic terminal");
  });

  it("rejects model requests after terminal completion", () => {
    expect(() => selectSmokeModelAction(
      parentRequest(true),
      scenario,
      { ...initialState(), complete: true },
    )).toThrow("already complete");
  });
});
