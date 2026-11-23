import assert from "node:assert/strict";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { SmokeAgentLane, smokeAgentText, type SmokeAgentRequest, type SmokeAgentStep } from "./smoke-agent-scenario";
import { requestSmokeJsonBeforeDeadline, type SmokeProxyRecord } from "./smoke-release-support";
import { SMOKE_KEYLESS_CERT, SMOKE_KEYLESS_KEY } from "./smoke-keyless-tls";
import type { ChildSessionSnapshotDto, SessionSnapshotDto } from "../src/web/contracts";

export const KEYLESS_HOSTS = ["api.firecrawl.dev", "api.tavily.com"] as const;
export const KEYLESS_SOURCE = "https://papers.native-smoke.invalid/selected";
const PAPER_URL = "https://arxiv.org/abs/1706.03762";
const PRIVATE_PROVIDER_ERROR = "UPSTREAM_PRIVATE_RECONFIGURE_WITH_KEY";

/** HTTPS origin behind the recording proxy, never an application endpoint override. */
export async function startKeylessSmokeOrigin(runId: string) {
  const records: Array<{ host: string; path: string; marker: string }> = [];
  const failures: unknown[] = [];
  const sockets = new Set<Duplex>();
  let stalledBodies = 0;
  let cancelledBodies = 0;
  const sentinel = `keyless-source-${runId}`;
  const server = createServer({ key: SMOKE_KEYLESS_KEY, cert: SMOKE_KEYLESS_CERT }, (request, response) => {
    void (async () => {
      const url = new URL(request.url!, `https://${request.headers.host}`);
      assert(KEYLESS_HOSTS.includes(url.hostname as typeof KEYLESS_HOSTS[number]));
      assert.equal(request.headers.authorization, undefined, "anonymous providers must not receive Authorization");
      assert.equal(request.headers["proxy-authorization"], undefined);
      assert.match(String(request.headers["user-agent"]), /EasyResearch/iu);
      if (url.hostname === "api.tavily.com") assert.equal(request.headers["x-tavily-access-mode"], "keyless");
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
        assert(chunks.reduce((size, value) => size + value.length, 0) < 16_384, "unexpected provider request size");
      }
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      assert.equal(body.api_key, undefined);
      const marker = String(body.query ?? body.url ?? body.urls?.[0] ?? url.searchParams.get("query") ?? "");
      records.push({ host: url.hostname, path: url.pathname, marker });
      const json = (value: unknown, status = 200, headers = {}) => {
        response.writeHead(status, { "Content-Type": "application/json", ...headers });
        response.end(JSON.stringify(value));
      };
      if (marker.includes("provider-error")) {
        json({ success: false, error: PRIVATE_PROVIDER_ERROR });
        return;
      }
      if (marker.includes("malformed")) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end("{not-json");
        return;
      }
      if (marker.includes("rate-limit")) {
        json({ error: PRIVATE_PROVIDER_ERROR }, 429, { "Retry-After": "600" });
        return;
      }
      if (marker.includes("oversized")) {
        response.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(300_000) });
        response.write('{"results":[');
        response.flushHeaders();
        return; // The compiled byte limit must cancel this incomplete body.
      }
      if (marker.includes("stall-body")) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write('{"success":true,"data":{"markdown":"');
        response.flushHeaders();
        stalledBodies++;
        response.once("close", () => { if (!response.writableEnded) cancelledBodies++; });
        return; // Stop must interrupt body consumption, not just preflight.
      }
      if (url.pathname === "/v2/search/research/papers") {
        assert.equal(url.hostname, "api.firecrawl.dev");
        assert.equal(request.method, "GET");
        assert.equal(url.searchParams.get("k"), "1");
        assert.equal(url.searchParams.get("from"), "2020-01-01");
        assert.equal(url.searchParams.get("to"), "2026-11-17");
        json({ success: true, partial: true, results: [{ paperId: "smoke-paper", primaryId: "arxiv:1706.03762",
          ids: { arxiv: ["1706.03762"] }, title: sentinel, abstract: "Provider index abstract only.",
          authors: ["Fixture Author"], createdDate: "2026-11-01", updateDate: "2026-11-02" }] });
      } else if (url.pathname === "/v2/search") {
        assert.equal(url.hostname, "api.firecrawl.dev");
        assert.equal(request.method, "POST");
        assert.equal(body.limit, 1);
        assert.deepEqual(body.sources, ["web"]);
        assert.equal(body.scrapeOptions, undefined);
        assert.deepEqual(body.includeDomains, ["papers.native-smoke.invalid"]);
        json({ success: true, data: { web: [{ url: KEYLESS_SOURCE, title: sentinel, description: "Original-source lead." }] } });
      } else if (url.pathname === "/search") {
        assert.equal(url.hostname, "api.tavily.com");
        assert.equal(request.method, "POST");
        assert.equal(body.max_results, 1);
        assert.equal(body.search_depth, "basic");
        assert.equal(body.include_answer, false);
        assert.equal(body.include_raw_content, false);
        assert.deepEqual(body.include_domains, ["papers.native-smoke.invalid"]);
        json({ results: [{ url: KEYLESS_SOURCE, title: sentinel, content: "Original-source lead." }] });
      } else if (url.pathname === "/v2/scrape") {
        assert.equal(url.hostname, "api.firecrawl.dev");
        assert.equal(request.method, "POST");
        assert.equal(body.url, KEYLESS_SOURCE);
        assert.deepEqual(body.formats, ["markdown"]);
        json({ success: true, data: { markdown: `# ${sentinel}\n\nSelected page.\n\n\`\`\`text\n<fixture>&value\n\`\`\``,
          metadata: { sourceURL: KEYLESS_SOURCE, url: `${KEYLESS_SOURCE}/final`, statusCode: 200 },
          cacheState: "hit" } }, 200, { "X-Cache": "HIT" });
      } else if (url.pathname === "/extract") {
        assert.equal(url.hostname, "api.tavily.com");
        assert.equal(request.method, "POST");
        assert.deepEqual(body.urls, [KEYLESS_SOURCE]);
        assert.equal(body.extract_depth, "basic");
        assert.equal(body.format, "text");
        json({ results: [{ url: KEYLESS_SOURCE, raw_content: `${sentinel}\nSelected page.` }], failed_results: [] });
      } else throw new Error(`Unexpected keyless fixture path ${url.pathname}`);
    })().catch(error => {
      failures.push(error);
      if (!response.headersSent) response.writeHead(500);
      response.end("Fixture contract failed");
    });
  });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    origin: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
    sentinel, records, failures,
    get stalledBodies() { return stalledBodies; },
    get cancelledBodies() { return cancelledBodies; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

export function createKeylessSearchSmoke(runId: string, customAgent: string) {
  const prefix = `KEYLESS_SMOKE:${runId}:`;
  const agentPrompt = `KEYLESS_CUSTOM_AGENT_${runId}`;
  const prompt = (name: string) => `${prefix}${name}`;
  const final = (name: string) => `${prefix}${name}:complete`;
  const lanes = new Map<string, SmokeAgentLane>();
  const search = (provider: string, query: string, accept: (text: string) => void): SmokeAgentStep => ({
    name: "web-search", args: () => ({ provider, query, num: 1,
      ...(provider === "firecrawl-research" ? { from: "2020-01-01", to: "2026-11-17" } : { site: "papers.native-smoke.invalid" }) }), accept,
  });
  const extract = (provider: string, url: string, accept: (text: string) => void): SmokeAgentStep => ({
    name: "webfetch", args: () => ({ provider, url, format: provider === "tavily" ? "text" : "markdown" }), accept,
  });
  const accepted = (text: string) => assert(text.includes(`keyless-source-${runId}`), "compiled tool did not return the actual fixture source");
  const positiveSteps = (lane: string): SmokeAgentStep[] => [
    ...["firecrawl", "tavily", "firecrawl-research"].map(provider => search(provider, `${prefix}${lane}-${provider}`, text => {
      accepted(text);
      assert(text.includes(provider));
      assert(text.includes(provider === "firecrawl-research" ? PAPER_URL : KEYLESS_SOURCE));
    })),
    ...["firecrawl", "tavily"].map(provider => extract(provider, KEYLESS_SOURCE, accepted)),
    { name: "webfetch", args: () => ({ provider: "firecrawl", url: KEYLESS_SOURCE, format: "text" }), accept: text => {
      accepted(text);
      assert(text.includes("<fixture>&value"), "compiled Markdown conversion must preserve code as text");
      assert(!text.includes(`# keyless-source-${runId}`), "compiled plain text must not retain Markdown heading syntax");
      assert(!text.includes("```"), "compiled plain text must not retain fenced-code delimiters");
    } },
  ];
  const denial = (code: string) => (text: string) => {
    assert(text.includes(code), `expected compiled ${code} denial, got ${text}`);
    assert(!text.includes(PRIVATE_PROVIDER_ERROR), "provider error instructions leaked into model context");
    assert(!text.includes("SEARCH_PROXY_SECRET"), "proxy credentials leaked into model context");
  };
  lanes.set("child", new SmokeAgentLane("keyless_child", positiveSteps("child"), () => final("child")));
  lanes.set("root", new SmokeAgentLane("keyless_root", [
    ...positiveSteps("root"),
    { name: "subagent", args: () => ({ agent: customAgent, description: "Verify native keyless tools", prompt: prompt("child") }), terminal: () => {
      assert(lanes.get("child")!.complete);
      return final("child");
    } },
    search("firecrawl", "provider-error", denial("PROVIDER_ERROR")),
    search("firecrawl", "malformed", denial("MALFORMED_RESPONSE")),
    search("firecrawl", "oversized", denial("RESPONSE_TOO_LARGE")),
    search("tavily", "rate-limit", denial("RATE_LIMITED")),
    // The two tools must share the same runtime-owned cooldown client.
    extract("tavily", KEYLESS_SOURCE, denial("PROVIDER_COOLDOWN")),
  ], () => final("root")));
  lanes.set("stop", new SmokeAgentLane("keyless_stop", [
    extract("firecrawl", `${KEYLESS_SOURCE}/stall-body`, () => { throw new Error("stalled extraction returned instead of being stopped"); }),
  ], () => final("stop")));
  lanes.set("invalid", new SmokeAgentLane("keyless_invalid", [
    search("firecrawl", "invalid-policy", denial("NETWORK_PROXY_INVALID")),
    extract("tavily", KEYLESS_SOURCE, denial("NETWORK_PROXY_INVALID")),
  ], () => final("invalid")));
  const laneFor = (request: SmokeAgentRequest) => {
    for (const message of request.messages ?? []) {
      if (message.role !== "user") continue;
      const text = smokeAgentText(message.content);
      const at = text.indexOf(prefix);
      if (at >= 0) return lanes.get(text.slice(at + prefix.length).split(/\s/u)[0]!);
    }
    return undefined;
  };
  let failure: unknown;
  let requests = 0;
  return {
    prompt, final, lanes, laneFor, agentPrompt,
    get failure() { return failure; },
    get requests() { return requests; },
    select(request: SmokeAgentRequest) {
      requests++;
      try {
        const lane = laneFor(request);
        assert(lane);
        if (lane === lanes.get("child")) {
          assert.deepEqual(request.tools?.map(tool => tool.function?.name).sort(), ["web-search", "webfetch"],
            "keyless child must run under the externally written custom Agent's strict allowlist");
          assert(request.messages?.some(message => message.role === "system" && smokeAgentText(message.content).includes(agentPrompt)),
            "keyless child lost its externally written role prompt");
        }
        return lane.select(request);
      }
      catch (error) { failure = error; throw error; }
    },
  };
}

type Scenario = ReturnType<typeof createKeylessSearchSmoke>;
type Origin = Awaited<ReturnType<typeof startKeylessSmokeOrigin>>;
type SmokeOptions = { base: string; project: string; deadline: number; scenario: Scenario; origin: Origin };

function api(options: SmokeOptions) {
  const json = (path: string, init?: RequestInit) => requestSmokeJsonBeforeDeadline({
    url: `${options.base}${path}`, deadline: options.deadline, label: `keyless ${path}`, init,
  });
  return {
    json,
    post: (path: string, body?: unknown) => json(path, { method: "POST",
      ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    }),
  };
}

async function waitFor(options: SmokeOptions, check: () => Promise<boolean>) {
  while (Date.now() < options.deadline) {
    if (options.scenario.failure) throw options.scenario.failure;
    if (options.origin.failures.length) throw new AggregateError(options.origin.failures, "keyless fixture contract failed");
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Compiled keyless acceptance exceeded its deadline");
}

async function runLane(options: SmokeOptions, name: "root" | "invalid") {
  const { json, post } = api(options);
  const created = await post("/api/sessions", { cwd: options.project }) as { id: string };
  assert(created.id);
  let snapshot!: SessionSnapshotDto;
  try {
    await post(`/api/sessions/${created.id}/messages`, { message: options.scenario.prompt(name) });
    await waitFor(options, async () => {
      snapshot = await json(`/api/sessions/${created.id}/snapshot`) as SessionSnapshotDto;
      return options.scenario.lanes.get(name)!.complete && snapshot.session.status === "ready" && !snapshot.session.isStreaming
        && snapshot.timeline.some(entry => entry.kind === "message" && entry.message.role === "assistant"
          && smokeAgentText(entry.message.content) === options.scenario.final(name));
    });
    return { id: created.id, snapshot };
  } finally {
    await requestSmokeJsonBeforeDeadline({ url: `${options.base}/api/sessions/${created.id}/stop`, deadline: Date.now() + 15_000,
      label: "keyless lane cleanup", init: { method: "POST" } });
  }
}

export function assertKeylessProvenance(snapshot: Pick<SessionSnapshotDto, "timeline">) {
  const results = snapshot.timeline.flatMap(entry => entry.kind === "message" && entry.message.role === "toolResult"
    ? [entry.message] : []);
  for (const provider of ["firecrawl", "tavily", "firecrawl-research"]) {
    const search = results.find(result => result.toolName === "web-search" && !result.isError
      && (result.details as Record<string, unknown> | undefined)?.provider === provider);
    assert(search, `${provider} did not execute successfully in compiled history`);
    const details = search.details as { channel: string; results: Array<Record<string, unknown>>; dateFilter?: { basis: string }; partial?: boolean };
    assert.equal(details.channel, provider === "firecrawl-research" ? "paper-index" : "web");
    assert.equal(details.results.length, 1);
    assert.equal(details.results[0]!.url, provider === "firecrawl-research" ? PAPER_URL : KEYLESS_SOURCE);
    assert.equal(details.results[0]!.provider, provider);
    if (provider === "firecrawl-research") {
      assert.equal(details.results[0]!.primaryId, "arxiv:1706.03762");
      assert.equal(details.results[0]!.source, "arxiv");
      assert.equal(details.dateFilter?.basis, "created/updated");
      assert.equal(details.partial, true, "compiled paper-index results must preserve partial coverage");
      assert.match(smokeAgentText(search.content), /partial/iu, "partial coverage must reach model-visible text");
    }
  }
  for (const provider of ["firecrawl", "tavily"]) {
    const extracted = results.find(result => result.toolName === "webfetch" && !result.isError
      && (result.details as Record<string, unknown> | undefined)?.provider === provider);
    assert(extracted, `${provider} extraction did not execute in compiled history`);
    const details = extracted.details as Record<string, unknown>;
    assert.equal(details.requestedUrl, KEYLESS_SOURCE);
    assert.equal(details.sourceUrl, KEYLESS_SOURCE);
    assert.equal(details.directOriginVerified, false);
    if (provider === "firecrawl") {
      assert.equal(details.finalUrl, `${KEYLESS_SOURCE}/final`);
      assert.equal((details.provenance as Record<string, unknown>).cacheState, "hit");
      assert.equal((details.providerCacheHeaders as Record<string, unknown>)["x-cache"], "HIT");
    }
  }
  const plain = results.find(result => result.toolName === "webfetch" && !result.isError
    && (result.details as Record<string, unknown> | undefined)?.provider === "firecrawl"
    && (result.details as Record<string, unknown> | undefined)?.requestedFormat === "text");
  assert(plain, "compiled Firecrawl Markdown-to-text conversion did not execute");
  assert.equal((plain.details as Record<string, unknown>).format, "text");
  assert.equal((plain.details as Record<string, unknown>).contentType, "text/plain");
  assert(smokeAgentText(plain.content).includes("<fixture>&value"));
}

export async function runKeylessSearchSmoke(options: SmokeOptions & { proxyRecords: () => readonly SmokeProxyRecord[] }) {
  const { json, post } = api(options);
  const root = await runLane(options, "root");
  assertKeylessProvenance(root.snapshot);
  const dispatch = options.scenario.lanes.get("root")!.dispatches[0]!;
  assert(dispatch, "missing compiled child terminal handoff");
  const child = root.snapshot.subagents.find(entry => entry.childSessionId === dispatch.sessionID);
  assert(child);
  const childSnapshot = await json(`/api/sessions/${root.id}/subagents/${child.childSessionId}/snapshot`) as ChildSessionSnapshotDto;
  assertKeylessProvenance(childSnapshot);
  assert(root.snapshot.timeline.some(entry => entry.kind === "subagent-completion"
    && entry.outcomes.some(outcome => outcome.status === "complete" && outcome.text === options.scenario.final("child"))));
  for (const name of ["root", "child"]) {
    for (const provider of ["firecrawl", "tavily", "firecrawl-research"]) {
      assert.equal(options.origin.records.filter(row => row.marker === `${options.scenario.prompt(name)}-${provider}`).length, 1,
        `${name} ${provider} must execute exactly one actual provider request`);
    }
  }
  assert.equal(options.origin.records.filter(row => row.path === "/v2/scrape" && row.marker === KEYLESS_SOURCE).length, 4,
    "root and custom-stage Firecrawl Markdown and plain-text extraction must reach the HTTPS fixture");
  const errors = root.snapshot.timeline.flatMap(entry => entry.kind === "message" && entry.message.role === "toolResult"
    && (entry.message.isError || typeof (entry.message.details as Record<string, unknown> | undefined)?.error === "string")
    ? [entry.message] : []);
  assert.equal(errors.length, 5, "provider errors must retain an explicit failed result, distinct from empty search");
  for (const code of ["RATE_LIMITED"]) {
    const result = errors.find(entry => smokeAgentText(entry.content).includes(code));
    assert(result);
    const details = result.details as Record<string, unknown>;
    assert.equal(details.status, 429);
    assert(Number(details.retryAfterSeconds) > 0 && Number(details.retryAfterSeconds) <= 600);
  }
  assert.equal(options.origin.records.filter(row => row.path === "/extract").length, 2,
    "cooldown must suppress extraction HTTP after search rate limiting in the same runtime");
  assert.equal(options.origin.records.filter(row => row.marker === "rate-limit").length, 1, "429 must not trigger retries");

  const stopped = await post("/api/sessions", { cwd: options.project }) as { id: string };
  const stopDeadline = Math.min(options.deadline, Date.now() + 15_000);
  const stopOptions = { ...options, deadline: stopDeadline };
  try {
    await post(`/api/sessions/${stopped.id}/messages`, { message: options.scenario.prompt("stop") });
    await waitFor(stopOptions, async () => options.origin.stalledBodies === 1);
    // Composer Stop cancels the run; /stop terminally disconnects the session.
    await api(stopOptions).post(`/api/sessions/${stopped.id}/abort`);
    await waitFor(stopOptions, async () => {
      const snapshot = await api(stopOptions).json(`/api/sessions/${stopped.id}/snapshot`) as SessionSnapshotDto;
      return options.origin.cancelledBodies === 1 && !snapshot.session.isStreaming
        && snapshot.session.status === "ready";
    });
    assert.equal(options.scenario.lanes.get("stop")!.calls.length, 1);
    assert.equal(options.scenario.lanes.get("stop")!.complete, false);
  } finally {
    await requestSmokeJsonBeforeDeadline({ url: `${options.base}/api/sessions/${stopped.id}/stop`, deadline: Date.now() + 15_000,
      label: "keyless Stop cleanup", init: { method: "POST" } });
  }
  for (const host of KEYLESS_HOSTS) {
    const records = options.proxyRecords().filter(row => row.host === host);
    assert(records.length > 0, `missing actual TLS provider route for ${host}`);
    assert(records.every(row => row.proxy === "search" && row.kind === "connect-fake-target"), `${host} escaped Search routing`);
  }
  assert(options.proxyRecords().some(row => row.proxy === "llm" && row.kind === "fake-target"), "missing independent LLM traffic");
}

export async function runInvalidKeylessSearchSmoke(options: SmokeOptions) {
  const count = options.origin.records.length;
  const result = await runLane(options, "invalid");
  assert.equal(options.origin.records.length, count, "malformed Search policy must not reach either provider");
  const text = JSON.stringify(result.snapshot.timeline);
  assert(!text.includes("SEARCH_PROXY_SECRET"));
  assert.equal(result.snapshot.timeline.filter(entry => entry.kind === "message" && entry.message.role === "toolResult"
    && (entry.message.isError || typeof (entry.message.details as Record<string, unknown> | undefined)?.error === "string")
    && smokeAgentText(entry.message.content).includes("NETWORK_PROXY_INVALID")).length, 2);
}
