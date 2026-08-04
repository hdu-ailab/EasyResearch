import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROJECT_LOCAL_DIR, PROJECT_STATE_FILE, createProject, resolveProjectDir, runNew } from "./new";

describe("new command", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lazy-new-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves topic to a slug directory", () => {
    expect(resolveProjectDir("Diffusion Models 2026!", dir)).toBe(join(dir, "diffusion-models-2026"));
  });

  it("creates project with state file", () => {
    const project = createProject(dir, "test topic");
    const state = JSON.parse(readFileSync(join(dir, PROJECT_LOCAL_DIR, PROJECT_STATE_FILE), "utf-8"));
    expect(state.name).toBe(project.name);
    expect(state.topic).toBe("test topic");
    expect(state.stage).toBe("topics");
  });

  it("runNew returns dir and state", async () => {
    const { dir: d, state } = await runNew("My Paper", dir);
    expect(d).toBe(join(dir, "my-paper"));
    expect(state.topic).toBe("My Paper");
  });

  it("runNew rejects empty topic", async () => {
    await expect(runNew("   ", dir)).rejects.toThrow(/Usage/);
  });
});
