import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { Type, type Static } from "typebox";
import { resultContent, type ManagedShellService } from "../../background/shell";
import { backgroundProgressDescription } from "../managed-shell/progress";
import { createSshExecutor, SshOperationAbortedError } from "./executor";
import {
  createSshBashRuntime,
  readProjectSshConfig,
  type SshAuthType,
  type SshBashRuntime,
  type SshConnectionConfig,
} from "./runtime";

const inputSchema = Type.Object({
  action: Type.Union([
    Type.Literal("configure"),
    Type.Literal("test"),
    Type.Literal("run"),
  ]),
  host: Type.Optional(Type.String()),
  port: Type.Optional(Type.Integer()),
  username: Type.Optional(Type.String()),
  hostFingerprint: Type.Optional(Type.String()),
  authType: Type.Optional(Type.Union([Type.Literal("password"), Type.Literal("private-key")])),
  credentialFile: Type.Optional(Type.String()),
  passphraseFile: Type.Optional(Type.String()),
  remoteExperimentRoot: Type.Optional(Type.String()),
  localMountPath: Type.Optional(Type.String()),
  command: Type.Optional(Type.String()),
  timeout: Type.Optional(Type.Integer({ minimum: 0, description: "Run timeout in milliseconds. Foreground omitted/zero waits 120000 ms then backgrounds the same remote command. For explicit background execution, a positive timeout stops the command; omitted/zero is unlimited." })),
  background: Type.Optional(Type.Boolean({ description: "Run the SSH command in the background and return immediately. Completion is reported automatically to this session; do not poll or launch another copy." })),
});

type SshBashInput = Static<typeof inputSchema>;

export interface CreateSshBashToolOptions {
  runtime: SshBashRuntime;
  allowConfigure: boolean;
  manager?: ManagedShellService;
  owner?: () => { sessionID: string; cwd: string };
}

function configureInput(input: SshBashInput): SshConnectionConfig {
  return {
    host: input.host as string,
    port: input.port as number,
    username: input.username as string,
    hostFingerprint: input.hostFingerprint as string,
    authType: input.authType as SshAuthType,
    credentialFile: input.credentialFile as string,
    ...(input.passphraseFile ? { passphraseFile: input.passphraseFile } : {}),
    remoteExperimentRoot: input.remoteExperimentRoot as string,
    localMountPath: input.localMountPath as string,
  };
}

export function createSshBashTool(options: CreateSshBashToolOptions) {
  return defineTool({
    name: "ssh-bash",
    label: "SSH Bash",
    description: [options.allowConfigure
      ? "Configure and test the project's single SSH server, or run a managed remote command. Credential contents stay in the configured external file."
      : "Test the configured project SSH server or run a managed remote experiment command. Connection changes belong to Research Assistant.",
      "Run uses millisecond timeouts and the same background/completion contract as shell. Full combined output is captured to an owned file with bounded previews.",
      "Use remote shell syntax and enter the selected remote directory in the command. Do not manually detach or poll managed commands.",
      backgroundProgressDescription,
      "Cancellation requests TERM and closes the SSH channel; escaped remote descendants are not guaranteed to stop. Remote connections cannot survive server shutdown or restart.",
    ].join(" "),
    parameters: inputSchema,
    async execute(toolCallID, input, signal, _onUpdate, ctx) {
      const effectiveSignal = signal ?? new AbortController().signal;
      if (input.action === "configure") {
        if (!options.allowConfigure) {
          throw new Error("Only Research Assistant may configure the SSH connection.");
        }
        await options.runtime.configure(ctx.cwd, configureInput(input), effectiveSignal);
        return {
          content: [{ type: "text", text: "SSH connection configured and tested." }],
          details: { configured: true },
        };
      }
      if (input.action === "test") {
        await options.runtime.test(ctx.cwd, effectiveSignal);
        return {
          content: [{ type: "text", text: "SSH connection test passed." }],
          details: { tested: true },
        };
      }
      if (!input.command?.trim()) throw new Error("ssh-bash run requires a non-empty command.");
      if (!options.manager || !options.owner) throw new Error("Managed SSH execution is unavailable for this session.");
      const owner = options.owner();
      if (owner.cwd !== ctx.cwd) throw new Error("SSH execution owner does not match the exact session cwd.");
      const branch = ctx.sessionManager.getBranch();
      let assistantEntryId: string | undefined;
      for (let index = branch.length - 1; index >= 0; index--) {
        const entry = branch[index]!;
        if (entry.type !== "message" || entry.message.role !== "assistant"
          || entry.message.stopReason === "error" || entry.message.stopReason === "aborted") continue;
        if (entry.message.content.some(part => part.type === "toolCall" && part.id === toolCallID && part.name === "ssh-bash")) {
          assistantEntryId = entry.id;
          break;
        }
      }
      const result = await options.manager.executeRemote(owner.sessionID,
        { command: input.command, timeout: input.timeout, background: input.background },
        async operation => {
          try {
            const completed = await options.runtime.run(owner.cwd, operation.command, undefined, operation.signal, undefined, operation.onOutput);
            return { exitCode: completed.exitCode, ...(completed.signal ? { signal: completed.signal } : {}) };
          } catch (error) {
            if (operation.signal.aborted && error instanceof SshOperationAbortedError) return error.outcome;
            throw error;
          }
        }, signal, { toolCallID, ...(assistantEntryId ? { assistantEntryId } : {}), toolName: "ssh-bash" });
      return {
        content: [{ type: "text", text: resultContent(result) }],
        details: result,
        isError: result.status === "error" || result.status === "cancelled",
      };
    },
  });
}

export interface CreateSshBashExtensionOptions extends Omit<CreateSshBashToolOptions, "runtime"> {
  runtime?: SshBashRuntime;
}

export function createSshBashExtension(options: CreateSshBashExtensionOptions): ExtensionFactory {
  const runtime = options.runtime ?? createSshBashRuntime({
    execute: createSshExecutor(),
    pinConfiguration: !options.allowConfigure,
  });
  return (pi: ExtensionAPI) => {
    pi.registerTool(createSshBashTool({ ...options, runtime }));
    pi.on("tool_call", (event, ctx) => {
      if (event.toolName !== "read" && event.toolName !== "edit" && event.toolName !== "write") return;
      const path = (event.input as { path?: unknown }).path;
      if (typeof path !== "string") return;
      let config: SshConnectionConfig;
      try {
        config = readProjectSshConfig(ctx.cwd);
      } catch {
        return;
      }
      const sensitive = [config.credentialFile, config.passphraseFile].filter(
        (entry): entry is string => typeof entry === "string",
      );
      let candidate: string;
      try {
        const expanded = path === "~" || path.startsWith("~/")
          ? resolve(homedir(), path.slice(path === "~" ? 1 : 2))
          : isAbsolute(path)
            ? path
            : resolve(ctx.cwd, path);
        candidate = realpathSync(expanded);
      } catch {
        return;
      }
      if (sensitive.some((entry) => {
        try {
          return realpathSync(entry) === candidate;
        } catch {
          return false;
        }
      })) {
        return {
          block: true,
          terminate: true,
          reason: "SSH credential files are available only inside ssh-bash.",
        };
      }
    });
  };
}
