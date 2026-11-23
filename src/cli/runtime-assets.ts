import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { bundledSourceRoot } from "../runtime/bundled-assets";

/** Pi's compiled asset getters resolve beside process.execPath. */
export function copyPiRuntimeAssets(agentDir: string, source = join(bundledSourceRoot(), "pi")): void {
  const binDir = join(agentDir, "bin");
  mkdirSync(binDir, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    cpSync(join(source, entry.name), join(binDir, entry.name), { recursive: entry.isDirectory(), force: true });
  }
}
