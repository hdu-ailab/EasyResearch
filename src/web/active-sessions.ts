import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ActiveSessionDto } from "./contracts";
import type {
  RpcSessionAdapter,
  RpcSessionFactory,
  StartRpcSessionOptions,
} from "./rpc-session";
import { createLogger } from "../runtime/logger";
import { attachEventLogger } from "./event-logger";
import type { Logger } from "../runtime/logger";

const logger = createLogger("web-registry");

export class UnknownSessionError extends Error {}

interface ActiveRecord {
  dto: ActiveSessionDto;
  cwd: string;
  sessionPath?: string;
  client: RpcSessionAdapter;
  listeners: Set<(event: unknown) => void>;
  dispose: () => void;
  stopPromise: Promise<void> | null;
}

export interface CreateSessionInput {
  cwd: string;
}

export interface OpenSessionInput {
  cwd: string;
  sessionPath: string;
}

/**
 * In-memory registry owning one Pi RPC child per active Web session. Browser
 * disconnects only unsubscribe listeners; the child survives. Explicit stop,
 * restart, or registry shutdown stops children but preserves session paths
 * for later resume.
 */
export class ActiveSessionRegistry {
  private readonly records = new Map<string, ActiveRecord>();

  constructor(
    private readonly factory: RpcSessionFactory,
    private readonly logger?: Logger,
  ) {}

  async create(input: CreateSessionInput): Promise<ActiveSessionDto> {
    return this.launch({ cwd: input.cwd });
  }

  async open(input: OpenSessionInput): Promise<ActiveSessionDto> {
    for (const record of this.records.values()) {
      if (
        record.sessionPath === input.sessionPath &&
        (record.dto.status === "starting" || record.dto.status === "ready" || record.dto.status === "running")
      ) {
        return record.dto;
      }
    }
    return this.launch({
      cwd: input.cwd,
      sessionPath: input.sessionPath,
    });
  }

  list(): ActiveSessionDto[] {
    return [...this.records.values()].map((r) => ({ ...r.dto }));
  }

  async snapshot(id: string): Promise<{ session: ActiveSessionDto; messages: AgentMessage[] }> {
    return this.withRecord(id, async (record) => {
      await this.refreshFromClient(record);
      const live =
        record.dto.status === "starting" ||
        record.dto.status === "ready" ||
        record.dto.status === "running";
      const messages = live ? await record.client.getMessages() : [];
      return { session: { ...record.dto }, messages };
    });
  }

  /**
   * Dispatch a prompt without touching the DTO status: a session counts as
   * `running` only while a real agent run is active (`agent_start` →
   * `agent_settled`), never while a prompt is merely in flight. Pi's RPC
   * `prompt` resolves even when the run never starts (e.g. missing
   * model/auth preflight failure), and no `agent_settled` follows then;
   * pre-marking `running` here would leave an idle session stuck `running`.
   */
  async prompt(id: string, message: string): Promise<void> {
    return this.withRecord(id, async (record) => {
      await record.client.prompt(message);
    });
  }

  async abort(id: string): Promise<void> {
    return this.withRecord(id, async (record) => {
      await record.client.abort();
      record.dto.isStreaming = false;
      if (record.dto.status !== "stopped" && record.dto.status !== "error") {
        record.dto.status = "ready";
      }
    });
  }

  async setModel(id: string, provider: string, modelId: string): Promise<void> {
    return this.withRecord(id, (record) => record.client.setModel(provider, modelId));
  }

  async getSessionPath(id: string): Promise<string | undefined> {
    return this.withRecord(id, (record) => Promise.resolve(record.sessionPath));
  }

  async getCwd(id: string): Promise<string> {
    return this.withRecord(id, (record) => Promise.resolve(record.cwd));
  }

  /**
   * The orchestrator's current model as a `provider/id` string, the level-4
   * fallback for stage agents in this session. Undefined when the session has
   * no model (e.g. no auth configured).
   */
  async getOrchestratorModel(id: string): Promise<string | undefined> {
    return this.withRecord(id, async (record) => {
      const state = await record.client.getState();
      const model = state.model;
      return model ? `${model.provider}/${model.id}` : undefined;
    });
  }

  async stop(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    if (!record.stopPromise) {
      record.stopPromise = (async () => {
        for (const listener of record.listeners) {
          listener({ type: "session_deactivated", sessionId: record.dto.id });
        }
        await record.client.stop();
        record.dto.isStreaming = false;
        record.dto.status = "stopped";
        record.dto.error = undefined;
        record.dispose();
        (this.logger ?? logger).info("session deactivated", { sessionId: record.dto.id });
        this.records.delete(id);
      })();
    }
    await record.stopPromise;
  }

