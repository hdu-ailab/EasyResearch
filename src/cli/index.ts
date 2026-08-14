#!/usr/bin/env bun
import { injectSkillVenvEnv } from "../runtime/venv-env";
import { runNativeTui } from "../runtime/pi-host";
import { runWeb } from "./commands/web";

export interface CliDependencies {
  runTui: () => Promise<void>;
  runWeb: () => Promise<void>;
}

export async function runCli(
  argv: string[],
  deps: CliDependencies = { runTui: runNativeTui, runWeb },
): Promise<number> {
  try {
    injectSkillVenvEnv();
    if (argv.length === 0) await deps.runTui();
    else if (argv.length === 1 && argv[0] === "web") await deps.runWeb();
    else {
      console.error("Usage: easyresearch\n       easyresearch web");
      return 1;
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) process.exit(await runCli(process.argv.slice(2)));