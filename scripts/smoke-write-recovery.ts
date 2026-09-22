import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemorySmokeLane, memorySmokeText, type MemorySmokeRequest, type MemorySmokeStep } from "./smoke-research-memory-support";
import { requestSmokeJsonBeforeDeadline } from "./smoke-release-support";
import type { SessionSnapshotDto } from "../src/web/contracts";

/** Reuses the deterministic native provider; every next step requires a real result. */
export function createWriteRecoverySmoke(runId: string) {
  const prefix = `WRITE_RECOVERY:${runId}:`;
  const lanes = new Map<string, MemorySmokeLane>();
  const paths = (name: string) => [`native-write-${name}-01.md`, `native-write-${name}-02.md`];
  const sections = ["# Confirmed first section\n", "## Recovered second section\n"];
  const prompt = (name: string) => `${prefix}${name}`;
  const final = (name: string) => `${prefix}${name}:complete`;
  const makeSteps = (name: string): MemorySmokeStep[] => [
    { name: "write", args: () => ({ path: paths(name)[0], content: sections[0] }), accept: text => assert(text.includes("Successfully wrote")) },
    { name: "write", args: () => ({ path: paths(name)[1] }), errorCode: 'Validation failed for tool "write"',
      accept: text => {
        assert(text.includes("Write recovery:"), "compiled model context lost write-recovery advice");
        assert(text.includes("smaller section") && text.includes("overwrites"), "recovery must explain incremental writes and overwrite semantics");
      } },
    { name: "write", args: () => ({ path: paths(name)[1], content: sections[1] }), accept: text => assert(text.includes("Successfully wrote")) },
  ];
  lanes.set("child", new MemorySmokeLane("write_child", makeSteps("child"), () => final("child")));
  lanes.set("root", new MemorySmokeLane("write_root", [
    ...makeSteps("root"),
    { name: "subagent", args: () => ({ agent: "search", task: prompt("child") }), terminal: () => {
      assert(lanes.get("child")!.complete);
      return final("child");
    } },
  ], () => final("root")));
  const laneFor = (request: MemorySmokeRequest) => {
    for (const message of request.messages ?? []) {
      if (message.role !== "user") continue;
      const text = memorySmokeText(message.content);
      const at = text.indexOf(prefix);
      if (at >= 0) return lanes.get(text.slice(at + prefix.length).split(/\s/u)[0]!);
    }
    return undefined;
  };
  let failure: unknown;
  let requests = 0;
  return {
    prompt, final, laneFor, paths, sections, lanes,
    get failure() { return failure; },
    get requests() { return requests; },
    select(request: MemorySmokeRequest) {
      requests++;
      try { const lane = laneFor(request); assert(lane); return lane.select(request); }
      catch (error) { failure = error; throw error; }
    },
  };
}

export async function runWriteRecoverySmoke(options: {
  base: string; project: string; deadline: number; scenario: ReturnType<typeof createWriteRecoverySmoke>;
}): Promise<void> {
  const { base, project, deadline, scenario } = options;
  const json = (path: string, init?: RequestInit) => requestSmokeJsonBeforeDeadline({ url: `${base}${path}`, deadline, label: `write-recovery ${path}`, init });
  const post = (path: string, body: unknown) => json(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const created = await post("/api/sessions", { cwd: project }) as { id: string };
  assert(created.id);
  try {
    await post(`/api/sessions/${created.id}/messages`, { message: scenario.prompt("root") });
    for (;;) {
      if (scenario.failure) throw scenario.failure;
      assert(Date.now() < deadline, "compiled write recovery did not settle before deadline");
      const snapshot = await json(`/api/sessions/${created.id}/snapshot`) as SessionSnapshotDto;
      const finished = snapshot.timeline.some(entry => entry.kind === "message" && entry.message.role === "assistant"
        && memorySmokeText(entry.message.content) === scenario.final("root"));
      if (scenario.lanes.get("root")!.complete && snapshot.session.status === "ready" && finished) {
        assert.equal(snapshot.session.isStreaming, false);
        const failed = snapshot.timeline.filter(entry => entry.kind === "message" && entry.message.role === "toolResult" && entry.message.isError);
        assert.equal(failed.length, 1, "native failed write must remain an error in history");
        assert(snapshot.timeline.some(entry => entry.kind === "subagent-completion" && entry.outcomes.some(outcome => outcome.status === "complete" && outcome.text === scenario.final("child"))), "missing child recovery handoff");
        for (const name of ["root", "child"]) {
          scenario.paths(name).forEach((path, index) => assert.equal(readFileSync(join(project, path), "utf8"), scenario.sections[index]));
        }
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  } finally {
    await requestSmokeJsonBeforeDeadline({ url: `${base}/api/sessions/${created.id}/stop`, deadline: Date.now() + 15_000,
      label: "write-recovery cleanup", init: { method: "POST" } });
  }
}