  async restart(id: string): Promise<ActiveSessionDto> {
    const record = this.records.get(id);
    if (!record) {
      throw new UnknownSessionError(`Unknown session: ${id}`);
    }
    await this.stop(id);
    const oldListeners = record.listeners;
    const replacement = await this.launch({
      cwd: record.cwd,
      sessionPath: record.sessionPath,
      adoptListeners: oldListeners,
    });
    return replacement;
  }

  subscribe(id: string, listener: (event: unknown) => void): () => void {
    const record = this.records.get(id);
    if (!record) throw new UnknownSessionError(`Unknown session: ${id}`);
    record.listeners.add(listener);
    return () => record.listeners.delete(listener);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.records.values()].map((r) => this.stop(r.dto.id)));
  }

  private async launch(
    options: StartRpcSessionOptions & { adoptListeners?: Set<(event: unknown) => void> },
  ): Promise<ActiveSessionDto> {
    const { assertSafeExtensionSources } = await import("../runtime/extensions-guard");
    assertSafeExtensionSources({ cwd: options.cwd });
    const listeners = options.adoptListeners ?? new Set<(event: unknown) => void>();
    const dto: ActiveSessionDto = {
      id: "",
      cwd: options.cwd,
      sessionFile: options.sessionPath,
      isStreaming: false,
      status: "starting",
    };
    const client = this.factory.create(options);
    const record: ActiveRecord = {
      dto,
      cwd: options.cwd,
      sessionPath: options.sessionPath,
      client,
      listeners,
      dispose: () => {},
      stopPromise: null,
    };
    (this.logger ?? logger).info("session launch", { cwd: options.cwd, sessionPath: options.sessionPath ?? "" });
    await client.start();
    const state = await client.getState();
    dto.id = state.sessionId;
    if (state.sessionFile) {
      dto.sessionFile = state.sessionFile;
      // Resume must target the real session file, even when it was created
      // during this launch (create has no sessionPath up front).
      record.sessionPath = state.sessionFile;
    }
    if (state.sessionName) dto.sessionName = state.sessionName;
    dto.isStreaming = state.isStreaming;
    dto.status = state.isStreaming ? "running" : "ready";

    const eventCancel = client.onEvent((event) => {
      for (const listener of record.listeners) listener(event);
      this.syncDtoFromEvent(record, event);
    });
    const eventLogCancel = attachEventLogger(dto.id, record.cwd, client.onEvent.bind(client), this.logger ?? logger);
    const exitCancel = client.onExit((error) => {
      (this.logger ?? logger).error("rpc child exited", { sessionId: record.dto.id, error: error.message });
      record.dto.isStreaming = false;
      record.dto.status = "error";
      record.dto.error = error.message;
    });
    record.dispose = () => {
      eventCancel();
      eventLogCancel();
      exitCancel();
    };

    this.records.set(dto.id, record);
    return { ...dto };
  }

  /**
   * The DTO status must reflect an actual agent run, never user focus,
   * session launch, or a prompt send. `agent_start`/`agent_settled` are Pi's
   * authoritative run boundaries: a run that fails preflight emits neither,
   * so the session stays `ready` instead of being marked `running`. Message
   * events are intentionally ignored here — `message_start` fires for user
   * and queued messages too, which would mark the session running while no
   * agent is active.
   */
  private syncDtoFromEvent(record: ActiveRecord, event: unknown): void {
    const type = (event as { type?: string }).type;
    if (type === "agent_start") {
      record.dto.isStreaming = true;
      if (record.dto.status !== "stopped" && record.dto.status !== "error") {
        record.dto.status = "running";
      }
    }
    if (type === "agent_settled") {
      void this.deactivate(record);
    }
  }

  private async deactivate(record: ActiveRecord): Promise<void> {
    await this.stop(record.dto.id);
  }

  private async refreshFromClient(record: ActiveRecord): Promise<void> {
    try {
      const state = await record.client.getState();
      record.dto.isStreaming = state.isStreaming;
      if (record.dto.status !== "stopped" && record.dto.status !== "error") {
        record.dto.status = state.isStreaming ? "running" : "ready";
      }
      if (state.sessionFile) record.dto.sessionFile = state.sessionFile;
      if (state.sessionName) record.dto.sessionName = state.sessionName;
    } catch (error) {
      if (record.dto.status !== "stopped") {
        record.dto.status = "error";
        record.dto.error = error instanceof Error ? error.message : String(error);
      }
    }
  }

  private withRecord<T>(id: string, run: (record: ActiveRecord) => Promise<T>): Promise<T> {
    const record = this.records.get(id);
    if (!record) return Promise.reject(new UnknownSessionError(`Unknown session: ${id}`));
    return run(record);
  }
}