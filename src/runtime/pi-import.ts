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
 * Upstream 0.83.0 package entry re-exports only `ProjectTrustStore` and
 * `hasTrustRequiringProjectResources` from the trust manager; the entry
 * omits `getProjectTrustOptions`, and Bun resolves package subpaths only
 * through the `exports` whitelist. Load the internal module by file URL so
 * trust options stay native (labels/updates semantics unchanged).
 */
/** Minimal structural types for the upstream trust manager internal module. */
export interface PiTrustOption {
	label: string;
	trusted: boolean;
	updates: Array<{ path: string; decision: boolean | null }>;
	savedPath?: string;
}

export interface PiTrustManager {
	getProjectTrustOptions: (
		cwd: string,
		options?: { includeSessionOnly?: boolean },
	) => PiTrustOption[];
}

const trustManagerUrl = fileURLToPath(
	new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/core/trust-manager.js", import.meta.url),
);

export async function importPiTrustManager(): Promise<PiTrustManager> {
	return import(trustManagerUrl) as Promise<PiTrustManager>;
}

/**
 * Synchronous access to the LazyResearch agent dir. Callers that run before
 * `importPi()` has bootstrapped identity fall back to the exact `~/.lazyresearch`
 * layout (never `.pi`).
 */
export function getAgentDir(): string {
	if (cachedPi) return cachedPi.getAgentDir();
	return process.env.LAZYRESEARCH_CODING_AGENT_DIR || join(homedir(), ".lazyresearch", "agent");
}

export function getAgentsDir(): string {
	return join(getAgentDir(), "agents");
}

export function getSkillsDir(): string {
	return join(getAgentDir(), "skills");
}