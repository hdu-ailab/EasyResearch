import type { BackgroundTask } from "../contracts";

export interface ShellInput {
  command: string;
  workdir?: string;
  timeout?: number;
  background?: boolean;
}
export interface ShellResult {
  output: string;
  exitCode: number | null;
  wallTimeSeconds: number;
  status: "running" | "completed" | "cancelled" | "error";
  truncated: boolean;
  /** Capture ended before every output writer/cleanup operation settled. */
  incomplete?: boolean;
  /** A foreground interruption returned before command cleanup finished. */
  stopping?: boolean;
  shellID?: string;
  pid?: number;
  outputPath?: string;
  signal?: string;
  killed?: string;
  timeout?: boolean;
  /** Actual configured runtime limit, never inferred from elapsed wall time. */
  timeoutMs?: number;
}
export interface ShellNotification {
  id: string;
  content: string;
  sessionID: string;
  shellID: string;
  state: "completed" | "cancelled" | "error";
  result: ShellResult;
  /** Recovery replays/lost outcomes admit without waking an otherwise idle owner. */
  wake: boolean;
  recovered: boolean;
}
export interface ShellOwner {
  sessionID: string;
  cwd: string;
  /** Current accepted Pi settings; the host keeps them stable for the whole run. */
  shell?: () => { path?: string; commandPrefix?: string };
  /** Resolve after durable id-deduplicated admission, never after the model run. */
  notify(notification: ShellNotification): Promise<void>;
}
export interface ShellRecoveryOptions {
  /** The host must validate native root identity and prior daemon custody first. */
  verifyPriorOwner(owner: { pid: number; instanceID: string; rootSessionID: string }): Promise<boolean>;
  /** Managed host restart authority only: authenticate prepared custody even while
   * the predecessor remains alive waiting for successor readiness. */
  allowPreparedHandoff?: boolean;
}
/** SSH owns connection/config/credentials. This hook owns only execution lifetime/output. */
export type ManagedRemoteOperation = (input: {
  command: string;
  workdir?: string;
  signal: AbortSignal;
  onOutput(chunk: string | Uint8Array): void;
}) => Promise<{ exitCode: number | null; signal?: string; killed?: string }>;
export interface ShellCallContext {
  toolCallID: string;
  /** Local callers default to shell; the remote consumer supplies ssh-bash. */
  toolName?: "shell" | "ssh-bash";
  /** Native assistant row containing this invocation; absent on legacy records. */
  assistantEntryId?: string;
}
export interface RecoveredShellCall extends ShellCallContext {
  sessionID: string;
  result: ShellResult;
}
export interface ManagedShellService {
  attachOwner(owner: ShellOwner): () => void;
  detachOwner(sessionID: string): void;
  /** Retry retained admission at an existing host lifecycle boundary. */
  flushNotifications(sessionID?: string): Promise<void>;
  execute(sessionID: string, input: ShellInput, signal?: AbortSignal, context?: ShellCallContext): Promise<ShellResult>;
  executeRemote(sessionID: string, input: ShellInput, operation: ManagedRemoteOperation, signal?: AbortSignal, context?: ShellCallContext): Promise<ShellResult>;
  tasks(): BackgroundTask[];
  list(sessionID?: string): BackgroundTask[];
  blocking(sessionID: string): BackgroundTask[];
  promote(sessionID: string): Promise<void>;
  cancel(taskID: string): Promise<void>;
  hasWork(sessionID?: string, descendants?: readonly string[]): boolean;
  subscribe(listener: () => void): () => void;
  recover(options: ShellRecoveryOptions): Promise<void>;
  recoveredCalls(): RecoveredShellCall[];
  prepareHandoff(): Promise<void>;
  revokeHandoff(): Promise<void>;
  dispose(options?: { handoff?: boolean }): Promise<void>;
}
export interface ShellManagerOptions {
  agentDir: string;
  rootSessionID: string;
  cwd: string;
  /** Already accepted All-traffic child environment; never read a new config here. */
  environment?: NodeJS.ProcessEnv;
  shellPath?: string;
  worker?: false | { executable: string; args: string[] };
  onError?: (error: unknown) => void;
}
