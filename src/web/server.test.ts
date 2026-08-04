import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_CONFIG_ROOT } from "../config/paths";
import { routeRequest } from "./routes";

describe("web routes", () => {
  let dir: string;
  let webuiDist: string;
  const realEnv = process.env[ENV_CONFIG_ROOT];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lazy-web-"));
    webuiDist = mkdtempSync(join(tmpdir(), "lazy-webui-dist-"));
    process.env[ENV_CONFIG_ROOT] = dir;
    writeFileSync(join(webuiDist, "index.html"), "<div id=\"root\"></div>", "utf-8");
  });

  afterEach(() => {
    if (realEnv === undefined) delete process.env[ENV_CONFIG_ROOT];
    else process.env[ENV_CONFIG_ROOT] = realEnv;
    rmSync(dir, { recursive: true, force: true });
    rmSync(webuiDist, { recursive: true, force: true });
  });

  it("returns status with empty sessions", async () => {
    const res = await routeRequest(new Request("http://localhost/api/status"), webuiDist);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: unknown[]; configRoot: string };
    expect(body.sessions).toEqual([]);
    expect(body.configRoot).toBe(dir);
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
