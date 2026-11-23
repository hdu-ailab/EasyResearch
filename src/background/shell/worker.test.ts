import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createManagedShellManager, type ManagedShellService, type ShellNotification } from "./index";
import { revokeShellWorker } from "./worker-client";

const roots: string[] = [];
const services: ManagedShellService[] = [];
const bun = process.platform === "win32" ? "bun.exe" : execFileSync("which", ["bun"], { encoding: "utf8" }).trim();
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function world() {
  const cwd = await mkdtemp(join(tmpdir(), "shell-worker-"));
  roots.push(cwd);
  const errors: unknown[] = [];
  const options = { agentDir: cwd, rootSessionID: "root", cwd, onError: (error: unknown) => { errors.push(error); }, worker: { executable: bun, args: [resolve("src/cli/index.ts"), "--shell-worker"] } };
  const make = () => { const service = createManagedShellManager(options); services.push(service); return service; };
  const manager = make();
  const notices: ShellNotification[] = [];
  manager.attachOwner({ sessionID: "root", cwd, notify: async (notice) => { notices.push(notice); } });
  return { cwd, manager, notices, make, errors };
}

describe.skipIf(process.platform === "win32")("process-only shell worker custody (POSIX process fixtures)", () => {
  it("hands the same process and output to a verified successor without spawning twice", async () => {
    const { cwd, manager, notices, make, errors } = await world();
    const first = await manager.execute("root", { command: "echo once >> count; sleep 0.5; echo finished", background: true });
    expect(errors).toEqual([]);
    await manager.prepareHandoff();
    await manager.dispose({ handoff: true });
    const successor = make();
    successor.attachOwner({ sessionID: "root", cwd, notify: async (notice) => { notices.push(notice); } });
    await successor.recover({ verifyPriorOwner: async () => true });
    expect(errors).toEqual([]);
    expect(successor.tasks()[0]?.pid).toBe(first.pid);
    await expect.poll(() => notices.length).toBe(1);
    expect(notices[0]?.result.exitCode).toBe(0);
    expect(notices[0]?.content).toContain("finished");
    expect(await readFile(join(cwd, "count"), "utf8")).toBe("once\n");
  });
  it("terminal disposal cancels the process rather than leaving a worker orphan", async () => {
    const { manager } = await world();
    const first = await manager.execute("root", { command: "sleep 30", background: true });
    await manager.dispose();
    expect(() => process.kill(first.pid!, 0)).toThrow();
  });
  it("refuses recovery without verified prior ownership", async () => {
    const { manager, make } = await world();
    await manager.execute("root", { command: "sleep 30", background: true });
    await manager.prepareHandoff();
    const successor = make();
    await expect(successor.recover({ verifyPriorOwner: async () => false })).rejects.toThrow("verified");
  });
  it("cancels during worker startup before executing the command", async () => {
    const { cwd, manager } = await world();
    const abort = new AbortController();
    const running = manager.execute("root", { command: "echo started > marker", background: true }, abort.signal);
    abort.abort();
    expect((await running).status).toBe("cancelled");
    await expect(readFile(join(cwd, "marker"))).rejects.toMatchObject({ code: "ENOENT" });
    await manager.dispose();
  });
  it("replays a completion finished during handoff and repairs a foreground result", async () => {
    const { cwd, manager, make, errors } = await world();
    const call = manager.execute("root", { command: "sleep 0.15; echo final" }, undefined, { toolCallID: "original-call" });
    await expect.poll(() => manager.tasks()[0]?.pid).toBeGreaterThan(0);
    await manager.prepareHandoff();
    expect((await call).shellID).toBeTruthy();
    await manager.dispose({ handoff: true });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const successor = make();
    const notices: ShellNotification[] = [];
    successor.attachOwner({ sessionID: "root", cwd, notify: async (notice) => { notices.push(notice); } });
    await successor.recover({ verifyPriorOwner: async () => true });
    await expect.poll(() => notices.length).toBe(1);
    expect(notices[0]?.content).toContain("final");
    expect(notices[0]?.result.exitCode).toBe(0);
    expect(successor.recoveredCalls()).toMatchObject([{ sessionID: "root", toolCallID: "original-call" }]);
    expect(errors).toEqual([]);
  });
  it("does not launch a fallback after an ambiguous worker start response", async () => {
    const { cwd } = await world();
    const fixture = join(cwd, "ambiguous.ts");
    await writeFile(fixture, `
      import {createServer} from 'node:net';
      import {appendFileSync} from 'node:fs';
      let init=''; for await (const chunk of process.stdin) init+=chunk;
      const data=JSON.parse(init);
      const server=createServer(socket=>{
        socket.setEncoding('utf8'); let text='';
        socket.on('data',chunk=>{ text+=chunk; let end;
          while((end=text.indexOf('\\n'))!==-1){
            const message=JSON.parse(text.slice(0,end)); text=text.slice(end+1);
            if(message.op==='attach') socket.write(JSON.stringify({id:message.id})+'\\n');
            if(message.op==='start'){ appendFileSync(${JSON.stringify(join(cwd, "count"))},'worker\\n'); socket.destroy(); server.close(); }
          }
        });
      });
      server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({version:1,port:server.address().port,workerPID:process.pid})));
    `);
    const manager = createManagedShellManager({ agentDir: cwd, rootSessionID: "ambiguous", cwd, worker: { executable: bun, args: [fixture] } });
    services.push(manager);
    manager.attachOwner({ sessionID: "ambiguous", cwd, notify: async () => {} });
    const result = await manager.execute("ambiguous", { command: "echo fallback >> count", background: true });
    expect(result.status).toBe("error");
    expect(await readFile(join(cwd, "count"), "utf8")).toBe("worker\n");
  });
  it("falls back only when the worker is unavailable before admission", async () => {
    const { cwd } = await world();
    const manager = createManagedShellManager({ agentDir: cwd, rootSessionID: "fallback", cwd, worker: { executable: join(cwd, "missing-worker"), args: [] } });
    services.push(manager);
    manager.attachOwner({ sessionID: "fallback", cwd, notify: async () => {} });
    const result = await manager.execute("fallback", { command: "echo once >> count" });
    expect(result.exitCode).toBe(0);
    expect(await readFile(join(cwd, "count"), "utf8")).toBe("once\n");
  });
  it("keeps an already admitted command when restart races worker registration", async () => {
    const { cwd, manager, make } = await world();
    const running = manager.execute("root", { command: "echo once >> count; sleep 0.25; echo finish", background: true });
    await manager.prepareHandoff();
    const first = await running;
    expect(first.status).toBe("running");
    await manager.dispose({ handoff: true });
    const next = make();
    const notices: ShellNotification[] = [];
    next.attachOwner({ sessionID: "root", cwd, notify: async (notice) => { notices.push(notice); } });
    await next.recover({ verifyPriorOwner: async () => true });
    await expect.poll(() => notices.length).toBe(1);
    expect(notices[0]?.result.exitCode).toBe(0);
    expect(await readFile(join(cwd, "count"), "utf8")).toBe("once\n");
  });
  it("releases a worker whose final result was persisted between prepare and detach", async () => {
    const { cwd, manager, make } = await world();
    await manager.execute("root", { command: "sleep 0.15; echo done", background: true });
    await manager.prepareHandoff();
    await expect.poll(() => manager.tasks()[0]?.status).toBe("completed");
    const [bucket] = await readdir(join(cwd, "background", "shell"));
    const directory = join(cwd, "background", "shell", bucket!);
    const [file] = (await readdir(directory)).filter((name) => name.endsWith(".json"));
    const record = JSON.parse(await readFile(join(directory, file!), "utf8"));
    await manager.dispose({ handoff: true });
    const next = make();
    next.attachOwner({ sessionID: "root", cwd, notify: async () => {} });
    await next.recover({ verifyPriorOwner: async () => true });
    await next.dispose();
    await expect.poll(() => {
      try { process.kill(record.worker.workerPID, 0); return true; } catch { return false; }
    }).toBe(false);
  });
  it.each([false, true])("revokes detached handoff on terminal Exit (successor attached: %s)", async (attached) => {
    const { cwd, manager, make } = await world();
    const running = await manager.execute("root", { command: "sleep 30", background: true });
    await manager.prepareHandoff();
    await manager.dispose({ handoff: true });
    if (attached) {
      const next = make();
      next.attachOwner({ sessionID: "root", cwd, notify: async () => {} });
      await next.recover({ verifyPriorOwner: async () => true });
    }
    await manager.revokeHandoff();
    await manager.revokeHandoff();
    expect(() => process.kill(running.pid!, 0)).toThrow();
  });
  it("rejects forged revocation custody without stopping the admitted command", async () => {
    const { cwd, manager } = await world();
    const running = await manager.execute("root", { command: "sleep 30", background: true });
    await manager.prepareHandoff();
    const [bucket] = await readdir(join(cwd, "background", "shell"));
    const directory = join(cwd, "background", "shell", bucket!);
    const [file] = (await readdir(directory)).filter((name) => name.endsWith(".json"));
    const record = JSON.parse(await readFile(join(directory, file!), "utf8"));
    await expect(revokeShellWorker(record.worker, { ...record.handoff, ticket: "invalid-ticket" })).rejects.toThrow("Invalid shell revocation custody");
    expect(() => process.kill(running.pid!, 0)).not.toThrow();
    await manager.revokeHandoff();
    expect(() => process.kill(running.pid!, 0)).toThrow();
  });
  it("expires abandoned prepared custody and stops its command", async () => {
    const { manager } = await world();
    const running = await manager.execute("root", { command: "sleep 60", background: true });
    await manager.prepareHandoff();
    await manager.dispose({ handoff: true });
    await expect.poll(() => {
      try { process.kill(running.pid!, 0); return true; } catch { return false; }
    }, { timeout: 35_000, interval: 100 }).toBe(false);
    await manager.revokeHandoff();
  }, 40_000);
});
