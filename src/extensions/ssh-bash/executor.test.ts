import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSshExecutor, type SshClientLike, type SshCommandStreamLike } from "./executor";
import type { SshExecutionRequest } from "./runtime";

class FakeStream extends EventEmitter implements SshCommandStreamLike {
  readonly stderr = new EventEmitter();
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

  end(): void {}

  destroy(): void {
    this.destroyed = true;
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
