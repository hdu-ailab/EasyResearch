import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { routeRequest } from "./routes";

const AGENT_DIR_ENV = "LAZYRESEARCH_CODING_AGENT_DIR";

describe("web routes", () => {
  let dir: string;
  let webuiDist: string;
  const realAgentDirEnv = process.env[AGENT_DIR_ENV];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lazy-web-"));
    webuiDist = mkdtempSync(join(tmpdir(), "lazy-webui-dist-"));
    process.env[AGENT_DIR_ENV] = join(dir, "agent");
    writeFileSync(join(webuiDist, "index.html"), "<div id=\"root\"></div>", "utf-8");
  });

  afterEach(() => {
    if (realAgentDirEnv === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = realAgentDirEnv;
    rmSync(dir, { recursive: true, force: true });
    rmSync(webuiDist, { recursive: true, force: true });
  });

  it("returns status with empty sessions", async () => {
    const res = await routeRequest(new Request("http://localhost/api/status"), webuiDist);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: unknown[]; agentDir: string };
    expect(body.sessions).toEqual([]);
    expect(body.agentDir).toBe(join(dir, "agent"));
  });

  it("lists sessions from the default subdir layout (--<cwd>--/<file>.jsonl)", async () => {
    const sessionsDir = join(dir, "agent", "sessions", "--tmp-project--");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "20260804_110000_seed.jsonl"),
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "seed-001",
          timestamp: "2026-08-04T11:00:00.000Z",
          cwd: "/tmp/project",
        }),
        JSON.stringify({
          type: "message",
          id: "a1",
          timestamp: "2026-08-04T11:00:01.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "Write a paper on fault diagnosis" }],
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const res = await routeRequest(new Request("http://localhost/api/status"), webuiDist);
    const body = (await res.json()) as { sessions: { id: string; cwd: string; messageCount: number }[] };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]!.id).toBe("seed-001");
    expect(body.sessions[0]!.cwd).toBe("/tmp/project");
    expect(body.sessions[0]!.messageCount).toBe(1);
  });

  it("serves the webui index.html", async () => {
    const res = await routeRequest(new Request("http://localhost/"), webuiDist);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<div id=\"root\">");
  });

  it("404s unknown paths", async () => {
    const res = await routeRequest(new Request("http://localhost/nope"), webuiDist);
    expect(res.status).toBe(404);
  });

  it("streams SSE on /api/events", async () => {
    const res = await routeRequest(new Request("http://localhost/api/events"), webuiDist);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
  });
});
