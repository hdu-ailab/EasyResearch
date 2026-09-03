import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  createServer,
  request as requestHttp,
  type IncomingHttpHeaders,
  type Server as HttpServer,
} from "node:http";
import { request as requestHttps } from "node:https";
import { connect as connectTcp, type AddressInfo, type Socket } from "node:net";
import { isAbsolute, posix, win32 } from "node:path";
import type { NativeLocalShellTool } from "../src/runtime/platform-tools";

export const FIRST_RUN_CEILING_MS = 720_000;

const PYTHON_CONTAMINATION_KEYS = new Set(["PYTHONPATH", "PYTHONHOME", "PYTHONUSERBASE"]);

export type SmokeProxyRecordKind =
  | "fake-target"
  | "forward"
  | "connect-forward"
  | "connect-blocked";

export interface SmokeProxyRecord {
  readonly sequence: number;
  readonly proxy: string;
  readonly kind: SmokeProxyRecordKind;
  readonly method: string;
  readonly host: string;
  readonly port: number;
}

export interface RecordingHttpProxy {
  readonly url: string;
  records(): readonly SmokeProxyRecord[];
  close(): Promise<void>;
}

function normalizeSmokeHost(host: string): string {
  let normalized = host.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  if (normalized.endsWith(".")) normalized = normalized.slice(0, -1);
  return normalized;
}

function urlPort(url: URL): number {
  if (url.port) return Number.parseInt(url.port, 10);
  return url.protocol === "https:" ? 443 : 80;
}

function sanitizedForwardHeaders(headers: IncomingHttpHeaders, host: string): IncomingHttpHeaders {
  const forwarded: IncomingHttpHeaders = { ...headers, host };
  delete forwarded["proxy-authorization"];
  delete forwarded["proxy-connection"];
  return forwarded;
}

function endProxyFailure(response: import("node:http").ServerResponse): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(502, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": "24",
    Connection: "close",
  });
  response.end("Proxy forwarding failed.");
}

function parseConnectTarget(authority: string): { host: string; port: number } | undefined {
  try {
    const url = new URL(`http://${authority}`);
    const host = normalizeSmokeHost(url.hostname);
    const port = url.port ? Number.parseInt(url.port, 10) : 443;
    if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
    return { host, port };
  } catch {
    return undefined;
  }
}

function listenOnLoopback(server: HttpServer): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

/**
 * Starts a local HTTP proxy for native release acceptance. It records only safe
 * host-level classifications, rewrites selected fake-public hosts to local
 * servers, and transparently forwards all other HTTP and CONNECT traffic.
 */
