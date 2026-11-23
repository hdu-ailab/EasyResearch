import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNpmUpdateController } from "./npm-update-host";
import { acquireTransitionLease } from "../cli/runtime-lease";
import type { NpmProvenance } from "./npm-update-provenance";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe.skipIf(process.platform === "win32")("real npm-update process boundary", () => {
  it("uses captured Node/npm, exact original prefix, sanitized child environment and verified package bytes", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "npm-update-host-"))); roots.push(root);
    const prefix = join(root, "user prefix's install");
    const metaRoot = join(prefix, "lib/node_modules/easyresearch");
    const platformRoot = join(metaRoot, "node_modules/easyresearch-linux-x64");
    const node = join(root, "runtime/bin/node");
    const npmRoot = join(root, "runtime/lib/node_modules/npm");
    const agentDir = join(root, "agent"); const receipt = join(root, "receipt.json");
    for (const dir of [dirname(node), join(npmRoot, "bin"), join(platformRoot, "bin"), join(prefix, "bin"), agentDir]) mkdirSync(dir, { recursive: true });
    copyFileSync(process.execPath, node);
    const launcher = join(metaRoot, "launcher.mjs"); writeFileSync(launcher, "");
    symlinkSync(launcher, join(prefix, "bin/easyresearch"));
    const binary = join(platformRoot, "bin/easyresearch");
    const meta = { name: "easyresearch", version: "1.0.0", bin: { easyresearch: "launcher.mjs" }, optionalDependencies: { "easyresearch-linux-x64": "1.0.0" } };
    writeFileSync(join(metaRoot, "package.json"), JSON.stringify(meta));
    writeFileSync(join(platformRoot, "package.json"), JSON.stringify({ name: "easyresearch-linux-x64", version: "1.0.0" }));
    writeFileSync(binary, "#!/bin/sh\nprintf 'easyresearch 1.0.0\\n'\n", { mode: 0o755 });
    writeFileSync(join(npmRoot, "package.json"), JSON.stringify({ name: "npm", version: "10.0.0", bin: { npm: "bin/npm-cli.js" } }));
    const npm = join(npmRoot, "bin/npm-cli.js");
    writeFileSync(npm, `const fs = require('node:fs');
if(process.argv[2] === '--version') { console.log('10.0.0'); } else {
 const p = ${JSON.stringify({ receipt, metaRoot, platformRoot, binary, badVersion: join(root, "bad-version"), hold: join(root, "hold-before-exit"), written: join(root, "manifests-written") })};
 const count=fs.existsSync(p.receipt)?JSON.parse(fs.readFileSync(p.receipt,'utf8')).count+1:1;
 fs.writeFileSync(p.receipt, JSON.stringify({ count,args:process.argv.slice(2), carrier: process.env.EASYRESEARCH_NPM_PROVENANCE, proxy:process.env.HTTPS_PROXY }));
 const meta=JSON.parse(fs.readFileSync(p.metaRoot+'/package.json','utf8')); meta.version='2.0.0'; meta.optionalDependencies['easyresearch-linux-x64']='2.0.0';
 fs.writeFileSync(p.metaRoot+'/package.json',JSON.stringify(meta));
 fs.writeFileSync(p.platformRoot+'/package.json',JSON.stringify({name:'easyresearch-linux-x64',version:'2.0.0'}));
 fs.writeFileSync(p.binary,"#!/bin/sh\\nprintf 'easyresearch "+(fs.existsSync(p.badVersion)?'1.0.0':'2.0.0')+"\\\\n'\\n"); fs.chmodSync(p.binary,0o755);
 if(fs.existsSync(p.hold)){ fs.writeFileSync(p.written,''); setInterval(()=>{},100); }
}`);
    symlinkSync(npm, join(dirname(node), "npm"));
    const provenance: NpmProvenance = { schema: 1, metaRoot, launcher, platformManifest: join(platformRoot, "package.json"), binary, nodeExecutable: node, version: "1.0.0", platform: "linux", arch: "x64" };
    const controller = createNpmUpdateController({ owner: "cli", currentVersion: "1.0.0", agentDir,
      environment: { PATH: "/unavailable", HTTPS_PROXY: "http://all-traffic.example:8080", EASYRESEARCH_NPM_PROVENANCE: "must-not-reach-npm" },
      fetch: async () => Response.json({ name: "easyresearch", version: "2.0.0" }),
      lifecycle: { provenance, reserve: () => acquireTransitionLease(agentDir, "cli", { timeoutMs: 0 }), activate() { throw new Error("activation not requested"); } },
      busy: () => ({ code: "RUNTIME_BUSY", activeSessions: 0, authFlowActive: false }), beginShutdown() { throw new Error("installation must preserve active work"); },
    });
    try {
      writeFileSync(join(root, "hold-before-exit"), "");
      await controller.action({ action: "check" });
      await vi.waitFor(() => expect(controller.snapshot().phase).toBe("available"));
      const id = controller.snapshot().operationId!;
      await controller.action({ action: "install", operationId: id });
      await vi.waitFor(() => expect(existsSync(join(root, "manifests-written"))).toBe(true));
      await controller.action({ action: "cancel", operationId: id });
      rmSync(join(root, "hold-before-exit"));
      await controller.action({ action: "check" });
      await vi.waitFor(() => expect(controller.snapshot().phase).toBe("available"));
      await controller.action({ action: "install", operationId: controller.snapshot().operationId! });
      await vi.waitFor(() => expect(controller.snapshot().phase).toBe("ready"), { timeout: 5000 });
      expect(controller.snapshot().currentVersion).toBe("1.0.0");
      const actual = JSON.parse(readFileSync(receipt, "utf8"));
      expect(actual.args).toEqual(["install", "--global", "--prefix", prefix, "easyresearch@2.0.0", "--registry=https://registry.npmjs.org/", "--ignore-scripts", "--include=optional", "--no-audit", "--no-fund"]);
      expect(actual.carrier).toBeUndefined(); expect(actual.proxy).toBe("http://all-traffic.example:8080");
      await expect(acquireTransitionLease(agentDir, "cli", { timeoutMs: 0 })).rejects.toThrow();
      await controller.action({ action: "cancel", operationId: controller.snapshot().operationId! });
      expect(readdirSync(join(agentDir, "bin")).filter((name) => name.startsWith("easyresearch-"))).toEqual([]);
      const retryInstall = async () => {
        await controller.action({ action: "check" });
        await vi.waitFor(() => expect(controller.snapshot().phase).toBe("available"));
        await controller.action({ action: "install", operationId: controller.snapshot().operationId! });
      };
      await retryInstall();
      await vi.waitFor(() => expect(controller.snapshot().phase).toBe("ready"), { timeout: 5000 });
      expect(JSON.parse(readFileSync(receipt, "utf8")).count).toBe(3);
      expect(controller.snapshot().currentVersion).toBe("1.0.0");
      await controller.action({ action: "cancel", operationId: controller.snapshot().operationId! });
      writeFileSync(join(root, "bad-version"), "");
      await retryInstall();
      await vi.waitFor(() => expect(controller.snapshot().phase).toBe("failed"), { timeout: 5000 });
      rmSync(join(root, "bad-version"));
      await retryInstall();
      await vi.waitFor(() => expect(controller.snapshot().phase).toBe("ready"), { timeout: 5000 });
      expect(JSON.parse(readFileSync(receipt, "utf8")).count).toBe(5);
    } finally { await controller.close(); }
  });
});
