import assert from "node:assert/strict";
import { join } from "node:path";
import type { MemoryComparison, MemoryEntry, MemoryRecord, MemoryRef, MemoryResult, MemoryVerification } from "../src/research-memory/types";
import { nativeLocalShellTool } from "../src/runtime/platform-tools";
import { MemorySmokeLane, memorySmokeText, type MemorySmokeRequest, type MemorySmokeStep } from "./smoke-research-memory-support";

const METHOD = "Read the source unit before comparing a reported value.";
const STRATEGY = "Choose the first probe whose evidence family has not yet been covered.";
const PROBES = [
  { id: "unit-a", family: "unit" }, { id: "unit-b", family: "unit" }, { id: "boundary", family: "boundary" },
];
// A fixed two-probe fixture measures deterministic scheduling mechanics only.
function compareStrategies(): MemoryComparison {
  const baseline = PROBES.slice(0, 2);
  const candidate = PROBES.filter((probe, index) => PROBES.findIndex(other => other.family === probe.family) === index).slice(0, 2);
  return { baseline: new Set(baseline.map(probe => probe.family)).size, candidate: new Set(candidate.map(probe => probe.family)).size,
    direction: "maximize", baselineBudget: 2, candidateBudget: 2, budgetUnit: "fixture probes",
    protocol: "Same fixture, evaluator and two-probe budget; score distinct evidence families. Mechanism proof only.", heldOutTask: "held-out-fixture-family-coverage" };
}

