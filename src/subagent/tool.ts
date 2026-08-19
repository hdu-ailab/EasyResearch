import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLogger } from "../runtime/logger";
import type { SubagentLaunchDetails } from "./contracts";
import type { AgentCatalog, SubagentCoordinator } from "./coordinator";
import { resolveModelForSpawn } from "./model-resolution";
import type { SubagentSupervisor } from "./supervisor";
import { resolveThinkingForSpawn } from "./thinking-resolution";

const subagentLogger = createLogger("subagent");

interface SubagentLaunchErrorDetails {
  phase: "pre-materialization";
  code?: string;
  syscall?: string;
}

class SubagentLaunchError extends Error {
  readonly details: SubagentLaunchErrorDetails;

  constructor(message: string, details: SubagentLaunchErrorDetails) {
    super(message);
    this.name = "SubagentLaunchError";
    this.details = details;
  }
}

function errorField(error: unknown, key: string): string | undefined {
  if (error === null || typeof error !== "object" || !(key in error)) return undefined;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function publicLaunchError(error: unknown, internalPaths: readonly (string | undefined)[]): unknown {
  const paths = new Set(internalPaths.filter((path): path is string => typeof path === "string" && path.length > 0));
  for (const key of ["path", "sessionPath", "session_path"]) {
    const path = errorField(error, key);
    if (path) paths.add(path);
  }
  if (paths.size === 0) return error;

  let message = error instanceof Error ? error.message : String(error);
  for (const path of [...paths].sort((left, right) => right.length - left.length)) {
    message = message.replaceAll(path, "[session path]");
  }
  const code = errorField(error, "code");
  const syscall = errorField(error, "syscall");
  return new SubagentLaunchError(message, {
    phase: "pre-materialization",
    ...(code ? { code } : {}),
    ...(syscall ? { syscall } : {}),
  });
}

/** The exact three-line description lists only the caller's available Agents. */
export function formatSubagentDescription(available: readonly string[]): string {
  const names = available.length > 0 ? available.join(", ") : "none";
  return [
    "Delegate tasks to specialized subagents with isolated context.",
    "Sub agents run in the exact project directory.",
    `Available subagents: ${names}.`,
  ].join("\n");
}

const SubagentParams = Type.Object({
  agent: Type.String({
    description: "Name of the agent to invoke, or its agent id (e.g. 'search_0') to continue that child of this session",
  }),
  task: Type.String({ description: "Task to delegate" }),
});

export function createSubagentTool(options: {
  coordinator: SubagentCoordinator;
  supervisor: SubagentSupervisor;
  catalog: AgentCatalog;
  description?: string;
}) {
  return defineTool({
    name: "subagent",
    label: "Subagent",
    description: options.description ?? formatSubagentDescription([]),
    executionMode: "parallel",
    parameters: SubagentParams,
    async execute(toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      if (!params.agent.trim() || !params.task.trim()) {
        throw new Error("Agent and task are required.");
      }

      // This happens before the first await so parallel sibling calls cannot
      // observe the same id candidate.
      const reservation = options.coordinator.reserveDispatch({
        ownerSessionId: ctx.sessionManager.getSessionId(),
        toolCallId,
        requested: params.agent,
        catalog: options.catalog,
      });

      const agent = options.catalog.available.find((candidate) => candidate.name === reservation.agent);
      if (!agent) {
        const error = new Error(`Agent "${reservation.agent}" is no longer available.`);
        options.coordinator.recordPreMaterializationFailure(reservation, error);
        throw error;
      }

      let model: string | undefined;
      let thinking: string;
      try {
        const sessionManager = options.coordinator.getRootSessionManager() as Parameters<
          typeof resolveModelForSpawn
        >[0]["sessionManager"];
        model = await resolveModelForSpawn(
          { cwd: ctx.cwd, sessionManager },
          reservation.agent,
          options.coordinator.getPaperAssistantModel(),
        );
        thinking = await resolveThinkingForSpawn(
          { cwd: ctx.cwd, sessionManager },
          reservation.agent,
          options.coordinator.getPaperAssistantThinking(),
        );
      } catch (error) {
        options.coordinator.recordPreMaterializationFailure(reservation, error);
        throw error;
      }

      subagentLogger?.debug("subagent launch resolved", {
        agent: reservation.agent,
        agentId: reservation.agentId,
        model: model ?? "",
        thinking,
      });

      let details: SubagentLaunchDetails;
      try {
        details = await options.supervisor.launch(reservation, {
          agent,
          task: params.task,
          cwd: ctx.cwd,
          model,
          thinking,
          signal,
        });
      } catch (error) {
        let job = options.coordinator.journal().jobs.get(reservation.launchId);
        if (job?.status === "reserved") {
          options.coordinator.recordPreMaterializationFailure(reservation, error);
          job = options.coordinator.journal().jobs.get(reservation.launchId);
        }
        throw publicLaunchError(error, [reservation.sessionPath, job?.sessionPath]);
      }
      return {
        content: [{ type: "text", text: `${reservation.agentId} is working.` }],
        details,
      };
    },
  });
}
