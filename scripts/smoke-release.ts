#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { TARGETS, platformBinaryName, platformPackageDir, repoPackageVersion } from "./build";
import { validateNativeVersionOutput } from "./release";
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
  redactSmokeDiagnostic,
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
  type RecordingHttpProxy,
  type SmokeDaemonIdentity,
  type SmokeModelScenario,
  type SmokeModelState,
  type SmokeNetworkState,
  type SmokeProxyRecord,
  type SmokeSessionActivityTracker,
  type SmokeWebFetchScenario,
  type SmokeWebFetchState,
  skillVenvPython,
  startRecordingHttpProxy,
  settleProcess,
  venvToolCommand,
  writeVenvValidationScript,
} from "./smoke-release-support";
import { nativeLocalShellTool } from "../src/runtime/platform-tools";
import { DAEMON_CONTROL_PATH, DAEMON_TOKEN_HEADER } from "../src/cli/daemon-control";

const targetName = process.argv[2];
const target = TARGETS.find((candidate) => candidate.name === targetName);
if (!target) throw new Error(`unknown smoke target: ${targetName}`);
const versionVerifiedByRunner = process.argv[3] === "--version-verified-by-runner";
if (process.argv.length > (versionVerifiedByRunner ? 4 : 3)) throw new Error("unexpected native smoke arguments");
if (versionVerifiedByRunner && target.name !== "windows-x64") {
  throw new Error("runner-verified version is reserved for Windows native smoke");
}

const binary = resolve(platformPackageDir(target.name), "bin", platformBinaryName(target));
const systemPython = resolveSmokePython({ explicit: process.env.EASYRESEARCH_SMOKE_PYTHON });
const smokeShellToolName = nativeLocalShellTool(process.platform);
const systemPowerShell = process.platform === "win32"
  ? resolveSmokePowerShell()
  : undefined;
const windowsSystem32 = process.platform === "win32"
  ? resolveSmokeWindowsSystem32(process.env)
  : undefined;
const root = mkdtempSync(join(tmpdir(), "easyresearch-native-smoke-"));
const home = join(root, "home");
const agentDir = join(root, "agent");
const project = join(root, "project");
mkdirSync(home, { recursive: true });
mkdirSync(project, { recursive: true });
mkdirSync(agentDir, { recursive: true });
const venvPython = skillVenvPython(agentDir, process.platform);
const validationScript = join(root, "validate-easyresearch-venv.py");
const stageValidationScript = join(root, "validate-easyresearch-agent-network.py");
const setupRunId = randomUUID();
const googleCredentialsPath = join(root, "gaxios-adc.json");
const firstRunStdoutPath = join(root, "first-run-stdout.txt");
const firstRunStderrPath = join(root, "first-run-stderr.txt");
const firstRunPidPath = join(root, "first-run-client.pid");
const shutdownWrapperPath = join(root, "shutdown-wrapper.ps1");
const shutdownWrapperPidPath = join(root, "shutdown-wrapper.pid");
const shutdownStatusPath = join(root, "shutdown-status.txt");
const daemonPidPath = join(agentDir, "server.pid");
writeVenvValidationScript(validationScript);
const smokeAgentName = "smoke-reviewer";
const smokeAgentPromptMarker = "NATIVE_SMOKE_CUSTOM_REVIEWER_PROMPT";
const smokeSkillName = "native-smoke-resource";
const smokeSkillPromptMarker = `NATIVE_SMOKE_SKILL_${setupRunId}`;
const smokeAgentPath = join(agentDir, "agents", `${smokeAgentName}.md`);
const smokeSkillPath = join(agentDir, "skills", smokeSkillName, "SKILL.md");
const fakeLlmHost = "llm.native-smoke.invalid";
const fakeGaxiosHost = "gaxios.native-smoke.invalid";
const fakeSearchHost = "search.native-smoke.invalid";
const fakeChildHost = "child.native-smoke.invalid";
const oauthHost = "auth.openai.com";
const candidateHost = "example.com";
const ambientPipProxy = "http://ambient-user:AMBIENT_PIP_SECRET@ambient-pip.invalid:8080";
const validSearchMarker = `NATIVE_SMOKE_VALID_SEARCH_${setupRunId}`;
const loopbackProviderMarker = `NATIVE_SMOKE_LOOPBACK_PROVIDER_${setupRunId}`;
const loopbackProviderCompletion = `Loopback provider route complete ${setupRunId}.`;
const ipv6ProviderMarker = `NATIVE_SMOKE_IPV6_PROVIDER_${setupRunId}`;
const ipv6ProviderCompletion = `IPv6 loopback provider route complete ${setupRunId}.`;
const vertexProviderMarker = `NATIVE_SMOKE_VERTEX_PROVIDER_${setupRunId}`;
const vertexProviderCompletion = `Google Gaxios route complete ${setupRunId}.`;
const fixtureGoogleAccessToken = `fixture-google-access-${setupRunId}`;
const loopbackSearchMarker = `NATIVE_SMOKE_LOOPBACK_SEARCH_${setupRunId}`;
const successorSearchMarker = `NATIVE_SMOKE_SUCCESSOR_SEARCH_${setupRunId}`;
const invalidSearchMarker = `NATIVE_SMOKE_INVALID_SEARCH_${setupRunId}`;
const invalidLlmMarker = `NATIVE_SMOKE_INVALID_LLM_${setupRunId}`;
const fakeSearchSentinel = `native-search-route-${setupRunId}`;
const fakeChildSentinel = `native-child-route-${setupRunId}`;
const loopbackSearchSentinel = `native-loopback-search-${setupRunId}`;
const loopbackChildSentinel = `native-loopback-child-${setupRunId}`;
const fakeSearchUrl = `http://${fakeSearchHost}/article`;
const fakeChildUrl = `http://${fakeChildHost}/python-child`;
const smokeAgentContent = [
  "---",
  `name: ${smokeAgentName}`,
  "description: Native smoke custom reviewer",
  "enable: true",
  "tools:",
  "  - read",
  `  - ${smokeShellToolName}`,
  "skills:",
  `  - ${smokeSkillName}`,
  "subagents: []",
  "---",
  "",
  smokeAgentPromptMarker,
  "Run only the requested venv validation command, then return a complete handoff.",
  "",
].join("\n");
const smokeSkillContent = [
  "---",
  `name: ${smokeSkillName}`,
  `description: ${smokeSkillPromptMarker}`,
  "---",
  "",
  "# Native smoke resource",
  "",
].join("\n");
const smokeModelScenario: SmokeModelScenario = {
  shellToolName: smokeShellToolName,
  toolCommand: venvToolCommand(process.platform, stageValidationScript),
  agentName: smokeAgentName,
  agentPath: smokeAgentPath,
  agentContent: smokeAgentContent,
  agentPromptMarker: smokeAgentPromptMarker,
  skillName: smokeSkillName,
  skillPath: smokeSkillPath,
  skillContent: smokeSkillContent,
  skillPromptMarker: smokeSkillPromptMarker,
};
let systemPythonVersionOutput = "not checked";
let validationStdout = "not run";
let validationStderr = "not run";
let firstRunClientPid: number | undefined;
let firstRunClientProcess: ReturnType<typeof spawn> | undefined;
let firstRunClientCompletion: Promise<{ status: number | null; error?: Error }> | undefined;
let firstRunLaunchAttempted = false;
let firstRunDeadline = 0;
let firstRunAllProxyBaselineSequence = 0;
let firstRunPipObservationArmed = false;
let resolveFirstRunPipObservation!: (record: SmokeProxyRecord) => void;
const firstRunPipObservation = new Promise<SmokeProxyRecord>((resolveObservation) => {
  resolveFirstRunPipObservation = resolveObservation;
});
let daemonPid: number | undefined;
let gaxiosRequests = 0;
let modelRequests = 0;
let loopbackProviderRequests = 0;
let ipv6ProviderRequests = 0;
let vertexProviderRequests = 0;
let loopbackSearchRequests = 0;
let loopbackDirectRequests = 0;
let venvToolResults = 0;
let smokeModelState: SmokeModelState = {
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
};
let sessionSnapshotObserved = false;
let observedSupervisorTerminal = false;
let sessionActivityState: SmokeSessionActivityTracker = { sequence: 0 };
let dispatchActivityBaseline: number | undefined;
let completionActivityBaseline: number | undefined;
let sessionEventError: Error | undefined;
let sessionEventReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
let sessionEventTask: Promise<void> | undefined;
let sessionEventsStopping = false;
const recentSessionEvents: string[] = [];
let initialConfigurationGeneration: number | undefined;
let expectedConfigurationBootId: string | undefined;
let observedConfigurationBootId: string | undefined;
let advancedConfigurationGeneration: number | undefined;
let snapshotConfigurationGeneration: number | undefined;
let observedRootAppliedGeneration: number | undefined;
let configurationEventError: Error | undefined;
let configurationEventReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
let configurationEventTask: Promise<void> | undefined;
let configurationEventsStopping = false;
const recentConfigurationEvents: string[] = [];
let smokeNetworkState: SmokeNetworkState = {
  setupPipObserved: false,
  initialBootId: undefined,
  routesObserved: false,
  oauthObserved: false,
  restartAccepted: false,
  successorBootId: undefined,
  successorSessionReady: false,
  invalidSearchRejected: false,
  invalidLlmRejected: false,
};
const initialWebFetchScenario: SmokeWebFetchScenario = {
  targetUrl: fakeSearchUrl,
  expectedResultText: fakeSearchSentinel,
  completionText: "Initial Search route complete.",
};
const successorWebFetchScenario: SmokeWebFetchScenario = {
  targetUrl: fakeSearchUrl,
  expectedResultText: fakeSearchSentinel,
  completionText: "Successor Search route complete.",
  toolCallId: "call_native_successor_webfetch",
};
let invalidSearchWebFetchScenario: SmokeWebFetchScenario;
let loopbackWebFetchScenario: SmokeWebFetchScenario;
let loopbackWebFetchState: SmokeWebFetchState = {
  toolIssued: false,
  resultObserved: false,
  completedRequests: 0,
};
let initialWebFetchState: SmokeWebFetchState = {
  toolIssued: false,
  resultObserved: false,
  completedRequests: 0,
};
let successorWebFetchState: SmokeWebFetchState = {
  toolIssued: false,
  resultObserved: false,
  completedRequests: 0,
};
let invalidSearchWebFetchState: SmokeWebFetchState = {
  toolIssued: false,
  resultObserved: false,
  completedRequests: 0,
};

function smokeCompletionMilestonesSatisfied(): boolean {
  return smokeModelState.complete
    && smokeModelState.customDispatchIssued
    && smokeModelState.childSkillObserved
    && smokeModelState.stageShellIssued
    && smokeModelState.venvValidated
    && smokeModelState.stageCompleted
    && smokeModelState.terminalHandoffObserved
    && venvToolResults === 1
    && observedSupervisorTerminal;
}

function captureCompletionActivityBaseline(): void {
  completionActivityBaseline = captureSmokeCompletionActivityBaseline({
    baseline: completionActivityBaseline,
    activitySequence: sessionActivityState.sequence,
    milestonesComplete: smokeCompletionMilestonesSatisfied(),
  });
}

function modelMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(modelMessageText).join("\n");
  if (content && typeof content === "object" && "text" in content) {
    return modelMessageText((content as { text?: unknown }).text);
  }
  return "";
}

function modelRequestContains(
  messages: Array<{ role?: string; content?: unknown }> | undefined,
  marker: string,
): boolean {
  return messages?.some(
    (message) => message.role === "user" && modelMessageText(message.content).includes(marker),
  ) ?? false;
}

