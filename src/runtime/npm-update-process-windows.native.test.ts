import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runNpmUpdateProcess } from "./npm-update-process";

describe.skipIf(process.platform !== "win32")("native Windows npm process consumer", () => {
  let directory: string; let fixture: string;
  const operations: Array<{ abort: AbortController; settled: Promise<unknown> }> = [];
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "easyresearch-npm-job-")));
    fixture = join(directory, "npm boundary fixture.cjs");
    await writeFile(fixture, `
const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
const [mode,dir,...args]=process.argv.slice(2);
if(mode==='argv')process.stdout.write(JSON.stringify({args,cwd:process.cwd(),proxy:process.env.HTTPS_PROXY,carrier:process.env.EASYRESEARCH_NPM_PROVENANCE,nodeOptions:process.env.NODE_OPTIONS}));
if(mode==='flood'){fs.writeSync(1,Buffer.alloc(300000,97));fs.writeSync(1,Buffer.from([0,13,10,90]));fs.writeSync(2,Buffer.alloc(300000,98));fs.writeSync(2,'tail');process.exit(41);}
if(mode==='leaf'){process.on('SIGTERM',()=>{});fs.writeFileSync(path.join(dir,'leaf'),String(process.pid));setInterval(()=>{},100);}
if(mode==='tree'){const child=cp.spawn(process.execPath,[__filename,'leaf',dir],{stdio:'ignore',detached:true});child.unref();fs.writeFileSync(path.join(dir,'root'),String(process.pid));process.exit(0);}
`);
  });
  afterEach(async () => {
    for (const operation of operations) operation.abort.abort();
    await Promise.all(operations.splice(0).map((operation) => operation.settled));
    await rm(directory, { recursive: true, force: true });
  }, 30_000);
  const launch = (mode: string, args: string[] = []) => {
    const abort = new AbortController();
    const task = runNpmUpdateProcess(process.execPath, [fixture, mode, directory, ...args], { cwd: directory,
      environment: { ...process.env, HOME: directory, USERPROFILE: directory, EASYRESEARCH_CODING_AGENT_DIR: join(directory, "agent"), HTTPS_PROXY: "http://all-traffic.invalid:8080", NODE_OPTIONS: "--require intentionally-missing-preload", EASYRESEARCH_NPM_PROVENANCE: "private-carrier" },
      timeoutMs: 45_000, signal: abort.signal,
    });
    const settled = task.catch((error: unknown) => error); operations.push({ abort, settled });
    return { task, settled, abort };
  };
  const file = async (name: string) => {
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const value = await readFile(join(directory, name), "utf8").catch(() => undefined);
      if (value !== undefined) return value;
      await delay(25);
    }
    throw new Error("Native npm fixture did not start.");
  };
  const dead = (pid: number) => {
    try { process.kill(pid, 0); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
  };
  it("preserves literal argv, scoped environment and bounded output through the actual job adapter", async () => {
    const args = ["", "space value", 'quote"value', "雪 😀", "literal;$HOME"];
    const argv = await launch("argv", args).task;
    expect(JSON.parse(argv.stdout)).toEqual({ args, cwd: directory, proxy: "http://all-traffic.invalid:8080" });
    const output = await launch("flood").task;
    expect(output.code).toBe(41); expect(Buffer.byteLength(output.stdout)).toBe(8192);
    expect(output.stdout.endsWith("\0\r\nZ")).toBe(true); expect(output.stderr.length).toBe(8192); expect(output.stderr.endsWith("tail")).toBe(true);
  }, 90_000);
  it("keeps the consumer pending after root exit, then aborts and joins the surviving detached descendant", async () => {
    const operation = launch("tree"); const leaf = Number(await file("leaf")); const root = Number(await file("root"));
    await expect.poll(() => dead(root)).toBe(true); expect(dead(leaf)).toBe(false);
    expect(await Promise.race([operation.settled.then(() => "settled"), delay(150, "pending")])).toBe("pending");
    operation.abort.abort();
    expect(await operation.settled).toBeInstanceOf(Error);
    expect(dead(leaf)).toBe(true);
  }, 60_000);
});
