import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeFirstRunSetupEvidence } from "../runtime/first-run-setup-evidence";
import { injectSkillVenvEnv } from "../runtime/venv-env";
import {
  bundledSourceRoot,
  embeddedPackageVersion,
  materializeBundledIfNeeded,
  useExistingMaterializedBundle,
} from "../runtime/bundled-assets";
import { ensureSkillVenv, type SetupResult } from "../setup-venv";
import { renameSameNameToBak } from "../setup-resources";

export interface FirstRunOptions {
  log: (message: string) => void;
  setup?: (agentDir: string, log: (message: string) => void) => SetupResult | void;
  useExistingSetup?: (agentDir: string) => void;
  skipSetup?: boolean;
  writeEvidence?: (result: SetupResult) => void;
  injectVenv?: () => void;
}

export function isSkipSetupEnabled(): boolean {
  const value = process.env.EASYRESEARCH_SKIP_SETUP;
  return value === "1" || value === "true" || value === "yes";
}

export function performFirstRunSetup(
  agentDir: string,
  options: FirstRunOptions,
): SetupResult | void {
  const injectVenv = options.injectVenv ?? injectSkillVenvEnv;
  if (options.skipSetup ?? isSkipSetupEnabled()) {
    const useExistingSetup = options.useExistingSetup
      ?? ((root: string) => useExistingMaterializedBundle(root, embeddedPackageVersion()));
    useExistingSetup(agentDir);
    injectVenv();
    return;
  }

  const result = (options.setup ?? ensureFirstRunSetup)(agentDir, options.log);
  if (result !== undefined) {
    try {
      (options.writeEvidence ?? writeFirstRunSetupEvidence)(result);
    } catch (error) {
      options.log(
        `First-run setup evidence could not be written: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  injectVenv();
  return result;
}

/**
 * First-run bootstrap: materialize embedded bundled assets (compiled builds
 * only), create the skill Python venv with live progress, and migrate
 * same-name user agents/skills to current bundled versions. Resource
 * extraction is required; optional setup phases report failures independently.
 */
export function ensureFirstRunSetup(agentDir: string, log: (message: string) => void): SetupResult {
  const version = embeddedPackageVersion();
  materializeBundledIfNeeded(agentDir, version, log);
  let skillVenvResult: SetupResult;
  try {
    skillVenvResult = ensureSkillVenv(agentDir, { stream: true, log });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`Skill environment setup failed: ${reason}`);
    skillVenvResult = { venvDir: join(agentDir, "venv"), success: false, reason };
  }
  try {
    retireBundledResourcesOnce(agentDir, version, () => {
      const bundledRoot = bundledSourceRoot();
      const retired = renameSameNameToBak({
        agentDir,
        bundledAgentsDir: join(bundledRoot, "agents"),
        bundledSkillsDir: join(bundledRoot, "skills"),
        log,
      });
      const count = retired.entries.filter((entry) => entry.renamed).length;
      if (count > 0) log(`Retired ${count} same-name user resources to .bak backups`);
    });
  } catch (error) {
    log(`Bundled resource retirement failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return skillVenvResult;
}

export function retireBundledResourcesOnce(
  agentDir: string,
  version: string,
  retire: () => void,
): boolean {
  const marker = join(agentDir, ".easyresearch-resource-retirement-version");
  try {
    if (readFileSync(marker, "utf8") === version) return false;
  } catch {
    // Missing/unreadable marker means this version has not completed retirement.
  }
  retire();
  const temporary = `${marker}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, version);
  renameSync(temporary, marker);
  return true;
}
