import { homedir } from "node:os";
import type { ProjectTrustStore, ProjectTrustUpdate } from "@earendil-works/pi-coding-agent";

export type DefaultProjectTrustValue = "ask" | "always" | "never";

export interface TrustInspection {
  required: boolean;
  trusted?: boolean;
  options: Array<{ label: string; trusted: boolean; savesDecision: boolean }>;
}

export interface AppliedTrustDecision {
  trusted: boolean;
  projectTrustOverride: boolean;
}

export interface TrustStoreLike {
  get(cwd: string): boolean | null;
  setMany(decisions: ProjectTrustUpdate[]): void;
}

export interface TrustDeps {
  hasTrustRequiringProjectResources: (cwd: string) => boolean;
  trustStore: TrustStoreLike;
  getProjectTrustOptions: (
    cwd: string,
    options?: { includeSessionOnly?: boolean },
  ) => Array<{ label: string; trusted: boolean; updates: ProjectTrustUpdate[]; savedPath?: string }>;
  defaultProjectTrust?: DefaultProjectTrustValue;
}

/**
 * Maps Pi's native project-trust semantics to a serializable inspection and
 * application. Resolution order follows Pi: no resources -> trusted; saved
 * decision (current or nearest parent) wins; otherwise `defaultProjectTrust`
 * always|never resolves without prompting; only `ask` returns the native
 * option labels. Applying an option uses its native `updates` unchanged.
 */
export class TrustService {
  constructor(private readonly deps: TrustDeps) {}

  inspect(cwd: string): TrustInspection {
    if (!this.deps.hasTrustRequiringProjectResources(cwd)) {
      return { required: false, trusted: true, options: [] };
    }
    const saved = this.deps.trustStore.get(cwd);
    if (saved !== null) {
      return { required: true, trusted: saved, options: [] };
    }
    switch (this.deps.defaultProjectTrust ?? "ask") {
      case "always":
        return { required: true, trusted: true, options: [] };
      case "never":
        return { required: true, trusted: false, options: [] };
    }
    const options = this.deps
      .getProjectTrustOptions(cwd, { includeSessionOnly: true })
      .map((option) => ({
        label: option.label,
        trusted: option.trusted,
        savesDecision: option.updates.length > 0,
      }));
    return { required: true, options };
  }

  apply(cwd: string, optionIndex: number): AppliedTrustDecision {
    const options = this.deps.getProjectTrustOptions(cwd, { includeSessionOnly: true });
    const option = options[optionIndex];
    if (!option) {
      throw new Error(`Invalid trust option index: ${optionIndex}`);
    }
    if (option.updates.length > 0) {
      this.deps.trustStore.setMany(option.updates);
    }
    return { trusted: option.trusted, projectTrustOverride: option.trusted };
  }
}

/** Production dependency wiring through the identity bootstrap. */
export async function createTrustService(agentDir: string): Promise<TrustService> {
  const { importPi, importPiTrustManager } = await import("../runtime/pi-import");
  const pi = await importPi();
  const { ProjectTrustStore, hasTrustRequiringProjectResources } =
    pi as typeof pi & {
      ProjectTrustStore: new (agentDir: string) => TrustStoreLike;
      hasTrustRequiringProjectResources: (cwd: string) => boolean;
    };
  const { getProjectTrustOptions } = await importPiTrustManager();
  const { SettingsManager } = pi;
  const globalSettings = SettingsManager.create(homedir(), agentDir).getGlobalSettings();
  return new TrustService({
    hasTrustRequiringProjectResources,
    trustStore: new ProjectTrustStore(agentDir) as unknown as TrustStoreLike,
    getProjectTrustOptions,
    defaultProjectTrust: globalSettings.defaultProjectTrust as DefaultProjectTrustValue | undefined,
  });
}