const modelServer = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/gaxios-token") {
      const body = await request.text();
      if (
        request.method !== "POST"
        || !body.includes("grant_type=refresh_token")
        || !body.includes("refresh_token=fixture-refresh")
      ) {
        return new Response("Invalid token request", { status: 400 });
      }
      gaxiosRequests += 1;
      return Response.json({
        access_token: fixtureGoogleAccessToken,
        expires_in: 3600,
        token_type: "Bearer",
      });
    }
    if (path !== "/v1/chat/completions") {
      const body = await request.text();
      if (
        request.method !== "POST"
        || !path.startsWith("/vertex/")
        || !body.includes(vertexProviderMarker)
        || request.headers.get("authorization") !== `Bearer ${fixtureGoogleAccessToken}`
      ) {
        return new Response("Invalid Vertex request", { status: 400 });
      }
      vertexProviderRequests += 1;
      return googleVertexStream(vertexProviderCompletion);
    }
    const body = await request.json() as {
      model?: string;
      messages?: Array<{ role?: string; content?: unknown; tool_call_id?: string }>;
      tools?: Array<{ function?: { name?: string; description?: string } }>;
    };
    modelRequests += 1;
    if (modelRequestContains(body.messages, loopbackProviderMarker)) {
      loopbackProviderRequests += 1;
      return openAiStream({ text: loopbackProviderCompletion });
    }
    let action;
    if (
      modelRequestContains(body.messages, loopbackSearchMarker)
      && !loopbackWebFetchState.resultObserved
    ) {
      const transition = selectSmokeWebFetchAction(
        body,
        loopbackWebFetchScenario,
        loopbackWebFetchState,
      );
      loopbackWebFetchState = transition.state;
      action = transition.action;
    } else if (
      modelRequestContains(body.messages, invalidSearchMarker)
      && !invalidSearchWebFetchState.resultObserved
    ) {
      const transition = selectSmokeWebFetchAction(
        body,
        invalidSearchWebFetchScenario,
        invalidSearchWebFetchState,
      );
      invalidSearchWebFetchState = transition.state;
      action = transition.action;
    } else if (
      modelRequestContains(body.messages, successorSearchMarker)
      && !successorWebFetchState.resultObserved
    ) {
      const transition = selectSmokeWebFetchAction(
        body,
        successorWebFetchScenario,
        successorWebFetchState,
      );
      successorWebFetchState = transition.state;
      action = transition.action;
    } else if (
      modelRequestContains(body.messages, validSearchMarker)
      && !initialWebFetchState.resultObserved
    ) {
      const transition = selectSmokeWebFetchAction(
        body,
        initialWebFetchScenario,
        initialWebFetchState,
      );
      initialWebFetchState = transition.state;
      action = transition.action;
    } else {
      const transition = selectSmokeModelAction(
        body,
        smokeModelScenario,
        smokeModelState,
      );
      smokeModelState = transition.state;
      if (transition.validatedVenvResult) venvToolResults += 1;
      captureCompletionActivityBaseline();
      action = transition.action;
    }
    return action.kind === "tool"
      ? openAiStream({ toolCall: { id: action.id, name: action.name, arguments: action.arguments } })
      : openAiStream({ text: action.text });
  },
});
const fakeTargetServer = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/article") return new Response(fakeSearchSentinel, { headers: { "Content-Type": "text/plain" } });
    if (path === "/python-child") return new Response(fakeChildSentinel, { headers: { "Content-Type": "text/plain" } });
    if (path === "/loopback-search") {
      loopbackSearchRequests += 1;
      return new Response(loopbackSearchSentinel, { headers: { "Content-Type": "text/plain" } });
    }
    if (path === "/loopback-child") {
      loopbackDirectRequests += 1;
      return new Response(loopbackChildSentinel, { headers: { "Content-Type": "text/plain" } });
    }
    return new Response("Not found", { status: 404 });
  },
});
function isUnsupportedIpv6LoopbackBind(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EAFNOSUPPORT" || code === "EADDRNOTAVAIL" || code === "EPROTONOSUPPORT";
}

let ipv6ModelServer: ReturnType<typeof Bun.serve> | undefined;
try {
  ipv6ModelServer = Bun.serve({
    hostname: "::1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/v1/chat/completions" || request.method !== "POST") {
        return new Response("Not found", { status: 404 });
      }
      const body = await request.json() as {
        messages?: Array<{ role?: string; content?: unknown }>;
      };
      if (!modelRequestContains(body.messages, ipv6ProviderMarker)) {
        return new Response("Invalid IPv6 provider request", { status: 400 });
      }
      ipv6ProviderRequests += 1;
      return openAiStream({ text: ipv6ProviderCompletion });
    },
  });
} catch (error) {
  if (!isUnsupportedIpv6LoopbackBind(error)) throw error;
  console.log(`[smoke] IPv6 loopback: skipped (${(error as NodeJS.ErrnoException).code})`);
}
const modelOrigin = `http://127.0.0.1:${modelServer.port}`;
const fakeTargetOrigin = `http://127.0.0.1:${fakeTargetServer.port}`;
const ipv6ModelOrigin = ipv6ModelServer
  ? `http://[::1]:${ipv6ModelServer.port}`
  : undefined;
loopbackWebFetchScenario = {
  targetUrl: `${fakeTargetOrigin}/loopback-search`,
  expectedResultText: loopbackSearchSentinel,
  completionText: "Loopback Search route complete.",
  toolCallId: "call_native_loopback_webfetch",
};

interface SmokeProxySet {
  all: RecordingHttpProxy;
  llm: RecordingHttpProxy;
  search: RecordingHttpProxy;
}

function observeFirstRunAllProxyRecord(record: SmokeProxyRecord): void {
  if (
    !firstRunPipObservationArmed
    || !isSmokeFirstRunPipRecord(record, firstRunAllProxyBaselineSequence)
  ) return;
  firstRunPipObservationArmed = false;
  resolveFirstRunPipObservation(record);
}

async function startProxySet(
  onAllRecord?: (record: SmokeProxyRecord) => void,
): Promise<SmokeProxySet> {
  const fakeTargets = {
    [fakeChildHost]: fakeTargetOrigin,
    [fakeGaxiosHost]: modelOrigin,
    [fakeLlmHost]: modelOrigin,
    [fakeSearchHost]: fakeTargetOrigin,
  };
  const [all, llm, search] = await Promise.all([
    startRecordingHttpProxy({
      name: "all",
      fakeTargets,
      blockedConnectHosts: [oauthHost],
      ...(onAllRecord ? { onRecord: onAllRecord } : {}),
    }),
    startRecordingHttpProxy({
      name: "llm",
      fakeTargets,
      blockedConnectHosts: [oauthHost],
    }),
    startRecordingHttpProxy({
      name: "search",
      fakeTargets,
      blockedConnectHosts: [oauthHost],
    }),
  ]);
  return { all, llm, search };
}

const [initialProxies, successorProxies, candidateProxy] = await Promise.all([
  startProxySet(observeFirstRunAllProxyRecord),
  startProxySet(),
  startRecordingHttpProxy({
    name: "candidate",
    blockedConnectHosts: [candidateHost],
  }),
]);
invalidSearchWebFetchScenario = {
  targetUrl: fakeSearchUrl,
  expectedResultText: "NETWORK_PROXY_INVALID",
  completionText: "Invalid Search route failed closed.",
  toolName: "web-search",
  toolCallId: "call_native_invalid_search",
  toolArguments: {
    query: "native smoke fail closed",
    engines: ["duckduckgo"],
    limit: 1,
  },
  forbiddenResultText: [
    initialProxies.search.url,
    successorProxies.search.url,
    "SEARCH_PROXY_SECRET",
  ],
};
const smokeDiagnosticSecrets = [
  initialProxies.all.url,
  initialProxies.llm.url,
  initialProxies.search.url,
  successorProxies.all.url,
  successorProxies.llm.url,
  successorProxies.search.url,
  candidateProxy.url,
  ambientPipProxy,
  "AMBIENT_PIP_SECRET",
  "SEARCH_PROXY_SECRET",
  "LLM_PROXY_SECRET",
  "fixture-client-secret",
  "fixture-refresh",
  fixtureGoogleAccessToken,
  "smoke-key",
];

function safeSmokeDiagnostic(value: unknown): string {
  return redactSmokeDiagnostic(value, smokeDiagnosticSecrets);
}

writeFileSync(googleCredentialsPath, JSON.stringify({
  type: "external_account_authorized_user",
  audience: "//iam.googleapis.com/locations/global/workforcePools/native-smoke/providers/local",
  client_id: "fixture-client",
  client_secret: "fixture-client-secret",
  refresh_token: "fixture-refresh",
  token_url: `http://${fakeGaxiosHost}/gaxios-token`,
  token_info_url: `http://${fakeGaxiosHost}/gaxios-token-info`,
}));

writeFileSync(join(agentDir, "models.json"), JSON.stringify({
  providers: {
    smoke: {
      baseUrl: `http://${fakeLlmHost}/v1`,
      api: "openai-completions",
      apiKey: "smoke-key",
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      models: [{ id: "smoke-model", name: "Smoke Model", contextWindow: 32000, maxTokens: 2048 }],
    },
    "smoke-loopback": {
      baseUrl: `${modelOrigin}/v1`,
      api: "openai-completions",
      apiKey: "smoke-key",
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      models: [{ id: "smoke-model", name: "Smoke Loopback Model", contextWindow: 32000, maxTokens: 2048 }],
    },
    ...(ipv6ModelOrigin
      ? {
          "smoke-loopback-ipv6": {
            baseUrl: `${ipv6ModelOrigin}/v1`,
            api: "openai-completions",
            apiKey: "smoke-key",
            compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
            models: [{ id: "smoke-model", name: "Smoke IPv6 Loopback Model", contextWindow: 32000, maxTokens: 2048 }],
          },
        }
      : {}),
    "smoke-vertex": {
      baseUrl: `http://${fakeLlmHost}/vertex`,
      api: "google-vertex",
      apiKey: "gcp-vertex-credentials",
      models: [{ id: "smoke-vertex-model", name: "Smoke Vertex Model", contextWindow: 32000, maxTokens: 2048 }],
    },
  },
}));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
  httpProxy: initialProxies.all.url,
  defaultProvider: "smoke",
  defaultModel: "smoke-model",
  easyresearch: {
    network: {
      llmProxy: initialProxies.llm.url,
      searchProxy: initialProxies.search.url,
    },
    agentDefaults: {
      [smokeAgentName]: { model: "smoke/smoke-model", thinking: "off" },
    },
  },
}));
writeVenvValidationScript(stageValidationScript, {
  allProxy: initialProxies.all.url,
  searchProxy: initialProxies.search.url,
  bypass: "localhost,127.0.0.1,::1",
  targetUrl: fakeChildUrl,
  targetSentinel: fakeChildSentinel,
  loopbackTargetUrl: `${fakeTargetOrigin}/loopback-child`,
  loopbackTargetSentinel: loopbackChildSentinel,
});
const portProbe = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
const port = portProbe.port;
portProbe.stop(true);

const env = createCompiledChildEnv({
  base: process.env,
  python: systemPython,
  platform: process.platform,
  powershellExecutable: systemPowerShell,
  windowsSystem32,
  overrides: {
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: join(root, "localappdata"),
    EASYRESEARCH_CODING_AGENT_DIR: agentDir,
    GOOGLE_APPLICATION_CREDENTIALS: googleCredentialsPath,
    GOOGLE_CLOUD_LOCATION: "native-smoke-location",
    GOOGLE_CLOUD_PROJECT: "native-smoke-project",
    PIP_PROXY: ambientPipProxy,
    npm_config_proxy: "http://ambient-npm.invalid:8080",
    npm_config_https_proxy: "http://ambient-npm.invalid:8443",
    npm_config_noproxy: "*",
  },
});