export function createResearchMemorySmoke(options: { runId: string; project: string; agentDir: string; platform: NodeJS.Platform }) {
  const prefix = `RSI_SMOKE:${options.runId}:`;
  const records = new Map<string, MemoryRecord>();
  const denials: string[] = [];
  const lanes = new Map<string, MemorySmokeLane>();
  const comparison = compareStrategies();
  const rootIds = new Map<string, string>();
  let requests = 0;
  let failure: unknown;
  const paths = {
    source: "rsi-method-source.md", proof: "rsi-method-verification.md", strategy: "rsi-strategy-source.md",
    strategyProof: "rsi-strategy-verification.md", probes: "rsi-probes.json", next: "rsi-next-round.md",
  };
  const stamp = new Date().toISOString().replace(/[-:TZ.]/gu, "");
  const handoff = (lane: string) => `handoffs/search-${stamp}-${lane}.md`;
  const record = (key: string): MemoryRecord => { const value = records.get(key); assert(value, `missing observed ${key}`); return value; };
  const ref = (key: string): MemoryRef => { const { scope, id, revision } = record(key); return { scope, id, revision }; };
  const target = (key: string) => { const { scope, id, revision } = ref(key); return { scope, id, expectedRevision: revision }; };
  const parse = (text: string): MemoryResult => JSON.parse(text) as MemoryResult;
  const remember = (key: string, inspect: (value: MemoryRecord) => void = () => {}) => (text: string) => {
    const value = parse(text).record;
    assert(value && value.scope === "project" && value.schemaVersion === 1, `${key} invalid tool snapshot`);
    assert(value.actor.cwd === options.project && value.actor.sessionId && value.actor.model === "smoke/smoke-model", `${key} invalid runtime provenance`);
    inspect(value);
    records.set(key, value);
  };
  const memory = (args: () => unknown, accept: (text: string) => void): MemorySmokeStep => ({ name: "research-memory", args, accept });
  const deny = (args: () => unknown, errorCode: string): MemorySmokeStep => ({ name: "research-memory", args, errorCode, accept: () => { denials.push(errorCode); } });
  const write = (path: string, content: () => string): MemorySmokeStep => ({ name: "write", args: () => ({ path, content: content() }),
    accept: text => assert(text.includes("Successfully wrote"), `write failed: ${text}`) });
  const read = (path: string, accept: (text: string) => void): MemorySmokeStep => ({ name: "read", args: () => ({ path }), accept });
  const skill = () => read(join(options.agentDir, "bundled", "skills", "research-experience", "SKILL.md"), text => assert(text.includes("research-experience"), "experience Skill read failed"));
  const verification = (path: string, strategy = false, fail = false): MemoryVerification => ({
    outcome: fail ? "fail" : "pass", summary: fail ? "Fixture replacement intentionally failed replay; retain incumbent." : "Deterministic independent mechanism replay.",
    evidencePaths: [path], checks: [
      { name: "replay", kind: "replay", outcome: fail ? "fail" : "pass", details: "Replayed the bounded fixture." },
      { name: "retention", kind: "regression", outcome: "pass", details: "Incumbent unit check retained." },
      ...(strategy ? [{ name: "selection", kind: "mechanism" as const, outcome: "pass" as const, details: "Distinct-family selection used the same two-probe budget." }] : []),
    ], ...(strategy ? { comparison } : {}),
  });
  const entry = (kind: "method" | "strategy", evidence: string, basedOn: MemoryRef[] = []): MemoryEntry => ({
    kind, title: `Native fixture ${kind}`, roles: ["search", "research-assistant"], tags: ["native-rsi"],
    conditions: "Only this deterministic smoke fixture; no scientific efficacy claim.", procedure: kind === "method" ? METHOD : STRATEGY,
    limitations: "Fixed-budget fake provider tests mechanism, not model quality.", rationale: "Retain evidence-grounded decisions across fresh sessions.",
    evidencePaths: [evidence], basedOn,
  });
  const emptyRecall = (text: string) => { const value = parse(text); assert.deepEqual(value.memories, []); assert.deepEqual(value.diagnostics, []); assert.equal(value.truncated, false); };
  const exactActive = (key: string, expected: string) => remember(key, value => {
    assert.deepEqual(value.active, record(expected).active, `${key} changed accepted content`);
    assert.equal(value.id, record(expected).id);
    assert.equal(value.revision, record(expected).revision);
  });
  const final = (lane: string) => `complete\nRSI_DONE:${options.runId}:${lane}\nArtifacts: ${handoff(lane)}\nGaps: none\nNext action: caller acceptance`;
  const finishChild = (lane: string, evidence: () => unknown): MemorySmokeStep => write(handoff(lane), () => `${final(lane)}\n${JSON.stringify(evidence())}\n`);
  const dispatch = (lane: string, refs: () => unknown = () => []): MemorySmokeStep => ({ name: "subagent",
    args: () => ({ agent: "search", task: `${prefix}${lane}\nFrozen inputs: ${JSON.stringify(refs())}` }), terminal: () => {
      assert(lanes.get(lane)?.complete, `${lane} terminal arrived before observed tool results`);
      return final(lane);
    } });
  const activated = (key: string, verified: string, root: string) => remember(key, value => {
    assert(value.active && !value.pending && !value.retired);
    assert.equal(value.active.verification?.outcome, "pass");
    assert.deepEqual(value.active, record(verified).pending);
    assert.equal(value.actor.agent, "research-assistant");
    rootIds.set(root, value.actor.sessionId!);
  });
  const verified = (key: string, proposed: string) => remember(key, value => {
    assert(value.pending?.verification);
    assert.equal(value.pending.verification.proposalRevision, record(proposed).pending?.proposalRevision);
    assert.notEqual(value.pending.author.sessionId, value.pending.verification.actor.sessionId, "verifier reused author session");
    assert.equal(value.pending.verification.actor.agent, "search");
  });

  lanes.set("author", new MemorySmokeLane("author", [
    skill(),
    write(paths.source, () => "Fixture: 1000 ms = 1 s. Reading units retains equality; raw numeric comparison fails.\n"),
    memory(() => ({ action: "propose", entry: entry("method", paths.source) }), remember("proposal", value => {
      assert(!value.active && value.pending); assert.equal(value.pending.author.agent, "search");
    })),
    memory(() => ({ action: "recall", query: "native-rsi" }), emptyRecall),
    deny(() => ({ action: "verify", ...target("proposal"), verification: verification(paths.source) }), "FORBIDDEN"),
    deny(() => ({ action: "activate", ...target("proposal") }), "FORBIDDEN"),
    finishChild("author", () => ({ proposal: ref("proposal"), inspected: [paths.source] })),
  ], () => final("author")));

  lanes.set("verifier", new MemorySmokeLane("verifier", [
    skill(),
    memory(() => ({ action: "get", ...ref("proposal") }), remember("verifierRead", value => assert.deepEqual(value.pending, record("proposal").pending))),
    read(paths.source, text => assert(text.includes("1000 ms = 1 s"))),
    write(paths.proof, () => "Independent fixture replay: normalized units equal. Regression: equal-unit values retain equality.\n"),
    memory(() => ({ action: "verify", ...target("proposal"), verification: verification(paths.proof) }), verified("verified", "proposal")),
    write(paths.probes, () => JSON.stringify(PROBES)),
    write(paths.strategy, () => JSON.stringify({ comparison, probes: PROBES, limit: "mechanism only" })),
    finishChild("verifier", () => ({ verified: ref("verified"), inspected: Object.values(paths).slice(0, 3) })),
  ], () => final("verifier")));

  lanes.set("strategyVerifier", new MemorySmokeLane("strategyVerifier", [
    skill(),
    memory(() => ({ action: "get", ...ref("strategyProposal") }), remember("strategyVerifierRead", value => assert.equal(value.pending?.entry.procedure, STRATEGY))),
    read(paths.strategy, text => assert.deepEqual(JSON.parse(text).comparison, comparison)),
    read(paths.probes, text => assert.deepEqual(JSON.parse(text), PROBES)),
    write(paths.strategyProof, () => JSON.stringify({ baseline: ["unit-a", "unit-b"], candidate: ["unit-a", "boundary"], comparison })),
    memory(() => ({ action: "verify", ...target("strategyProposal"), verification: verification(paths.strategyProof, true) }), verified("strategyVerified", "strategyProposal")),
    finishChild("strategyVerifier", () => ({ verified: ref("strategyVerified"), inspected: [paths.strategy, paths.probes, paths.strategyProof] })),
  ], () => final("strategyVerifier")));

  lanes.set("learn", new MemorySmokeLane("learn", [
    memory(() => ({ action: "recall", query: "native-rsi" }), emptyRecall),
    dispatch("author"), dispatch("verifier", () => ref("proposal")),
    memory(() => ({ action: "activate", ...target("verified") }), activated("method", "verified", "learn")),
    memory(() => ({ action: "propose", entry: entry("strategy", paths.strategy, [ref("method")]) }), remember("strategyProposal", value => {
      assert.equal(value.pending?.author.agent, "research-assistant"); assert.equal(value.actor.sessionId, rootIds.get("learn"));
    })),
    deny(() => ({ action: "verify", ...target("strategyProposal"), verification: verification(paths.strategy, true) }), "FORBIDDEN"),
    dispatch("strategyVerifier", () => ref("strategyProposal")),
    memory(() => ({ action: "activate", ...target("strategyVerified") }), activated("strategy", "strategyVerified", "learn")),
  ], () => `RSI_ROOT_DONE:${options.runId}:learn`));

  let selectedProbe: typeof PROBES[number] | undefined;
  lanes.set("nextRound", new MemorySmokeLane("nextRound", [
    skill(),
    memory(() => ({ action: "get", ...ref("method") }), exactActive("nextMethodRead", "method")),
    memory(() => ({ action: "get", ...ref("strategy") }), exactActive("nextStrategyRead", "strategy")),
    read(paths.probes, text => {
      assert.equal(record("nextStrategyRead").active?.entry.procedure, STRATEGY);
      const probes = JSON.parse(text) as typeof PROBES;
      selectedProbe = probes.find(probe => probe.family !== "unit");
      assert.equal(selectedProbe?.id, "boundary", "accepted strategy did not drive the next-round selection");
    }),
    write(paths.next, () => JSON.stringify({ used: [ref("nextMethodRead"), ref("nextStrategyRead")], selectedProbe,
      decision: "Selected the uncovered boundary family after unit coverage.", replay: "fail", limit: "deliberate negative replacement fixture" })),
    memory(() => ({ action: "propose", ...target("method"), entry: { ...entry("method", paths.next, [ref("method"), ref("strategy")]), procedure: "Deliberately failing boundary replacement." } }), remember("nextRound", value => {
      assert.deepEqual(value.active, record("method").active);
      assert.deepEqual(value.pending?.entry.basedOn, [ref("method"), ref("strategy")]);
      assert.notEqual(value.pending?.author.sessionId, record("method").active?.author.sessionId);
    })),
    memory(() => ({ action: "recall", kind: "method" }), text => {
      const memories = parse(text).memories; assert.equal(memories?.length, 1);
      assert.equal(memories?.[0]?.procedure, METHOD); assert.deepEqual(memories?.[0]?.ref, ref("nextRound"));
    }),
    finishChild("nextRound", () => ({ used: [ref("method"), ref("strategy")], proposal: ref("nextRound"), selectedProbe, inspected: [paths.probes, paths.next] })),
  ], () => final("nextRound")));

  lanes.set("reuse", new MemorySmokeLane("reuse", [
    memory(() => ({ action: "recall", query: "native-rsi" }), text => {
      const result = parse(text); assert.deepEqual(result.diagnostics, []); assert.equal(result.truncated, false);
      assert.deepEqual(new Set(result.memories?.map(item => item.ref)), new Set([ref("method"), ref("strategy")]));
    }),
    memory(() => ({ action: "get", ...ref("method") }), exactActive("freshMethod", "method")),
    memory(() => ({ action: "get", ...ref("strategy") }), exactActive("freshStrategy", "strategy")),
    dispatch("nextRound", () => [ref("freshMethod"), ref("freshStrategy")]),
    read(paths.next, text => { const proof = JSON.parse(text); assert.deepEqual(proof.used, [ref("method"), ref("strategy")]); assert.equal(proof.replay, "fail"); }),
    memory(() => ({ action: "verify", ...target("nextRound"), verification: verification(paths.next, false, true) }), remember("failed", value => {
      assert.equal(value.pending?.verification?.outcome, "fail");
      assert.notEqual(value.actor.sessionId, rootIds.get("learn"), "fresh task reused the first root session");
      rootIds.set("reuse", value.actor.sessionId!);
    })),
    deny(() => ({ action: "activate", ...target("failed") }), "EVIDENCE"),
    memory(() => ({ action: "reject", ...target("failed"), reason: "Failed deterministic replacement replay." }), remember("rejected", value => {
      assert(!value.pending); assert.deepEqual(value.active, record("method").active);
    })),
    memory(() => ({ action: "get", ...ref("method") }), remember("historical", value => {
      assert(value.historical); assert.deepEqual(value.active, record("method").active);
    })),
    memory(() => ({ action: "retire", ...target("rejected"), reason: "Exercise reversible retirement." }), remember("retired", value => assert(value.retired))),
    memory(() => ({ action: "recall", kind: "method" }), emptyRecall),
    memory(() => ({ action: "rollback", ...target("retired"), revision: record("method").revision, reason: "Restore the exact accepted incumbent." }), remember("restored", value => {
      assert(!value.pending && !value.retired); assert.deepEqual(value.active, record("method").active); assert(value.revision > record("retired").revision);
    })),
    memory(() => ({ action: "recall", kind: "method" }), text => assert.deepEqual(parse(text).memories?.map(item => item.ref), [ref("restored")])),
  ], () => `RSI_ROOT_DONE:${options.runId}:reuse`));

  const laneFor = (request: MemorySmokeRequest) => {
    for (const message of request.messages ?? []) {
      if (message.role !== "user") continue;
      const text = memorySmokeText(message.content);
      const at = text.indexOf(prefix);
      if (at >= 0) return text.slice(at + prefix.length).split(/\s/u)[0];
    }
    return undefined;
  };
  return {
    lanes, laneFor,
    prompt: (lane: string) => `${prefix}${lane}`,
    select(request: MemorySmokeRequest) {
      requests++;
      try {
      const name = laneFor(request); const lane = name && lanes.get(name);
      assert(lane, "unknown RSI provider lane");
      const tools = request.tools?.map(tool => tool.function?.name) ?? [];
      assert.equal(tools.filter(tool => tool === "research-memory").length, 1);
      assert.deepEqual(tools.filter(tool => tool === "bash" || tool === "powershell"), [nativeLocalShellTool(options.platform)]);
      const root = name === "learn" || name === "reuse";
      assert.equal(tools.includes("subagent"), root, "Search leaf boundary");
      assert.equal(tools.includes("ssh-bash"), root, "Search SSH boundary");
      const system = request.messages?.filter(message => message.role === "system").map(message => memorySmokeText(message.content)).join("\n") ?? "";
      assert(system.includes("<name>research-experience</name>"), `${name} did not receive experience Skill`);
      if (root) assert(system.includes("<name>recursive-self-improvement</name>"), "root missing RSI Skill");
      return lane.select(request);
      } catch (error) { failure = error; throw error; }
    },
    get requests() { return requests; },
    get failure() { return failure; },
    report() {
      return { complete: [...lanes.values()].every(lane => lane.complete), method: record("method"), strategy: record("strategy"),
        strategyRef: ref("strategy"), nextRound: record("nextRound"), restored: record("restored"), denials: [...denials], comparison,
        rootSessions: Object.fromEntries(rootIds), selectedProbe, calls: Object.fromEntries([...lanes].map(([name, lane]) => [name, lane.calls])) };
    },
  };
}
