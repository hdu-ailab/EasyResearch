import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelBackgroundTask,
  getBackgroundTasks,
  getShellOutput,
  parseBackgroundOutputChanged,
  parseBackgroundTasks,
  parseBackgroundTasksChanged,
  parseShellOutput,
  promoteBackgroundTasks,
  replaceBackgroundOutputWatches,
} from "./background";

afterEach(() => vi.unstubAllGlobals());

describe("background task API", () => {
  it("reads byte-cursor output and independently revisions view-owned output watches", async () => {
    const output = {
      id: "shell/1",
      sessionID: "child",
      command: "train",
      startedAt: 1,
      status: "running",
      exitCode: null,
      output: "汉",
      cursor: 3,
      size: 3,
      reset: false,
      truncated: false,
    };
    const fetch = vi
      .fn()
      .mockImplementation(
        async (_url, init) =>
          new Response(JSON.stringify(init?.method === "PUT" ? { applied: true, revision: 7 } : output)),
      );
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    expect(await getShellOutput("root/a", "shell/1", undefined, signal)).toEqual(output);
    await getShellOutput("root/a", "shell/1", 3, signal);
    expect(fetch.mock.calls[0]![0]).toBe("/api/sessions/root%2Fa/background/shell%2F1/output?limit=65536");
    expect(fetch.mock.calls[1]![0]).toContain("cursor=3");
    expect(fetch.mock.calls[1]![1].signal).toBe(signal);
    await replaceBackgroundOutputWatches("root/a", "lease/b", 7, ["shell/1"]);
    const [url, init] = fetch.mock.calls[2]!;
    expect(url).toBe("/api/sessions/root%2Fa/background-output-watches/lease%2Fb");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ revision: 7, taskIds: ["shell/1"] });
    for (const patch of [
      { cursor: 4 },
      { size: -1 },
      { reset: "yes" },
      { output: "x".repeat(65537) },
      { status: "unknown" },
    ]) {
      expect(() => parseShellOutput({ ...output, ...patch })).toThrow();
    }
    expect(parseBackgroundOutputChanged({ type: "background_output_changed", taskId: "shell/1" })).toEqual({
      type: "background_output_changed",
      taskId: "shell/1",
    });
    expect(() => parseBackgroundOutputChanged({ type: "background_output_changed", taskId: "" })).toThrow();
  });
  const task = {
    id: "shell/1",
    kind: "shell",
    sessionID: "root",
    description: "Train",
    status: "running",
    blocking: true,
  };
  it("encodes opaque identities and sends each mutation once as JSON", async () => {
    const fetch = vi
      .fn()
      .mockImplementation(
        async (_url, init) => new Response(JSON.stringify(init?.method === "POST" ? { ok: true } : { tasks: [task] })),
      );
    vi.stubGlobal("fetch", fetch);
    expect(await getBackgroundTasks("root/a")).toEqual({ tasks: [task] });
    await promoteBackgroundTasks("root/a");
    await cancelBackgroundTask("root/a", "shell/1");
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "/api/sessions/root%2Fa/background",
      "/api/sessions/root%2Fa/background",
      "/api/sessions/root%2Fa/background/shell%2F1/cancel",
    ]);
    for (const [, init] of fetch.mock.calls.slice(1)) {
      expect(init.method).toBe("POST");
      expect(init.headers["Content-Type"]).toBe("application/json");
      expect(JSON.parse(init.body)).toEqual({});
    }
  });
  it("rejects malformed replacement lists atomically", () => {
    for (const patch of [{ sessionID: "" }, { status: "idle" }, { blocking: "false" }, { pid: -1 }, { command: {} }]) {
      expect(() => parseBackgroundTasks([task, { ...task, id: "second", ...patch }])).toThrow();
    }
    expect(() => parseBackgroundTasks([task, task])).toThrow();
    expect(parseBackgroundTasksChanged({ type: "background_tasks_changed", tasks: [] }).tasks).toEqual([]);
  });
  it("requires explicit mutation acceptance", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"ok":false}')));
    await expect(cancelBackgroundTask("root", "shell")).rejects.toThrow();
  });
});
