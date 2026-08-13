import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { importPi } from "../../runtime/pi-import";
import {
  createPaperAssistantConfigResolver,
  type PaperAssistantConfigResolverOptions,
} from "../pa-config";
import {
  defaultSkillDirectories,
  isDotAgentsSkillEnabled,
  resolveSkillDirectories,
} from "../../subagent/skill-resolution";

/**
 * ADR-063: the Paper Assistant extension now applies ONLY the effective
 * paper-assistant agent definition to the runtime — active tools
 * (`session_start`), the appended system prompt (`before_agent_start`), and
 * the resolved skill paths (`resources_discover`). The former sibling duties
 * moved to their own atomic extensions: subagent-dispatch (subagent tool),
 * welcome-banner (TUI banner), event-logger (TUI logs), project-trust
 * (project_trust → yes).
 */
export function createPaperAssistantExtension(options: PaperAssistantConfigResolverOptions = {}): InlineExtension {
  return async (pi) => {
    const { SettingsManager } = await importPi();
    const resolver = createPaperAssistantConfigResolver(options);
    pi.on("session_start", async (_event, ctx) => {
      const config = await resolver.resolve(ctx.cwd, true);
      pi.setActiveTools(config.tools ?? pi.getAllTools().map(({ name }) => name));
    });
    pi.on("before_agent_start", async (event, ctx) => {
      const config = await resolver.resolve(ctx.cwd);
      return { systemPrompt: `${event.systemPrompt}\n\n${config.systemPrompt}` };
    });
    pi.on("resources_discover", async (event) => {
      const config = await resolver.resolve(event.cwd);
      const deps = {
        cwd: event.cwd,
        agentDir: resolver.agentDir,
        homeDir: resolver.homeDir,
        bundledSkillsDir: resolver.bundledSkillsDir,
        enableDotAgentsSkill: isDotAgentsSkillEnabled(
          SettingsManager.create(event.cwd, resolver.agentDir).getGlobalSettings(),
        ),
      };
      return {
        skillPaths: config.skills === undefined
          ? defaultSkillDirectories(deps)
          : resolveSkillDirectories(config.skills, deps) ?? [],
      };
    });
  };
}

export default createPaperAssistantExtension();
