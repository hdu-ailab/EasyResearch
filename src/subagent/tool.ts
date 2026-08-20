import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLogger } from "../runtime/logger";
import type { SubagentLaunchDetails } from "./contracts";
import type { AgentCatalog, ReservedDispatch, SubagentCoordinator } from "./coordinator";
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
      let reservation: ReservedDispatch | undefined;
      let journalSessionPath: string | undefined;
      try {
        if (!params.agent.trim() || !params.task.trim()) {
          throw new Error("Agent and task are required.");
        }

        // This happens before the first await so parallel sibling calls cannot
        // observe the same id candidate.
        const reserved = options.coordinator.reserveDispatch({
          ownerSessionId: ctx.sessionManager.getSessionId(),
          toolCallId,
          requested: params.agent,
          catalog: options.catalog,
        });
        reservation = reserved;

        const agent = options.catalog.available.find((candidate) => candidate.name === reserved.agent);
        if (!agent) {
          const error = new Error(`Agent "${reserved.agent}" is no longer available.`);
          options.coordinator.recordPreMaterializationFailure(reserved, error);
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
            reserved.agent,
            options.coordinator.getPaperAssistantModel(),
          );
          thinking = await resolveThinkingForSpawn(
            { cwd: ctx.cwd, sessionManager },
            reserved.agent,
            options.coordinator.getPaperAssistantThinking(),
          );
        } catch (error) {
          options.coordinator.recordPreMaterializationFailure(reserved, error);
          throw error;
        }

        subagentLogger?.debug("subagent launch resolved", {
          agent: reserved.agent,
          agentId: reserved.agentId,
          model: model ?? "",
          thinking,
        });

        let details: SubagentLaunchDetails;
        try {
          details = await options.supervisor.launch(reserved, {
            agent,
            task: params.task,
            cwd: ctx.cwd,
            model,
            thinking,
            signal,
          });
        } catch (error) {
          let job = options.coordinator.journal().jobs.get(reserved.launchId);
          if (job?.status === "reserved") {
            options.coordinator.recordPreMaterializationFailure(reserved, error);
            job = options.coordinator.journal().jobs.get(reserved.launchId);
          }
          journalSessionPath = job?.sessionPath;
          throw error;
        }
        return {
          content: [{ type: "text", text: `${reserved.agentId} is working.` }],
          details,
        };
      } catch (error) {
        throw publicLaunchError(error, [reservation?.sessionPath, journalSessionPath]);
      }
    },
  });
}
