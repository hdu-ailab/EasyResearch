import { afterEach, describe, expect, it } from "vitest";
import { createRouteHandler, type RouteHandler, type RouteServices } from "./routes";
import { UnknownSessionError } from "./active-sessions";

let handler: RouteHandler;
afterEach(async () => { await handler?.close?.(); });

function fixture() {
  const tasks = [{ id: "shell-a", sessionID: "root", kind: "shell", description: "build", status: "running", blocking: true }];
  handler = createRouteHandler({ registry: {
    async backgroundTasks(root: string) { if (root !== "root") throw new UnknownSessionError(); return tasks; },
    async promoteBackground(root: string) { if (root !== "root") throw new UnknownSessionError(); tasks[0]!.blocking = false; },
    async cancelBackground(root: string, id: string) {
      if (root !== "root" || id !== tasks[0]!.id) throw new UnknownSessionError();
      tasks[0]!.status = "cancelled";
    },
  } } as unknown as RouteServices);
  const request = (suffix = "", method = "GET", body?: unknown) => handler(new Request(
    `http://localhost/api/sessions/root/background${suffix}`,
    { method, ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) } : {}) },
  ));
  return { request, tasks };
}

describe("root-scoped background task routes", () => {
  it("lists, promotes and cancels a task without sending an Agent prompt", async () => {
    const { request, tasks } = fixture();
    expect(await (await request()).json()).toEqual({ tasks });
    expect((await request("", "POST")).status).toBe(200);
    expect(tasks[0]!.blocking).toBe(false);
    expect((await request("/shell-a/cancel", "POST")).status).toBe(200);
    expect(tasks[0]!.status).toBe("cancelled");
  });

  it("rejects unrelated ids and additional process/path inputs", async () => {
    const { request, tasks } = fixture();
    expect((await request("/foreign/cancel", "POST")).status).toBe(404);
    expect((await request("/shell-a/cancel", "POST", { pid: 1 })).status).toBe(400);
    expect(tasks[0]!.status).toBe("running");
  });
});
