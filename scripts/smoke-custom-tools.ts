import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentDto, SessionSnapshotDto } from "../src/web/contracts";
import { SmokeAgentLane, smokeAgentText, type SmokeAgentAction, type SmokeAgentRequest } from "./smoke-agent-scenario";
import { fetchSessionEventsBeforeDeadline, requestSmokeJsonBeforeDeadline } from "./smoke-release-support";

interface WireTool {
  function?: {
    name?: string;
    description?: string;
    parameters?: { type?: string; properties?: Record<string, { type?: string; const?: unknown; enum?: unknown[] }>; required?: string[] };
  };
}

/** Provider assertions and generated external sources; never a second tool executor. */
export function createCustomToolsSmoke(runId: string) {
  const suffix = createHash("sha256").update(runId).digest("hex").slice(0, 16);
  const prefix = `CUSTOM_TOOL_SMOKE:${runId}:`;
  const tools = { global: `native_custom_${suffix}`, project: `native_project_${suffix}`, repaired: `native_repaired_${suffix}` };
  const agents = { empty: `native-tool-empty-${suffix}`, optin: `native-tool-optin-${suffix}` };
  const missingTool = `native_missing_${suffix}`;
  const resultMarker = `CUSTOM_TOOL_RESULT_${runId}`;
  const privateError = `PRIVATE_EXTENSION_ERROR_${runId}`;
  const prompt = (name: string) => `${prefix}${name}`;
  const final = (name: string) => `${prefix}${name}:complete`;
  const lanes = new Map<string, SmokeAgentLane>();
  const expected = new Map<string, Record<string, string>>();
  const requestCounts = new Map<string, number>();
  const gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const expectedCwds = new Map<string, string>();
  const evidence: Record<string, unknown> = { phase: "not-started" };
  let failure: unknown;
  let requests = 0;
  const call = (phase: string, name: string, version: string) => ({
    name,
    args: () => ({ version, echo: prompt(phase) }),
    accept(text: string) {
      const result = JSON.parse(text) as Record<string, unknown>;
      assert.equal(result.marker, resultMarker, "Native tool result lost its fixture identity");
      assert.equal(result.tool, name);
      assert.equal(result.version, version, "Native helper implementation has a stale version");
      assert.equal(result.echo, prompt(phase), "Native tool did not execute this request's arguments");
      assert.equal(typeof result.cwd, "string");
      if (expectedCwds.has(phase)) assert.equal(resolve(String(result.cwd)), expectedCwds.get(phase), "Tool execution escaped its exact cwd");
    },
  });
  const add = (phase: string, schemas: Record<string, string>, invoke?: [string, string]) => {
    expected.set(phase, schemas);
    lanes.set(phase, new SmokeAgentLane(`custom_${suffix}_${phase.replaceAll("-", "_")}`,
      invoke ? [call(phase, ...invoke)] : [], () => final(phase)));
  };
  add("before", {});
  add("created", { [tools.global]: "v1" }, [tools.global, "v1"]);
  add("child-empty", {});
  add("child-optin", { [tools.global]: "v1" }, [tools.global, "v1"]);
  expected.set("children", { [tools.global]: "v1" });
  lanes.set("children", new SmokeAgentLane(`custom_${suffix}_children`, [
    ...(["empty", "optin"] as const).map(kind => ({
      name: "subagent",
      args: () => ({ agent: agents[kind], description: `Verify native custom-tool ${kind} policy`, prompt: prompt(`child-${kind}`) }),
      terminal: () => {
        assert(lanes.get(`child-${kind}`)!.complete);
        return final(`child-${kind}`);
      },
    })),
  ], () => final("children")));
  add("updated", { [tools.global]: "v2" }, [tools.global, "v2"]);
  add("busy", { [tools.global]: "v2" }, [tools.global, "v2"]);
  add("settled", { [tools.global]: "v3" }, [tools.global, "v3"]);
  add("project", { [tools.global]: "v3", [tools.project]: "project-v1" }, [tools.project, "project-v1"]);
  add("other-cwd", { [tools.global]: "v3" }, [tools.global, "v3"]);
  add("malformed", { [tools.global]: "v3" }, [tools.global, "v3"]);
  add("repaired", { [tools.global]: "v3", [tools.repaired]: "repaired-v1" }, [tools.repaired, "repaired-v1"]);
  add("removed", { [tools.repaired]: "repaired-v1" }, [tools.repaired, "repaired-v1"]);
  const taskLine = (message: NonNullable<SmokeAgentRequest["messages"]>[number]) => {
    if (message.role !== "user") return undefined;
    const text = smokeAgentText(message.content).trim();
    if (text.startsWith("<background-result")) return undefined;
    // Native child dispatch prepends its subagent-context sentence to the task.
    return text.split(/\r?\n/u).find(line => line.startsWith(prefix));
  };
  const laneName = (request: SmokeAgentRequest) => {
    // A reused root retains previous prompts and user-role background reports.
    // Only an exact admitted task marker can select its current response lane.
    for (const message of [...request.messages ?? []].reverse()) {
      const text = taskLine(message);
      if (text && lanes.has(text.slice(prefix.length))) return text.slice(prefix.length);
    }
    return undefined;
  };
  return {
    suffix, tools, agents, missingTool, resultMarker, privateError, prompt, final, lanes, evidence,
    get failure() { return failure; },
    get requests() { return requests; },
    requestCount: (phase: string) => requestCounts.get(phase) ?? 0,
    setCwd(phase: string, cwd: string) { expectedCwds.set(phase, resolve(cwd)); },
    matches(request: SmokeAgentRequest) {
      return request.messages?.some(message => taskLine(message) !== undefined) ?? false;
    },
    hold(phase: string) {
      assert(lanes.has(phase) && !gates.has(phase));
      gates.set(phase, Promise.withResolvers<void>());
    },
    release() {
      for (const gate of gates.values()) gate.resolve();
      gates.clear();
    },
    async select(request: SmokeAgentRequest): Promise<SmokeAgentAction> {
      requests++;
      try {
        assert(!JSON.stringify(request.messages ?? []).includes(privateError), "Private extension failure entered model context");
        const phase = laneName(request);
        assert(phase, "Unknown custom-tool smoke task");
        requestCounts.set(phase, (requestCounts.get(phase) ?? 0) + 1);
        const actual = request.tools ?? [];
        const schemas = expected.get(phase)!;
        const names = actual.map(tool => tool.function?.name);
        assert.deepEqual(names.filter(name => Object.values(tools).includes(name!)).sort(), Object.keys(schemas).sort(),
          `${phase}: native user-tool schema scope or activation mismatch`);
        assert(!names.includes(missingTool), "Configured but unregistered tool became callable");
        if (phase === "child-empty") assert(names.includes("read"), "Empty specialist lost its controlled bundled tools");
        if (phase === "child-optin") assert.deepEqual(names, [tools.global], "Explicit specialist tool allowlist was not strict");
        for (const [name, version] of Object.entries(schemas)) {
          const tool = (actual as WireTool[]).find(tool => tool.function?.name === name)!.function!;
          const parameters = tool.parameters;
          assert.equal(parameters?.type, "object", `${phase}: TypeBox schema missing`);
          const literal = parameters.properties?.version;
          assert(literal?.const === version || literal?.enum?.length === 1 && literal.enum[0] === version,
            `${phase}: stale native tool schema, expected ${version}`);
          assert(parameters.required?.includes("version") && parameters.required.includes("echo"));
          assert.equal(parameters.properties?.echo?.type, "string");
        }
        evidence.lastRequest = { phase, count: requests, customTools: names.filter(name => Object.values(tools).includes(name!)) };
        await gates.get(phase)?.promise;
        return lanes.get(phase)!.select(request);
      } catch (error) {
        failure ??= error;
        throw error;
      }
    },
    helperSource(version: string) { return `export const VERSION = ${JSON.stringify(version)};\n`; },
    extensionSource(name: string, loadedPath?: string) {
      return [
        'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
        'import { Type } from "typebox";',
        'import { VERSION } from "./helper.ts";',
        ...(loadedPath ? ['import { appendFileSync } from "node:fs";'] : []),
        "export default function (api: ExtensionAPI) {",
        ...(loadedPath ? [`  appendFileSync(${JSON.stringify(loadedPath)}, "loaded\\n");`] : []),
        "  api.registerTool({",
        `    name: ${JSON.stringify(name)}, label: "Native custom tool",`,
        '    description: `Native external tool version ${VERSION}`,',
        "    parameters: Type.Object({ version: Type.Literal(VERSION), echo: Type.String() }),",
        "    async execute(_id, params, _signal, _update, ctx) {",
        `      const result = { marker: ${JSON.stringify(resultMarker)}, tool: ${JSON.stringify(name)},`,
        "        version: VERSION, echo: params.echo, cwd: ctx.cwd };",
        '      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };',
        "    },",
        "  });",
        "}", "",
      ].join("\n");
    },
  };
}

