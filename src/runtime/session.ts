import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAgentSession, SessionManager, type CreateAgentSessionResult } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { applyConfigRootToPi, getAgentDir, getAuthPath, getConfigPath, getModelsPath, loadConfig } from "../config";
import { subagentTool } from "../subagent/tool";

export interface RunOptions {
  cwd: string;
  /** Override the orchestrator model, e.g. "anthropic/claude-opus-4-5" */
  model?: string;
}

/**
 * Create the orchestrator AgentSession for a paper project.
 *
 * The orchestrator is the default user window: a full coding agent with the
 * `subagent` tool mounted so it can dispatch stage agents. The session is
 * persisted by Pi's SessionManager under the config root.
 */
export async function createOrchestratorSession(options: RunOptions): Promise<CreateAgentSessionResult> {
  applyConfigRootToPi();
  const config = loadConfig();

  const modelRuntime = await ModelRuntime.create({
    authPath: getAuthPath(),
    modelsPath: getModelsPath(),
  });
  let model: Model<any> | undefined;
  const modelSpec = options.model ?? config.model;
  if (modelSpec) {
    model = resolveModel(modelRuntime, modelSpec);
  }
  if (!model) {
    throw new Error(buildModelError(modelSpec));
  }

  const result = await createAgentSession({
    cwd: options.cwd,
    agentDir: getAgentDir(),
    modelRuntime,
    model,
    customTools: [subagentTool],
    sessionManager: SessionManager.create(options.cwd, undefined),
  });

  return result;
}

export function splitModelSpec(spec: string): [string, string] {
  const idx = spec.indexOf("/");
  if (idx === -1) return ["", spec];
  return [spec.slice(0, idx), spec.slice(idx + 1)];
}

/**
 * Resolve a "provider/model" spec against the model runtime, or undefined if
 * the provider or model is not configured. Pure so it is unit-testable.
 */
export function resolveModel(
  modelRuntime: Pick<ModelRuntime, "getModel">,
  modelSpec: string,
): Model<any> | undefined {
  return modelRuntime.getModel(...splitModelSpec(modelSpec));
}

/** Build the error message for a missing/unresolvable model. */
export function buildModelError(modelSpec: string | undefined): string {
  return (
    `No model available. Configure one in ${getConfigPath()} (e.g. "model": "provider/id") or pass --model. ` +
    (modelSpec ? `Model "${modelSpec}" was not found in ${getModelsPath()}.` : "")
  );
}
