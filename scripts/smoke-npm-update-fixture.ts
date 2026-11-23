import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync,
  realpathSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { connect, type AddressInfo, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TARGETS, platformBinaryName } from "./build";
import { mainPackageManifest, NPM_REGISTRY, platformPackageManifest } from "./release";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REGISTRY_HOST = "registry.npmjs.org";
export const MODEL_HOST = "npm-update-model.invalid";
const OUTPUT_LIMIT = 1024 * 1024;
const ARTIFACT_LIMIT = 1024 * 1024 * 1024;

export interface FixtureCommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  logFile?: string;
}

/** Asynchronous: a real npm child must not block its in-process registry/proxy. */
export async function fixtureCommand(command: string, args: string[], options: FixtureCommandOptions): Promise<string> {
  options.signal?.throwIfAborted();
  return new Promise((resolveCommand, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let failure: Error | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const signal = (value: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, value); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(value);
      }
    };
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      signal("SIGTERM");
      escalation = setTimeout(() => signal("SIGKILL"), 1000);
    };
    const aborted = () => stop(new Error(`Fixture command aborted: ${command}`));
    options.signal?.addEventListener("abort", aborted, { once: true });
    const timer = setTimeout(() => stop(new Error(`Fixture command timed out: ${command}`)), options.timeoutMs ?? 60_000);
    const capture = (chunk: Buffer, kind: "stdout" | "stderr") => {
      const before = kind === "stdout" ? stdout : stderr;
      const after = Buffer.concat([before, chunk.subarray(0, Math.max(0, OUTPUT_LIMIT - before.length))]);
      if (kind === "stdout") stdout = after; else stderr = after;
      if (before.length + chunk.length > OUTPUT_LIMIT) stop(new Error(`Fixture command exceeded its output bound: ${command}`));
    };
    child.stdout.on("data", (chunk: Buffer) => capture(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => capture(chunk, "stderr"));
    child.once("error", (error) => { failure ??= error; });
    child.once("close", (code, exitSignal) => {
      clearTimeout(timer); clearTimeout(escalation);
      options.signal?.removeEventListener("abort", aborted);
      const output = `${stdout.toString("utf8")}\n${stderr.toString("utf8")}`;
      if (options.logFile) writeFileSync(options.logFile, output, { mode: 0o600 });
      if (failure || code !== 0 || exitSignal) {
        reject(new Error(`${failure?.message ?? `${command} exited ${code ?? exitSignal}`}\n${output.slice(-8192)}`));
      } else resolveCommand(stdout.toString("utf8"));
    });
  });
}

export function executableOnPath(name: string): string {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    const candidate = join(directory, name);
    try { if (statSync(candidate).isFile() && (statSync(candidate).mode & 0o111)) return realpathSync(candidate); } catch { /* Next PATH entry. */ }
  }
  throw new Error(`Required fixture executable is unavailable: ${name}`);
}

export interface FixtureRuntime { node: string; npm: string; openssl: string }
export function fixtureRuntime(nodePath?: string): FixtureRuntime {
  const node = realpathSync(nodePath ?? executableOnPath("node"));
  const npm = realpathSync(join(dirname(node), "npm"));
  const manifest = JSON.parse(readFileSync(join(dirname(dirname(npm)), "package.json"), "utf8"));
  assert.equal(manifest.name, "npm", "Use the real npm associated with the launcher's Node runtime");
  assert.equal(manifest.bin?.npm, "bin/npm-cli.js");
  return { node, npm, openssl: executableOnPath("openssl") };
}