function safeReadText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return `[capture unavailable: ${cause}]`;
  }
}

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function recordedPid(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return parseRecordedPid(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function readDaemonIdentity(): SmokeDaemonIdentity {
  if (!existsSync(daemonPidPath)) {
    throw new Error("native smoke daemon ownership record is missing");
  }
  return parseSmokeDaemonIdentity(readFileSync(daemonPidPath, "utf8"));
}

function recordsFor(...sets: SmokeProxySet[]): ReturnType<RecordingHttpProxy["records"]>[number][] {
  return sets.flatMap((set) => [
    ...set.all.records(),
    ...set.llm.records(),
    ...set.search.records(),
  ]);
}

function loopbackEvidence() {
  return {
    firstRunAllProxyBaselineSequence,
    gaxiosRequests,
    ipv6Requests: ipv6ProviderRequests,
    ipv6Supported: ipv6ModelServer !== undefined,
    providerRequests: loopbackProviderRequests,
    searchRequests: loopbackSearchRequests,
    directRequests: loopbackDirectRequests,
  };
}

function proxyTargetCount(sets: readonly SmokeProxySet[], host: string): number {
  const expected = host.toLowerCase();
  return recordsFor(...sets).filter((record) => record.host.toLowerCase() === expected).length;
}

async function pollSmokeCondition<T>(
  label: string,
  probe: () => T | undefined | Promise<T | undefined>,
  retryErrors = false,
): Promise<T> {
  let lastError: unknown;
  while (Date.now() < firstRunDeadline) {
    try {
      const result = await probe();
      if (result !== undefined) return result;
    } catch (error) {
      if (!retryErrors) throw error;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const suffix = lastError
    ? ` (${formatSmokeProxyDiagnostics([], [lastError])})`
    : "";
  throw new Error(`${label} did not finish before the native smoke deadline${suffix}`);
}

async function readDaemonStatus(base: string): Promise<{
  bootId: string;
  agentDir: string;
  sessions: Array<{ path?: string }>;
}> {
  const response = await fetch(`${base}/api/status`, {
    signal: AbortSignal.timeout(Math.max(1, Math.min(3_000, firstRunDeadline - Date.now()))),
  });
  const value = await requireOk(response, "daemon status probe") as {
    bootId?: unknown;
    agentDir?: unknown;
    sessions?: unknown;
  };
  if (
    typeof value.bootId !== "string"
    || !value.bootId
    || typeof value.agentDir !== "string"
    || !Array.isArray(value.sessions)
  ) {
    throw new Error("daemon status probe returned an invalid identity");
  }
  return {
    bootId: value.bootId,
    agentDir: value.agentDir,
    sessions: value.sessions as Array<{ path?: string }>,
  };
}

async function waitForFirstRunPipObservation(): Promise<SmokeProxyRecord> {
  const remaining = firstRunDeadline - Date.now();
  if (remaining <= 0) {
    throw new Error("first-run pip All-proxy traffic did not arrive before the native smoke deadline");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      firstRunPipObservation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(
          "first-run pip All-proxy traffic did not arrive before the native smoke deadline",
        )), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readAuthenticatedDaemonReadiness(base: string): Promise<{
  status: Awaited<ReturnType<typeof readDaemonStatus>>;
  identity: SmokeDaemonIdentity;
}> {
  const status = await readDaemonStatus(base);
  const identity = readDaemonIdentity();
  const control = await fetch(`${base}${DAEMON_CONTROL_PATH}`, {
    method: "GET",
    headers: { [DAEMON_TOKEN_HEADER]: identity.token },
    signal: AbortSignal.timeout(Math.max(1, Math.min(3_000, firstRunDeadline - Date.now()))),
  });
  const body = await requireOk(control, "authenticated initial daemon readiness") as {
    runtimeId?: unknown;
  };
  if (body.runtimeId !== identity.runtimeId) {
    throw new Error("authenticated initial daemon readiness returned the wrong runtime identity");
  }
  return { status, identity };
}

async function restartCompiledDaemon(
  base: string,
  oldBootId: string,
  before: SmokeDaemonIdentity,
): Promise<{ bootId: string; identity: SmokeDaemonIdentity }> {
  const accepted = await requestSmokeJsonBeforeDeadline({
    url: `${base}/api/runtime/restart`,
    deadline: firstRunDeadline,
    label: "typed runtime restart",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: true }),
    },
  }) as { accepted?: unknown; bootId?: unknown };
  if (accepted.accepted !== true || accepted.bootId !== oldBootId) {
    throw new Error("typed runtime restart returned an invalid old-boot acceptance");
  }

  const status = await pollSmokeCondition("compiled daemon successor readiness", async () => {
    const candidate = await readDaemonStatus(base);
    return candidate.bootId !== oldBootId ? candidate : undefined;
  }, true);
  const identity = readDaemonIdentity();
  smokeDiagnosticSecrets.push(identity.token);
  assertSmokeRuntimeReplacement({
    before,
    after: identity,
    oldBootId,
    newBootId: status.bootId,
  });
  const staleControl = await fetch(`${base}${DAEMON_CONTROL_PATH}`, {
    method: "GET",
    headers: { [DAEMON_TOKEN_HEADER]: before.token },
    signal: AbortSignal.timeout(Math.max(1, Math.min(3_000, firstRunDeadline - Date.now()))),
  });
  await staleControl.body?.cancel();
  if (staleControl.status !== 404) {
    throw new Error("successor accepted the prior daemon ownership credential");
  }
  const control = await fetch(`${base}${DAEMON_CONTROL_PATH}`, {
    method: "GET",
    headers: { [DAEMON_TOKEN_HEADER]: identity.token },
    signal: AbortSignal.timeout(Math.max(1, Math.min(3_000, firstRunDeadline - Date.now()))),
  });
  const controlBody = await requireOk(control, "authenticated successor readiness") as {
    runtimeId?: unknown;
  };
  if (controlBody.runtimeId !== identity.runtimeId) {
    throw new Error("authenticated successor readiness returned the wrong runtime identity");
  }
  daemonPid = identity.pid;
  return { bootId: status.bootId, identity };
}

function updateExternalProxySettings(
  values: Partial<Record<"llmProxy" | "searchProxy", string>>,
): void {
  const settingsPath = join(agentDir, "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  const easyresearch = settings.easyresearch as Record<string, unknown>;
  const network = easyresearch.network as Record<string, unknown>;
  Object.assign(network, values);
  writeFileSync(settingsPath, JSON.stringify(settings), "utf8");
}

async function run(
  args: string[],
  captureName: "first-run" | "shutdown",
): Promise<{ stdout: string; stderr: string; pid?: number }> {
  const stdoutPath = captureName === "first-run" ? firstRunStdoutPath : join(root, `${captureName}-stdout.txt`);
  const stderrPath = captureName === "first-run" ? firstRunStderrPath : join(root, `${captureName}-stderr.txt`);
  const powershellErrorPath = join(root, `${captureName}-powershell-error.txt`);
  const timeout = captureName === "first-run" ? FIRST_RUN_CEILING_MS : 180_000;
  const asynchronous = captureName === "first-run";
  let result: { status: number | null; error?: Error };
  if (process.platform === "win32") {
    // Native testing under the former Bun 1.3.14 pin found that spawnSync could
    // silently miss compiled Windows executables. Retain the PowerShell launch;
    // Start-Process -Wait would wait on the live daemon, so smoke polls readiness.
    // Start-Process owns those capture paths so Node must not open them first.
    const nul = openSync("NUL", "w");
    try {
      if (!systemPowerShell) throw new Error("Windows smoke PowerShell preflight result is missing");
      if (!windowsSystem32) throw new Error("Windows smoke System32 preflight result is missing");
      const powershell = systemPowerShell;
      const taskkill = join(windowsSystem32, "taskkill.exe");
      let script: string;
      if (asynchronous) {
        script = [
          "$ErrorActionPreference = 'Stop'",
          "$process = $null",
          "try {",
          `  $process = Start-Process -FilePath ${powershellQuote(binary)} -ArgumentList @(${args.map(powershellQuote).join(", ")}) -WindowStyle Hidden -RedirectStandardOutput ${powershellQuote(stdoutPath)} -RedirectStandardError ${powershellQuote(stderrPath)} -PassThru`,
          `  Set-Content -LiteralPath ${powershellQuote(firstRunPidPath)} -Value $process.Id -Encoding ascii`,
          "  exit 0",
          "} catch {",
          "  if ($null -ne $process) {",
          `    & ${powershellQuote(taskkill)} /PID $($process.Id) /T /F | Out-Null`,
          "  }",
          `  $_ | Out-File -FilePath ${powershellQuote(powershellErrorPath)} -Encoding utf8`,
          "  exit 99",
          "}",
        ].join("; ");
      } else {
        writeFileSync(shutdownWrapperPath, buildWindowsShutdownScript({
          binary,
          args,
          stdoutPath,
          stderrPath,
          statusPath: shutdownStatusPath,
          powershellErrorPath,
        }));
        script = buildWindowsShutdownLauncherScript({
          powershell,
          wrapperPath: shutdownWrapperPath,
          pidPath: shutdownWrapperPidPath,
          taskkill,
          powershellErrorPath,
        });
      }
      result = spawnSync(
        powershell,
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { env, stdio: ["ignore", nul, nul], timeout },
      );
    } finally {
      closeSync(nul);
    }
  } else {
    const stdoutFd = openSync(stdoutPath, "w");
    const stderrFd = openSync(stderrPath, "w");
    try {
      if (captureName === "first-run") {
        const child = spawn(binary, args, { env, stdio: ["ignore", stdoutFd, stderrFd] });
        firstRunClientProcess = child;
        firstRunClientCompletion = new Promise((resolveCompletion) => {
          let settled = false;
          const finish = (value: { status: number | null; error?: Error }): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolveCompletion(value);
          };
          const timer = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              // The first-run client may have exited at the deadline edge.
            }
            finish({ status: null, error: new Error("native first-run client timed out") });
          }, timeout);
          child.once("error", (error) => finish({ status: null, error }));
          child.once("close", (status) => finish({ status }));
        });
        result = await new Promise((resolveLaunch) => {
          child.once("spawn", () => {
            firstRunClientPid = child.pid;
            resolveLaunch({ status: 0 });
          });
          child.once("error", (error) => resolveLaunch({ status: null, error }));
        });
      } else {
        result = spawnSync(binary, args, { env, stdio: ["ignore", stdoutFd, stderrFd], timeout });
      }
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }
  }
  const { stdout, stderr } = collectLaunchOutput({
    asynchronous,
    stdoutPath,
    stderrPath,
    read: safeReadText,
  });
  if (result.error || result.status !== 0) {
    const cause = result.error ? `${result.error.name}: ${result.error.message}` : "no spawn error";
    const powershellError = process.platform === "win32" ? `\n${safeReadText(powershellErrorPath)}` : "";
    const childStatus = process.platform === "win32" && captureName === "shutdown"
      ? `\nshutdown client status: ${safeReadText(shutdownStatusPath)}`
      : "";
    throw new Error(safeSmokeDiagnostic(
      `${binary} ${args.join(" ")} failed (${result.status ?? "no status"}; ${cause}):\n${stdout}\n${stderr}${powershellError}${childStatus}`,
    ));
  }
  if (process.platform === "win32" && captureName === "shutdown") {
    requireZeroProcessStatus({
      label: "Windows shutdown client",
      statusText: safeReadText(shutdownStatusPath),
      stdout,
      stderr,
    });
  }
  const pid = asynchronous
    ? firstRunClientPid ?? recordedPid(firstRunPidPath)
    : undefined;
  if (process.platform === "win32" && captureName === "first-run" && pid === undefined) {
    throw new Error(`Windows first-run client did not record a valid PID at ${firstRunPidPath}`);
  }
  return { stdout, stderr, pid };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function terminateWindowsProcessTree(pid: number): void {
  if (!windowsSystem32) throw new Error("Windows smoke System32 preflight result is missing");
  const taskkill = join(windowsSystem32, "taskkill.exe");
  const result = spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error || (result.status !== 0 && isProcessAlive(pid))) {
    const cause = result.error ? `${result.error.name}: ${result.error.message}` : `status ${result.status ?? "unknown"}`;
    throw new Error(`failed to terminate Windows process tree ${pid} (${cause}):\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
}

function terminateProcessTree(pid: number): void {
  if (process.platform === "win32") {
    terminateWindowsProcessTree(pid);
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function settleFirstRun(terminateImmediately: boolean): Promise<void> {
  if (process.platform === "win32") {
    const pid = firstRunClientPid ?? recordedPid(firstRunPidPath);
    if (pid === undefined) return;
    firstRunClientPid = pid;
    await settleProcess({
      pid,
      deadline: firstRunDeadline,
      terminateImmediately,
      isAlive: isProcessAlive,
      terminateTree: terminateWindowsProcessTree,
    });
    return;
  }

  const child = firstRunClientProcess;
  const completion = firstRunClientCompletion;
  if (!child || !completion) return;
  if (terminateImmediately && child.exitCode === null && !child.killed) {
    child.kill("SIGKILL");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = terminateImmediately
    ? Date.now() + 30_000
    : firstRunDeadline;
  const result = await Promise.race([
    completion,
    new Promise<{ status: null; error: Error }>((resolveTimeout) => {
      timer = setTimeout(() => {
        if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
        resolveTimeout({ status: null, error: new Error("native first-run client timed out") });
      }, Math.max(1, deadline - Date.now()));
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (terminateImmediately) return;
  if (result.error || result.status !== 0) {
    const cause = result.error ? `${result.error.name}: ${result.error.message}` : "no spawn error";
    throw new Error(safeSmokeDiagnostic(
      `${binary} first-run client failed (${result.status ?? "no status"}; ${cause}):\n${safeReadText(firstRunStdoutPath)}\n${safeReadText(firstRunStderrPath)}`,
    ));
  }
}

async function verifyDaemonStopped(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  try {
    await settleProcess({
      pid,
      deadline: Date.now() + 30_000,
      isAlive: isProcessAlive,
      terminateTree: terminateProcessTree,
    });
  } catch (error) {
    throw new Error(`daemon process ${pid} did not terminate cleanly: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function removeSmokeRoot(): Promise<void> {
  let cause = "root still exists";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      if (!existsSync(root)) return;
    } catch (error) {
      cause = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`failed to remove smoke root ${root}: ${cause}`);
}

function requireCommandUnavailable(command: "node" | "bun"): void {
  const result = spawnSync(command, ["--version"], { env, encoding: "utf8", timeout: 30_000 });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    console.log(`[smoke] child ${command}: unavailable (expected)`);
    return;
  }
  const cause = result.error ? `${result.error.name}: ${result.error.message}` : `status ${result.status ?? "unknown"}`;
  throw new Error(`child environment unexpectedly resolved ${command} (${cause}):\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
}

function inspectSystemPython(): void {
  const result = spawnSync(systemPython, ["--version"], { env, encoding: "utf8", timeout: 30_000 });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  systemPythonVersionOutput = output || "no version output";
  console.log(`[smoke] system Python: ${systemPython}`);
  console.log(`[smoke] system Python --version: ${systemPythonVersionOutput}`);
  if (result.error || result.status !== 0) {
    const cause = result.error ? `${result.error.name}: ${result.error.message}` : `status ${result.status ?? "unknown"}`;
    throw new Error(`system Python version probe failed (${cause}): ${systemPythonVersionOutput}`);
  }
}

function runVersion(): string {
  const outputPath = join(root, "version-output.txt");
  const outputFd = openSync(outputPath, "w");
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(binary, ["--version"], {
      env,
      stdio: ["ignore", outputFd, outputFd],
      timeout: 180_000,
    });
  } finally {
    closeSync(outputFd);
  }
  const output = readFileSync(outputPath, "utf8");
  if (result.error || result.status !== 0) {
    const cause = result.error ? `${result.error.name}: ${result.error.message}` : "no spawn error";
    throw new Error(`${binary} --version failed (${result.status ?? "no status"}; ${cause}):\n${output}`);
  }
  return output;
}

function treeFiles(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  const entries: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) entries.push(...treeFiles(join(dir, entry.name), rel));
    else entries.push(rel);
  }
  return entries.sort();
}

async function requireOk(response: Response, label: string): Promise<any> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} failed (${response.status}): ${text}`);
  return text ? JSON.parse(text) : undefined;
}