export async function startRecordingHttpProxy(options: {
  name: string;
  fakeTargets?: Readonly<Record<string, string>>;
  blockedConnectHosts?: readonly string[];
  onRecord?: (record: SmokeProxyRecord) => void;
}): Promise<RecordingHttpProxy> {
  if (!options.name.trim()) throw new Error("Recording proxy requires a non-empty name.");
  const fakeTargets = new Map<string, URL>();
  for (const [host, origin] of Object.entries(options.fakeTargets ?? {})) {
    const normalizedHost = normalizeSmokeHost(host);
    const target = new URL(origin);
    if (!normalizedHost || (target.protocol !== "http:" && target.protocol !== "https:")) {
      throw new Error("Recording proxy fake targets require HTTP(S) origins and non-empty hosts.");
    }
    fakeTargets.set(normalizedHost, target);
  }
  const blockedConnectHosts = new Set(
    (options.blockedConnectHosts ?? []).map(normalizeSmokeHost).filter(Boolean),
  );
  const records: SmokeProxyRecord[] = [];
  const sockets = new Set<Socket>();
  let sequence = 0;
  let closed = false;
  const record = (
    kind: SmokeProxyRecordKind,
    method: string,
    host: string,
    port: number,
  ): void => {
    const entry = Object.freeze({
      sequence: ++sequence,
      proxy: options.name,
      kind,
      method,
      host,
      port,
    });
    records.push(entry);
    options.onRecord?.(entry);
  };

  const server = createServer((request, response) => {
    let requested: URL;
    try {
      requested = new URL(request.url ?? "");
    } catch {
      response.writeHead(400, { Connection: "close" });
      response.end();
      return;
    }
    if (requested.protocol !== "http:" && requested.protocol !== "https:") {
      response.writeHead(400, { Connection: "close" });
      response.end();
      return;
    }

    const requestedHost = normalizeSmokeHost(requested.hostname);
    const fakeTarget = fakeTargets.get(requestedHost);
    const target = fakeTarget
      ? new URL(`${requested.pathname}${requested.search}`, fakeTarget)
      : requested;
    record(
      fakeTarget ? "fake-target" : "forward",
      request.method ?? "GET",
      requestedHost,
      urlPort(requested),
    );
    const send = target.protocol === "https:" ? requestHttps : requestHttp;
    const upstream = send({
      protocol: target.protocol,
      hostname: normalizeSmokeHost(target.hostname),
      port: urlPort(target),
      method: request.method,
      path: `${target.pathname}${target.search}`,
      headers: sanitizedForwardHeaders(request.headers, target.host),
    }, (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.statusMessage,
        upstreamResponse.headers,
      );
      upstreamResponse.pipe(response);
    });
    upstream.once("error", () => endProxyFailure(response));
    request.once("aborted", () => upstream.destroy());
    request.pipe(upstream);
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("connect", (request, client, head) => {
    const target = parseConnectTarget(request.url ?? "");
    if (!target) {
      client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    if (blockedConnectHosts.has(target.host)) {
      record("connect-blocked", "CONNECT", target.host, target.port);
      client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }

    record("connect-forward", "CONNECT", target.host, target.port);
    const upstream = connectTcp({ host: target.host, port: target.port });
    sockets.add(upstream);
    upstream.once("close", () => sockets.delete(upstream));
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.once("error", () => {
      if (!client.destroyed) {
        client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      }
    });
    client.once("error", () => upstream.destroy());
  });

  const port = await listenOnLoopback(server);
  return Object.freeze({
    url: `http://127.0.0.1:${port}`,
    records: () => Object.freeze(records.map((entry) => ({ ...entry }))),
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  });
}

function replaceAllLiteral(input: string, value: string, replacement: string): string {
  return value ? input.split(value).join(replacement) : input;
}

export function redactSmokeDiagnostic(value: unknown, secrets: readonly string[] = []): string {
  let text: string;
  try {
    text = value instanceof Error ? value.message : String(value);
  } catch {
    return "[unavailable diagnostic]";
  }
  for (const secret of [...new Set(secrets)].sort((left, right) => right.length - left.length)) {
    text = replaceAllLiteral(text, secret, "[redacted]");
  }
  text = text.replace(/\bhttps?:\/\/[^\s"'<>]+/giu, "[redacted url]");
  text = text.replace(
    /\b(proxy-authorization|authorization)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/giu,
    "$1=[redacted]",
  );
  text = text.replace(
    /["'](api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|token)["']\s*:\s*["'][^"']*["']/giu,
    '"$1":"[redacted]"',
  );
  text = text.replace(
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|token)\s*[:=]\s*[^\s,;]+/giu,
    "$1=[redacted]",
  );
  return text;
}

export function formatSmokeProxyDiagnostics(
  records: readonly SmokeProxyRecord[],
  errors: readonly unknown[] = [],
  secrets: readonly string[] = [],
): string {
  return JSON.stringify({
    records: records.map((record) => ({ ...record })),
    errors: errors.map((error) => redactSmokeDiagnostic(error, secrets)),
  });
}

export interface SmokeProxyRouteExpectations {
  readonly allHost: string;
  readonly gaxiosHost: string;
  readonly llmHost: string;
  readonly searchHost: string;
  readonly oauthHost: string;
  readonly candidateHost: string;
}

export interface SmokeLoopbackEvidence {
  readonly firstRunAllProxyBaselineSequence: number;
  readonly gaxiosRequests: number;
  readonly ipv6Requests: number;
  readonly ipv6Supported: boolean;
  readonly providerRequests: number;
  readonly searchRequests: number;
  readonly directRequests: number;
}

export interface SmokeProxyRouteClassification {
  readonly allTarget: boolean;
  readonly firstRunPipTarget: boolean;
  readonly gaxiosTarget: boolean;
  readonly llmTarget: boolean;
  readonly searchTarget: boolean;
  readonly oauthTarget: boolean;
  readonly candidateTarget: boolean;
  readonly loopbackBypassed: boolean;
  readonly routesSeparated: boolean;
}

export function isSmokeFirstRunPipRecord(
  record: SmokeProxyRecord,
  baselineSequence: number,
): boolean {
  if (!Number.isSafeInteger(baselineSequence) || baselineSequence < 0) return false;
  const host = normalizeSmokeHost(record.host);
  return record.proxy === "all"
    && record.sequence > baselineSequence
    && (record.kind === "forward" || record.kind === "connect-forward")
    && host !== "localhost"
    && host !== "127.0.0.1"
    && host !== "::1";
}

export function classifySmokeProxyRoutes(
  records: readonly SmokeProxyRecord[],
  expected: SmokeProxyRouteExpectations,
  loopbackEvidence: SmokeLoopbackEvidence,
): SmokeProxyRouteClassification {
  const hosts = {
    all: normalizeSmokeHost(expected.allHost),
    gaxios: normalizeSmokeHost(expected.gaxiosHost),
    llm: normalizeSmokeHost(expected.llmHost),
    search: normalizeSmokeHost(expected.searchHost),
    oauth: normalizeSmokeHost(expected.oauthHost),
    candidate: normalizeSmokeHost(expected.candidateHost),
  };
  const observed = (proxy: string, host: string, kind: SmokeProxyRecordKind): boolean => records.some(
    (record) => record.proxy === proxy
      && record.kind === kind
      && normalizeSmokeHost(record.host) === host,
  );
  const expectedProxy = new Map([
    [hosts.all, { proxy: "all", kind: "fake-target" }],
    [hosts.gaxios, { proxy: "llm", kind: "fake-target" }],
    [hosts.llm, { proxy: "llm", kind: "fake-target" }],
    [hosts.search, { proxy: "search", kind: "fake-target" }],
    [hosts.oauth, { proxy: "llm", kind: "connect-blocked" }],
    [hosts.candidate, { proxy: "candidate", kind: "connect-blocked" }],
  ]);
  const routesSeparated = records.every((record) => {
    const expectedRecord = expectedProxy.get(normalizeSmokeHost(record.host));
    return expectedRecord === undefined
      || (expectedRecord.proxy === record.proxy && expectedRecord.kind === record.kind);
  });
  const firstRunPipTarget = records.some((record) => isSmokeFirstRunPipRecord(
    record,
    loopbackEvidence.firstRunAllProxyBaselineSequence,
  ));
  return {
    allTarget: observed("all", hosts.all, "fake-target"),
    firstRunPipTarget,
    gaxiosTarget:
      loopbackEvidence.gaxiosRequests > 0
      && observed("llm", hosts.gaxios, "fake-target"),
    llmTarget: observed("llm", hosts.llm, "fake-target"),
    searchTarget: observed("search", hosts.search, "fake-target"),
    oauthTarget: observed("llm", hosts.oauth, "connect-blocked"),
    candidateTarget: observed("candidate", hosts.candidate, "connect-blocked"),
    loopbackBypassed:
      loopbackEvidence.providerRequests > 0
      && loopbackEvidence.searchRequests > 0
      && loopbackEvidence.directRequests > 0
      && (!loopbackEvidence.ipv6Supported || loopbackEvidence.ipv6Requests > 0)
      && records.every((record) => {
        const host = normalizeSmokeHost(record.host);
        return host !== "localhost" && host !== "127.0.0.1" && host !== "::1";
      }),
    routesSeparated,
  };
}

export async function observeFirstRunStartup<SetupPip, AuthenticatedReadiness>(options: {
  observeSetupPip: () => Promise<SetupPip>;
  observeAuthenticatedReadiness: () => Promise<AuthenticatedReadiness>;
}): Promise<{
  setupPip: SetupPip;
  authenticatedReadiness: AuthenticatedReadiness;
}> {
  let observationSequence = 0;
  let setupPipSequence: number | undefined;
  let authenticatedReadinessSequence: number | undefined;
  const setupPip = Promise.resolve()
    .then(options.observeSetupPip)
    .then((value) => {
      setupPipSequence = ++observationSequence;
      return value;
    });
  const authenticatedReadiness = Promise.resolve()
    .then(options.observeAuthenticatedReadiness)
    .then((value) => {
      authenticatedReadinessSequence = ++observationSequence;
      if (setupPipSequence === undefined) {
        throw new Error(
          "Native smoke must observe first-run pip All-proxy evidence before authenticated readiness.",
        );
      }
      return value;
    });
  const [setupPipValue, authenticatedReadinessValue] = await Promise.all([
    setupPip,
    authenticatedReadiness,
  ]);
  if (
    setupPipSequence === undefined
    || authenticatedReadinessSequence === undefined
    || setupPipSequence >= authenticatedReadinessSequence
  ) {
    throw new Error(
      "Native smoke must observe first-run pip All-proxy evidence before authenticated readiness.",
    );
  }
  return {
    setupPip: setupPipValue,
    authenticatedReadiness: authenticatedReadinessValue,
  };
}

export interface SmokeDaemonIdentity {
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly runtimeId: string;
  readonly owner: "cli";
}

export function parseSmokeDaemonIdentity(content: string): SmokeDaemonIdentity {
  try {
    const value = JSON.parse(content.trim()) as Partial<SmokeDaemonIdentity> & {
      schema?: unknown;
      owner?: unknown;
    };
    const owner = value.owner ?? "cli";
    if (
      value.schema !== 1
      || !Number.isSafeInteger(value.pid)
      || (value.pid ?? 0) < 1
      || typeof value.host !== "string"
      || !value.host
      || !Number.isSafeInteger(value.port)
      || (value.port ?? 0) < 1
      || (value.port ?? 0) > 65_535
      || typeof value.token !== "string"
      || !value.token
      || typeof value.runtimeId !== "string"
      || !value.runtimeId
      || owner !== "cli"
    ) {
      throw new Error("invalid");
    }
    return Object.freeze({
      pid: value.pid,
      host: value.host,
      port: value.port,
      token: value.token,
      runtimeId: value.runtimeId,
      owner,
    }) as SmokeDaemonIdentity;
  } catch {
    throw new Error("Native smoke daemon ownership record was invalid.");
  }
}

export function assertSmokeRuntimeReplacement(options: {
  before: SmokeDaemonIdentity;
  after: SmokeDaemonIdentity;
  oldBootId: string;
  newBootId: string;
}): {
  oldBootId: string;
  newBootId: string;
  host: string;
  port: number;
  runtimeId: string;
} {
  const { before, after } = options;
  if (!options.oldBootId || !options.newBootId || options.oldBootId === options.newBootId) {
    throw new Error("Native smoke successor requires a fresh boot id.");
  }
  if (before.token === after.token) {
    throw new Error("Native smoke successor requires a fresh ownership token.");
  }
  if (before.pid === after.pid) {
    throw new Error("Native smoke successor requires a fresh daemon PID.");
  }
  if (before.host !== after.host || before.port !== after.port) {
    throw new Error("Native smoke successor changed the CLI endpoint.");
  }
  if (before.runtimeId !== after.runtimeId) {
    throw new Error("Native smoke successor changed the accepted runtime identity.");
  }
  return {
    oldBootId: options.oldBootId,
    newBootId: options.newBootId,
    host: after.host,
    port: after.port,
    runtimeId: after.runtimeId,
  };
}

export interface SmokeNetworkState {
  readonly setupPipObserved: boolean;
  readonly initialBootId: string | undefined;
  readonly routesObserved: boolean;
  readonly oauthObserved: boolean;
  readonly restartAccepted: boolean;
  readonly successorBootId: string | undefined;
  readonly successorSessionReady: boolean;
  readonly invalidSearchRejected: boolean;
  readonly invalidLlmRejected: boolean;
}

export type SmokeNetworkMilestone =
  | { kind: "setup-pip-observed" }
  | { kind: "initial-ready"; bootId: string }
  | { kind: "routes-observed" }
  | { kind: "oauth-observed" }
  | { kind: "restart-accepted"; bootId: string }
  | { kind: "successor-ready"; bootId: string }
  | { kind: "successor-session-ready" }
  | { kind: "invalid-search-rejected" }
  | { kind: "invalid-llm-rejected" };

export function recordSmokeNetworkMilestone(
  state: SmokeNetworkState,
  milestone: SmokeNetworkMilestone,
): SmokeNetworkState {
  const fail = (message: string): never => {
    throw new Error(`Native smoke network milestone order is invalid: ${message}`);
  };
  if (milestone.kind === "setup-pip-observed") {
    if (state.setupPipObserved || state.initialBootId !== undefined) {
      fail("first-run setup pip evidence was duplicated or observed after readiness");
    }
    return { ...state, setupPipObserved: true };
  }
  if (milestone.kind === "initial-ready") {
    if (!state.setupPipObserved) fail("first-run setup pip evidence must be recorded before readiness");
    if (!milestone.bootId.trim() || state.initialBootId !== undefined) fail("initial readiness was duplicated");
    return { ...state, initialBootId: milestone.bootId };
  }
  if (state.initialBootId === undefined) fail("initial readiness must be recorded before network evidence");
  if (milestone.kind === "routes-observed") {
    if (state.routesObserved || state.oauthObserved || state.restartAccepted) fail("route evidence was out of order");
    return { ...state, routesObserved: true };
  }
  if (milestone.kind === "oauth-observed") {
    if (!state.routesObserved || state.oauthObserved || state.restartAccepted) fail("OAuth evidence requires route evidence first");
    return { ...state, oauthObserved: true };
  }
  if (milestone.kind === "restart-accepted") {
    if (!state.oauthObserved || state.restartAccepted || milestone.bootId !== state.initialBootId) {
      fail("restart acceptance requires the initial boot after OAuth evidence");
    }
    return { ...state, restartAccepted: true };
  }
  if (milestone.kind === "successor-ready") {
    if (!state.restartAccepted || state.successorBootId !== undefined) fail("successor readiness was out of order");
    if (!milestone.bootId.trim() || milestone.bootId === state.initialBootId) {
      throw new Error("Native smoke successor requires a fresh boot id.");
    }
    return { ...state, successorBootId: milestone.bootId };
  }
  if (milestone.kind === "successor-session-ready") {
    if (state.successorBootId === undefined || state.successorSessionReady) fail("successor session readiness was out of order");
    return { ...state, successorSessionReady: true };
  }
  if (milestone.kind === "invalid-search-rejected") {
    if (!state.successorSessionReady || state.invalidSearchRejected || state.invalidLlmRejected) {
      fail("invalid Search rejection was out of order");
    }
    return { ...state, invalidSearchRejected: true };
  }
  if (!state.invalidSearchRejected || state.invalidLlmRejected) {
    fail("invalid LLM rejection requires invalid Search rejection first");
  }
  return { ...state, invalidLlmRejected: true };
}

export function parseRecordedPid(content: string): number | undefined {
  const value = content.trim();
  if (/^[1-9]\d*$/u.test(value)) {
    const pid = Number(value);
    return Number.isSafeInteger(pid) ? pid : undefined;
  }
  try {
    const record = JSON.parse(value) as { schema?: unknown; pid?: unknown };
    return record.schema === 1 && Number.isSafeInteger(record.pid) && (record.pid as number) > 0
      ? record.pid as number
      : undefined;
  } catch {
    return undefined;
  }
}

export interface ResolveSmokePythonOptions {
  explicit?: string;
  which?: (name: string) => string | null | undefined;
  exists?: (path: string) => boolean;
}

export function resolveSmokePython(options: ResolveSmokePythonOptions = {}): string {
  const exists = options.exists ?? existsSync;
  if (options.explicit !== undefined) {
    if (!isAbsolute(options.explicit) || !exists(options.explicit)) {
      throw new Error(`EASYRESEARCH_SMOKE_PYTHON must name an existing absolute interpreter: ${options.explicit}`);
    }
    return options.explicit;
  }

  const which = options.which ?? Bun.which;
  for (const name of ["python3", "python"]) {
    const python = which(name);
    if (python && isAbsolute(python) && exists(python)) return python;
  }
  throw new Error("EASYRESEARCH_SMOKE_PYTHON is unset and no Python interpreter was found");
}

export interface ResolveSmokePowerShellOptions {
  which?: (name: string) => string | null | undefined;
  exists?: (path: string) => boolean;
}

export function resolveSmokePowerShell(
  options: ResolveSmokePowerShellOptions = {},
): string {
  const which = options.which ?? Bun.which;
  const exists = options.exists ?? existsSync;
  for (const name of ["pwsh.exe", "powershell.exe"] as const) {
    const candidate = which(name);
    if (candidate && win32.isAbsolute(candidate) && exists(candidate)) return candidate;
  }
  throw new Error(
    "Windows native smoke requires an existing absolute pwsh.exe or powershell.exe discovered on the runner PATH",
  );
}

export function resolveSmokeWindowsSystem32(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string {
  const systemRoot = Object.entries(env).find(
    ([key]) => key.toLowerCase() === "systemroot",
  )?.[1];
  if (!systemRoot || !win32.isAbsolute(systemRoot)) {
    throw new Error("Windows native smoke requires a non-empty absolute SystemRoot");
  }

  const system32 = win32.join(systemRoot, "System32");
  const whereExecutable = win32.join(system32, "where.exe");
  if (!exists(whereExecutable)) {
    throw new Error(`Windows native smoke requires where.exe at ${whereExecutable}`);
  }
  return system32;
}

export function createCompiledChildEnv(options: {
  base: NodeJS.ProcessEnv;
  python: string;
  platform?: NodeJS.Platform;
  powershellExecutable?: string;
  windowsSystem32?: string;
  exists?: (path: string) => boolean;
  overrides?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  const windows = platform === "win32";
  if (windows) {
    if (!options.powershellExecutable || !win32.isAbsolute(options.powershellExecutable)) {
      throw new Error("Windows native smoke requires an absolute PowerShell executable");
    }
    if (!options.windowsSystem32 || !win32.isAbsolute(options.windowsSystem32)) {
      throw new Error("Windows native smoke requires an absolute System32 directory");
    }
    const whereExecutable = win32.join(options.windowsSystem32, "where.exe");
    if (!(options.exists ?? existsSync)(whereExecutable)) {
      throw new Error(`Windows native smoke requires where.exe at ${whereExecutable}`);
    }
  } else {
    if (options.powershellExecutable !== undefined) {
      throw new Error("PowerShell executable is only valid for Windows native smoke");
    }
    if (options.windowsSystem32 !== undefined) {
      throw new Error("System32 directory is only valid for Windows native smoke");
    }
  }

  const env = { ...options.base, ...options.overrides };
  const pythonDir = windows ? win32.dirname(options.python) : posix.dirname(options.python);
  for (const key of Object.keys(env)) {
    const normalized = key.toUpperCase();
    if (normalized === "PATH" || PYTHON_CONTAMINATION_KEYS.has(normalized)) delete env[key];
  }
  env.PATH = windows
    ? [pythonDir, win32.dirname(options.powershellExecutable!), options.windowsSystem32!].join(win32.delimiter)
    : pythonDir;
  env.PIP_RETRIES = "3";
  env.PIP_DEFAULT_TIMEOUT = "30";
  env.PIP_NO_CACHE_DIR = "1";
  return env;
}

export function skillVenvPython(
  agentDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32"
    ? win32.join(agentDir, "venv", "Scripts", "python.exe")
    : posix.join(agentDir, "venv", "bin", "python");
}

export interface VenvNetworkValidationOptions {
  allProxy: string;
  searchProxy: string;
  bypass: string;
  targetUrl: string;
  targetSentinel: string;
  loopbackTargetUrl: string;
  loopbackTargetSentinel: string;
}

export function writeVenvValidationScript(
  path: string,
  network?: VenvNetworkValidationOptions,
): void {
  const networkValidation = network
    ? `
proxy_keys = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]
expected_all_proxy = ${JSON.stringify(network.allProxy)}
for key in proxy_keys:
    if os.environ.get(key) != expected_all_proxy:
        raise RuntimeError(f"wrong {key} proxy route")
if os.environ.get("PIP_PROXY") != expected_all_proxy:
    raise RuntimeError("wrong PIP_PROXY proxy route")

actual_bypass = os.environ.get("NO_PROXY", "")
if os.environ.get("no_proxy") != actual_bypass:
    raise RuntimeError("NO_PROXY aliases differ")
required_bypass = {entry.strip().lower() for entry in ${JSON.stringify(network.bypass)}.split(",") if entry.strip()}
actual_bypass_entries = {entry.strip().lower() for entry in actual_bypass.replace(" ", ",").split(",") if entry.strip()}
if not required_bypass.issubset(actual_bypass_entries):
    raise RuntimeError("mandatory loopback bypass is missing")
if "[::1]" not in actual_bypass_entries:
    raise RuntimeError("Bun IPv6 loopback bypass is missing")
if "localhost." not in actual_bypass_entries:
    raise RuntimeError("Bun localhost-dot bypass is missing")
if os.environ.get("PLAYWRIGHT_MCP_PROXY_SERVER") != ${JSON.stringify(network.searchProxy)}:
    raise RuntimeError("wrong Playwright Search proxy route")
if os.environ.get("PLAYWRIGHT_MCP_PROXY_BYPASS") != actual_bypass:
    raise RuntimeError("Playwright bypass differs from process bypass")

npm_proxy_keys = ["npm_config_proxy", "NPM_CONFIG_PROXY", "npm_config_https_proxy", "NPM_CONFIG_HTTPS_PROXY"]
for key in npm_proxy_keys:
    if os.environ.get(key) != expected_all_proxy:
        raise RuntimeError(f"wrong {key} proxy route")
for key in ["npm_config_noproxy", "NPM_CONFIG_NOPROXY"]:
    if os.environ.get(key) != actual_bypass:
        raise RuntimeError(f"wrong {key} bypass")

with urllib.request.urlopen(${JSON.stringify(network.targetUrl)}, timeout=15) as response:
    body = response.read().decode("utf-8")
if body.strip() != ${JSON.stringify(network.targetSentinel)}:
    raise RuntimeError("unexpected deterministic child target response")

with urllib.request.urlopen(${JSON.stringify(network.loopbackTargetUrl)}, timeout=15) as response:
    loopback_body = response.read().decode("utf-8")
if loopback_body.strip() != ${JSON.stringify(network.loopbackTargetSentinel)}:
    raise RuntimeError("unexpected deterministic child loopback response")
print("easyresearch-network-route-ok")
`
    : "";
  writeFileSync(path, `import os
import pathlib
import sys
import urllib.request
import arxiv
import markitdown

expected = pathlib.Path(os.environ["EASYRESEARCH_VENV"]).resolve()
actual = pathlib.Path(sys.prefix).resolve()
if actual != expected:
    raise RuntimeError(f"wrong venv prefix: {actual} != {expected}")
${networkValidation}
print("easyresearch-venv-ok")
`);
}

export interface VenvValidationResult {
  stdout: string;
  stderr: string;
}

interface ValidationSpawnResult {
  status: number | null;
  stdout: string | Buffer | null;
  stderr: string | Buffer | null;
  error?: Error;
}

const VENV_SENTINEL = "easyresearch-venv-ok";
const STAGE_COMPLETION = "complete\nArtifacts: none\nGaps: none\nNext action: none";

export function assertPathFreeSessionEvent(event: unknown): string {
  validateSmokeSessionActivityFrames(event);
  const serialized = JSON.stringify(event);
  if (serialized === undefined) throw new Error("session SSE emitted an unserializable empty frame");
  if (serialized.includes("<agent_handoff>")) {
    throw new Error(`session SSE exposed a hidden handoff: ${serialized}`);
  }
  if (/"(?:sessionPath|session_path)"\s*:/u.test(serialized)) {
    throw new Error(`session SSE exposed a child session path: ${serialized}`);
  }
  return serialized;
}

export function validateSmokeSessionActivityFrames(event: unknown): void {
  if (!event || typeof event !== "object" || Array.isArray(event)) return;
  const value = event as { type?: unknown; event?: unknown };
  if (value.type === "session_activity_changed") {
    parseSmokeSessionActivity(value);
    return;
  }
  if (value.type === "subagent_supervisor") {
    validateSmokeSessionActivityFrames(value.event);
  }
}

export interface SmokeSessionActivity {
  status: "ready" | "running";
  isStreaming: boolean;
}

export interface SmokeSessionActivityTracker {
  sequence: number;
  latest?: SmokeSessionActivity;
}

export function captureSmokeCompletionActivityBaseline(options: {
  baseline: number | undefined;
  activitySequence: number;
  milestonesComplete: boolean;
}): number | undefined {
  if (!Number.isSafeInteger(options.activitySequence) || options.activitySequence < 0) {
    throw new Error("native smoke completion activity sequence is invalid");
  }
  if (
    options.baseline !== undefined
    && (
      !Number.isSafeInteger(options.baseline)
      || options.baseline < 0
      || options.baseline > options.activitySequence
    )
  ) {
    throw new Error("native smoke completion activity baseline is invalid");
  }
  if (options.baseline !== undefined) return options.baseline;
  return options.milestonesComplete ? options.activitySequence : undefined;
}

export function parseSmokeInitialSessionSnapshot(snapshot: unknown): SmokeSessionActivity {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("native smoke initial session snapshot was not an object");
  }
  const value = snapshot as {
    type?: unknown;
    session?: unknown;
    timeline?: unknown;
    messages?: unknown;
  };
  if (value.type !== "snapshot") {
    throw new Error("native smoke initial session snapshot had an invalid type");
  }
  if (!Array.isArray(value.timeline)) {
    throw new Error("native smoke initial session snapshot did not expose timeline");
  }
  if (Object.hasOwn(value, "messages")) {
    throw new Error("native smoke initial session snapshot exposed legacy messages");
  }
  validateSmokeInitialTimeline(value.timeline);
  return parseSmokeSessionActivity(value.session);
}

function validateSmokeInitialTimeline(timeline: readonly unknown[]): void {
  for (let index = 0; index < timeline.length; index += 1) {
    const entry = timeline[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`native smoke initial timeline entry ${index} was not an object`);
    }
    const value = entry as {
      kind?: unknown;
      entryId?: unknown;
      message?: unknown;
      timestamp?: unknown;
      summary?: unknown;
    };
    if (typeof value.entryId !== "string" || value.entryId.trim().length === 0) {
      throw new Error(`native smoke initial timeline entry ${index} had an invalid entryId`);
    }
    if (value.kind === "message") {
      if (!value.message || typeof value.message !== "object" || Array.isArray(value.message)) {
        throw new Error(`native smoke initial timeline message ${index} was invalid`);
      }
      const role = (value.message as { role?: unknown }).role;
      if (typeof role !== "string" || role.trim().length === 0) {
        throw new Error(`native smoke initial timeline message ${index} had an invalid role`);
      }
      continue;
    }
    if (value.kind !== "compaction" && value.kind !== "branch-summary") {
      throw new Error(`native smoke initial timeline entry ${index} had an invalid kind`);
    }
    if (
      typeof value.timestamp !== "string"
      || value.timestamp.length === 0
      || !Number.isFinite(Date.parse(value.timestamp))
    ) {
      throw new Error(`native smoke initial timeline summary ${index} had an invalid timestamp`);
    }
    if (Object.hasOwn(value, "summary") && typeof value.summary !== "string") {
      throw new Error(`native smoke initial timeline summary ${index} had an invalid summary`);
    }
  }
}

export function recordSmokeSessionActivityReplacement(
  state: SmokeSessionActivityTracker,
  event: unknown,
): SmokeSessionActivityTracker {
  if (!Number.isSafeInteger(state.sequence) || state.sequence < 0) {
    throw new Error("native smoke session activity sequence is invalid");
  }
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("native smoke session activity replacement was not an object");
  }
  const value = event as { type?: unknown; active?: unknown };
  if (value.type !== "session_activity_changed") {
    throw new Error("native smoke session activity replacement had an invalid type");
  }
  if (Object.hasOwn(value, "active")) {
    throw new Error("native smoke session activity replacement leaked private active state");
  }
  return {
    sequence: state.sequence + 1,
    latest: parseSmokeSessionActivity(value),
  };
}

export function isSmokeSessionReadyAfter(
  state: SmokeSessionActivityTracker,
  baseline: number,
): boolean {
  if (!Number.isSafeInteger(baseline) || baseline < 0 || baseline > state.sequence) {
    throw new Error("native smoke session activity baseline is invalid");
  }
  return state.sequence > baseline
    && state.latest?.status === "ready"
    && state.latest.isStreaming === false;
}

function parseSmokeSessionActivity(value: unknown): SmokeSessionActivity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("native smoke session activity was not an object");
  }
  const activity = value as { status?: unknown; isStreaming?: unknown; active?: unknown };
  if (Object.hasOwn(activity, "active")) {
    throw new Error("native smoke session activity leaked private active state");
  }
  if (
    (activity.status !== "ready" && activity.status !== "running")
    || typeof activity.isStreaming !== "boolean"
    || (activity.status === "ready" && activity.isStreaming)
  ) {
    throw new Error(
      `native smoke session activity pair was invalid: ${JSON.stringify({
        status: activity.status,
        isStreaming: activity.isStreaming,
      })}`,
    );
  }
  return { status: activity.status, isStreaming: activity.isStreaming };
}

export async function fetchSessionEventsBeforeDeadline(options: {
  url: string;
  deadline: number;
  init?: Omit<RequestInit, "signal">;
  timeoutMessage?: string;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  now?: () => number;
}): Promise<Response> {
  const remaining = options.deadline - (options.now ?? Date.now)();
  const timeoutMessage = options.timeoutMessage
    ?? "session SSE subscription did not finish before the native smoke deadline";
  if (remaining <= 0) throw new Error(timeoutMessage);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remaining);
  try {
    return await (options.fetch ?? globalThis.fetch)(options.url, {
      ...options.init,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(timeoutMessage, { cause: error });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function requestSmokeJsonBeforeDeadline(options: {
  url: string;
  deadline: number;
  label: string;
  init?: Omit<RequestInit, "signal">;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  now?: () => number;
}): Promise<unknown> {
  const remaining = options.deadline - (options.now ?? Date.now)();
  const timeoutMessage = `${options.label} did not finish before the native smoke deadline`;
  if (remaining <= 0) throw new Error(timeoutMessage);

  const controller = new AbortController();
  let response: Response | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const operation = async (): Promise<unknown> => {
    response = await (options.fetch ?? globalThis.fetch)(options.url, {
      ...options.init,
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${options.label} failed (${response.status}): ${text}`);
    }
    return text ? JSON.parse(text) as unknown : undefined;
  };
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      try {
        void response?.body?.cancel().catch(() => {});
      } catch {
        // A response reader may already own the body; the deadline race remains authoritative.
      }
      reject(new Error(timeoutMessage));
    }, remaining);
  });

  try {
    return await Promise.race([operation(), deadline]);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(timeoutMessage, { cause: error });
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function hasExactLine(text: string, expected: string): boolean {
  return text.split(/\r?\n/).some((line) => line === expected);
}

export function runVenvValidation(options: {
  python: string;
  script: string;
  exists?: (path: string) => boolean;
  spawn?: (
    command: string,
    args: readonly string[],
    options: { encoding: "utf8"; timeout: number },
  ) => ValidationSpawnResult;
}): VenvValidationResult {
  const failure = (reason: string, stdout = "", stderr = ""): never => {
    throw new Error(`${options.python} venv validation ${reason}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  };
  const exists = options.exists ?? (options.spawn ? undefined : existsSync);
  if (exists && !exists(options.python)) failure("interpreter is missing");

  const result = (options.spawn ?? spawnSync)(options.python, ["-I", options.script], {
    encoding: "utf8",
    timeout: 60_000,
  });
  const stdout = result.stdout?.toString() ?? "";
  const stderr = result.stderr?.toString() ?? "";
  if (result.error) failure(`spawn failed: ${result.error.message}`, stdout, stderr);
  if (result.status !== 0) failure(`failed with status ${result.status ?? "unknown"}`, stdout, stderr);
  if (!hasExactLine(stdout, VENV_SENTINEL)) failure(`did not emit ${VENV_SENTINEL}`, stdout, stderr);
  return { stdout, stderr };
}

/** Ensures the first-run writer exits before returning or reporting its deadline failure. */
export async function settleProcess(options: {
  pid: number;
  deadline: number;
  terminateImmediately?: boolean;
  terminationGraceMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  isAlive: (pid: number) => boolean;
  terminateTree: (pid: number) => void;
  sleep?: (ms: number) => Promise<void>;
}): Promise<"exited" | "terminated"> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pollIntervalMs = options.pollIntervalMs ?? 200;
  const terminationGraceMs = options.terminationGraceMs ?? 30_000;
  if (!options.isAlive(options.pid)) return "exited";

  let terminated = false;
  let exceededDeadline = false;
  let terminationDeadline = 0;
  const terminate = () => {
    options.terminateTree(options.pid);
    terminated = true;
    terminationDeadline = now() + terminationGraceMs;
  };

  if (options.terminateImmediately) terminate();
  while (options.isAlive(options.pid)) {
    const current = now();
    if (!terminated && current >= options.deadline) {
      exceededDeadline = true;
      terminate();
    } else if (terminated && current >= terminationDeadline) {
      throw new Error(`process ${options.pid} did not exit after tree termination`);
    }
    await sleep(pollIntervalMs);
  }

  if (exceededDeadline) {
    throw new Error(`process ${options.pid} exceeded first-run deadline and was terminated`);
  }
  return terminated ? "terminated" : "exited";
}

export async function readTextFileWithRetry(options: {
  path: string;
  attempts?: number;
  delayMs?: number;
  read?: (path: string) => string;
  sleep?: (ms: number) => Promise<void>;
}): Promise<string> {
  const attempts = Math.max(1, options.attempts ?? 10);
  const read = options.read ?? ((path) => readFileSync(path, "utf8"));
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let cause = "unknown read failure";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return read(options.path);
    } catch (error) {
      cause = error instanceof Error ? error.message : String(error);
      if (attempt < attempts) await sleep(options.delayMs ?? 200);
    }
  }
  return `[capture unavailable: ${cause}]`;
}

export function collectLaunchOutput(options: {
  asynchronous: boolean;
  stdoutPath: string;
  stderrPath: string;
  read: (path: string) => string;
}): { stdout: string; stderr: string } {
  if (options.asynchronous) return { stdout: "", stderr: "" };
  return {
    stdout: options.read(options.stdoutPath),
    stderr: options.read(options.stderrPath),
  };
}

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function buildWindowsShutdownScript(options: {
  binary: string;
  args: readonly string[];
  stdoutPath: string;
  stderrPath: string;
  statusPath: string;
  powershellErrorPath: string;
}): string {
  const command = [options.binary, ...options.args].map(powershellQuote).join(" ");
  return [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    `  & ${command} 1> ${powershellQuote(options.stdoutPath)} 2> ${powershellQuote(options.stderrPath)}`,
    "  $status = $LASTEXITCODE",
    `  Set-Content -LiteralPath ${powershellQuote(options.statusPath)} -Value ([string]$status) -Encoding ascii`,
    "  if ($status -ne 0) { throw \"Windows shutdown client exited with status $status\" }",
    "  exit 0",
    "} catch {",
    `  $_ | Out-File -FilePath ${powershellQuote(options.powershellErrorPath)} -Encoding utf8`,
    "  exit 99",
    "}",
  ].join("; ");
}

export function buildWindowsShutdownLauncherScript(options: {
  powershell: string;
  wrapperPath: string;
  pidPath: string;
  taskkill: string;
  powershellErrorPath: string;
}): string {
  const wrapperArgument = `"${options.wrapperPath}"`;
  const argumentList = ["-NoProfile", "-NonInteractive", "-File", wrapperArgument]
    .map(powershellQuote)
    .join(", ");
  return [
    "$ErrorActionPreference = 'Stop'",
    "$process = $null",
    "try {",
    `  $process = Start-Process -FilePath ${powershellQuote(options.powershell)} -ArgumentList @(${argumentList}) -WindowStyle Hidden -PassThru`,
    `  Set-Content -LiteralPath ${powershellQuote(options.pidPath)} -Value $process.Id -Encoding ascii`,
    "  if (-not $process.WaitForExit(30000)) {",
    `    & ${powershellQuote(options.taskkill)} /PID $($process.Id) /T /F | Out-Null`,
    "    throw 'Windows shutdown wrapper timed out after 30000ms'",
    "  }",
    "  exit 0",
    "} catch {",
    "  if ($null -ne $process) {",
    `    & ${powershellQuote(options.taskkill)} /PID $($process.Id) /T /F | Out-Null`,
    "  }",
    `  $_ | Out-File -FilePath ${powershellQuote(options.powershellErrorPath)} -Encoding utf8`,
    "  exit 99",
    "}",
  ].join("; ");
}

export function requireZeroProcessStatus(options: {
  label: string;
  statusText: string;
  stdout: string;
  stderr: string;
}): void {
  const text = options.statusText.trim();
  if (!/^-?\d+$/.test(text)) {
    throw new Error(`${options.label} did not record a valid exit status: ${text || "missing"}`);
  }
  const status = Number(text);
  if (!Number.isSafeInteger(status)) {
    throw new Error(`${options.label} did not record a valid exit status: ${text}`);
  }
  if (status !== 0) {
    throw new Error(
      `${options.label} failed with status ${status}\nstdout:\n${options.stdout}\nstderr:\n${options.stderr}`,
    );
  }
}

type CleanupStep = () => void | Promise<void>;

export async function finishSmokeCleanup(options: {
  primaryError?: Error;
  shutdown: CleanupStep;
  stopAuxiliary: CleanupStep;
  verifyDaemonStopped: CleanupStep;
  removeRoot: CleanupStep;
}): Promise<void> {
  const failures: Array<{ label: string; error: Error }> = [];
  const attempt = async (label: string, step: CleanupStep): Promise<boolean> => {
    try {
      await step();
      return true;
    } catch (error) {
      failures.push({ label, error: error instanceof Error ? error : new Error(String(error)) });
      return false;
    }
  };

  await attempt("shutdown", options.shutdown);
  await attempt("auxiliary shutdown", options.stopAuxiliary);
  const daemonStopped = await attempt("daemon termination verification", options.verifyDaemonStopped);
  if (daemonStopped) {
    await attempt("temporary root removal", options.removeRoot);
  }

  if (failures.length === 0) {
    if (options.primaryError) throw options.primaryError;
    return;
  }
  const diagnostics = failures.map(({ label, error }) => `${label}: ${error.message}`).join("\n");
  if (options.primaryError) {
    options.primaryError.message = `${options.primaryError.message}\n\nCleanup diagnostics:\n${diagnostics}`;
    Object.defineProperty(options.primaryError, "cleanupErrors", {
      configurable: true,
      enumerable: false,
      value: failures.map(({ error }) => error),
    });
    throw options.primaryError;
  }
  throw new AggregateError(
    failures.map(({ error }) => error),
    `native smoke cleanup failed:\n${diagnostics}`,
  );
}

export function venvToolCommand(platform: NodeJS.Platform, scriptPath: string): string {
  if (platform === "win32") {
    const quotedScript = scriptPath.replaceAll("'", "''");
    return `& (Join-Path $env:EASYRESEARCH_VENV 'Scripts\\python.exe') '${quotedScript}'`;
  }
  const quotedScript = scriptPath.replace(/["\\`$]/g, "\\$&");
  return `"$EASYRESEARCH_VENV/bin/python" "${quotedScript}"`;
}

export type SmokeModelAction =
  | { kind: "tool"; id: string; name: "subagent" | "web-search" | "webfetch" | NativeLocalShellTool; arguments: string }
  | { kind: "text"; text: string };

export interface SmokeWebFetchScenario {
  targetUrl: string;
  expectedResultText: string;
  completionText: string;
  forbiddenResultText?: readonly string[];
  toolName?: "web-search" | "webfetch";
  toolCallId?: string;
  toolArguments?: Record<string, unknown>;
}

export interface SmokeWebFetchState {
  toolIssued: boolean;
  resultObserved: boolean;
  completedRequests: number;
}

export interface SmokeWebFetchTransition {
  action: SmokeModelAction;
  state: SmokeWebFetchState;
}

export function selectSmokeWebFetchAction(
  request: {
    tools?: Array<{ function?: { name?: string } }>;
    messages?: Array<{ role?: string; content?: unknown; tool_call_id?: string }>;
  },
  scenario: SmokeWebFetchScenario,
  state: SmokeWebFetchState,
): SmokeWebFetchTransition {
  const toolName = scenario.toolName ?? "webfetch";
  const toolCallId = scenario.toolCallId ?? "call_native_webfetch";
  const matchingTools = request.tools?.filter((tool) => tool.function?.name === toolName) ?? [];
  if (matchingTools.length !== 1) {
    throw new Error(`native smoke expected exactly one ${toolName} tool, received ${matchingTools.length}`);
  }
  if (state.resultObserved && !state.toolIssued) {
    throw new Error("native smoke webfetch state is out of order");
  }
  if (state.resultObserved) throw new Error("native smoke webfetch sequence is already complete");
  if (!state.toolIssued) {
    return {
      action: {
        kind: "tool",
        id: toolCallId,
        name: toolName,
        arguments: JSON.stringify(scenario.toolArguments ?? {
          url: scenario.targetUrl,
          format: "text",
          timeout: 30,
        }),
      },
      state: { ...state, toolIssued: true, completedRequests: state.completedRequests + 1 },
    };
  }

  const results = request.messages?.filter(
    (message) => message.role === "tool" && message.tool_call_id === toolCallId,
  ) ?? [];
  if (results.length !== 1) {
    throw new Error(`native smoke expected exactly one ${toolName} result, received ${results.length}`);
  }
  const result = messageContentText(results[0]!.content);
  if (!result.includes(scenario.expectedResultText)) {
    throw new Error(`native smoke ${toolName} result did not contain the expected result marker`);
  }
  if (scenario.forbiddenResultText?.some((value) => value && result.includes(value))) {
    throw new Error(`native smoke ${toolName} result exposed sensitive route data`);
  }
  return {
    action: { kind: "text", text: scenario.completionText },
    state: {
      ...state,
      resultObserved: true,
      completedRequests: state.completedRequests + 1,
    },
  };
}

export interface SmokeModelScenario {
  shellToolName: NativeLocalShellTool;
  toolCommand: string;
  agentName: string;
  agentPath: string;
  agentContent: string;
  agentPromptMarker: string;
  skillName: string;
  skillPath: string;
  skillContent: string;
  skillPromptMarker: string;
}

export interface SmokeModelState {
  baselineConfigurationGeneration: number | undefined;
  externalResourcesWritten: boolean;
  acceptedConfigurationGeneration: number | undefined;
  rootAppliedConfigurationGeneration: number | undefined;
  customDispatchIssued: boolean;
  parentWorkingObserved: boolean;
  childSkillObserved: boolean;
  stageShellIssued: boolean;
  venvValidated: boolean;
  stageCompleted: boolean;
  terminalHandoffObserved: boolean;
  complete: boolean;
  completedRequests: number;
}

export type SmokeAcceptanceMilestone =
  | { kind: "baseline-snapshot"; generation: number }
  | { kind: "external-resources-written" }
  | { kind: "accepted-generation"; generation: number }
  | { kind: "root-applied-generation"; generation: number };

export function recordSmokeAcceptanceMilestone(
  state: SmokeModelState,
  milestone: SmokeAcceptanceMilestone,
): SmokeModelState {
  const validGeneration = (generation: number): boolean =>
    Number.isSafeInteger(generation) && generation >= 0;
  if (milestone.kind === "baseline-snapshot") {
    if (
      !validGeneration(milestone.generation)
      || state.baselineConfigurationGeneration !== undefined
      || state.externalResourcesWritten
      || state.acceptedConfigurationGeneration !== undefined
      || state.rootAppliedConfigurationGeneration !== undefined
    ) {
      throw new Error("native smoke baseline snapshot milestone is invalid or out of order");
    }
    return { ...state, baselineConfigurationGeneration: milestone.generation };
  }

  const baseline = state.baselineConfigurationGeneration;
  if (baseline === undefined) {
    throw new Error("native smoke must obtain the root baseline snapshot before later milestones");
  }
  if (milestone.kind === "external-resources-written") {
    if (
      state.externalResourcesWritten
      || state.acceptedConfigurationGeneration !== undefined
      || state.rootAppliedConfigurationGeneration !== undefined
    ) {
      throw new Error("native smoke external resource write milestone is out of order");
    }
    return { ...state, externalResourcesWritten: true };
  }
  if (!state.externalResourcesWritten) {
    throw new Error("native smoke must externally write Agent and Skill resources before generation acceptance");
  }
  if (milestone.kind === "accepted-generation") {
    if (
      !validGeneration(milestone.generation)
      || milestone.generation <= baseline
      || state.acceptedConfigurationGeneration !== undefined
      || state.rootAppliedConfigurationGeneration !== undefined
    ) {
      throw new Error("native smoke accepted generation must be greater than the baseline and recorded in order");
    }
    return { ...state, acceptedConfigurationGeneration: milestone.generation };
  }

  const accepted = state.acceptedConfigurationGeneration;
  if (accepted === undefined) {
    throw new Error("native smoke must observe the accepted generation before root application");
  }
  if (
    !validGeneration(milestone.generation)
    || milestone.generation <= baseline
    || milestone.generation < accepted
    || state.rootAppliedConfigurationGeneration !== undefined
  ) {
    throw new Error("native smoke root-applied generation must be greater than the baseline and include acceptance");
  }
  return { ...state, rootAppliedConfigurationGeneration: milestone.generation };
}

export interface SmokeModelTransition {
  action: SmokeModelAction;
  state: SmokeModelState;
  validatedVenvResult: boolean;
}

function messageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(messageContentText).join("\n");
  if (content && typeof content === "object" && "text" in content) {
    return messageContentText((content as { text?: unknown }).text);
  }
  return "";
}

function hasSuccessfulTerminalHandoff(
  messages: Array<{ role?: string; content?: unknown }> | undefined,
  agentId: string,
): boolean {
  const terminalMessages = messages
    ?.filter((message) => message.role === "user")
    .map((message) => messageContentText(message.content))
    .filter((content) => content.includes("<agent_status>") || content.includes("<agent_handoff>"))
    ?? [];
  if (terminalMessages.length === 0) return false;
  if (terminalMessages.length !== 1) {
    throw new Error(`native smoke expected exactly one atomic terminal notification, received ${terminalMessages.length}`);
  }

  const normalized = terminalMessages[0]!.replaceAll("\r\n", "\n").trim();
  const match = normalized.match(
    /^<agent_status>\n([\s\S]*?)\n<\/agent_status>\n<agent_handoff>\n([\s\S]*?)\n<\/agent_handoff>$/u,
  );
  const status = match?.[1];
  const handoff = match?.[2];
  const completeLines = status
    ?.split("\n")
    .filter((line) => line.trim() === `Complete subagent:${agentId}`)
    ?? [];
  if (
    completeLines.length !== 1
    || status?.includes("session_path")
    || handoff?.trim() !== `Agent: ${agentId}\nResult: ${STAGE_COMPLETION}`
  ) {
    throw new Error(`native smoke received a malformed atomic terminal notification: ${normalized}`);
  }
  return true;
}

export function selectSmokeModelAction(
  request: {
    tools?: Array<{ function?: { name?: string; description?: string } }>;
    messages?: Array<{ role?: string; content?: unknown; tool_call_id?: string }>;
  },
  scenario: SmokeModelScenario,
  state: SmokeModelState,
): SmokeModelTransition {
  if (!isAbsolute(scenario.agentPath)) {
    throw new Error(`native smoke custom Agent path must be absolute: ${scenario.agentPath}`);
  }
  if (!isAbsolute(scenario.skillPath)) {
    throw new Error(`native smoke custom Skill path must be absolute: ${scenario.skillPath}`);
  }
  if (!scenario.agentContent.includes(scenario.agentPromptMarker)) {
    throw new Error("native smoke custom Agent content is missing its role-prompt marker");
  }
  if (!scenario.agentContent.includes(scenario.skillName)) {
    throw new Error("native smoke custom Agent content does not reference its unique Skill");
  }
  if (!scenario.skillContent.includes(scenario.skillPromptMarker)) {
    throw new Error("native smoke custom Skill content is missing its prompt marker");
  }
  const tools = request.tools ?? [];
  const toolNames = new Set(tools.map((tool) => tool.function?.name));
  const shellTools = tools
    .map((tool) => tool.function?.name)
    .filter((name): name is NativeLocalShellTool =>
      name === "bash" || name === "powershell"
    );
  if (shellTools.length !== 1 || shellTools[0] !== scenario.shellToolName) {
    throw new Error(
      `native smoke expected exactly one local shell tool named ${scenario.shellToolName}; received ${shellTools.join(", ") || "none"}`,
    );
  }
  if (state.baselineConfigurationGeneration === undefined) {
    throw new Error("native smoke model request arrived before the root baseline snapshot");
  }
  if (!state.externalResourcesWritten) {
    throw new Error("native smoke model request arrived before external Agent and Skill writes");
  }
  if (state.acceptedConfigurationGeneration === undefined) {
    throw new Error("native smoke model request arrived before configuration acceptance");
  }
  if (state.rootAppliedConfigurationGeneration === undefined) {
    throw new Error("native smoke model request arrived before root configuration application");
  }
  if (state.complete) throw new Error("native smoke model sequence is already complete");
  const agentId = `${scenario.agentName}_0`;

  const transition = (
    action: SmokeModelAction,
    updates: Partial<SmokeModelState>,
    validatedVenvResult = false,
  ): SmokeModelTransition => ({
    action,
    state: { ...state, ...updates, completedRequests: state.completedRequests + 1 },
    validatedVenvResult,
  });
  const expectedToolResult = (toolCallId: string): string => {
    const matches = request.messages?.filter(
      (message) => message.role === "tool" && message.tool_call_id === toolCallId,
    ) ?? [];
    if (matches.length !== 1) {
      throw new Error(`native smoke expected exactly one tool result for ${toolCallId}, received ${matches.length}`);
    }
    return messageContentText(matches[0]?.content);
  };
  const subagentDescription = (): string => {
    const matches = tools.filter((tool) => tool.function?.name === "subagent");
    if (matches.length !== 1) {
      throw new Error(`native smoke expected exactly one subagent tool, received ${matches.length}`);
    }
    const description = matches[0]?.function?.description;
    if (typeof description !== "string") {
      throw new Error("native smoke subagent tool had no description");
    }
    return description;
  };
  const descriptionListsAgent = (description: string): boolean => {
    const prefix = "Available subagents: ";
    const line = description.split(/\r?\n/u).find((candidate) => candidate.startsWith(prefix));
    if (!line?.endsWith(".")) return false;
    return line
      .slice(prefix.length, -1)
      .split(", ")
      .includes(scenario.agentName);
  };

  if (toolNames.has("write")) {
    const webSearchTools = tools.filter((tool) => tool.function?.name === "web-search");
    if (webSearchTools.length !== 1) {
      throw new Error(`native smoke expected exactly one web-search tool, received ${webSearchTools.length}`);
    }
    const description = subagentDescription();
    if (!state.customDispatchIssued) {
      if (!descriptionListsAgent(description)) {
        throw new Error(`native smoke post-application parent request did not expose ${scenario.agentName} in the subagent schema`);
      }
      return transition({
        kind: "tool",
        id: "call_native_reviewer",
        name: "subagent",
        arguments: JSON.stringify({
          agent: scenario.agentName,
          task: `Run the native venv validation command with the ${scenario.shellToolName} tool and return a complete handoff.`,
        }),
      }, { customDispatchIssued: true });
    }
    if (!descriptionListsAgent(description)) {
      throw new Error(`native smoke parent lost ${scenario.agentName} from the refreshed subagent schema`);
    }
    const working = expectedToolResult("call_native_reviewer");
    if (working !== `${agentId} is working.`) {
      throw new Error(`subagent tool result was not exactly ${agentId} is working.: ${working}`);
    }
    const terminalHandoffObserved = hasSuccessfulTerminalHandoff(request.messages, agentId);
    if (!terminalHandoffObserved) {
      return transition(
        { kind: "text", text: "Parent waiting for supervised completion." },
        { parentWorkingObserved: true },
      );
    }
    if (!state.childSkillObserved || !state.venvValidated || !state.stageCompleted) {
      throw new Error(
        `native smoke received the terminal handoff before successful ${scenario.shellToolName} stage validation`,
      );
    }
    return transition(
      { kind: "text", text: "Parent smoke run complete." },
      { parentWorkingObserved: true, terminalHandoffObserved: true, complete: true },
    );
  }

  if (toolNames.has(scenario.shellToolName)) {
    if (!state.customDispatchIssued) {
      throw new Error("native smoke custom child ran before the parent dispatch");
    }
    const configuredTools = tools.map((tool) => tool.function?.name);
    if (
      configuredTools.length !== 2
      || configuredTools.filter((name) => name === "read").length !== 1
      || configuredTools.filter((name) => name === scenario.shellToolName).length !== 1
    ) {
      throw new Error(`native smoke custom child did not receive only its configured tools: ${configuredTools.join(", ")}`);
    }
    const systemPrompt = request.messages
      ?.filter((message) => message.role === "system")
      .map((message) => messageContentText(message.content))
      .join("\n")
      ?? "";
    if (!systemPrompt.includes(scenario.agentPromptMarker)) {
      throw new Error("native smoke custom child did not receive its current role prompt");
    }
    if (!systemPrompt.includes(scenario.skillPromptMarker)) {
      throw new Error("native smoke custom child did not receive its referenced Skill marker");
    }
    if (!state.stageShellIssued) {
      return transition({
        kind: "tool",
        id: "call_native_venv",
        name: scenario.shellToolName,
        arguments: JSON.stringify({ command: scenario.toolCommand, timeout: 60 }),
      }, { childSkillObserved: true, stageShellIssued: true });
    }
    if (state.stageCompleted) {
      throw new Error("native smoke stage model sequence is already complete");
    }
    const content = expectedToolResult("call_native_venv");
    const sentinelLines = content
      .split(/\r?\n/u)
      .filter((line) => line === VENV_SENTINEL);
    if (sentinelLines.length !== 1) {
      throw new Error(
        `${scenario.shellToolName} tool result did not contain exactly one ${VENV_SENTINEL} line: ${content}`,
      );
    }
    return transition(
      { kind: "text", text: STAGE_COMPLETION },
      { venvValidated: true, stageCompleted: true },
      true,
    );
  }

  throw new Error(
    `native smoke model request exposed neither the parent write tool nor the custom child ${scenario.shellToolName} tool`,
  );
}
