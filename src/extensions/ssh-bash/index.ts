import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { Type, type Static } from "typebox";
import { createSshExecutor } from "./executor";
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
  timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 7200 })),
});

type SshBashInput = Static<typeof inputSchema>;

export interface CreateSshBashToolOptions {
  runtime: SshBashRuntime;
  allowConfigure: boolean;
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

function outputText(stdout: string, stderr: string): string {
  if (!stderr) return stdout || "Remote command completed without output.";
  if (!stdout) return stderr;
  return `${stdout}${stdout.endsWith("\n") ? "" : "\n"}${stderr}`;
}

export function createSshBashTool(options: CreateSshBashToolOptions) {
  return defineTool({
    name: "ssh-bash",
    label: "SSH Bash",
    description: options.allowConfigure
      ? "Configure and test the project's single SSH server, or run a bounded remote command. Credential contents stay in the configured external file."
      : "Test the configured project SSH server or run a bounded remote experiment command. Connection changes belong to Research Assistant.",
    parameters: inputSchema,
    async execute(_toolCallId, input, signal, onUpdate, ctx) {
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
      const result = await options.runtime.run(
        ctx.cwd,
        input.command,
        input.timeout ?? 120,
        effectiveSignal,
        (text) => onUpdate?.({
          content: [{ type: "text", text }],
          details: { running: true },
        }),
      );
      if (result.exitCode !== 0) {
        throw new Error(
          result.stderr.trim() || result.stdout.trim() || `Remote command exited with status ${result.exitCode}`,
        );
      }
      return {
        content: [{ type: "text", text: outputText(result.stdout, result.stderr) }],
        details: { exitCode: result.exitCode },
      };
    },
  });
}

export function createSshBashExtension(options: {
  allowConfigure: boolean;
  runtime?: SshBashRuntime;
}): ExtensionFactory {
  const runtime = options.runtime ?? createSshBashRuntime({
    execute: createSshExecutor(),
    pinConfiguration: !options.allowConfigure,
  });
  return (pi: ExtensionAPI) => {
    pi.registerTool(createSshBashTool({ runtime, allowConfigure: options.allowConfigure }));
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