/** No inherited npmrc, credentials, NODE_OPTIONS, config roots, proxies or Python. */
export function fixtureEnvironment(root: string, runtime: FixtureRuntime): NodeJS.ProcessEnv {
  const home = join(root, "home");
  const bin = join(root, "node only bin");
  for (const dir of [home, bin, join(root, "tmp"), join(root, "agent"), join(root, "project")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, target] of [["node", runtime.node], ["npm", runtime.npm]]) {
    const destination = join(bin, name!);
    if (!existsSync(destination)) symlinkSync(target!, destination);
  }
  const npmrc = join(root, "empty-user.npmrc");
  const globalNpmrc = join(root, "empty-global.npmrc");
  writeFileSync(npmrc, "", { mode: 0o600 });
  writeFileSync(globalNpmrc, "", { mode: 0o600 });
  return {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"), TMPDIR: join(root, "tmp"), PATH: bin, LANG: "C.UTF-8", CI: "1",
    EASYRESEARCH_CODING_AGENT_DIR: join(root, "agent"), EASYRESEARCH_NPM_SMOKE_ROOT: root,
    npm_config_userconfig: npmrc, npm_config_globalconfig: globalNpmrc, npm_config_cache: join(root, "npm cache"),
    npm_config_prefix: join(root, "unused default prefix"), npm_config_registry: NPM_REGISTRY,
    npm_config_strict_ssl: "true", npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false",
    npm_config_fetch_retries: "0", npm_config_fetch_timeout: "20000", npm_config_logs_max: "20",
    NODE_TLS_REJECT_UNAUTHORIZED: "1", NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1",
  };
}

export function withFixtureProxy(env: NodeJS.ProcessEnv, proxy: string): NodeJS.ProcessEnv {
  return { ...env, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, all_proxy: proxy,
    npm_config_proxy: proxy, npm_config_https_proxy: proxy, npm_config_noproxy: "localhost,127.0.0.1,::1" };
}

export async function fileDigest(path: string, algorithm = "sha256", encoding: "hex" | "base64" = "hex"): Promise<string> {
  const stat = statSync(path);
  assert(stat.isFile() && stat.size > 0 && stat.size <= ARTIFACT_LIMIT, "Fixture artifacts must be nonempty regular files within the 1 GiB bound");
  const digest = createHash(algorithm);
  const stream = createReadStream(path);
  try { for await (const chunk of stream) digest.update(chunk); } finally { stream.destroy(); }
  return digest.digest(encoding);
}