function smokeProgressDiagnostics(): string {
  return JSON.stringify({
    smokeShellToolName,
    systemPowerShell: systemPowerShell ?? null,
    windowsSystem32: windowsSystem32 ?? null,
    childPath: env.PATH,
    modelRequests,
    gaxiosRequests,
    vertexProviderRequests,
    smokeModelState,
    smokeNetworkState,
    loopbackEvidence: loopbackEvidence(),
    loopbackWebFetchState,
    initialWebFetchState,
    successorWebFetchState,
    invalidSearchWebFetchState,
    venvToolResults,
    smokeAgentPath,
    smokeAgentExists: existsSync(smokeAgentPath),
    smokeSkillPath,
    smokeSkillExists: existsSync(smokeSkillPath),
    initialConfigurationGeneration,
    advancedConfigurationGeneration,
    snapshotConfigurationGeneration,
    observedRootAppliedGeneration,
    expectedConfigurationBootId,
    observedConfigurationBootId,
    configurationEventError: configurationEventError
      ? safeSmokeDiagnostic(configurationEventError)
      : undefined,
    recentConfigurationEvents: recentConfigurationEvents.map(safeSmokeDiagnostic),
    sessionSnapshotObserved,
    observedSupervisorTerminal,
    sessionActivitySequence: sessionActivityState.sequence,
    latestSessionActivity: sessionActivityState.latest,
    dispatchActivityBaseline,
    completionActivityBaseline,
    sessionEventError: sessionEventError ? safeSmokeDiagnostic(sessionEventError) : undefined,
    recentSessionEvents: recentSessionEvents.map(safeSmokeDiagnostic),
    proxy: formatSmokeProxyDiagnostics(
      [...recordsFor(initialProxies, successorProxies), ...candidateProxy.records()],
      [],
      smokeDiagnosticSecrets,
    ),
  }, null, 2);
}

function observeSessionEvent(event: unknown): void {
  captureCompletionActivityBaseline();
  const serialized = assertPathFreeSessionEvent(event);
  recentSessionEvents.push(serialized.slice(0, 1_000));
  if (recentSessionEvents.length > 12) recentSessionEvents.shift();
  if (!event || typeof event !== "object") return;
  const value = event as {
    type?: unknown;
    agentId?: unknown;
    status?: unknown;
    generation?: unknown;
    runtimeConfigurationGeneration?: unknown;
  };
  if (value.type === "snapshot") {
    sessionActivityState = {
      ...sessionActivityState,
      latest: parseSmokeInitialSessionSnapshot(event),
    };
    const generation = value.runtimeConfigurationGeneration;
    if (!Number.isSafeInteger(generation) || (generation as number) < 1) {
      throw new Error(`root session snapshot had an invalid runtime configuration generation: ${serialized}`);
    }
    snapshotConfigurationGeneration = generation as number;
    sessionSnapshotObserved = true;
  }
  if (value.type === "session_activity_changed") {
    sessionActivityState = recordSmokeSessionActivityReplacement(sessionActivityState, event);
  }
  if (value.type === "runtime_configuration_applied") {
    const generation = value.generation;
    if (!Number.isSafeInteger(generation) || (generation as number) < 1) {
      throw new Error(`root runtime application event had an invalid generation: ${serialized}`);
    }
    observedRootAppliedGeneration = Math.max(observedRootAppliedGeneration ?? 0, generation as number);
  }
  if (value.type !== "subagent_supervisor" || value.agentId !== `${smokeAgentName}_0`) return;
  if (value.status === "error") throw new Error(`${smokeAgentName}_0 supervisor reported error: ${serialized}`);
  if (value.status === "complete") {
    observedSupervisorTerminal = true;
    captureCompletionActivityBaseline();
  }
}

function observeConfigurationEvent(event: unknown): void {
  const serialized = JSON.stringify(event) ?? "undefined";
  recentConfigurationEvents.push(serialized.slice(0, 1_000));
  if (recentConfigurationEvents.length > 12) recentConfigurationEvents.shift();
  if (!event || typeof event !== "object") {
    throw new Error(`configuration SSE emitted a non-object event: ${serialized}`);
  }
  const value = event as {
    type?: unknown;
    bootId?: unknown;
    generation?: unknown;
    agentsChanged?: unknown;
    skillsChanged?: unknown;
    message?: unknown;
  };
  if (value.type === "config.error") {
    throw new Error(`configuration SSE reported an error: ${String(value.message)}`);
  }
  if (
    typeof value.bootId !== "string"
    || !value.bootId
    || (expectedConfigurationBootId !== undefined && value.bootId !== expectedConfigurationBootId)
    || (observedConfigurationBootId !== undefined && value.bootId !== observedConfigurationBootId)
  ) {
    throw new Error("configuration SSE emitted an invalid daemon boot id");
  }
  observedConfigurationBootId = value.bootId;
  if (
    value.type !== "config.updated"
    || typeof value.generation !== "number"
    || !Number.isSafeInteger(value.generation)
    || value.generation < 1
  ) {
    throw new Error(`configuration SSE emitted a malformed update: ${serialized}`);
  }
  const generation = value.generation;
  if (initialConfigurationGeneration === undefined) {
    initialConfigurationGeneration = generation;
    return;
  }
  if (
    snapshotConfigurationGeneration !== undefined
    && generation > snapshotConfigurationGeneration
    && value.agentsChanged === true
    && value.skillsChanged === true
    && smokeModelState.externalResourcesWritten
    && existsSync(smokeAgentPath)
    && readFileSync(smokeAgentPath, "utf8") === smokeAgentContent
    && existsSync(smokeSkillPath)
    && readFileSync(smokeSkillPath, "utf8") === smokeSkillContent
  ) {
    advancedConfigurationGeneration = Math.max(advancedConfigurationGeneration ?? 0, generation);
  }
}

async function consumeEventStream(options: {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  label: string;
  stopping: () => boolean;
  observe: (event: unknown) => void;
}): Promise<void> {
  const decoder = new TextDecoder();
  let buffered = "";
  while (true) {
    const { done, value } = await options.reader.read();
    if (done) {
      if (!options.stopping()) throw new Error(`${options.label} ended before native smoke completion`);
      return;
    }
    buffered += decoder.decode(value, { stream: true });
    const frames = buffered.split(/\r?\n\r?\n/u);
    buffered = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        options.observe(JSON.parse(data));
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        throw new Error(`invalid ${options.label} frame (${cause}): ${data}`);
      }
    }
  }
}

