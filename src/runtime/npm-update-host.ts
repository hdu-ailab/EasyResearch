import { realpathSync } from "node:fs";
import type { RuntimeLease } from "../cli/runtime-lease";
import { verifyNpmUpdateCandidate } from "../cli/npm-update-candidate";
import { discardNpmUpdateCandidate, reclaimNpmUpdateArtifacts } from "../cli/npm-update-artifact";
import { NpmUpdateController, type NpmUpdateCandidate } from "./npm-update";
import { inspectNpmInstallation, npmInstallArguments, npmManualCommand, resolveAssociatedNpm, type NpmProvenance } from "./npm-update-provenance";
import { runNpmUpdateProcess } from "./npm-update-process";
import { fetchNpmUpdateVersion } from "./npm-update-registry";
import type { EnvironmentMap } from "./network-policy";
import type { UpdateActionResult } from "./update-contract";

export interface NpmUpdateOwner {
  provenance?: NpmProvenance;
  reserve(): Promise<RuntimeLease>;
  activate(candidate: NpmUpdateCandidate, lease: RuntimeLease): void;
}

export function createNpmUpdateController(options: {
  owner: "cli" | "desktop";
  currentVersion: string;
  agentDir: string;
  environment: EnvironmentMap;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  lifecycle?: NpmUpdateOwner;
  busy(): Extract<UpdateActionResult, { code: string }>;
  beginShutdown(): void;
}): NpmUpdateController {
  const provenance = options.lifecycle?.provenance;
  let prefix: string | undefined;
  let reason = "Automatic npm update is unavailable: the original installation scope is unknown. Update through the installation method you used.";
  let available = false;
  if (provenance && options.owner === "cli") {
    try {
      prefix = inspectNpmInstallation(provenance, options.currentVersion).prefix;
      reason = "The captured Node/npm runtime is unavailable. Use the manual command for this installation prefix.";
      resolveAssociatedNpm(provenance);
      available = true;
    } catch { /* Show capability and scoped fallback without leaking filesystem errors. */ }
  }
  const environment = { ...options.environment };
  // The running daemon version remains unchanged until activation. A completed
  // owned npm mutation may already have advanced the package on disk, including
  // when later native verification fails or the ready candidate is cancelled.
  let installedVersion = options.currentVersion;
  return new NpmUpdateController({
    owner: options.owner, currentVersion: options.currentVersion,
    capability: () => ({ available, reason: available ? undefined : reason }),
    manualCommand: (version) => npmManualCommand(prefix, version, provenance?.platform ?? process.platform),
    latest: async (signal) => {
      await reclaimNpmUpdateArtifacts(options.agentDir);
      signal.throwIfAborted();
      return fetchNpmUpdateVersion(signal, { fetch: options.fetch });
    },
    reserve: () => {
      if (!available || !options.lifecycle) throw new Error("npm update ownership is unavailable.");
      return options.lifecycle.reserve();
    },
    install: async (version, signal) => {
      if (!provenance || !prefix) throw new Error("npm installation is unavailable.");
      try { inspectNpmInstallation(provenance, installedVersion); }
      catch (error) {
        // An exit-zero npm run can also leave the old package unchanged. Both
        // known versions retain the exact same canonical scope/identity checks.
        if (installedVersion === options.currentVersion) throw error;
        inspectNpmInstallation(provenance, options.currentVersion);
      }
      const runtime = resolveAssociatedNpm(provenance);
      const node = await runNpmUpdateProcess(runtime.node, ["-p", "JSON.stringify({execPath:process.execPath,node:process.versions.node})"], { environment, cwd: options.agentDir, signal, timeoutMs: 10_000 });
      if (node.code !== 0) throw new Error("Launcher Node is unavailable.");
      const identity = JSON.parse(node.stdout) as { execPath: string; node: string };
      if (realpathSync(identity.execPath) !== runtime.node || !/^\d+\.\d+\.\d+$/.test(identity.node)) throw new Error("Launcher Node identity changed.");
      const npm = await runNpmUpdateProcess(runtime.node, [runtime.npm, "--version"], { environment, cwd: options.agentDir, signal, timeoutMs: 10_000 });
      if (npm.code !== 0 || !/^\d+\.\d+\.\d+$/.test(npm.stdout.trim())) throw new Error("Associated npm is unavailable.");
      let settled = true;
      try {
        const installed = await runNpmUpdateProcess(runtime.node, [runtime.npm, ...npmInstallArguments(prefix, version)], { environment, cwd: options.agentDir, signal, timeoutMs: 10 * 60_000 });
        if (installed.code !== 0) throw new Error("npm installation failed. Check installation permissions.");
      } catch (error) {
        if (error && typeof error === "object" && "custodyUnresolved" in error && error.custodyUnresolved) settled = false;
        throw error;
      } finally {
        // npm may write the selected manifests before cancellation/nonzero exit.
        // Once its whole process scope has settled, disk identities (not the
        // process status or daemon version) determine the next repair admission.
        if (settled) {
          try { inspectNpmInstallation(provenance, version); installedVersion = version; }
          catch { /* Partial/foreign relationships remain fail-closed. */ }
        }
      }
    },
    verify: (version, signal) => {
      if (!provenance) throw new Error("npm installation is unavailable.");
      return verifyNpmUpdateCandidate(provenance, version, options.agentDir, signal, { environment });
    },
    discard: discardNpmUpdateCandidate,
    busy: options.busy, beginShutdown: options.beginShutdown,
    activate: (candidate, lease) => options.lifecycle!.activate(candidate, lease as RuntimeLease),
  });
}
