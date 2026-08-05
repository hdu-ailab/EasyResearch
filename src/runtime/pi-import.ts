import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let cachedPi: typeof import("@earendil-works/pi-coding-agent") | null = null;

export async function importPi(): Promise<typeof import("@earendil-works/pi-coding-agent")> {
	if (cachedPi) return cachedPi;
	const previous = process.env.PI_PACKAGE_DIR;
	process.env.PI_PACKAGE_DIR = packageRoot;
	try {
		cachedPi = await import("@earendil-works/pi-coding-agent");
		return cachedPi;
	} finally {
		if (previous === undefined) delete process.env.PI_PACKAGE_DIR;
		else process.env.PI_PACKAGE_DIR = previous;
	}
}

/**
 * Synchronous access to the LazyPaper agent dir. Callers that run before
 * `importPi()` has bootstrapped identity fall back to the exact `~/.lazypaper`
 * layout (never `.pi`).
 */
export function getAgentDir(): string {
	if (cachedPi) return cachedPi.getAgentDir();
	return process.env.LAZYPAPER_CODING_AGENT_DIR || join(homedir(), ".lazypaper", "agent");
}

export function getAgentsDir(): string {
	return join(getAgentDir(), "agents");
}

export function getSkillsDir(): string {
	return join(getAgentDir(), "skills");
}