async function waitForSmokeCondition(label: string, ready: () => boolean): Promise<void> {
  while (Date.now() < firstRunDeadline) {
    if (configurationEventError) {
      throw new Error(`${label} failed while reading configuration SSE: ${configurationEventError.message}\n${smokeProgressDiagnostics()}`);
    }
    if (sessionEventError) {
      throw new Error(`${label} failed while reading session SSE: ${sessionEventError.message}\n${smokeProgressDiagnostics()}`);
    }
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label} did not finish before the native smoke deadline\n${smokeProgressDiagnostics()}`);
}

async function stopSessionEventStream(): Promise<void> {
  sessionEventsStopping = true;
  const reader = sessionEventReader;
  sessionEventReader = undefined;
  await reader?.cancel();
  const task = sessionEventTask;
  sessionEventTask = undefined;
  await task;
  if (sessionEventError) throw sessionEventError;
}

async function stopConfigurationEventStream(): Promise<void> {
  configurationEventsStopping = true;
  const reader = configurationEventReader;
  configurationEventReader = undefined;
  await reader?.cancel();
  const task = configurationEventTask;
  configurationEventTask = undefined;
  await task;
  if (configurationEventError) throw configurationEventError;
}

async function startConfigurationEventStream(base: string, bootId: string): Promise<void> {
  expectedConfigurationBootId = bootId;
  observedConfigurationBootId = undefined;
  initialConfigurationGeneration = undefined;
  configurationEventError = undefined;
  configurationEventsStopping = false;
  recentConfigurationEvents.length = 0;
  const response = await fetchSessionEventsBeforeDeadline({
    url: `${base}/api/config/events`,
    deadline: firstRunDeadline,
  });
  if (!response.ok) {
    throw new Error(`configuration SSE failed (${response.status}): ${await response.text()}`);
  }
  if (!response.body) throw new Error("configuration SSE response had no body");
  configurationEventReader = response.body.getReader();
  configurationEventTask = consumeEventStream({
    reader: configurationEventReader,
    label: "configuration SSE",
    stopping: () => configurationEventsStopping,
    observe: observeConfigurationEvent,
  }).catch((error) => {
    configurationEventError = error instanceof Error ? error : new Error(String(error));
  });
  await waitForSmokeCondition(
    "configuration SSE identity",
    () => initialConfigurationGeneration !== undefined && observedConfigurationBootId === bootId,
  );
}

async function waitForSessionSnapshot(options: {
  base: string;
  sessionId: string;
  expectedText: string;
  forbiddenText?: readonly string[];
}): Promise<unknown> {
  return pollSmokeCondition("session probe settlement", async () => {
    const response = await fetch(`${options.base}/api/sessions/${options.sessionId}/snapshot`, {
      signal: AbortSignal.timeout(Math.max(1, Math.min(3_000, firstRunDeadline - Date.now()))),
    });
    if (!response.ok) return undefined;
    const snapshot = await response.json() as {
      session?: { status?: unknown; isStreaming?: unknown };
    };
    const serialized = JSON.stringify(snapshot);
    if (!serialized.includes(options.expectedText)) return undefined;
    if (options.forbiddenText?.some((value) => value && serialized.includes(value))) {
      throw new Error("session probe exposed sensitive network route data");
    }
    return snapshot.session?.status === "ready" && snapshot.session.isStreaming === false
      ? snapshot
      : undefined;
  });
}

async function exerciseCodexDeviceRequest(base: string): Promise<void> {
  const login = await requestSmokeJsonBeforeDeadline({
    url: `${base}/api/auth/login`,
    deadline: firstRunDeadline,
    label: "Codex OAuth login",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "openai-codex", type: "oauth" }),
    },
  }) as { flowId?: unknown };
  if (typeof login.flowId !== "string" || !login.flowId) {
    throw new Error("Codex OAuth login did not return a flow id");
  }
  const flowPath = encodeURIComponent(login.flowId);
  await pollSmokeCondition("Codex OAuth device-method prompt", async () => {
    const response = await fetch(`${base}/api/auth/flows/${flowPath}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "device_code" }),
      signal: AbortSignal.timeout(Math.max(1, Math.min(3_000, firstRunDeadline - Date.now()))),
    });
    if (response.status === 409) {
      await response.body?.cancel();
      return undefined;
    }
    await requireOk(response, "Codex OAuth device-method response");
    return true;
  });
  await waitForSmokeCondition(
    "Codex OAuth LLM proxy observation",
    () => initialProxies.llm.records().some(
      (record) => record.host === oauthHost && record.kind === "connect-blocked",
    ),
  );
  await requestSmokeJsonBeforeDeadline({
    url: `${base}/api/auth/flows/${flowPath}/cancel`,
    deadline: firstRunDeadline,
    label: "Codex OAuth cancellation",
    init: { method: "POST" },
  });
}

async function dumpServerLogs(): Promise<void> {
  console.log(`[smoke] progress diagnostics:\n${smokeProgressDiagnostics()}`);
  console.log(`[smoke] system Python: ${systemPython}`);
  console.log(`[smoke] system Python --version: ${systemPythonVersionOutput}`);
  console.log(`[smoke] expected venv Python: ${venvPython}`);
  console.log(`[smoke] expected venv Python exists: ${existsSync(venvPython)}`);
  console.log(`[smoke] --- venv validation stdout (${validationStdout.length} bytes) ---`);
  console.log(safeSmokeDiagnostic(validationStdout.slice(-4000)));
  console.log(`[smoke] --- venv validation stderr (${validationStderr.length} bytes) ---`);
  console.log(safeSmokeDiagnostic(validationStderr.slice(-4000)));
  for (const capture of ["first-run-stdout.txt", "first-run-stderr.txt"]) {
    const content = await readTextFileWithRetry({
      path: join(root, capture),
      attempts: firstRunLaunchAttempted ? 10 : 1,
    });
    console.log(`[smoke] --- ${capture} (${content.length} bytes) ---`);
    console.log(safeSmokeDiagnostic(content.slice(-4000)));
  }
  for (const capture of [
    "first-run-powershell-error.txt",
    "shutdown-stdout.txt",
    "shutdown-stderr.txt",
    "shutdown-status.txt",
    "shutdown-wrapper.pid",
    "shutdown-powershell-error.txt",
  ]) {
    const path = join(root, capture);
    if (!existsSync(path)) continue;
    const content = safeReadText(path);
    console.log(`[smoke] --- ${capture} (${content.length} bytes) ---`);
    console.log(safeSmokeDiagnostic(content.slice(-4000)));
  }
  console.log(`[smoke] agentDir exists: ${existsSync(agentDir)}`);
  let agentFiles: string[] = [];
  try {
    agentFiles = treeFiles(agentDir);
  } catch (error) {
    console.log(`[smoke] failed to inspect agentDir: ${safeSmokeDiagnostic(error)}`);
  }
  console.log(`[smoke] agentDir files: ${agentFiles.length}`);
  if (existsSync(agentDir)) {
    try {
      const topLevel = readdirSync(agentDir).filter((entry) => !agentFiles.includes(`/${entry}`));
      console.log(`[smoke] agentDir dirs: ${topLevel.join(", ")}`);
    } catch (error) {
      console.log(`[smoke] failed to inspect agentDir top level: ${safeSmokeDiagnostic(error)}`);
    }
  }
  for (const file of agentFiles.slice(0, 40)) console.log(`[smoke]   /agent${file}`);
  const cliError = join(agentDir, "cli-error.log");
  if (existsSync(cliError)) {
    console.log(`[smoke] --- cli-error.log ---`);
    console.log(safeSmokeDiagnostic(safeReadText(cliError).slice(-4000)));
  }
  try {
    const logsDir = join(agentDir, "logs");
    if (!existsSync(logsDir)) {
      console.log("[smoke] no server logs directory");
      return;
    }
    for (const entry of readdirSync(logsDir)) {
      const path = join(logsDir, entry);
      const content = safeReadText(path);
      console.log(`[smoke] --- ${entry} (${content.length} bytes) ---`);
      console.log(safeSmokeDiagnostic(content.slice(-4000)));
    }
  } catch (error) {
    console.log(`[smoke] failed to dump server logs: ${safeSmokeDiagnostic(error)}`);
  }
}

