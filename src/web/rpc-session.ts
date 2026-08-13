import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { RpcEventListener, RpcSessionState } from "@earendil-works/pi-coding-agent";

export interface StartRpcSessionOptions {
  cwd: string;
  sessionPath?: string;
  /** Thinking level to apply at launch via `--thinking` for fresh sessions. */
  thinking?: string;
}

export interface RpcSessionAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  prompt(message: string): Promise<void>;
  abort(): Promise<void>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: string): Promise<void>;
  getState(): Promise<RpcSessionState>;
  getMessages(): Promise<AgentMessage[]>;
  onEvent(listener: RpcEventListener): () => void;
  onExit(listener: (error: Error) => void): () => void;
}

export interface RpcSessionFactory {
  create(options: StartRpcSessionOptions): RpcSessionAdapter;
}

/**
 * Minimal structural subset of upstream `RpcClient` that the adapter and
 * tests depend on. The production constructor is the pinned upstream class
 * obtained through the identity bootstrap; tests inject a fake.
 */
export interface RpcClientLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  onEvent(listener: RpcEventListener): () => void;
  prompt(message: string): Promise<void>;
  abort(): Promise<void>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: string): Promise<void>;
  getState(): Promise<RpcSessionState>;
  getMessages(): Promise<AgentMessage[]>;
}

export interface RpcClientLikeOptions {
  cwd: string;
  cliPath: string;
  args: string[];
  env?: Record<string, string>;
}

export type RpcClientLikeConstructor = new (options: RpcClientLikeOptions) => RpcClientLike;

const CLI_PATH = fileURLToPath(new URL("../runtime/pi-bootstrap.mjs", import.meta.url));
const EXTENSION_PATH = fileURLToPath(new URL("../runtime/paper-assistant-extension.ts", import.meta.url));

export interface HeartbeatOptions {
  heartbeatIntervalMs?: number;
}

/**
 * Adapter implementing exit detection on top of upstream `RpcClient`, which
 * exposes no exit callback. A low-frequency `get_state` heartbeat plus
 * command-failure probing fires the exit listeners once when the child is
 * gone; explicit `stop()` suppresses alarms and never fires them. Heartbeats
 * never mutate session state.
 */
class DefaultRpcSessionAdapter implements RpcSessionAdapter {
  private stopped = false;
  private exited = false;
  private exitListeners = new Set<(error: Error) => void>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly heartbeatIntervalMs: number;

  constructor(
    private readonly client: RpcClientLike,
    heartbeatOptions: HeartbeatOptions = {},
  ) {
    this.heartbeatIntervalMs = heartbeatOptions.heartbeatIntervalMs ?? 30_000;
  }

  async start(): Promise<void> {
    await this.client.start();
    if (this.stopped) return;
    this.heartbeat = setInterval(() => {
      void this.checkAlive();
    }, this.heartbeatIntervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearHeartbeat();
    await this.client.stop();
  }

  async prompt(message: string): Promise<void> {
    await this.withExitProbe(() => this.client.prompt(message));
  }

  async abort(): Promise<void> {
    await this.withExitProbe(() => this.client.abort());
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    await this.withExitProbe(() => this.client.setModel(provider, modelId));
  }

  async setThinkingLevel(level: string): Promise<void> {
    await this.withExitProbe(() => this.client.setThinkingLevel(level));
  }

  async getState(): Promise<RpcSessionState> {
    return this.withExitProbe(() => this.client.getState());
  }

  async getMessages(): Promise<AgentMessage[]> {
    return this.withExitProbe(() => this.client.getMessages());
  }

  onEvent(listener: RpcEventListener): () => void {
    return this.client.onEvent(listener);
  }

  onExit(listener: (error: Error) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  private async checkAlive(): Promise<void> {
    if (this.stopped || this.exited) return;
    try {
      await this.client.getState();
    } catch (error) {
      this.fireExit(toError(error));
    }
  }

  private async withExitProbe<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (!this.stopped && !this.exited) {
        await this.checkAlive();
      }
      throw error;
    }
  }

  private fireExit(error: Error): void {
    if (this.stopped || this.exited) return;
    this.exited = true;
    this.clearHeartbeat();
    for (const listener of this.exitListeners) {
      listener(error);
    }
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Production factory. The upstream `RpcClient` class must be obtained through
 * the identity bootstrap; use `PiRpcSessionFactory.resolve()` (which also runs
 * `bootstrapBundledResources()`) for the production entry point.
 * `clientCtor` is injectable for tests.
 */
export class PiRpcSessionFactory implements RpcSessionFactory {
  /**
   * Production entry point: bootstrap bundled agents/skills into the global
   * agent dir, resolve the pinned upstream `RpcClient` through the identity
   * bootstrap, and build a factory bound to it.
   */
  static async resolve(heartbeatOptions?: HeartbeatOptions): Promise<PiRpcSessionFactory> {
    const { importPi } = await import("../runtime/pi-import");
    const { bootstrapBundledResources } = await import("../bootstrap/resources");
    await bootstrapBundledResources();
    const pi = await importPi();
    return new PiRpcSessionFactory(pi.RpcClient as unknown as RpcClientLikeConstructor, heartbeatOptions);
  }

  private readonly clientCtor: RpcClientLikeConstructor;
  private readonly heartbeatOptions: HeartbeatOptions;

  constructor(
    clientCtor: RpcClientLikeConstructor,
    heartbeatOptions: HeartbeatOptions = {},
  ) {
    this.clientCtor = clientCtor;
    this.heartbeatOptions = heartbeatOptions;
  }

  create(options: StartRpcSessionOptions): RpcSessionAdapter {
    // ADR-018: project config is always trusted — no trust prompt, ever.
    const args = [
      "--extension",
      EXTENSION_PATH,
      "--approve",
      "--no-skills",
      ...(options.sessionPath ? ["--session", options.sessionPath] : []),
      ...(options.sessionPath || !options.thinking ? [] : ["--thinking", options.thinking]),
    ];
    const client = new this.clientCtor({
      cwd: options.cwd,
      cliPath: CLI_PATH,
      args,
      env: { EASYRESEARCH_RPC_CHILD: "1" },
    });
    return new DefaultRpcSessionAdapter(client, this.heartbeatOptions);
  }
}
