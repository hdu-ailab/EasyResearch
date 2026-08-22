import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLogger } from "../runtime/logger";
import type { LiveConfiguration } from "../runtime/live-configuration";
import type { SubagentLaunchDetails } from "./contracts";
import type { AgentCatalog, ReservedDispatch, SubagentCoordinator } from "./coordinator";
import {
  availableSubagentsForCaller,
  withCurrentAgentCatalog,
} from "./dispatch-authorization";
import { RESEARCH_ASSISTANT_AGENT } from "./agents";
import { resolveConfiguredModel } from "./model-resolution";
import type { SubagentSupervisor } from "./supervisor";
import { resolveConfiguredThinking } from "./thinking-resolution";
import { isThinkingLevel } from "../thinking-levels";

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

interface LaunchErrorMetadata {
  paths: Set<string>;
  code?: string;
  syscall?: string;
}

function collectLaunchErrorMetadata(
  error: unknown,
  internalPaths: readonly (string | undefined)[],
): LaunchErrorMetadata {
  const metadata: LaunchErrorMetadata = {
    paths: new Set(internalPaths.filter((path): path is string => typeof path === "string" && path.length > 0)),
  };
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) continue;
      const field = descriptor.value;
      if (
        (key === "path" || key === "sessionPath" || key === "session_path")
        && typeof field === "string"
        && field.length > 0
      ) metadata.paths.add(field);
      if (
        (key === "code" || key === "syscall")
        && typeof field === "string"
        && /^[A-Za-z0-9_.:-]+$/.test(field)
        && metadata[key] === undefined
      ) metadata[key] = field;
      visit(field);
    }
  };
  visit(error);
  return metadata;
}

function redactSessionPaths(message: string, paths: ReadonlySet<string>): string {
  let sanitized = message;
  for (const path of [...paths].sort((left, right) => right.length - left.length)) {
    sanitized = sanitized.replaceAll(path, "[session path]");
  }
  sanitized = sanitized.replace(
    /(["'])((?:[A-Za-z]:[\\/]|\/)[^\r\n]*?\.jsonl)\1/gi,
    (_match, quote: string) => `${quote}[session path]${quote}`,
  );
  return sanitized.replace(
    /(?:[A-Za-z]:[\\/]|\/)[^"'`\r\n,;()[\]{}<>|]*?\.jsonl/gi,
    "[session path]",
  );
}

function publicLaunchError(error: unknown, internalPaths: readonly (string | undefined)[]): Error {
  const metadata = collectLaunchErrorMetadata(error, internalPaths);
  const rawMessage = error instanceof Error && error.message.trim() ? error.message : String(error);
  const message = redactSessionPaths(rawMessage, metadata.paths);
  return new SubagentLaunchError(message, {
    phase: "pre-materialization",
    ...(metadata.code ? { code: metadata.code } : {}),
    ...(metadata.syscall ? { syscall: metadata.syscall } : {}),
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

export interface CreateSubagentToolOptions {
  coordinator: SubagentCoordinator;
  supervisor: SubagentSupervisor;
  liveConfiguration: Pick<
    LiveConfiguration,
    "generation" | "synchronize" | "isCurrent" | "resolveAgents" | "subscribe"
  >;
  callerAgent: string;
  description?: string;
}

export function createSubagentTool(options: CreateSubagentToolOptions) {
  return defineTool({
    name: "subagent",
    label: "Subagent",
    description: options.description ?? formatSubagentDescription([]),
    executionMode: "parallel",
    parameters: SubagentParams,
    async execute(toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      let reservation: ReservedDispatch | undefined;
      let journalSessionPath: string | undefined;
      try {
        if (!params.agent.trim() || !params.task.trim()) {
          throw new Error("Agent and task are required.");
        }

        const authorized = await withCurrentAgentCatalog(
          options.liveConfiguration,
          ctx.cwd,
          ({ agents }) => {
            const available = availableSubagentsForCaller(agents, options.callerAgent);
            const catalog: AgentCatalog = { all: agents, available };

            // Reserve inside the final generation check, before any await, so
            // sibling parallel calls cannot observe the same id candidate.
            const reserved = options.coordinator.reserveDispatch({
              ownerSessionId: ctx.sessionManager.getSessionId(),
              toolCallId,
              requested: params.agent,
              catalog,
            });
            const agent = available.find((candidate) => candidate.name === reserved.agent);
            if (!agent) throw new Error(`Agent "${reserved.agent}" is disabled or unavailable.`);
            const researchAssistant = agents.find((candidate) => candidate.name === RESEARCH_ASSISTANT_AGENT);
            const researchAssistantThinking = options.coordinator.getResearchAssistantThinking();
            return {
              reservation: reserved,
              agent,
              model: resolveConfiguredModel(agent, researchAssistant?.model),
              thinking: resolveConfiguredThinking(
                agent,
                isThinkingLevel(researchAssistantThinking) ? researchAssistantThinking : undefined,
              ),
            };
          },
          { signal, maxGenerationRetries: 1 },
        );
        reservation = authorized.reservation;

        subagentLogger?.debug("subagent launch resolved", {
          agent: reservation.agent,
          agentId: reservation.agentId,
          model: authorized.model ?? "",
          thinking: authorized.thinking,
        });

        let details: SubagentLaunchDetails;
        try {
          details = await options.supervisor.launch(reservation, {
            agent: authorized.agent,
            callerAgent: options.callerAgent,
            task: params.task,
            cwd: ctx.cwd,
            model: authorized.model,
            thinking: authorized.thinking,
            liveConfiguration: options.liveConfiguration,
            signal,
          });
        } catch (error) {
          let job = options.coordinator.journal().jobs.get(reservation.launchId);
          if (job?.status === "reserved") {
            options.coordinator.recordPreMaterializationFailure(reservation, error);
            job = options.coordinator.journal().jobs.get(reservation.launchId);
          }
          journalSessionPath = job?.sessionPath;
          throw error;
        }
        return {
          content: [{ type: "text", text: `${reservation.agentId} is working.` }],
          details,
        };
      } catch (error) {
        throw publicLaunchError(error, [reservation?.sessionPath, journalSessionPath]);
      }
    },
  });
}