export interface FixtureCertificate { caPath: string; cert: Buffer; key: Buffer }
export async function createRegistryCertificate(root: string, runtime: FixtureRuntime, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<FixtureCertificate> {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const run = (args: string[]) => fixtureCommand(runtime.openssl, args, { cwd: root, env, signal, timeoutMs: 15_000 });
  const caPath = join(root, "fixture-ca.pem");
  await run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2", "-subj", "/CN=EasyResearch isolated npm acceptance CA",
    "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-keyout", "ca.key", "-out", caPath]);
  await run(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256", "-subj", `/CN=${REGISTRY_HOST}`, "-keyout", "registry.key", "-out", "registry.csr"]);
  writeFileSync(join(root, "leaf.ext"), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${REGISTRY_HOST}\n`);
  await run(["x509", "-req", "-in", "registry.csr", "-CA", caPath, "-CAkey", "ca.key", "-CAcreateserial", "-days", "2", "-sha256", "-extfile", "leaf.ext", "-out", "registry.pem"]);
  for (const name of ["ca.key", "registry.key"]) chmodSync(join(root, name), 0o600);
  await run(["verify", "-CAfile", caPath, "-verify_hostname", REGISTRY_HOST, "registry.pem"]);
  return { caPath, cert: readFileSync(join(root, "registry.pem")), key: readFileSync(join(root, "registry.key")) };
}

export interface FixturePackage {
  name: string; version: string; manifest: Record<string, unknown>; tarball: string; size: number;
  sha256: string; integrity: string; shasum: string; native: boolean;
}

/** Pack locally with the release manifests. Foreign targets are metadata-only and may never be downloaded. */
export async function packUpdateFixtures(options: {
  directory: string; runtime: FixtureRuntime; env: NodeJS.ProcessEnv; target: string;
  candidates: ReadonlyArray<{ version: string; executable: string }>;
  launcher?: string; signal?: AbortSignal;
}): Promise<FixturePackage[]> {
  const { directory, runtime, signal } = options;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const result: FixturePackage[] = [];
  const launcher = options.launcher ?? join(REPO, "launcher.mjs");
  // Packing has its own cache: the later new-version download must be observed.
  const env = { ...options.env, npm_config_cache: join(directory, "pack cache") };
  for (const candidate of options.candidates) {
    for (const target of [undefined, ...TARGETS]) {
      const manifest = target ? platformPackageManifest(target, candidate.version) : mainPackageManifest(candidate.version);
      const name = String(manifest.name);
      const pkg = join(directory, `${name}-${candidate.version}`);
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, "package.json"), JSON.stringify(manifest));
      copyFileSync(join(REPO, "LICENSE"), join(pkg, "LICENSE"));
      writeFileSync(join(pkg, "README.md"), "Private npm update acceptance fixture. Never publish.\n");
      if (!target) { copyFileSync(launcher, join(pkg, "launcher.mjs")); chmodSync(join(pkg, "launcher.mjs"), 0o755); }
      else if (target.name === options.target) {
        assert(statSync(candidate.executable).size <= ARTIFACT_LIMIT, "Native fixture executable exceeds the 1 GiB bound");
        mkdirSync(join(pkg, "bin"));
        const binary = join(pkg, "bin", platformBinaryName(target));
        copyFileSync(candidate.executable, binary); chmodSync(binary, 0o755);
      }
      const packed = JSON.parse(await fixtureCommand(runtime.node, [runtime.npm, "pack", pkg, "--json", "--ignore-scripts", "--offline", `--registry=${NPM_REGISTRY}`, "--pack-destination", directory],
        { cwd: directory, env, signal, timeoutMs: 120_000 })) as Array<{ filename: string }>;
      assert.equal(packed.length, 1);
      const tarball = join(directory, packed[0]!.filename);
      assert(statSync(tarball).size <= ARTIFACT_LIMIT, "Fixture tarball exceeds the 1 GiB bound");
      result.push({ name, version: candidate.version, manifest, tarball, size: statSync(tarball).size,
        native: target?.name === options.target, sha256: await fileDigest(tarball), integrity: `sha512-${await fileDigest(tarball, "sha512", "base64")}`, shasum: await fileDigest(tarball, "sha1") });
    }
  }
  return result;
}

async function listen(server: Server): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolvePort((server.address() as AddressInfo).port); });
  });
}

function ownSockets(server: Server) {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  return {
    add(socket: Socket) { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); },
    async close() {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    },
  };
}

export interface ProxyRecord { method: string; target: string; allowed: boolean }
/** Deliberately NOT the general smoke forwarding proxy: it has no external-connect branch. */
export async function startClosedProxy(options: {
  registryPort?: number;
  http?: (request: IncomingMessage, response: ServerResponse, target: URL) => void;
}) {
  const records: ProxyRecord[] = [];
  const record = (entry: ProxyRecord) => { if (records.length >= 2048) return false; records.push(entry); return true; };
  const server = createServer((request, response) => {
    let url: URL | undefined;
    try { url = new URL(request.url ?? ""); } catch { /* Reject malformed proxy URLs. */ }
    const allowed = !!options.http && url?.protocol === "http:" && url.hostname === MODEL_HOST && !url.port;
    if (!record({ method: request.method ?? "GET", target: url?.host ?? "invalid", allowed })) { response.writeHead(429); response.end(); return; }
    if (!allowed || !url) { response.writeHead(502); response.end("Fixture proxy forbids external forwarding"); return; }
    options.http!(request, response, url);
  });
  const sockets = ownSockets(server);
  server.headersTimeout = 10_000; server.requestTimeout = 30_000;
  server.on("connect", (request, client, head) => {
    const allowed = request.url === `${REGISTRY_HOST}:443` && options.registryPort !== undefined;
    if (!record({ method: "CONNECT", target: request.url ?? "", allowed })) { client.destroy(); return; }
    if (!allowed) { client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return; }
    const upstream = connect({ host: "127.0.0.1", port: options.registryPort! });
    sockets.add(upstream);
    const close = () => { client.destroy(); upstream.destroy(); };
    (client as Socket).setTimeout(60_000, close); upstream.setTimeout(60_000, close);
    upstream.once("error", close); client.once("error", close);
    client.once("close", () => upstream.destroy()); upstream.once("close", () => client.destroy());
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, records, close: sockets.close };
}

export interface RegistryRecord { method: string; path: string; status: number; userAgent: string }
export async function startFixtureRegistry(certificate: FixtureCertificate, packages: FixturePackage[], latest: string) {
  const records: RegistryRecord[] = [];
  let gate: { name: string; version: string; hit: boolean; release(): void; promise: Promise<void>; timer: ReturnType<typeof setTimeout> } | undefined;
  const tarballPath = (pkg: FixturePackage) => `/${pkg.name}/-/${pkg.name}-${pkg.version}.tgz`;
  const versionMetadata = (pkg: FixturePackage) => ({ ...pkg.manifest,
    dist: { tarball: `${NPM_REGISTRY.replace(/\/$/, "")}${tarballPath(pkg)}`, integrity: pkg.integrity, shasum: pkg.shasum } });
  const server = createTlsServer({ cert: certificate.cert, key: certificate.key, minVersion: "TLSv1.2" }, (request, response) => {
    void (async () => {
      const path = request.url ?? "";
      const entry = { method: request.method ?? "GET", path, status: 200, userAgent: String(request.headers["user-agent"] ?? "").slice(0, 256) };
      if (records.length >= 2048) { response.writeHead(429); response.end(); return; }
      records.push(entry);
      const fail = (status: number) => { entry.status = status; response.writeHead(status, { "Content-Type": "application/json", Connection: "close" }); response.end(JSON.stringify({ error: "Fixture request rejected" })); };
      if (request.method !== "GET" || request.headers.host !== REGISTRY_HOST) { fail(405); return; }
      const tarball = packages.find(pkg => path === tarballPath(pkg));
      if (tarball) {
        if (tarball.name !== "easyresearch" && !tarball.native) { fail(409); return; }
        if (gate?.name === tarball.name && gate.version === tarball.version) { gate.hit = true; await gate.promise; }
        if (response.destroyed) return;
        response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": tarball.size, "Cache-Control": "no-store" });
        const source = createReadStream(tarball.tarball);
        source.once("error", () => response.destroy()); response.once("close", () => source.destroy()); source.pipe(response);
        return;
      }
      const [, name, version] = path.split("/");
      const found = packages.filter(pkg => pkg.name === name);
      if (!found.length || path !== `/${name}${version ? `/${version}` : ""}`) { fail(404); return; }
      const selected = version ? found.find(pkg => pkg.version === (version === "latest" ? latest : version)) : undefined;
      if (version && !selected) { fail(404); return; }
      const data = JSON.stringify(selected ? versionMetadata(selected) : { name, "dist-tags": { latest }, versions: Object.fromEntries(found.map(pkg => [pkg.version, versionMetadata(pkg)])) });
      assert(Buffer.byteLength(data) <= 256 * 1024, "Fixture metadata exceeded updater bound");
      response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), "Cache-Control": "no-store" }); response.end(data);
    })().catch(() => { response.destroy(); });
  });
  server.headersTimeout = 10_000; server.requestTimeout = 30_000;
  const sockets = ownSockets(server);
  const port = await listen(server);
  return {
    port, records,
    holdTarball(name: string, version: string) {
      assert(!gate, "Only one held tarball is supported");
      let release!: () => void;
      const promise = new Promise<void>(resolveGate => { release = resolveGate; });
      const timer = setTimeout(release, 30_000);
      gate = { name, version, hit: false, release: () => { clearTimeout(timer); release(); }, promise, timer };
      return gate;
    },
    async close() { gate?.release(); await sockets.close(); },
  };
}

export async function waitFixture<T>(label: string, read: () => T | undefined | Promise<T | undefined>, signal: AbortSignal, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const value = await read();
    if (value !== undefined) return value;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