type Fixture = ReturnType<typeof createCustomToolsSmoke>;
type RuntimeObservation = { id: string; applied: number; snapshot: boolean };

/** Exercises only the already-running candidate over HTTP plus external source writes. */
export async function runCustomToolsSmoke(options: {
  base: string; root: string; agentDir: string; deadline: number; fixture: Fixture;
}) {
  const { base, root, agentDir, deadline, fixture } = options;
  const project = join(root, `custom-tool-project-${fixture.suffix}`);
  const peer = join(root, `custom-tool-peer-${fixture.suffix}`);
  const privateProject = join(root, `custom-tool-private-${fixture.suffix}`);
  const globalExtension = join(agentDir, "extensions", `native-custom-${fixture.suffix}`);
  const brokenExtension = join(agentDir, "extensions", `native-broken-${fixture.suffix}`);
  const projectExtension = join(privateProject, ".easyresearch", "extensions", `native-private-${fixture.suffix}`);
  const loadedPath = join(privateProject, "extension-loaded.txt");
  const ownedSources: string[] = [];
  const sessions: RuntimeObservation[] = [];
  const closeStreams: Array<() => Promise<void>> = [];
  const events: Array<{ generation: number; toolsChanged?: boolean; runtimeChanged?: boolean }> = [];
  const inventory: Record<string, unknown> = {};
  let generation = 0;
  let toolInventoryEvents = 0;
  let bootId: string | undefined;
  let streamFailure: unknown;
  let primary: unknown;
  const json = <T>(path: string, body?: unknown, end = deadline) => requestSmokeJsonBeforeDeadline({
    url: base + path, deadline: end, label: `custom tools ${path}`,
    init: body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  }) as Promise<T>;
  const catalog = async (cwd?: string) => {
    const rows = await json<AgentDto[]>(`/api/agents${cwd ? `?${new URLSearchParams({ cwd })}` : ""}`);
    inventory[cwd ?? "global"] = rows.filter(agent => agent.name === "research-assistant" || Object.values(fixture.agents).includes(agent.name))
      .map(agent => ({ name: agent.name, tools: agent.effectiveTools.filter(name => Object.values(fixture.tools).includes(name) || name === fixture.missingTool),
        diagnostics: agent.toolDiagnostics ?? [] }));
    fixture.evidence.inventory = inventory;
    return rows;
  };
  const main = (agents: AgentDto[]) => {
    const agent = agents.find(agent => agent.name === "research-assistant");
    assert(agent, "Research Assistant missing from native catalog");
    return agent;
  };
  const waitFor = async (label: string, check: () => boolean | Promise<boolean>, end = deadline) => {
    fixture.evidence.phase = label;
    const until = Math.min(end, Date.now() + 45_000);
    while (Date.now() < until) {
      if (fixture.failure) throw fixture.failure;
      if (streamFailure) throw streamFailure;
      if (await check()) return;
      await new Promise(done => setTimeout(done, 25));
    }
    throw new Error(`Custom-tool smoke timed out: ${label}`);
  };
  const watch = async (path: string, observe: (event: Record<string, unknown>) => void) => {
    const response = await fetchSessionEventsBeforeDeadline({ url: base + path, deadline });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`Custom-tool SSE unavailable: ${path} (${response.status})`);
    }
    const reader = response.body.getReader();
    let stopping = false;
    const task = (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const part = await reader.read();
        if (part.done) { assert(stopping, `Custom-tool SSE ended: ${path}`); return; }
        buffer += decoder.decode(part.value, { stream: true });
        assert(buffer.length <= 4 * 1024 * 1024, "Custom-tool SSE exceeded its bounded frame buffer");
        const frames = buffer.split(/\r?\n\r?\n/u);
        buffer = frames.pop()!;
        for (const frame of frames) {
          const data = frame.split(/\r?\n/u).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          if (data) observe(JSON.parse(data));
        }
      }
    })().catch(error => { streamFailure ??= error; });
    closeStreams.push(async () => { stopping = true; await reader.cancel(); await task; });
  };
  const createSession = async (cwd: string) => {
    const created = await json<{ id: string }>("/api/sessions", { cwd });
    assert(created.id);
    const state = { id: created.id, applied: 0, snapshot: false };
    sessions.push(state);
    fixture.evidence.sessions = sessions;
    await watch(`/api/sessions/${state.id}/events`, event => {
      if (event.type === "snapshot") {
        state.snapshot = true;
        if (typeof event.runtimeConfigurationGeneration === "number") state.applied = event.runtimeConfigurationGeneration;
      }
      if (event.type === "runtime_configuration_applied" && typeof event.generation === "number") state.applied = Math.max(state.applied, event.generation);
    });
    await waitFor("initial owned runtime snapshot", () => state.snapshot && state.applied > 0);
    return state;
  };
  const snapshot = (session: RuntimeObservation) => json<SessionSnapshotDto>(`/api/sessions/${session.id}/snapshot`);
  const settled = async (session: RuntimeObservation, phase: string) => {
    await waitFor(`${phase} native result and settlement`, async () => {
      const current = await snapshot(session);
      return fixture.lanes.get(phase)!.complete && current.session.status === "ready" && !current.session.isStreaming
        && current.timeline.some(entry => entry.kind === "message" && entry.message.role === "assistant"
          && smokeAgentText(entry.message.content) === fixture.final(phase));
    });
  };
  const run = async (session: RuntimeObservation, phase: string, cwd: string) => {
    fixture.setCwd(phase, cwd);
    await json(`/api/sessions/${session.id}/messages`, { message: fixture.prompt(phase) });
    await settled(session, phase);
  };
  const appliedAfter = async (previous: number, session: RuntimeObservation) => {
    await waitFor("external write configuration event and idle runtime application",
      () => generation > previous && session.applied >= generation);
  };
  const publish = (directory: string, name: string, version: string, loaded?: string) => {
    mkdirSync(join(directory, ".."), { recursive: true });
    mkdirSync(directory); // Exclusive ownership; never replace a foreign fixture.
    ownedSources.push(directory);
    writeFileSync(join(directory, "helper.ts"), fixture.helperSource(version), { flag: "wx" });
    writeFileSync(join(directory, "index.ts"), fixture.extensionSource(name, loaded), { flag: "wx" });
  };
  try {
    assert.equal((await json<{ autoSessionTitle: boolean }>("/api/settings/session-title")).autoSessionTitle, false,
      "Native suite must disable automatic titles before custom-tool acceptance");
    for (const directory of [project, peer, privateProject]) {
      mkdirSync(directory);
      mkdirSync(join(directory, ".easyresearch"));
      writeFileSync(join(directory, ".easyresearch", "settings.json"), JSON.stringify({ compaction: { enabled: false } }), { flag: "wx" });
    }
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    for (const kind of ["empty", "optin"] as const) {
      const path = join(agentDir, "agents", `${fixture.agents[kind]}.md`);
      writeFileSync(path, [
        "---", `name: ${fixture.agents[kind]}`, "description: Isolated native custom-tool acceptance",
        `tools: ${JSON.stringify(kind === "empty" ? [] : [fixture.tools.global, fixture.missingTool])}`,
        "skills: []", "subagents: []", "---", `Execute only ${fixture.prompt(`child-${kind}`)} and return its exact final marker.`, "",
      ].join("\n"), { flag: "wx" });
      ownedSources.push(path);
    }
    await watch("/api/config/events", event => {
      assert.equal(event.type, "config.updated", "Unexpected custom-tool configuration diagnostic");
      assert(typeof event.bootId === "string" && typeof event.generation === "number");
      if (bootId) assert.equal(event.bootId, bootId, "Custom-tool acceptance unexpectedly restarted the daemon");
      bootId = event.bootId;
      generation = Math.max(generation, event.generation);
      if (event.toolsChanged === true) toolInventoryEvents++;
      events.push({ generation, toolsChanged: event.toolsChanged === true, runtimeChanged: event.runtimeChanged === true });
      if (events.length > 24) events.shift();
      fixture.evidence.configuration = events;
    });
    await waitFor("configuration subscription barrier", () => generation > 0);
    const active = await createSession(project);
    const other = await createSession(peer);
    assert(!main(await catalog(project)).effectiveTools.includes(fixture.tools.global));
    await run(active, "before", project);
    const createdBaseline = generation;
    const toolEventsBefore = toolInventoryEvents;
    // The daemon and both root AgentSessions exist before the first external TS write.
    publish(globalExtension, fixture.tools.global, "v1");
    await appliedAfter(createdBaseline, active);
    await waitFor("runtime-backed main and specialist inventory", async () => {
      const rows = await catalog(project);
      return main(rows).effectiveTools.includes(fixture.tools.global)
        && rows.find(agent => agent.name === fixture.agents.optin)?.effectiveTools.includes(fixture.tools.global) === true;
    });
    assert(toolInventoryEvents > toolEventsBefore, "Native registration did not invalidate Settings through configuration events");
    const rows = await catalog(project);
    assert(!rows.find(agent => agent.name === fixture.agents.empty)!.effectiveTools.includes(fixture.tools.global));
    assert(!rows.some(agent => agent.effectiveTools.includes(fixture.missingTool)));
    await run(active, "created", project);
    fixture.setCwd("child-empty", project);
    fixture.setCwd("child-optin", project);
    await run(active, "children", project);
    assert.equal(fixture.lanes.get("children")!.dispatches.length, 2, "Both specialist policies need real independent child sessions");

    const updatedBaseline = generation;
    writeFileSync(join(globalExtension, "helper.ts"), fixture.helperSource("v2"));
    await appliedAfter(updatedBaseline, active);
    await run(active, "updated", project);
    fixture.hold("busy");
    fixture.setCwd("busy", project);
    await json(`/api/sessions/${active.id}/messages`, { message: fixture.prompt("busy") });
    await waitFor("busy provider request admitted with v2", () => fixture.requestCount("busy") === 1);
    const held = await snapshot(active);
    assert(held.session.isStreaming);
    const busyBaseline = generation;
    writeFileSync(join(globalExtension, "helper.ts"), fixture.helperSource("v3"));
    await waitFor("new helper accepted during the held run", () => generation > busyBaseline);
    const pendingGeneration = generation;
    const stillBusy = await snapshot(active);
    assert(stillBusy.session.isStreaming);
    assert.equal(stillBusy.runtimeConfigurationGeneration, held.runtimeConfigurationGeneration,
      "Active root applied new extension code before whole-run settlement");
    fixture.release();
    await settled(active, "busy"); // Both tool execution AND its next provider schema must still be v2.
    await waitFor("new helper applied after settlement", () => active.applied >= pendingGeneration);
    await run(active, "settled", project);

    publish(projectExtension, fixture.tools.project, "project-v1", loadedPath);
    assert(!existsSync(loadedPath));
    assert(!main(await catalog(privateProject)).effectiveTools.includes(fixture.tools.project),
      "Unloaded extension was advertised from configuration alone");
    assert(!existsSync(loadedPath), "Settings evaluated an unowned project extension");
    const privateRuntime = await createSession(privateProject);
    await waitFor("owned project registration inventory", async () => main(await catalog(privateProject)).effectiveTools.includes(fixture.tools.project));
    assert(readFileSync(loadedPath, "utf8").includes("loaded\n"));
    for (const cwd of [undefined, project, peer]) assert(!main(await catalog(cwd)).effectiveTools.includes(fixture.tools.project), "Private tool leaked outside its exact cwd");
    await run(privateRuntime, "project", privateProject);
    await run(other, "other-cwd", peer);

    const brokenBaseline = generation;
    mkdirSync(brokenExtension);
    ownedSources.push(brokenExtension);
    const brokenPath = join(brokenExtension, "index.ts");
    writeFileSync(brokenPath, `export default function () { throw new Error(${JSON.stringify(fixture.privateError)}); }\n`, { flag: "wx" });
    await appliedAfter(brokenBaseline, active);
    const diagnosticRows = await catalog(project);
    const diagnostics = main(diagnosticRows).toolDiagnostics ?? [];
    assert(diagnostics.some(text => text.endsWith(brokenPath)), "Failed native extension load lacked its source path diagnostic");
    assert(diagnostics.every(text => !text.includes(fixture.privateError) && !text.includes("\n") && !text.includes("throw new Error")),
      "Arbitrary extension exception/source content escaped the safe diagnostic");
    assert(main(diagnosticRows).effectiveTools.includes(fixture.tools.global), "One bad extension hid a valid tool");
    await run(active, "malformed", project);
    const repairedBaseline = generation;
    writeFileSync(join(brokenExtension, "helper.ts"), fixture.helperSource("repaired-v1"), { flag: "wx" });
    writeFileSync(brokenPath, fixture.extensionSource(fixture.tools.repaired));
    await appliedAfter(repairedBaseline, active);
    await waitFor("repaired extension registration and diagnostic recovery", async () => {
      const agent = main(await catalog(project));
      return agent.effectiveTools.includes(fixture.tools.repaired) && !(agent.toolDiagnostics ?? []).some(text => text.endsWith(brokenPath));
    });
    await run(active, "repaired", project);
    const removedBaseline = generation;
    rmSync(globalExtension, { recursive: true, maxRetries: 10, retryDelay: 100 });
    await appliedAfter(removedBaseline, active);
    await waitFor("deleted tool removed from actual scoped/global catalogs", async () => {
      if (sessions.some(session => session.applied < generation)) return false;
      const catalogs = await Promise.all([undefined, project, peer, privateProject].map(cwd => catalog(cwd)));
      return catalogs.every(rows => !rows.some(agent => agent.effectiveTools.includes(fixture.tools.global)));
    });
    await run(active, "removed", project);
    for (const lane of fixture.lanes.values()) assert(lane.complete, `Unfinished custom-tool lane ${lane.name}`);
    fixture.evidence.phase = "accepted";
    const receipt = { requests: fixture.requests, sessions: sessions.map(session => session.id),
      childSessions: fixture.lanes.get("children")!.dispatches.map(dispatch => dispatch.sessionID),
      configGeneration: generation, inventoryEvents: toolInventoryEvents, tools: fixture.tools, busyRetainedGeneration: held.runtimeConfigurationGeneration,
      busyPendingGeneration: pendingGeneration, scope: "native extension loader via HTTP" };
    writeFileSync(join(root, "custom-tools-smoke.json"), JSON.stringify(receipt, null, 2));
    fixture.evidence.receipt = receipt;
    return receipt;
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    fixture.release();
    const failures: unknown[] = [];
    for (const close of closeStreams.reverse()) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    for (const session of sessions.reverse()) {
      try { await json(`/api/sessions/${session.id}/stop`, {}, Date.now() + 15_000); } catch (error) { failures.push(error); }
    }
    for (const path of ownedSources.reverse()) {
      try { rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (error) { failures.push(error); }
    }
    if (streamFailure) failures.push(streamFailure);
    if (failures.length) throw new AggregateError([...(primary ? [primary] : []), ...failures], "Custom-tool native acceptance/cleanup failed");
  }
}
