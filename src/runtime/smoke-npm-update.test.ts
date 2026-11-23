import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as connectTls } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRegistryCertificate, fixtureCommand, fixtureEnvironment, fixtureRuntime, packUpdateFixtures,
  REGISTRY_HOST, startClosedProxy, startFixtureRegistry, waitFixture, withFixtureProxy,
} from "../../scripts/smoke-npm-update-fixture";
import { assertNativeLinuxExecutable, fixtureProcesses, parseNpmUpdateSmokeOptions } from "../../scripts/smoke-npm-update";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "easyresearch-npm-update-fixture-test-")));
  roots.push(path); return path;
}

function tlsHandshake(port: number, ca?: Buffer, servername = REGISTRY_HOST): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connectTls({ host: "127.0.0.1", port, servername, ca, rejectUnauthorized: true });
    socket.setTimeout(3000, () => socket.destroy(new Error("Fixture TLS deadline")));
    socket.once("error", reject);
    socket.once("secureConnect", () => { socket.destroy(); resolve(); });
  });
}

function deniedConnect(proxy: string, authority: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL(proxy);
    const req = request({ hostname: url.hostname, port: url.port, method: "CONNECT", path: authority });
    req.setTimeout(3000, () => req.destroy(new Error("Proxy deadline")));
    req.once("error", reject);
    req.once("connect", (res, socket) => { socket.destroy(); resolve(res.statusCode!); });
    req.end();
  });
}

describe("two-version npm native acceptance inputs", () => {
  it("requires explicit distinct stable versions in increasing order", () => {
    const args = ["--old-bin", "/old/executable", "--old-version", "0.1.23", "--new-bin", "/new/executable", "--new-version", "0.1.24"];
    expect(parseNpmUpdateSmokeOptions(args)).toMatchObject({ oldVersion: "0.1.23", newVersion: "0.1.24", timeoutMs: 600_000 });
    expect(() => parseNpmUpdateSmokeOptions(args.slice(0, -2))).toThrow(/Required/);
    for (const version of ["0.1.23", "0.1.22", "latest", "0.1.24-test", "01.2.3"]) {
      expect(() => parseNpmUpdateSmokeOptions([...args.slice(0, -1), version])).toThrow();
    }
    expect(() => parseNpmUpdateSmokeOptions([...args, "--old-bin", "/other"])).toThrow(/repeated/);
  });

  it.skipIf(process.platform !== "linux")("rejects executable script stand-ins as native acceptance", () => {
    const file = join(root(), "fake executable");
    writeFileSync(file, "#!/bin/sh\nprintf 'easyresearch 0.1.23\\n'\n", { mode: 0o755 });
    expect(() => assertNativeLinuxExecutable(file)).toThrow(/ELF/);
  });
});

