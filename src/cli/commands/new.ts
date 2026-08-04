import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export interface ProjectState {
  name: string;
  topic: string;
  createdAt: string;
  stage: string;
}

export const PROJECT_STATE_FILE = "state.json";
export const PROJECT_LOCAL_DIR = ".lazyresearch";

export function createProject(rootDir: string, topic: string): ProjectState {
  const stateDir = join(rootDir, PROJECT_LOCAL_DIR);
  mkdirSync(stateDir, { recursive: true });
  const state: ProjectState = {
    name: basename(rootDir),
    topic,
    createdAt: new Date().toISOString(),
    stage: "topics",
  };
  writeFileSync(join(stateDir, PROJECT_STATE_FILE), JSON.stringify(state, null, 2), "utf-8");
  return state;
}

export function resolveProjectDir(topic: string, cwd: string = process.cwd()): string {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return resolve(cwd, slug || "paper");
}

export async function runNew(topic: string, cwd?: string): Promise<{ dir: string; state: ProjectState }> {
  if (!topic || !topic.trim()) {
    throw new Error("Usage: lazypaper new <topic>");
  }
  const dir = resolveProjectDir(topic.trim(), cwd);
  const state = createProject(dir, topic.trim());
  return { dir, state };
}
