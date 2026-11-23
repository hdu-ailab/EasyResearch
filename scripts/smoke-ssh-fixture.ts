import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { Server, utils, type Connection, type ServerChannel } from "ssh2";
import type { AddressInfo } from "node:net";

export interface SshFixtureCommand {
  command: string;
  stream: ServerChannel;
  signals: string[];
  closed: boolean;
  finish(stdout?: string | Buffer, stderr?: string | Buffer, exitCode?: number): void;
}

/** Isolated SSH protocol peer: never spawns a shell, reads host credentials or uses ssh/sshpass. */
export async function startSmokeSshFixture(options: {
  onCommand?: (command: SshFixtureCommand) => void;
  ignoreSignals?: boolean;
} = {}) {
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
  const parsed = utils.parseKey(privateKey);
  if (parsed instanceof Error || Array.isArray(parsed)) throw new Error("Cannot create SSH fixture host key");
  const secret = `fixture-${randomUUID()}`;
  const clients = new Set<Connection>();
  const commands: SshFixtureCommand[] = [];
  const server = new Server({ hostKeys: [privateKey] }, client => {
    const ownedCommands: SshFixtureCommand[] = [];
    clients.add(client);
    client.on("error", () => {});
    client.on("close", () => {
      clients.delete(client);
      for (const command of ownedCommands) command.closed = true;
    });
    client.on("authentication", context => {
      if (context.method === "password" && context.username === "fixture" && context.password === secret) context.accept();
      else context.reject();
    });
    client.on("ready", () => client.on("session", accept => {
      const session = accept();
      let current: SshFixtureCommand | undefined;
      session.on("signal", (acceptSignal, _reject, info) => {
        current?.signals.push(info.name);
        acceptSignal?.();
        if (!options.ignoreSignals) current?.finish("", "", 143);
      });
      session.on("exec", (acceptExec, _reject, info) => {
        const stream = acceptExec();
        const record: SshFixtureCommand = {
          command: info.command, stream, signals: [], closed: false,
          finish(stdout = "", stderr = "", exitCode = 0) {
            if (record.closed) return;
            if (stdout.length) stream.write(stdout);
            if (stderr.length) stream.stderr.write(stderr);
            stream.exit(exitCode);
            stream.end();
          },
        };
        current = record;
        commands.push(record);
        ownedCommands.push(record);
        stream.resume();
        stream.on("error", () => {});
        stream.on("close", () => { record.closed = true; });
        if (info.command === "true") record.finish();
        else options.onCommand?.(record);
      });
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  return {
    secret, commands,
    connection: { host: "127.0.0.1", port: (server.address() as AddressInfo).port, username: "fixture",
      hostFingerprint: `SHA256:${createHash("sha256").update(parsed.getPublicSSH()).digest("base64").replace(/=+$/u, "")}` },
    async close() {
      for (const client of clients) client.end();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
