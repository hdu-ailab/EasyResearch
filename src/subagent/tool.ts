import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLogger } from "../runtime/logger";
import type { LiveConfiguration } from "../runtime/live-configuration";
import type { SubagentLaunchDetails } from "./contracts";
import type { AgentCatalog, ReservedDispatch, SubagentCoordinator } from "./coordinator";
import {
  availableSubagentsForCaller,
  type DispatchLiveConfiguration,
  withCurrentAgentCatalog,
} from "./dispatch-authorization";
import { RESEARCH_ASSISTANT_AGENT } from "./agents";
import { resolveConfiguredModel } from "./model-resolution";
import type { SubagentSupervisor } from "./supervisor";
import { resolveConfiguredThinking } from "./thinking-resolution";
import { getSupportedThinkingLevels, isThinkingLevel } from "../thinking-levels";
import type { AgentConfig } from "./agents";

const subagentLogger = createLogger("subagent");

function invocationID(ctx: ExtensionContext, toolCallID: string): string {
  // Parallel sibling results may already have advanced the native leaf.
  const branch = ctx.sessionManager.getBranch?.() ?? [];
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index]!;
    if (entry.type !== "message" || entry.message.role !== "assistant"
      || entry.message.stopReason === "error" || entry.message.stopReason === "aborted") continue;
    if (typeof entry.id !== "string" || !entry.id || !Array.isArray(entry.message.content)) continue;
    if (entry.message.content.some((part) => part.type === "toolCall" && part.name === "subagent" && part.id === toolCallID)) {
      return `native:${JSON.stringify([ctx.sessionManager.getSessionId(), entry.id, toolCallID])}`;
    }
  }
  return `host:${ctx.sessionManager.getSessionId()}:${randomUUID()}`;
}

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

export function formatSubagentDescription(available: readonly (string | Pick<AgentConfig, "name" | "description">)[]): string {
  return [
    "Spawns an agent in a child session to work on the specified task.",
    'Subagents always run in the background: the call returns immediately with a sessionID, and you receive a `<background-result kind="subagent">` message each time the child goes idle, including after later work.',
    "Keep working on non-overlapping tasks, or briefly tell the user what you launched and end your response. Do not sleep, poll, or proactively check on the child's progress.",
    "New child sessions start with fresh context, so include all relevant context and instructions when you don't pass a sessionID.",
    "Pass the returned sessionID to continue that specific child conversation. A follow-up to a running child joins its current run.",
    "Subagents run in the exact project directory.",
    "", "Available subagents:",
    ...available.map((agent) => typeof agent === "string" ? `- ${agent}` : `- ${agent.name}: ${agent.description || "This subagent should only be called when explicitly requested."}`),
  ].join("\n");
}

const SubagentParams = Type.Object({
  agent: Type.String({
    description: "The type of specialized agent to use for this task. If the user asks for a subagent by a name that is not one of the available subagents, they most likely mean a model: pick a suitable agent and pass the name through the model parameter instead.",
  }),
  description: Type.String({ description: "A short 3-5 word label for the task, displayed to the user" }),
  prompt: Type.String({ description: "The task for the subagent to perform" }),
  model: Type.Optional(Type.String({ description: 'NEVER set this unless the user explicitly asks for a particular model or variant. It must be a chat model; image and decision models cannot run subagents. Use "providerID/modelID" or "providerID/modelID#variant". Do not guess the ID: look the model up with the models tool, filtering to your own provider first.' })),
  sessionID: Type.Optional(Type.String({ description: "Send a follow-up to an existing subagent, running or finished. Omit to start a new one." })),
});

export interface CreateSubagentToolOptions {
  coordinator: SubagentCoordinator;
  supervisor: SubagentSupervisor;
  liveConfiguration: DispatchLiveConfiguration & Pick<LiveConfiguration, "acquireProject">;
  callerAgent: string;
  getCallerThinking?: () => string | undefined;
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
        if (!params.agent.trim() || !params.prompt.trim() || !params.description.trim()) {
          throw new Error("Agent, description and prompt are required.");
        }
        const reference = params.model?.trim() || undefined;
        const sessionID = params.sessionID?.trim() || undefined;
        const inputID = invocationID(ctx, toolCallId);
        const inputFingerprint = createHash("sha256").update(JSON.stringify([params.agent, params.description, params.prompt, reference ?? null, sessionID ?? null])).digest("hex");
        let explicitModel: string | undefined;
        let explicitThinking: string | undefined;
        if (reference) {
          const [modelID, variant, extra] = reference.split("#");
          const selected = ctx.modelRegistry.getAvailable().find((model) => `${model.provider}/${model.id}` === modelID);
          if (!selected || extra !== undefined) throw new Error(`Model "${reference}" is not an available chat model. Use the models tool to find one.`);
          if (variant !== undefined && (!isThinkingLevel(variant) || !getSupportedThinkingLevels(selected).includes(variant))) {
            throw new Error(`Variant "${variant}" is not available for "${modelID}". Available: ${getSupportedThinkingLevels(selected).join(", ")}.`);
          }
          explicitModel = modelID;
          explicitThinking = variant;
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
              description: params.description,
              sessionID,
              inputID,
              inputFingerprint,
            });
            const agent = available.find((candidate) => candidate.name === params.agent);
            if (!agent) throw new Error(`Agent "${reserved.agent}" is disabled or unavailable.`);
            const researchAssistant = agents.find((candidate) => candidate.name === RESEARCH_ASSISTANT_AGENT);
            const callerThinking = options.getCallerThinking?.() ?? options.coordinator.getResearchAssistantThinking();
            return {
              reservation: reserved,
              agent,
              model: explicitModel ?? (sessionID ? undefined : resolveConfiguredModel(agent, ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : researchAssistant?.model)),
              thinking: explicitThinking ?? (sessionID ? undefined : resolveConfiguredThinking(
                agent,
                isThinkingLevel(callerThinking) ? callerThinking : undefined,
              )),
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
            task: params.prompt,
            inputID,
            inputFingerprint,
            cwd: ctx.cwd,
            model: authorized.model,
            thinking: authorized.thinking,
            liveConfiguration: options.liveConfiguration,
            signal,
          });
        } catch (error) {
          let job = options.coordinator.journal().jobs.get(reservation.launchId);
          if (job && (job.status === "reserved" || job.status === "created") && !job.background) {
            options.coordinator.recordPreMaterializationFailure(reservation, error);
            job = options.coordinator.journal().jobs.get(reservation.launchId);
          }
          journalSessionPath = job?.sessionPath;
          throw error;
        }
        const output = [
            `The subagent is working in the background (sessionID: ${details.job.childSessionId}). You will receive a <background-result kind="subagent"> message when it goes idle, and again after each later round of work.`,
            "DO NOT sleep, poll, proactively check on its progress, or duplicate this subagent's work.",
            "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
            "To send it follow-ups or change its instructions while it runs, call subagent again with this sessionID.",
          ].join("\n");
        return {
          content: [{ type: "text", text: output }],
          details: { ...details, sessionID: details.job.childSessionId, status: "running" as const, output },
        };
      } catch (error) {
        throw publicLaunchError(error, [reservation?.sessionPath, journalSessionPath]);
      }
    },
  });
}
