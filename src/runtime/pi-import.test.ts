import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { importPi } from "./pi-import";

const originalLazyPaperDir = process.env.LAZYPAPER_CODING_AGENT_DIR;
const originalPiDir = process.env.PI_CODING_AGENT_DIR;
const tempDirs: string[] = [];

afterEach(() => {
	if (originalLazyPaperDir === undefined) delete process.env.LAZYPAPER_CODING_AGENT_DIR;
	else process.env.LAZYPAPER_CODING_AGENT_DIR = originalLazyPaperDir;
	if (originalPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalPiDir;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("LazyPaper native identity", () => {
	it("uses the LazyPaper agent override and ignores Pi's override", async () => {
		const { getAgentDir } = await importPi();
		const lazyDir = mkdtempSync(join(tmpdir(), "lazypaper-agent-"));
		const piDir = mkdtempSync(join(tmpdir(), "pi-agent-"));
		tempDirs.push(lazyDir, piDir);
		process.env.LAZYPAPER_CODING_AGENT_DIR = lazyDir;
		process.env.PI_CODING_AGENT_DIR = piDir;

		expect(getAgentDir()).toBe(lazyDir);
	});

	it("loads project settings from exact-cwd .lazypaper instead of .pi", async () => {
		const { SettingsManager } = await importPi();
		const cwd = mkdtempSync(join(tmpdir(), "lazypaper-project-"));
		const agentDir = mkdtempSync(join(tmpdir(), "lazypaper-global-"));
		tempDirs.push(cwd, agentDir);
		mkdirSync(join(cwd, ".lazypaper"), { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".lazypaper", "settings.json"), '{"defaultModel":"lazy-model"}');
		writeFileSync(join(cwd, ".pi", "settings.json"), '{"defaultModel":"pi-model"}');

		expect(SettingsManager.create(cwd, agentDir).getDefaultModel()).toBe("lazy-model");
	});
});