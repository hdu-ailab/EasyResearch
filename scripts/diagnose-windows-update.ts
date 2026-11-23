/** Native CI diagnostic only. No installer or user configuration is used. */
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, win32 } from "node:path";
import { startWindowsUpdateJob } from "../src/runtime/windows-update-job";

async function main(): Promise<void> {
  if (process.platform !== "win32") throw new Error("Windows diagnosis requires a native Windows runner.");
  const root = await mkdtemp(join(tmpdir(), "easyresearch-win-job-diagnostic-"));
  const original = { TEMP: process.env.TEMP, TMP: process.env.TMP };
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT!;
  const where = spawnSync(win32.join(systemRoot, "System32", "where.exe"), ["node"], { encoding: "utf8", timeout: 5000 });
  if (where.status !== 0) throw new Error("The diagnostic requires installed Node.");
  const node = await realpath(where.stdout.trim().split(/\r?\n/)[0]!);
  const result: Record<string, unknown> = { root, canonicalRoot: await realpath(root), driver: { execPath: process.execPath, node: process.versions.node, bun: process.versions.bun }, target: node, cases: [] };
  const inspect = async (directory: string) => {
    const files = [];
    for (const name of await readdir(directory).catch(() => [])) {
      const info = await stat(join(directory, name)).catch(() => undefined);
      const item: Record<string, unknown> = { name, bytes: info?.size, directory: info?.isDirectory(), mode: info?.mode, created: info?.birthtimeMs, modified: info?.mtimeMs };
      if (info?.isDirectory()) {
        item.children = await readdir(join(directory, name)).catch(error => ({ error: (error as NodeJS.ErrnoException).code }));
        const childAcl = spawnSync(win32.join(systemRoot, "System32", "icacls.exe"), [join(directory, name)], { encoding: "utf8", timeout: 5000 });
        item.acl = childAcl.stdout?.slice(-4096); item.aclCode = childAcl.status;
      }
      if (name === "ready.json" || name === "receipt.json") {
        try {
          const data = JSON.parse(await readFile(join(directory, name), "utf8"));
          item.record = Object.fromEntries(["version", "guardPid", "rootPid", "jobEmpty", "code", "failure"].filter(key => key in data).map(key => [key, data[key]]));
        } catch (error) { item.readError = (error as NodeJS.ErrnoException).code; }
      }
      files.push(item);
    }
    const acl = spawnSync(win32.join(systemRoot, "System32", "icacls.exe"), [directory], { encoding: "utf8", timeout: 5000 });
    return { directory, canonical: await realpath(directory).catch(() => undefined), files, acl: acl.stdout?.slice(-4096), aclCode: acl.status };
  };
  try {
    for (const mode of ["echo", "tree"] as const) {
      const area = join(root, mode); await mkdir(area);
      process.env.TEMP = area; process.env.TMP = area;
      const leaf = join(area, "leaf.json");
      const childSource = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(leaf)},JSON.stringify({pid:process.pid}));setInterval(()=>{},100);`;
      const code = mode === "echo" ? "process.stdout.write(JSON.stringify({pid:process.pid,cwd:process.cwd(),node:process.versions.node,bun:process.versions.bun}));"
        : `const fs=require('node:fs'),cp=require('node:child_process');const c=cp.spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{detached:true,stdio:'ignore'});c.once('error',e=>{fs.writeFileSync(${JSON.stringify(join(area, "spawn-error.json"))},JSON.stringify({code:e.code,message:e.message}));process.exit(2)});c.once('spawn',()=>{fs.writeFileSync(${JSON.stringify(join(area, "root.json"))},JSON.stringify({pid:process.pid,child:c.pid}));c.unref();const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(leaf)})){clearInterval(t);process.exit(23)}},20);setTimeout(()=>process.exit(3),5000).unref()});`;
      const record: Record<string, unknown> = { mode }; (result.cases as unknown[]).push(record);
      const start = performance.now(); record.startedAt = Date.now();
      const job = await startWindowsUpdateJob(node, ["-e", code], { cwd: area, env: { ...process.env }, cleanupTimeoutMs: 5000 });
      record.guardPid = job.child.pid; record.createdMs = performance.now() - start;
      let output = "", errors = "";
      job.child.stdout.on("data", chunk => { record.firstOutputMs ??= performance.now() - start; output = (output + chunk.toString()).slice(-4096); });
      job.child.stderr.on("data", chunk => { errors = (errors + chunk.toString()).slice(-4096); });
      job.child.once("exit", (code, signal) => { record.guardExit = { code, signal, atMs: performance.now() - start }; });
      const settled = job.completed.then(value => { record.outcome = value; }, error => { record.error = String(error); });
      const cancelTimer = setTimeout(() => { void job.cancel().catch(error => { record.cancelError = String(error); }); }, 35000);
      let ceiling: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([settled, new Promise<void>(resolve => { ceiling = setTimeout(resolve, 45000); })]); }
      finally { clearTimeout(ceiling); }
      clearTimeout(cancelTimer);
      record.settledMs = performance.now() - start; record.stdout = output; record.stderr = errors;
      for (const name of ["leaf.json", "root.json", "spawn-error.json"]) {
        try { record[name] = JSON.parse(await readFile(join(area, name), "utf8")); } catch {}
      }
      const directories = (await readdir(area)).filter(name => name.startsWith("easyresearch-update-job-"));
      record.beforeDispose = await Promise.all(directories.map(name => inspect(join(area, name))));
      try { await job.dispose(); record.disposed = true; }
      catch (error) { record.disposeError = String(error); }
      record.afterDispose = await Promise.all(directories.map(name => inspect(join(area, name))));
      // A diagnostic may remove only its positively empty, exited guard's files.
      for (const name of directories) {
        const directory = join(area, name);
        try {
          const receipt = JSON.parse(await readFile(join(directory, "receipt.json"), "utf8"));
          if (receipt.jobEmpty === true && receipt.guardPid === job.child.pid && job.child.exitCode !== null) {
            try { await rm(directory, { recursive: true, force: true }); record.directRemoval = "ok"; }
            catch (error) { record.directRemoval = { code: (error as NodeJS.ErrnoException).code, syscall: (error as NodeJS.ErrnoException).syscall, path: basename((error as NodeJS.ErrnoException).path ?? "") }; }
          }
        } catch {}
      }
      console.log(JSON.stringify(record));
    }
  } finally {
    for (const key of ["TEMP", "TMP"] as const) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
    await writeFile(join(root, "report.json"), JSON.stringify(result, null, 2));
    if (process.env.RUNNER_TEMP) await writeFile(join(process.env.RUNNER_TEMP, `windows-job-diagnostic-${process.versions.bun ? "bun" : "node"}.json`), JSON.stringify(result, null, 2));
    console.log(`Diagnostic receipt: ${join(root, "report.json")}`);
  }
}

await main();