describe.skipIf(process.platform !== "linux")("offline npm fixture plumbing (not native product acceptance)", () => {
  it("isolates config and bounds child-process lifetime", async () => {
    const directory = root(); const runtime = fixtureRuntime(); const env = fixtureEnvironment(directory, runtime);
    expect(env.HOME).toBe(join(directory, "home"));
    expect(env.NODE_OPTIONS).toBeUndefined(); expect(env.NODE_PATH).toBeUndefined(); expect(env.NPM_TOKEN).toBeUndefined();
    expect(env.EASYRESEARCH_SKIP_SETUP).toBeUndefined();
    expect(env.npm_config_strict_ssl).toBe("true"); expect(env.NODE_TLS_REJECT_UNAUTHORIZED).toBe("1");
    await expect(fixtureCommand(runtime.node, ["-e", "setInterval(() => {}, 1000)"], { cwd: directory, env, timeoutMs: 100 })).rejects.toThrow(/timed out/);
    expect(fixtureProcesses(directory)).toEqual([]);
  });

  it("uses strict trusted TLS and real npm for two private global installs through a closed CONNECT proxy", async () => {
    const directory = root(); const runtime = fixtureRuntime(); const env = fixtureEnvironment(directory, runtime);
    const signal = AbortSignal.timeout(90_000);
    const certificate = await createRegistryCertificate(join(directory, "tls"), runtime, env, signal);
    const deny = await startClosedProxy({});
    const trusted = withFixtureProxy({ ...env, NODE_EXTRA_CA_CERTS: certificate.caPath, npm_config_cafile: certificate.caPath }, deny.url);
    const target = `linux-${process.arch}`;
    const candidates = ["0.1.23", "0.1.24"].map(version => {
      const executable = join(directory, `fake-${version}`);
      writeFileSync(executable, `#!/bin/sh\nprintf 'easyresearch ${version}\\n'\n`, { mode: 0o755 });
      return { version, executable };
    });
    let registry: Awaited<ReturnType<typeof startFixtureRegistry>> | undefined;
    let proxy: Awaited<ReturnType<typeof startClosedProxy>> | undefined;
    try {
      const packages = await packUpdateFixtures({ directory: join(directory, "packages"), runtime, env: trusted, target, candidates, signal });
      registry = await startFixtureRegistry(certificate, packages, candidates[1]!.version);
      await expect(tlsHandshake(registry.port)).rejects.toThrow();
      await expect(tlsHandshake(registry.port, readFileSync(certificate.caPath), "wrong-host.invalid")).rejects.toThrow();
      await expect(tlsHandshake(registry.port, readFileSync(certificate.caPath))).resolves.toBeUndefined();
      proxy = await startClosedProxy({ registryPort: registry.port });
      expect(await deniedConnect(proxy.url, "unmapped.invalid:443")).toBe(502);
      const installerEnv = withFixtureProxy(trusted, proxy.url);
      const prefix = join(directory, "nondefault prefix with spaces");
      const cwd = join(directory, "project"); mkdirSync(cwd, { recursive: true });
      const install = (version: string) => fixtureCommand(runtime.node, [runtime.npm, "install", "--global", "--prefix", prefix,
        `easyresearch@${version}`, "--registry=https://registry.npmjs.org/", "--ignore-scripts", "--include=optional", "--no-audit", "--no-fund"],
      { cwd, env: installerEnv, signal, timeoutMs: 30_000 });
      for (const candidate of candidates) {
        const gate = candidate === candidates[1] ? registry.holdTarball(`easyresearch-${target}`, candidate.version) : undefined;
        let finished = false;
        let installError: unknown;
        const task = install(candidate.version).then(() => { finished = true; }, error => { installError = error; });
        if (gate) {
          try {
            await waitFixture("new tarball gate", () => { if (installError) throw installError; return gate.hit ? true : undefined; }, signal);
            expect(finished).toBe(false);
          } finally { gate.release(); await task; }
        }
        await task;
        if (installError) throw installError;
        const link = join(prefix, "bin", "easyresearch");
        expect(realpathSync(link)).toBe(join(prefix, "lib", "node_modules", "easyresearch", "launcher.mjs"));
        const meta = JSON.parse(readFileSync(join(prefix, "lib", "node_modules", "easyresearch", "package.json"), "utf8"));
        const platformPath = createRequire(realpathSync(link)).resolve(`easyresearch-${target}/package.json`);
        expect(JSON.parse(readFileSync(platformPath, "utf8")).version).toBe(meta.version);
        expect(meta.version).toBe(candidate.version);
        expect((await fixtureCommand(link, ["--version"], { cwd, env: installerEnv, signal })).trim()).toBe(`easyresearch ${candidate.version}`);
      }
      expect(registry.records.every(record => record.method === "GET" && record.status === 200)).toBe(true);
      expect(registry.records.filter(record => record.path === `/easyresearch-${target}/-/easyresearch-${target}-0.1.24.tgz`)).toHaveLength(1);
      expect(registry.records.some(record => record.userAgent.startsWith("npm/"))).toBe(true);
      expect(proxy.records.filter(record => record.allowed).every(record => record.target === `${REGISTRY_HOST}:443`)).toBe(true);
      expect(deny.records).toEqual([]);
    } finally { await proxy?.close(); await registry?.close(); await deny.close(); }
  }, 100_000);
});
