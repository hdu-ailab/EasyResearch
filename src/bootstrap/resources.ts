export interface BootstrapOptions {
  agentDir?: string;
  bundledAgentsDir?: string;
  bundledSkillsDir?: string;
}

export interface BootstrapResult {
  copiedAgents: string[];
  copiedSkills: string[];
}

/**
 * Startup does not copy bundled resources. Discovery reads them as a lower
 * priority read-only layer; explicit Web edits perform copy-on-edit.
 */
export async function bootstrapBundledResources(
  _options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  return {
    copiedAgents: [],
    copiedSkills: [],
  };
}
