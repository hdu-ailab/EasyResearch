import { afterEach, describe, expect, it } from "vitest";
import { fetch as httpFetch, ProxyAgent } from "undici";
import { startRecordingHttpProxy } from "../../scripts/smoke-release-support";
import { assertKeylessProvenance, createKeylessSearchSmoke, KEYLESS_HOSTS, KEYLESS_SOURCE, startKeylessSmokeOrigin } from "../../scripts/smoke-keyless-search";
import { SMOKE_KEYLESS_CA } from "../../scripts/smoke-keyless-tls";
import { createKeylessWebClient } from "../extensions/keyless-web/client";
import { formatKeylessResults, searchKeyless } from "../extensions/web-search/keyless";
import { extractRemotePage } from "../extensions/webfetch/remote";
import type { SessionSnapshotDto } from "../web/contracts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const origin = await startKeylessSmokeOrigin("test");
  cleanups.push(() => origin.close());
  const proxy = await startRecordingHttpProxy({ name: "search", fakeTargets: {
    ...Object.fromEntries(KEYLESS_HOSTS.map(host => [host, origin.origin])),
    "wrong.native-smoke.invalid": origin.origin,
  } });
  cleanups.push(() => proxy.close());
  const dispatcher = new ProxyAgent({ uri: proxy.url, requestTls: { ca: SMOKE_KEYLESS_CA } });
  cleanups.push(() => dispatcher.destroy());
  const fetch = ((input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => httpFetch(String(input), {
    ...init as Parameters<typeof httpFetch>[1], dispatcher,
  })) as unknown as typeof globalThis.fetch;
  return { origin, proxy, fetch, client: createKeylessWebClient({ fetch }) };
}

describe("compiled keyless acceptance fixtures", () => {
  it("tunnels verified HTTPS to fixed provider names and rejects missing trust and wrong SAN", async () => {
    const f = await fixture();
    const result = await searchKeyless(f.client, { provider: "firecrawl", query: "test", num: 1, site: "papers.native-smoke.invalid" });
    expect(result.results[0]?.url).toBe(KEYLESS_SOURCE);
    expect(f.proxy.records()[0]).toMatchObject({ host: KEYLESS_HOSTS[0], proxy: "search", kind: "connect-fake-target" });
    await expect(f.fetch("https://wrong.native-smoke.invalid/v2/search")).rejects.toThrow();
    const untrusted = new ProxyAgent({ uri: f.proxy.url });
    cleanups.push(() => untrusted.destroy());
    await expect(httpFetch("https://api.firecrawl.dev/v2/search", { dispatcher: untrusted })).rejects.toThrow();
    expect(f.origin.records).toHaveLength(1); // TLS failures never reached HTTP.
    expect(f.origin.failures).toEqual([]);
  });

  it("accepts real adapter outputs for every fixture branch and rejects fabricated origin provenance", async () => {
    const f = await fixture();
    const timeline: unknown[] = [];
    for (const provider of ["firecrawl", "tavily", "firecrawl-research"] as const) {
      const details = await searchKeyless(f.client, { provider, query: "fixture", num: 1,
        ...(provider === "firecrawl-research" ? { from: "2020-01-01", to: "2026-11-17" } : { site: "papers.native-smoke.invalid" }) });
      timeline.push({ kind: "message", message: { role: "toolResult", toolName: "web-search", details,
        content: [{ type: "text", text: formatKeylessResults(details) }], isError: false } });
    }
    for (const provider of ["firecrawl", "tavily"] as const) {
      const result = await extractRemotePage({ client: f.client, provider, url: KEYLESS_SOURCE,
        format: provider === "tavily" ? "text" : "markdown", signal: new AbortController().signal, timeoutMs: 5000, maxBytes: 50000 });
      timeline.push({ kind: "message", message: { role: "toolResult", toolName: "webfetch", details: result.details, isError: false } });
    }
    const plain = await extractRemotePage({ client: f.client, provider: "firecrawl", url: KEYLESS_SOURCE,
      format: "text", signal: new AbortController().signal, timeoutMs: 5000, maxBytes: 50000 });
    timeline.push({ kind: "message", message: { role: "toolResult", toolName: "webfetch", details: plain.details,
      content: [{ type: "text", text: plain.content }], isError: false } });
    const snapshot = { timeline } as Pick<SessionSnapshotDto, "timeline">;
    expect(() => assertKeylessProvenance(snapshot)).not.toThrow();
    const hiddenCoverage = JSON.parse(JSON.stringify(snapshot));
    hiddenCoverage.timeline[2].message.content = [{ type: "text", text: "Paper records without a coverage notice" }];
    expect(() => assertKeylessProvenance(hiddenCoverage)).toThrow(/partial coverage/);
    const forged = JSON.parse(JSON.stringify(snapshot));
    forged.timeline[3].message.details.directOriginVerified = true;
    expect(() => assertKeylessProvenance(forged)).toThrow();
    expect(f.origin.records).toHaveLength(timeline.length);
    expect(f.origin.failures).toEqual([]);

    await expect(searchKeyless(f.client, { provider: "firecrawl", query: "provider-error", num: 1 })).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    await expect(searchKeyless(f.client, { provider: "firecrawl", query: "malformed", num: 1 })).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
    await expect(searchKeyless(f.client, { provider: "firecrawl", query: "oversized", num: 1 })).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    await expect(searchKeyless(f.client, { provider: "tavily", query: "rate-limit", num: 1 })).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 600 });
    const requests = f.origin.records.length;
    await expect(extractRemotePage({ client: f.client, provider: "tavily", url: KEYLESS_SOURCE, format: "text",
      signal: new AbortController().signal, timeoutMs: 5000, maxBytes: 50000 })).rejects.toMatchObject({ code: "PROVIDER_COOLDOWN" });
    expect(f.origin.records).toHaveLength(requests);
  });

  it("observes cancellation of an already-started TLS response body", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const pending = extractRemotePage({ client: f.client, provider: "firecrawl", url: `${KEYLESS_SOURCE}/stall-body`,
      format: "markdown", signal: controller.signal, timeoutMs: 5000, maxBytes: 50000 });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect.poll(() => f.origin.stalledBodies).toBe(1);
    controller.abort();
    await rejected;
    await expect.poll(() => f.origin.cancelledBodies).toBe(1);
  });

  it("requires a matching real tool result before a fake-LLM lane can advance", () => {
    const scenario = createKeylessSearchSmoke("test", "custom-search");
    const request = { messages: [{ role: "user", content: scenario.prompt("root") }],
      tools: [{ function: { name: "web-search" } }] };
    expect(scenario.select(request)).toMatchObject({ kind: "tool", name: "web-search" });
    expect(() => scenario.select(request)).toThrow(/exactly one result/);
    expect(scenario.lanes.get("root")!.complete).toBe(false);
    expect(scenario.failure).toBeDefined();
  });
});
