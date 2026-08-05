import { importPi } from "./pi-import";
import { bootstrapBundledResources } from "../bootstrap/resources";
import { assertNoUserExtensions } from "./extensions-guard";

export async function runNativeTui(): Promise<void> {
  const { main } = await importPi();
  await bootstrapBundledResources();
  assertNoUserExtensions({ cwd: process.cwd() });
  const { createOrchestratorExtension } = await import("./orchestrator-extension");
  await main([], { extensionFactories: [createOrchestratorExtension()] });
}
