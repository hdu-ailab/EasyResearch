import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { bundledSourceRoot, devSourceRoot, isEmbeddedBuild } from "./bundled-assets";

/**
 * Base directory pi uses to resolve its shipped assets (package.json, themes,
 * README). Source mode points at the repo root (pi's assets ship inside
 * node_modules); compiled binaries use the first-run materialized `pi`
 * directory.
 */
function piPackageRoot(): string {
  return isEmbeddedBuild() ? join(bundledSourceRoot(), "pi") : devSourceRoot();
}

let cachedPi: typeof import("@earendil-works/pi-coding-agent") | null = null;

export async function importPi(): Promise<typeof import("@earendil-works/pi-coding-agent")> {
	if (cachedPi) return cachedPi;
	const previous = process.env.PI_PACKAGE_DIR;
	process.env.PI_PACKAGE_DIR = piPackageRoot();
	try {
		cachedPi = await import("@earendil-works/pi-coding-agent");
		return cachedPi;
	} finally {
		if (previous === undefined) delete process.env.PI_PACKAGE_DIR;
		else process.env.PI_PACKAGE_DIR = previous;
	}
}

/**
 * Synchronous access to the EasyResearch agent dir. Callers that run before
 * `importPi()` has bootstrapped identity fall back to the exact `~/.easyresearch`
 * layout (never `.pi`).
 */
export function getAgentDir(): string {
	if (cachedPi) return cachedPi.getAgentDir();
	return process.env.EASYRESEARCH_CODING_AGENT_DIR || join(homedir(), ".easyresearch", "agent");
}

export function getAgentsDir(): string {
	return join(getAgentDir(), "agents");
}

export function getSkillsDir(): string {
	return join(getAgentDir(), "skills");
}