function openAiStream(input: {
  text?: string;
  toolCall?: { id: string; name: string; arguments: string };
}): Response {
  const id = `chatcmpl-${modelRequests}`;
  const created = Math.floor(Date.now() / 1000);
  const firstDelta = input.toolCall
    ? {
        role: "assistant",
        tool_calls: [{
          index: 0,
          id: input.toolCall.id,
          type: "function",
          function: { name: input.toolCall.name, arguments: input.toolCall.arguments },
        }],
      }
    : { role: "assistant", content: input.text ?? "" };
  const finishReason = input.toolCall ? "tool_calls" : "stop";
  const chunks = [
    { id, object: "chat.completion.chunk", created, model: "smoke-model", choices: [{ index: 0, delta: firstDelta, finish_reason: null }] },
    {
      id,
      object: "chat.completion.chunk",
      created,
      model: "smoke-model",
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ];
  return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

function googleVertexStream(text: string): Response {
  const chunk = {
    candidates: [{
      content: { role: "model", parts: [{ text }] },
      finishReason: "STOP",
      index: 0,
    }],
    usageMetadata: {
      promptTokenCount: 1,
      candidatesTokenCount: 1,
      totalTokenCount: 2,
    },
  };
  return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

let primaryError: Error | undefined;
try {
  inspectSystemPython();
  requireCommandUnavailable("node");
  requireCommandUnavailable("bun");
  const version = repoPackageVersion();
  if (!versionVerifiedByRunner) validateNativeVersionOutput(0, runVersion(), version, target.name);
  const treeBefore = treeFiles(root);
  firstRunDeadline = Date.now() + FIRST_RUN_CEILING_MS;
  firstRunLaunchAttempted = true;
  firstRunAllProxyBaselineSequence = initialProxies.all.records().reduce(
    (highest, record) => Math.max(highest, record.sequence),
    0,
  );
  firstRunPipObservationArmed = true;
  firstRunClientPid = (await run(["--no-open", "--port", String(port)], "first-run")).pid;
  const base = `http://127.0.0.1:${port}`;
  const startupObservation = await observeFirstRunStartup({
    observeSetupPip: waitForFirstRunPipObservation,
    observeAuthenticatedReadiness: () => pollSmokeCondition(
      "initial compiled daemon authenticated readiness",
      async () => readAuthenticatedDaemonReadiness(base),
      true,
    ),
  });
  const firstRunRoutes = classifySmokeProxyRoutes(recordsFor(initialProxies), {
      allHost: fakeChildHost,
      gaxiosHost: fakeGaxiosHost,
      llmHost: fakeLlmHost,
      searchHost: fakeSearchHost,
      oauthHost,
      candidateHost,
    }, loopbackEvidence());
  if (
    !isSmokeFirstRunPipRecord(
      startupObservation.setupPip,
      firstRunAllProxyBaselineSequence,
    )
    || !firstRunRoutes.firstRunPipTarget
  ) {
    throw new Error("first-run setup did not emit causally ordered pip traffic through All proxy");
  }
  smokeNetworkState = recordSmokeNetworkMilestone(smokeNetworkState, {
    kind: "setup-pip-observed",
  });
  const { status: initialStatus, identity: initialIdentity } =
    startupObservation.authenticatedReadiness;
  if (initialStatus.agentDir !== agentDir) {
    throw new Error("initial compiled daemon used the wrong isolated Agent directory");
  }
  smokeDiagnosticSecrets.push(initialIdentity.token);
  daemonPid = initialIdentity.pid;
  if (initialIdentity.host !== "127.0.0.1" || initialIdentity.port !== port) {
    throw new Error("initial compiled daemon ownership endpoint was invalid");
  }
  smokeNetworkState = recordSmokeNetworkMilestone(smokeNetworkState, {
    kind: "initial-ready",
    bootId: initialStatus.bootId,
  });
  const materializedDir = join(agentDir, "bundled");
  while (Date.now() < firstRunDeadline) {
    if (existsSync(materializedDir)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const bundledCandidates = [
    join(agentDir, "bundled"),
    join(home, ".easyresearch", "agent", "bundled"),
    join(process.env.APPDATA ?? "", ".easyresearch", "agent", "bundled"),
    join(process.env.LOCALAPPDATA ?? "", ".easyresearch", "agent", "bundled"),
  ];
  for (const candidate of bundledCandidates) {
    console.log(`[smoke] bundled candidate: ${candidate} -> ${existsSync(candidate)}`);
  }
  const bundledDir = join(agentDir, "bundled");
  if (!existsSync(bundledDir)) throw new Error("CLI did not materialize bundled resources (did the CLI actually run?)");
  for (const relativePath of [
    "agents/review.md",
    "skills/specialist-handoff/SKILL.md",
    "skills/paper-lookup/SKILL.md",
    "skills/scientific-visualization/SKILL.md",
    "skills/hypothesis-generation/SKILL.md",
    "skills/experimental-design/SKILL.md",
    "skills/statistical-power/SKILL.md",
    "skills/huggingface-datasets/SKILL.md",
    "skills/peer-review/SKILL.md",
  ]) {
    const materializedPath = join(bundledDir, relativePath);
    if (!existsSync(materializedPath)) throw new Error(`bundled ADR-102 resource missing: ${materializedPath}`);
  }
  const daemonBinary = join(agentDir, "bin", target.os[0] === "win32" ? "easyresearch-daemon.exe" : "easyresearch-daemon");
  while (Date.now() < firstRunDeadline) {
    if (existsSync(daemonBinary)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!existsSync(daemonBinary)) throw new Error(`daemon binary copy missing: ${daemonBinary}`);
  await settleFirstRun(false);
  if (!existsSync(venvPython)) {
    throw new Error(`first-run skill venv missing interpreter: ${venvPython}`);
  }
  runVenvValidation({
    python: venvPython,
    script: validationScript,
    spawn: (command, args, options) => {
      const result = spawnSync(command, [...args], {
        ...options,
        env: { ...env, EASYRESEARCH_VENV: join(agentDir, "venv") },
      });
      validationStdout = result.stdout?.toString() ?? "";
      validationStderr = result.stderr?.toString() ?? "";
      return result;
    },
  });
  const createdFiles = treeFiles(root).filter((file) => !treeBefore.includes(file));
  console.log(`[smoke] files created by CLI run: ${createdFiles.length}`);
  for (const file of createdFiles.slice(0, 60)) console.log(`[smoke]   ${file}`);
  const update = await requireOk(await fetch(`${base}/api/update-check`), "update availability probe");
  if (update.latestVersion !== null && typeof update.latestVersion !== "string") {
    throw new Error("compiled update availability endpoint returned an invalid latestVersion");
  }
  const auth = await requireOk(await fetch(`${base}/api/auth/providers`), "OAuth provider probe");
  if (!Array.isArray(auth.providers) || !auth.providers.some(
    (provider: { id?: string; authMethods?: string[] }) =>
      provider.id === "openai-codex" && provider.authMethods?.includes("oauth"),
  )) {
    throw new Error("compiled OAuth providers were not registered");
  }

  const candidateProbe = await requestSmokeJsonBeforeDeadline({
    url: `${base}/api/settings/network-proxy/test`,
    deadline: firstRunDeadline,
    label: "compiled Network candidate proxy probe",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "all", proxyUrl: candidateProxy.url }),
    },
  }) as Record<string, unknown>;
  const candidateProbeText = JSON.stringify(candidateProbe);
  const candidateRecords = candidateProxy.records();
  const candidateRoutes = classifySmokeProxyRoutes(candidateRecords, {
    allHost: fakeChildHost,
    gaxiosHost: fakeGaxiosHost,
    llmHost: fakeLlmHost,
    searchHost: fakeSearchHost,
    oauthHost,
    candidateHost,
  }, loopbackEvidence());
  if (
    candidateProbe.ok !== false
    || (candidateProbe.outcome !== "proxy-connect" && candidateProbe.outcome !== "proxy-response")
    || typeof candidateProbe.elapsedMs !== "number"
    || !Number.isFinite(candidateProbe.elapsedMs)
    || candidateProbe.elapsedMs < 0
    || Object.keys(candidateProbe).some((key) => !["ok", "outcome", "status", "elapsedMs"].includes(key))
    || candidateRecords.length !== 1
    || !candidateRoutes.candidateTarget
    || !candidateRoutes.routesSeparated
    || candidateProbeText.includes(candidateProxy.url)
    || candidateProbeText.includes("127.0.0.1")
    || candidateProbeText.includes(candidateHost)
    || candidateProbeText.includes("smoke-key")
  ) {
    throw new Error(`compiled Network candidate proxy probe was not safely recorded: ${smokeProgressDiagnostics()}`);
  }

  const researchAssistantPath = encodeURIComponent("research-assistant");
  const vertexAgent = await requestSmokeJsonBeforeDeadline({
    url: `${base}/api/agents/${researchAssistantPath}`,
    deadline: firstRunDeadline,
    label: "Google Vertex Agent selection",
    init: {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "smoke-vertex/smoke-vertex-model" }),
    },
  }) as { model?: unknown };
  if (vertexAgent.model !== "smoke-vertex/smoke-vertex-model") {
    throw new Error("Google Vertex Agent selection was not accepted");
  }
  const vertexSession = await requestSmokeJsonBeforeDeadline({
    url: `${base}/api/sessions`,
    deadline: firstRunDeadline,
    label: "Google Vertex session create",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: project }),
    },
  }) as { id?: unknown };
  if (typeof vertexSession.id !== "string" || !vertexSession.id) {
    throw new Error("Google Vertex session create returned an invalid id");
  }
  await requestSmokeJsonBeforeDeadline({
    url: `${base}/api/sessions/${vertexSession.id}/messages`,
    deadline: firstRunDeadline,
    label: "Google Vertex Gaxios request",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: vertexProviderMarker }),
    },
  });
  await waitForSessionSnapshot({
    base,
    sessionId: vertexSession.id,
    expectedText: vertexProviderCompletion,
  });
  if (gaxiosRequests !== 1 || vertexProviderRequests !== 1) {
    throw new Error("compiled Google Vertex path did not complete one deterministic Gaxios exchange");
  }

  const loopbackAgent = await requestSmokeJsonBeforeDeadline({
    url: `${base}/api/agents/${researchAssistantPath}`,
    deadline: firstRunDeadline,
    label: "loopback provider Agent selection",
    init: {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "smoke-loopback/smoke-model" }),
    },
  }) as { model?: unknown };
  if (loopbackAgent.model !== "smoke-loopback/smoke-model") {
    throw new Error("loopback provider Agent selection was not accepted");
  }
  const loopbackSession = await requestSmokeJsonBeforeDeadline({
    url: `${base}/api/sessions`,
    deadline: firstRunDeadline,
    label: "loopback provider session create",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: project }),
    },
  }) as { id?: unknown };
  if (typeof loopbackSession.id !== "string" || !loopbackSession.id) {
    throw new Error("loopback provider session create returned an invalid id");
  }
  await requestSmokeJsonBeforeDeadline({
    url: `${base}/api/sessions/${loopbackSession.id}/messages`,
    deadline: firstRunDeadline,
    label: "loopback provider request",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: loopbackProviderMarker }),
    },
  });
  await waitForSessionSnapshot({
    base,
    sessionId: loopbackSession.id,
    expectedText: loopbackProviderCompletion,
  });
  if (loopbackProviderRequests !== 1) {
    throw new Error("compiled provider transport did not issue exactly one deterministic loopback request");
  }
  if (ipv6ModelOrigin) {
    const ipv6Agent = await requestSmokeJsonBeforeDeadline({
      url: `${base}/api/agents/${researchAssistantPath}`,
      deadline: firstRunDeadline,
      label: "IPv6 loopback provider Agent selection",
      init: {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "smoke-loopback-ipv6/smoke-model" }),
      },
    }) as { model?: unknown };
    if (ipv6Agent.model !== "smoke-loopback-ipv6/smoke-model") {
      throw new Error("IPv6 loopback provider Agent selection was not accepted");
    }
    const ipv6Session = await requestSmokeJsonBeforeDeadline({
      url: `${base}/api/sessions`,
      deadline: firstRunDeadline,
      label: "IPv6 loopback provider session create",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: project }),
      },
    }) as { id?: unknown };
    if (typeof ipv6Session.id !== "string" || !ipv6Session.id) {
      throw new Error("IPv6 loopback provider session create returned an invalid id");
    }
    await requestSmokeJsonBeforeDeadline({
      url: `${base}/api/sessions/${ipv6Session.id}/messages`,
      deadline: firstRunDeadline,
      label: "IPv6 loopback provider request",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: ipv6ProviderMarker }),
      },
    });
    await waitForSessionSnapshot({
      base,
      sessionId: ipv6Session.id,
      expectedText: ipv6ProviderCompletion,
    });
    if (ipv6ProviderRequests !== 1) {
      throw new Error("compiled provider transport did not issue exactly one IPv6 loopback request");
    }
  }
  const restoredAgent = await requestSmokeJsonBeforeDeadline({
    url: `${base}/api/agents/${researchAssistantPath}`,
    deadline: firstRunDeadline,
    label: "public provider Agent restoration",
    init: {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "smoke/smoke-model" }),
    },
  }) as { model?: unknown };
  if (restoredAgent.model !== "smoke/smoke-model") {
    throw new Error("public provider Agent restoration was not accepted");
  }
  await startConfigurationEventStream(base, initialStatus.bootId);
  const created = await requireOk(await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: project }),
  }), "session create");
  const sessionEvents = await fetchSessionEventsBeforeDeadline({
    url: `${base}/api/sessions/${created.id}/events`,
    deadline: firstRunDeadline,
  });
  if (!sessionEvents.ok) {
    throw new Error(`session SSE failed (${sessionEvents.status}): ${await sessionEvents.text()}`);
  }
  if (!sessionEvents.body) throw new Error("session SSE response had no body");
  sessionEventReader = sessionEvents.body.getReader();
  sessionEventTask = consumeEventStream({
    reader: sessionEventReader,
    label: "session SSE",
    stopping: () => sessionEventsStopping,
    observe: observeSessionEvent,
  }).catch((error) => {
    sessionEventError = error instanceof Error ? error : new Error(String(error));
  });
  await waitForSmokeCondition("session SSE subscription", () => sessionSnapshotObserved);
  if (snapshotConfigurationGeneration === undefined) {
    throw new Error("root session snapshot did not provide a baseline configuration generation");
  }
  if (initialConfigurationGeneration !== snapshotConfigurationGeneration) {
    throw new Error(
      `root baseline generation ${snapshotConfigurationGeneration} did not match accepted configuration ${initialConfigurationGeneration}`,
    );
  }
  smokeModelState = recordSmokeAcceptanceMilestone(smokeModelState, {
    kind: "baseline-snapshot",
    generation: snapshotConfigurationGeneration,
  });

  mkdirSync(join(smokeAgentPath, ".."), { recursive: true });
  mkdirSync(join(smokeSkillPath, ".."), { recursive: true });
  writeFileSync(smokeAgentPath, smokeAgentContent, "utf8");
  writeFileSync(smokeSkillPath, smokeSkillContent, "utf8");
  if (readFileSync(smokeAgentPath, "utf8") !== smokeAgentContent) {
    throw new Error(`external global custom Agent write was not exact at ${smokeAgentPath}`);
  }
  if (readFileSync(smokeSkillPath, "utf8") !== smokeSkillContent) {
    throw new Error(`external global custom Skill write was not exact at ${smokeSkillPath}`);
  }
  smokeModelState = recordSmokeAcceptanceMilestone(smokeModelState, {
    kind: "external-resources-written",
  });

  await waitForSmokeCondition(
    "accepted configuration generation after external Agent and Skill writes",
    () => advancedConfigurationGeneration !== undefined,
  );
  if (advancedConfigurationGeneration === undefined) {
    throw new Error("external Agent and Skill writes did not produce an accepted configuration generation");
  }
  smokeModelState = recordSmokeAcceptanceMilestone(smokeModelState, {
    kind: "accepted-generation",
    generation: advancedConfigurationGeneration,
  });
  await waitForSmokeCondition(
    "root runtime application after external Agent and Skill acceptance",
    () => observedRootAppliedGeneration !== undefined
      && advancedConfigurationGeneration !== undefined
      && observedRootAppliedGeneration >= advancedConfigurationGeneration,
  );
  if (observedRootAppliedGeneration === undefined) {
    throw new Error("root runtime did not report an applied external-resource generation");
  }
  smokeModelState = recordSmokeAcceptanceMilestone(smokeModelState, {
    kind: "root-applied-generation",
    generation: observedRootAppliedGeneration,
  });

  const loopbackSearchActivityBaseline = sessionActivityState.sequence;
  await requestSmokeJsonBeforeDeadline({
    url: `${base}/api/sessions/${created.id}/messages`,
    deadline: firstRunDeadline,
    label: "deterministic bundled webfetch loopback probe",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: loopbackSearchMarker }),
    },
  });
  await waitForSmokeCondition(
    "deterministic bundled webfetch loopback completion",
    () => loopbackWebFetchState.resultObserved
      && isSmokeSessionReadyAfter(sessionActivityState, loopbackSearchActivityBaseline),
  );
  if (loopbackSearchRequests !== 1) {
    throw new Error("compiled Search transport did not issue exactly one deterministic loopback request");
  }

  const initialSearchActivityBaseline = sessionActivityState.sequence;
  await requestSmokeJsonBeforeDeadline({
    url: `${base}/api/sessions/${created.id}/messages`,
    deadline: firstRunDeadline,
    label: "deterministic bundled webfetch Search probe",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: validSearchMarker }),
    },
  });
  await waitForSmokeCondition(
    "deterministic bundled webfetch Search completion",
    () => initialWebFetchState.resultObserved
      && isSmokeSessionReadyAfter(sessionActivityState, initialSearchActivityBaseline),
  );

  dispatchActivityBaseline = sessionActivityState.sequence;
  await requestSmokeJsonBeforeDeadline({
    url: `${base}/api/sessions/${created.id}/messages`,
    deadline: firstRunDeadline,
    label: "post-reload custom Agent dispatch",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Launch the externally loaded ${smokeAgentName} and require its referenced ${smokeSkillName} resource plus deterministic ${smokeShellToolName} venv-validation tool call.`,
      }),
    },
  });
  await waitForSmokeCondition(
    "background custom-stage completion",
    () => smokeCompletionMilestonesSatisfied()
      && dispatchActivityBaseline !== undefined
      && completionActivityBaseline !== undefined
      && completionActivityBaseline >= dispatchActivityBaseline
      && isSmokeSessionReadyAfter(sessionActivityState, completionActivityBaseline),
  );
  if (!existsSync(smokeAgentPath) || readFileSync(smokeAgentPath, "utf8") !== smokeAgentContent) {
    throw new Error(`global custom Agent changed after external creation at ${smokeAgentPath}`);
  }
  if (!existsSync(smokeSkillPath) || readFileSync(smokeSkillPath, "utf8") !== smokeSkillContent) {
    throw new Error(`global custom Skill changed after external creation at ${smokeSkillPath}`);
  }
  const agents = await requireOk(
    await fetch(`${base}/api/agents?cwd=${encodeURIComponent(project)}`),
    "Agent catalog probe",
  );
  const reviewAgent = Array.isArray(agents)
    ? agents.find((agent: { name?: unknown }) => agent.name === "review")
    : undefined;
  if (
    !reviewAgent
    || reviewAgent.builtin !== true
    || reviewAgent.source !== "bundled"
    || reviewAgent.enabled !== true
    || JSON.stringify(reviewAgent.effectiveTools) !== JSON.stringify([
      "read",
      smokeShellToolName,
      "write",
      "subagent",
      "web-search",
      "webfetch",
    ])
    || JSON.stringify(reviewAgent.effectiveSkills) !== JSON.stringify([
      "peer-review",
      "paper-lookup",
      "arxiv",
      "specialist-handoff",
      "playwright-cli",
    ])
    || JSON.stringify(reviewAgent.missingSkills) !== JSON.stringify([])
    || JSON.stringify(reviewAgent.subagents) !== JSON.stringify(["search"])
  ) {
    throw new Error(`bundled Review catalog row was not authoritative: ${JSON.stringify(reviewAgent)}`);
  }
  const customAgent = Array.isArray(agents)
    ? agents.find((agent: { name?: unknown }) => agent.name === smokeAgentName)
    : undefined;
  if (
    !customAgent
    || customAgent.source !== "global"
    || customAgent.filePath !== smokeAgentPath
    || customAgent.model !== "smoke/smoke-model"
    || JSON.stringify(customAgent.effectiveTools) !== JSON.stringify(["read", smokeShellToolName])
    || JSON.stringify(customAgent.effectiveSkills) !== JSON.stringify([smokeSkillName])
    || JSON.stringify(customAgent.missingSkills) !== JSON.stringify([])
    || JSON.stringify(customAgent.subagents) !== JSON.stringify([])
  ) {
    throw new Error(`custom Agent catalog row was not authoritative: ${JSON.stringify(customAgent)}`);
  }
  if (
    smokeModelState.completedRequests !== modelRequests
      - loopbackProviderRequests
      - loopbackWebFetchState.completedRequests
      - initialWebFetchState.completedRequests
    || (smokeModelState.completedRequests !== 4 && smokeModelState.completedRequests !== 5)
    || loopbackProviderRequests !== 1
    || gaxiosRequests !== 1
    || vertexProviderRequests !== 1
    || loopbackWebFetchState.completedRequests !== 2
    || initialWebFetchState.completedRequests !== 2
    || loopbackSearchRequests !== 1
    || loopbackDirectRequests !== 1
  ) {
    throw new Error(`native smoke completed an unexpected model-request sequence: ${smokeProgressDiagnostics()}`);
  }

  const beforeOauth = classifySmokeProxyRoutes(recordsFor(initialProxies), {
    allHost: fakeChildHost,
    gaxiosHost: fakeGaxiosHost,
    llmHost: fakeLlmHost,
    searchHost: fakeSearchHost,
    oauthHost,
    candidateHost,
  }, loopbackEvidence());
  if (
    !beforeOauth.allTarget
    || !beforeOauth.gaxiosTarget
    || !beforeOauth.llmTarget
    || !beforeOauth.searchTarget
    || !beforeOauth.loopbackBypassed
    || !beforeOauth.routesSeparated
  ) {
    throw new Error(`compiled route separation failed: ${smokeProgressDiagnostics()}`);
  }
  smokeNetworkState = recordSmokeNetworkMilestone(smokeNetworkState, { kind: "routes-observed" });
  await exerciseCodexDeviceRequest(base);
  const afterOauth = classifySmokeProxyRoutes(recordsFor(initialProxies), {
    allHost: fakeChildHost,
    gaxiosHost: fakeGaxiosHost,
    llmHost: fakeLlmHost,
    searchHost: fakeSearchHost,
    oauthHost,
    candidateHost,
  }, loopbackEvidence());
  if (!afterOauth.oauthTarget || !afterOauth.loopbackBypassed || !afterOauth.routesSeparated) {
    throw new Error(`Codex OAuth route separation failed: ${smokeProgressDiagnostics()}`);
  }
  smokeNetworkState = recordSmokeNetworkMilestone(smokeNetworkState, { kind: "oauth-observed" });

  const completedSnapshot = await requireOk(
    await fetch(`${base}/api/sessions/${created.id}/snapshot`),
    "completed root session snapshot",
  ) as { session?: { sessionFile?: unknown } };
  const originalSessionPath = completedSnapshot.session?.sessionFile;
  if (typeof originalSessionPath !== "string" || !originalSessionPath) {
    throw new Error("completed root session snapshot did not expose its persisted path");
  }

  const patchedNetwork = await requestSmokeJsonBeforeDeadline({
    url: `${base}/api/settings/network-proxy`,
    deadline: firstRunDeadline,
    label: "typed Network proxy PATCH",
    init: {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        all: successorProxies.all.url,
        llm: successorProxies.llm.url,
        search: successorProxies.search.url,
      }),
    },
  }) as {
    configured?: Record<string, unknown>;
    appliedConfigured?: Record<string, unknown>;
    errors?: unknown;
    restartRequired?: unknown;
  };
  if (
    patchedNetwork.configured?.all !== successorProxies.all.url
    || patchedNetwork.configured.llm !== successorProxies.llm.url
    || patchedNetwork.configured.search !== successorProxies.search.url
    || patchedNetwork.appliedConfigured?.all !== initialProxies.all.url
    || patchedNetwork.appliedConfigured.llm !== initialProxies.llm.url
    || patchedNetwork.appliedConfigured.search !== initialProxies.search.url
    || !Array.isArray(patchedNetwork.errors)
    || patchedNetwork.errors.length !== 0
    || patchedNetwork.restartRequired !== true
  ) {
    throw new Error("typed Network proxy PATCH did not preserve configured/applied restart state");
  }
  await stopSessionEventStream();
  await stopConfigurationEventStream();

  const validReplacement = await restartCompiledDaemon(
    base,
    initialStatus.bootId,
    initialIdentity,
  );
  smokeNetworkState = recordSmokeNetworkMilestone(smokeNetworkState, {
    kind: "restart-accepted",
    bootId: initialStatus.bootId,
  });
  smokeNetworkState = recordSmokeNetworkMilestone(smokeNetworkState, {
    kind: "successor-ready",
    bootId: validReplacement.bootId,
  });
  await startConfigurationEventStream(base, validReplacement.bootId);
  await stopConfigurationEventStream();

  const appliedNetwork = await requestSmokeJsonBeforeDeadline({
    url: `${base}/api/settings/network-proxy`,
    deadline: firstRunDeadline,
    label: "successor Network proxy state",
  }) as {
    configured?: Record<string, unknown>;
    appliedConfigured?: Record<string, unknown>;
    errors?: unknown;
    restartRequired?: unknown;
  };
  if (
    appliedNetwork.configured?.all !== successorProxies.all.url
    || appliedNetwork.configured.llm !== successorProxies.llm.url
    || appliedNetwork.configured.search !== successorProxies.search.url
    || appliedNetwork.appliedConfigured?.all !== successorProxies.all.url
    || appliedNetwork.appliedConfigured.llm !== successorProxies.llm.url
    || appliedNetwork.appliedConfigured.search !== successorProxies.search.url
    || !Array.isArray(appliedNetwork.errors)
    || appliedNetwork.errors.length !== 0
    || appliedNetwork.restartRequired !== false
  ) {
    throw new Error("successor did not apply the typed Network proxy PATCH");
  }

  const reopened = await requestSmokeJsonBeforeDeadline({
    url: `${base}/api/sessions/open`,
    deadline: firstRunDeadline,
    label: "successor session resume",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: originalSessionPath }),
    },
  }) as { id?: unknown; cwd?: unknown };
  if (typeof reopened.id !== "string" || reopened.cwd !== project) {
    throw new Error("successor did not resume the original session");
  }
  await requestSmokeJsonBeforeDeadline({
    url: `${base}/api/sessions/${reopened.id}/messages`,
    deadline: firstRunDeadline,
    label: "successor model/Search session probe",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: successorSearchMarker }),
    },
  });
  await waitForSessionSnapshot({
    base,
    sessionId: reopened.id,
    expectedText: successorWebFetchScenario.completionText,
  });
  if (!successorWebFetchState.resultObserved || successorWebFetchState.completedRequests !== 2) {
    throw new Error("successor session did not complete deterministic model/Search traffic");
  }
  const successorRoutes = classifySmokeProxyRoutes(recordsFor(successorProxies), {
    allHost: fakeChildHost,
    gaxiosHost: fakeGaxiosHost,
    llmHost: fakeLlmHost,
    searchHost: fakeSearchHost,
    oauthHost,
    candidateHost,
  }, loopbackEvidence());
  if (
    !successorRoutes.llmTarget
    || !successorRoutes.searchTarget
    || !successorRoutes.loopbackBypassed
    || !successorRoutes.routesSeparated
  ) {
    throw new Error(`successor route/session acceptance failed: ${smokeProgressDiagnostics()}`);
  }
  smokeNetworkState = recordSmokeNetworkMilestone(smokeNetworkState, {
    kind: "successor-session-ready",
  });

  const malformedSearch = "socks5://SEARCH_PROXY_SECRET@proxy.invalid/path";
  updateExternalProxySettings({ searchProxy: malformedSearch });
  const malformedSearchDisk = await requestSmokeJsonBeforeDeadline({
    url: `${base}/api/settings/network-proxy`,
    deadline: firstRunDeadline,
    label: "externally malformed Search policy",
  }) as { errors?: Array<{ code?: unknown; field?: unknown }>; restartRequired?: unknown };
  if (
    malformedSearchDisk.restartRequired !== true
    || !malformedSearchDisk.errors?.some(
      (error) => error.code === "NETWORK_PROXY_INVALID" && error.field === "search",
    )
  ) {
    throw new Error("external malformed Search policy was not safely classified");
  }
  const invalidSearchReplacement = await restartCompiledDaemon(
    base,
    validReplacement.bootId,
    validReplacement.identity,
  );
  const invalidSearchApplied = await requestSmokeJsonBeforeDeadline({
    url: `${base}/api/settings/network-proxy`,
    deadline: firstRunDeadline,
    label: "applied malformed Search policy",
  }) as { errors?: Array<{ code?: unknown; field?: unknown }>; restartRequired?: unknown };
  if (
    invalidSearchApplied.restartRequired !== false
    || !invalidSearchApplied.errors?.some(
      (error) => error.code === "NETWORK_PROXY_INVALID" && error.field === "search",
    )
  ) {
    throw new Error("malformed Search successor did not retain fail-closed policy identity");
  }
  const invalidSearchSession = await requestSmokeJsonBeforeDeadline({
    url: `${base}/api/sessions/open`,
    deadline: firstRunDeadline,
    label: "invalid Search session resume",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: originalSessionPath }),
    },
  }) as { id?: unknown };
  if (typeof invalidSearchSession.id !== "string") {
    throw new Error("malformed Search successor did not resume the test session");
  }
  const searchTargetCountBefore = proxyTargetCount([initialProxies, successorProxies], fakeSearchHost);
  await requestSmokeJsonBeforeDeadline({
    url: `${base}/api/sessions/${invalidSearchSession.id}/messages`,
    deadline: firstRunDeadline,
    label: "invalid Search request",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: invalidSearchMarker }),
    },
  });
  await waitForSessionSnapshot({
    base,
    sessionId: invalidSearchSession.id,
    expectedText: invalidSearchWebFetchScenario.completionText,
    forbiddenText: [malformedSearch, "SEARCH_PROXY_SECRET", successorProxies.search.url],
  });
  if (
    !invalidSearchWebFetchState.resultObserved
    || invalidSearchWebFetchState.completedRequests !== 2
    || proxyTargetCount([initialProxies, successorProxies], fakeSearchHost) !== searchTargetCountBefore
  ) {
    throw new Error("malformed Search request did not fail closed before target access");
  }
  smokeNetworkState = recordSmokeNetworkMilestone(smokeNetworkState, {
    kind: "invalid-search-rejected",
  });

  const malformedLlm = "http://LLM_PROXY_SECRET@proxy.invalid";
  updateExternalProxySettings({
    searchProxy: successorProxies.search.url,
    llmProxy: malformedLlm,
  });
  const invalidLlmReplacement = await restartCompiledDaemon(
    base,
    invalidSearchReplacement.bootId,
    invalidSearchReplacement.identity,
  );
  const invalidLlmApplied = await requestSmokeJsonBeforeDeadline({
    url: `${base}/api/settings/network-proxy`,
    deadline: firstRunDeadline,
    label: "applied malformed LLM policy",
  }) as { errors?: Array<{ code?: unknown; field?: unknown }>; restartRequired?: unknown };
  if (
    invalidLlmApplied.restartRequired !== false
    || !invalidLlmApplied.errors?.some(
      (error) => error.code === "NETWORK_PROXY_INVALID" && error.field === "llm",
    )
  ) {
    throw new Error("malformed LLM successor did not retain fail-closed policy identity");
  }
  const invalidLlmSession = await requestSmokeJsonBeforeDeadline({
    url: `${base}/api/sessions`,
    deadline: firstRunDeadline,
    label: "invalid LLM fresh session",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: project }),
    },
  }) as { id?: unknown };
  if (typeof invalidLlmSession.id !== "string") {
    throw new Error("malformed LLM successor did not create a local recovery session");
  }
  const llmTargetCountBefore = proxyTargetCount([initialProxies, successorProxies], fakeLlmHost);
  const invalidLlmFailure = "Network proxy configuration is invalid for llm traffic (llm).";
  const invalidLlmResponse = await fetch(`${base}/api/sessions/${invalidLlmSession.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: invalidLlmMarker }),
    signal: AbortSignal.timeout(Math.max(1, firstRunDeadline - Date.now())),
  });
  const invalidLlmResponseText = await invalidLlmResponse.text();
  if (invalidLlmResponse.ok) {
    await waitForSessionSnapshot({
      base,
      sessionId: invalidLlmSession.id,
      expectedText: invalidLlmFailure,
      forbiddenText: [malformedLlm, "LLM_PROXY_SECRET", successorProxies.llm.url],
    });
  } else if (
    !invalidLlmResponseText.includes("NETWORK_PROXY_INVALID")
    && !invalidLlmResponseText.includes(invalidLlmFailure)
  ) {
    throw new Error("malformed LLM request failed without safe NETWORK_PROXY_INVALID classification");
  }
  if (
    invalidLlmResponseText.includes(malformedLlm)
    || invalidLlmResponseText.includes("LLM_PROXY_SECRET")
    || invalidLlmResponseText.includes(successorProxies.llm.url)
  ) {
    throw new Error("malformed LLM request exposed sensitive network route data");
  }
  if (proxyTargetCount([initialProxies, successorProxies], fakeLlmHost) !== llmTargetCountBefore) {
    throw new Error("malformed LLM request reached the deterministic fake provider target");
  }
  smokeNetworkState = recordSmokeNetworkMilestone(smokeNetworkState, {
    kind: "invalid-llm-rejected",
  });
  updateExternalProxySettings({
    llmProxy: successorProxies.llm.url,
    searchProxy: successorProxies.search.url,
  });
  const repairedNetwork = await requestSmokeJsonBeforeDeadline({
    url: `${base}/api/settings/network-proxy`,
    deadline: firstRunDeadline,
    label: "repaired external Network policy",
  }) as { errors?: unknown; restartRequired?: unknown };
  if (
    !Array.isArray(repairedNetwork.errors)
    || repairedNetwork.errors.length !== 0
    || repairedNetwork.restartRequired !== true
  ) {
    throw new Error("external Network policy repair was not visible before cleanup");
  }
  daemonPid = invalidLlmReplacement.identity.pid;

  const finalRoutes = classifySmokeProxyRoutes(recordsFor(initialProxies, successorProxies), {
    allHost: fakeChildHost,
    gaxiosHost: fakeGaxiosHost,
    llmHost: fakeLlmHost,
    searchHost: fakeSearchHost,
    oauthHost,
    candidateHost,
  }, loopbackEvidence());
  if (!finalRoutes.loopbackBypassed || !finalRoutes.routesSeparated) {
    throw new Error(`loopback or scoped route isolation regressed during restart: ${smokeProgressDiagnostics()}`);
  }

  const expectedModelRequests = smokeModelState.completedRequests
    + loopbackProviderRequests
    + loopbackWebFetchState.completedRequests
    + initialWebFetchState.completedRequests
    + successorWebFetchState.completedRequests
    + invalidSearchWebFetchState.completedRequests;
  if (modelRequests !== expectedModelRequests) {
    throw new Error(`native smoke completed an unexpected total model-request sequence: ${smokeProgressDiagnostics()}`);
  }

  process.env.EASYRESEARCH_CODING_AGENT_DIR = agentDir;
  const { importPi } = await import("../src/runtime/pi-import");
  const pi = await importPi();
  const history = pi.SessionManager.create(project);
  history.appendMessage({ role: "user", content: "native smoke history", timestamp: Date.now() });
  history.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "native smoke response" }],
    api: "openai-completions",
    provider: "smoke",
    model: "smoke",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const sessionPath = history.getSessionFile();
  if (!sessionPath) throw new Error("failed to persist smoke history");
  const historyStatus = await requireOk(await fetch(`${base}/api/status`), "history status probe");
  if (historyStatus.agentDir !== agentDir || !historyStatus.sessions.some((session: { path: string }) => session.path === sessionPath)) {
    throw new Error(`persisted smoke history was not discovered: ${JSON.stringify({ agentDir, sessionPath, historyStatus })}`);
  }
  await requireOk(await fetch(`${base}/api/sessions/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: sessionPath }),
  }), "session resume");
} catch (error) {
  primaryError = new Error(safeSmokeDiagnostic(error));
  try {
    updateExternalProxySettings({
      llmProxy: successorProxies.llm.url,
      searchProxy: successorProxies.search.url,
    });
  } catch {
    // Cleanup still owns daemon/proxy termination when settings repair is unavailable.
  }
  if (sessionEventReader || sessionEventTask) {
    try {
      await stopSessionEventStream();
    } catch (streamError) {
      console.log(`[smoke] failed to stop session SSE: ${safeSmokeDiagnostic(streamError)}`);
    }
  }
  if (configurationEventReader || configurationEventTask) {
    try {
      await stopConfigurationEventStream();
    } catch (streamError) {
      console.log(`[smoke] failed to stop configuration SSE: ${safeSmokeDiagnostic(streamError)}`);
    }
  }
  try {
    await settleFirstRun(true);
  } catch (settlementError) {
    console.log(`[smoke] failed to settle Windows first-run client: ${safeSmokeDiagnostic(settlementError)}`);
  }
  try {
    await dumpServerLogs();
  } catch (dumpError) {
    console.log(`[smoke] failed to dump smoke diagnostics: ${safeSmokeDiagnostic(dumpError)}`);
  }
}

const cleanupDaemonPid = recordedPid(daemonPidPath) ?? daemonPid;
await finishSmokeCleanup({
  primaryError,
  shutdown: async () => { await run(["exit"], "shutdown"); },
  stopAuxiliary: async () => {
    const results = await Promise.allSettled([
      initialProxies.all.close(),
      initialProxies.llm.close(),
      initialProxies.search.close(),
      successorProxies.all.close(),
      successorProxies.llm.close(),
      successorProxies.search.close(),
      candidateProxy.close(),
    ]);
    modelServer.stop(true);
    fakeTargetServer.stop(true);
    ipv6ModelServer?.stop(true);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) throw new AggregateError(failures, "recording proxy shutdown failed");
  },
  verifyDaemonStopped: () => verifyDaemonStopped(cleanupDaemonPid),
  removeRoot: removeSmokeRoot,
});
console.log(`[smoke] ${target.name} passed`);
