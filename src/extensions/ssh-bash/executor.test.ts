import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSshExecutor, SshOperationAbortedError, type SshClientLike, type SshCommandStreamLike } from "./executor";
import type { SshExecutionRequest } from "./runtime";

class FakeStream extends EventEmitter implements SshCommandStreamLike {
  readonly stderr = new EventEmitter();
  readonly signals: string[] = [];
  closed = false;
  signal(name: string): void { this.signals.push(name); }
  close(): void { this.closed = true; this.emit("close", null); }
  destroy(): void { this.close(); }
}

class FakeClient extends EventEmitter implements SshClientLike {
  connectedWith: Record<string, unknown> | undefined;
  command: string | undefined;
  destroyed = false;
  readonly stream = new FakeStream();

  connect(options: Record<string, unknown>): void {
    this.connectedWith = options;
    queueMicrotask(() => this.emit("ready"));
  }

  exec(command: string, callback: (error: Error | undefined, stream?: SshCommandStreamLike) => void): void {
    this.command = command;
    callback(undefined, this.stream);
    queueMicrotask(() => {
      this.stream.emit("data", Buffer.from("hello "));
      this.stream.stderr.emit("data", Buffer.from("warning"));
      this.stream.emit("data", Buffer.from("world"));
      this.stream.emit("close", 7);
    });
  }

  end(): void { this.emit("close"); }

  destroy(): void {
    this.destroyed = true;
    this.emit("close");
  }
}

function request(overrides: Partial<SshExecutionRequest> = {}): SshExecutionRequest {
  const hostKey = Buffer.from("fixture-host-key");
  return {
    config: {
      host: "gpu.example.org",
      port: 2222,
      username: "researcher",
      hostFingerprint: `SHA256:${createHash("sha256").update(hostKey).digest("base64").replace(/=+$/u, "")}`,
      authType: "password",
      credentialFile: "/outside/password.txt",
      remoteExperimentRoot: "/srv/papers/demo/experiments",
      localMountPath: "/project/experiments",
    },
    command: "hostname",
    timeoutSeconds: 30,
    signal: new AbortController().signal,
    password: "secret-password",
    ...overrides,
  };
}

