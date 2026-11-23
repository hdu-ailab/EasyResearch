import { describe, expect, it } from "vitest";
import { BackgroundOwnerJournal, recoverBackgroundRoots } from "./root-recovery";
import { ExecutionClaims } from "./execution-claims";

function history(id: string, cwd = "/project") {
  const entries: unknown[] = [];
  return {
    id, cwd, path: `/sessions/${id}.jsonl`, entries,
    getSessionId: () => id,
    getSessionFile: () => `/sessions/${id}.jsonl`,
    getSessionName: () => undefined as string | undefined,
    getCwd: () => cwd,
    getEntries: () => entries,
    appendCustomEntry(type: string, data: unknown) { entries.push({ type: "custom", customType: type, data }); return String(entries.length); },
  };
}

describe("root background recovery inventory", () => {
  it("reopens only identity-verified roots with a durable execution or background owner", async () => {
    const claimed = history("claimed");
    const background = history("background");
    const idle = history("idle");
    const fork = history("fork");
    const child = history("child");
    child.getSessionName = () => "easyresearch:search";
    new ExecutionClaims({ ...claimed, getSessionFile: undefined }).start();
    new ExecutionClaims({ ...child, getSessionFile: undefined }).start();
    new BackgroundOwnerJournal(background).update(true);
    fork.entries.push(...claimed.entries);
    const all = [claimed, background, idle, fork, child];
    const opened: string[] = [];
    const result = await recoverBackgroundRoots({
      listAll: async () => all,
      inspect: (path) => all.find((item) => item.path === path)!,
      open: async (target) => { opened.push(target.sessionId); },
    });
    expect(opened).toEqual(["claimed", "background"]);
    expect(result.failed).toEqual([]);
  });

  it("keeps failures isolated and refuses changed native identities", async () => {
    const bad = history("bad");
    const good = history("good");
    new ExecutionClaims({ ...bad, getSessionFile: undefined }).start();
    new ExecutionClaims({ ...good, getSessionFile: undefined }).start();
    const opened: string[] = [];
    const result = await recoverBackgroundRoots({
      listAll: async () => [bad, good],
      inspect: (path) => path === bad.path ? { ...bad, getCwd: () => "/foreign" } : good,
      open: async ({ sessionId }) => { opened.push(sessionId); },
    });
    expect(opened).toEqual(["good"]);
    expect(result.failed).toEqual(["bad"]);
  });

  it("writes only owner transitions and never restores a cancelled owner", async () => {
    const root = history("root");
    const owner = new BackgroundOwnerJournal(root);
    owner.update(true);
    owner.update(true);
    owner.update(false);
    expect(root.entries).toHaveLength(2);
    const result = await recoverBackgroundRoots({ listAll: async () => [root], inspect: () => root,
      open: async () => { throw new Error("Should not reopen cancelled work"); } });
    expect(result).toEqual({ recovered: [], failed: [] });
  });
});
