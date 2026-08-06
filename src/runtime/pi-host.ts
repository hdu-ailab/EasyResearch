import { importPi } from "./pi-import";
import { bootstrapBundledResources } from "../bootstrap/resources";
import { assertNoUserExtensions } from "./extensions-guard";

/** Pi's documented switch for the automatic version update check. */
export const VERSION_CHECK_ENV = "PI_SKIP_VERSION_CHECK";

/**
 * ADR-023: LazyResearch is a rebranded host distribution; Pi's "new version
 * available" notification would point at the upstream package and is noise.
 * `PI_SKIP_VERSION_CHECK` is Pi's documented env switch (.docs/pi/settings.md);
 * `PI_OFFLINE` is deliberately not used — it would also disable the model
 * catalog refresh needed for first runs.
 */
export function disableVersionUpdateCheck(): void {
  process.env[VERSION_CHECK_ENV] = "1";
}

export async function runNativeTui(): Promise<void> {
  disableVersionUpdateCheck();
  const { main } = await importPi();
  await bootstrapBundledResources();
  assertNoUserExtensions({ cwd: process.cwd() });
  const { createOrchestratorExtension } = await import("./orchestrator-extension");
  await main([], { extensionFactories: [createOrchestratorExtension()] });
}