describe("ssh2 command executor", () => {
  afterEach(() => vi.useRealTimers());

  it("streams complete binary output beyond the bounded probe limit without accumulating it or imposing a command deadline", async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    client.exec = (_command, callback) => callback(undefined, client.stream);
    const chunks: Buffer[] = [];
    const promise = createSshExecutor({ createClient: () => client })(request({
      timeoutSeconds: undefined, onOutput: chunk => chunks.push(Buffer.from(chunk)),
    }));
    await Promise.resolve();
    const large = Buffer.alloc(300 * 1024, 0x61);
    client.stream.emit("data", large);
    client.stream.stderr.emit("data", Buffer.from([0, 255, 10]));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(client.destroyed).toBe(false);
    expect(client.connectedWith?.readyTimeout).toBe(30_000);
    client.stream.emit("close", 0);
    await expect(promise).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
    expect(Buffer.concat(chunks)).toEqual(Buffer.concat([large, Buffer.from([0, 255, 10])]));
  });

  it("keeps configure/test output bounded", async () => {
    const client = new FakeClient();
    client.exec = (_command, callback) => {
      callback(undefined, client.stream);
      queueMicrotask(() => client.stream.emit("data", Buffer.alloc(257 * 1024)));
    };
    await expect(createSshExecutor({ createClient: () => client })(request())).rejects.toThrow(/256 KiB/);
    expect(client.destroyed).toBe(true);
  });

  it("requests TERM and owns bounded channel cleanup before rejecting cancellation", async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    client.exec = (_command, callback) => callback(undefined, client.stream);
    const abort = new AbortController();
    const promise = createSshExecutor({ createClient: () => client })(request({ timeoutSeconds: undefined, onOutput: () => {}, signal: abort.signal }));
    const rejected = expect(promise).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    abort.abort();
    expect(client.stream.signals).toEqual(["TERM"]);
    expect(client.stream.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(client.stream.closed).toBe(true);
  });

  it("bounds the connection handshake even when managed command time is unlimited", async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    client.connect = options => { client.connectedWith = options; };
    const promise = createSshExecutor({ createClient: () => client })(request({ timeoutSeconds: undefined, onOutput: () => {} }));
    const rejected = expect(promise).rejects.toThrow(/connection|handshake/i);
    await vi.advanceTimersByTimeAsync(31_000);
    await rejected;
    expect(client.destroyed).toBe(true);
  });

  it("retains a remotely admitted exec until its delayed channel acknowledgement can receive TERM", async () => {
    const client = new FakeClient();
    let admitted!: (error: Error | undefined, stream?: SshCommandStreamLike) => void;
    client.exec = (_command, callback) => { admitted = callback; };
    const abort = new AbortController();
    const pending = createSshExecutor({ createClient: () => client })(request({ timeoutSeconds: undefined, onOutput: () => {}, signal: abort.signal }));
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    abort.abort();
    expect(client.destroyed).toBe(false);
    admitted(undefined, client.stream);
    expect(client.stream.signals).toEqual(["TERM"]);
    client.stream.close();
    await rejected;
  });

  it("does not expose authentication material from transport exceptions", async () => {
    const client = new FakeClient();
    client.connect = () => { throw new Error("Rejected secret-password and private-key-fixture"); };
    await expect(createSshExecutor({ createClient: () => client })(request({ privateKey: "private-key-fixture" })))
      .rejects.toThrow("Rejected [redacted] and [redacted]");
  });

  it("preserves transport failure during cancellation instead of classifying every aborted signal as controlled cleanup", async () => {
    const client = new FakeClient();
    client.exec = (_command, callback) => callback(undefined, client.stream);
    const abort = new AbortController();
    const pending = createSshExecutor({ createClient: () => client })(request({ timeoutSeconds: undefined, onOutput: () => {}, signal: abort.signal })).catch(error => error);
    await Promise.resolve();
    abort.abort();
    const transportFailure = new Error("SSH transport failed during cancellation");
    transportFailure.name = "AbortError";
    client.emit("error", transportFailure);
    const error = await pending;
    expect(error).not.toBeInstanceOf(SshOperationAbortedError);
    expect(error.message).toBe("SSH transport failed during cancellation");
  });

  it("preserves a cleanup failure rather than inventing a completed cancellation outcome", async () => {
    const client = new FakeClient();
    client.exec = (_command, callback) => callback(undefined, client.stream);
    client.end = () => { throw new Error("SSH cleanup failed"); };
    const abort = new AbortController();
    const pending = createSshExecutor({ createClient: () => client })(request({ timeoutSeconds: undefined, onOutput: () => {}, signal: abort.signal })).catch(error => error);
    await Promise.resolve();
    abort.abort();
    client.stream.emit("close", null);
    const error = await pending;
    expect(error).not.toBeInstanceOf(SshOperationAbortedError);
    expect(error.message).toBe("SSH cleanup failed");
  });
  it("uses file-loaded credentials, streams output, and returns the remote exit code", async () => {
    const client = new FakeClient();
    const updates: string[] = [];
    const execute = createSshExecutor({ createClient: () => client });

    const result = await execute(request({ onUpdate: (text) => updates.push(text) }));

    expect(client.connectedWith).toMatchObject({
      host: "gpu.example.org",
      port: 2222,
      username: "researcher",
      password: "secret-password",
      readyTimeout: 30_000,
    });
    expect(client.connectedWith).not.toHaveProperty("privateKey");
    expect((client.connectedWith?.hostVerifier as (key: Buffer) => boolean)(Buffer.from("fixture-host-key"))).toBe(true);
    expect((client.connectedWith?.hostVerifier as (key: Buffer) => boolean)(Buffer.from("wrong-host-key"))).toBe(false);
    expect(client.command).toBe("hostname");
    expect(updates).toEqual(["hello ", "warning", "world"]);
    expect(result).toEqual({ stdout: "hello world", stderr: "warning", exitCode: 7 });
  });

  it("aborts and destroys a connection that never becomes ready", async () => {
    const controller = new AbortController();
    const client = new FakeClient();
    client.connect = (options) => {
      client.connectedWith = options;
    };
    const execute = createSshExecutor({ createClient: () => client });

    const promise = execute(request({ signal: controller.signal }));
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(client.destroyed).toBe(true);
  });

  it("treats a close without a numeric remote exit status as failure", async () => {
    const client = new FakeClient();
    client.exec = (command, callback) => {
      client.command = command;
      callback(undefined, client.stream);
      queueMicrotask(() => client.stream.emit("close", null, "SIGTERM"));
    };
    const execute = createSshExecutor({ createClient: () => client });

    await expect(execute(request())).resolves.toMatchObject({ exitCode: 255 });
  });
});
