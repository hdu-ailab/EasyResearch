#!/usr/bin/env bun
import { parseArgs } from "./args";
import { runNew } from "./commands/new";
import { runRun } from "./commands/run";
import { runWeb } from "./commands/web";

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);

  switch (parsed.command) {
    case "new":
      return await cmdNew(parsed.positionals);
    case "run":
      return await cmdRun(parsed);
    case "web":
      return await cmdWeb(parsed);
    case "help":
    default:
      printHelp();
      return 0;
  }
}

async function cmdNew(positionals: string[]): Promise<number> {
  try {
    const topic = positionals.join(" ").trim();
    const { dir, state } = await runNew(topic);
    console.log(`Created paper project: ${dir}`);
    console.log(`Topic: ${state.topic}`);
    console.log("Next: cd into it and run `lazypaper run`");
    return 0;
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    return 1;
  }
}

async function cmdRun(parsed: ReturnType<typeof parseArgs>): Promise<number> {
  try {
    const model = typeof parsed.flags.model === "string" ? parsed.flags.model : undefined;
    await runRun({ model });
    return 0;
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    return 1;
  }
}

async function cmdWeb(parsed: ReturnType<typeof parseArgs>): Promise<number> {
  try {
    const port = typeof parsed.flags.port === "string" ? Number(parsed.flags.port) : undefined;
    await runWeb({ port });
    return 0;
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    return 1;
  }
}

function printHelp(): void {
  console.log(
    [
      "lazypaper — automated academic paper writing",
      "",
      "Usage:",
      "  lazypaper new <topic>      Create a paper project workspace",
      "  lazypaper run [--model M]  Start the orchestrator session (terminal)",
      "  lazypaper web [--port N]   Start the Web panel",
      "",
      "Config root: ~/.lazyresearch (override with LAZYRESEARCH_CONFIG_DIR)",
    ].join("\n"),
  );
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
