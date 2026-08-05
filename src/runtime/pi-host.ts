import { importPi } from "./pi-import";
import { bootstrapBundledResources } from "../bootstrap/resources";

export async function runNativeTui(): Promise<void> {
  const { main } = await importPi();
  await bootstrapBundledResources();
  const { createOrchestratorExtension } = await import("./orchestrator-extension");
  await main([], { extensionFactories: [createOrchestratorExtension()] });
}