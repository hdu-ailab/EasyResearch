import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WINDOWS_UPDATE_JOB_SOURCE } from "../src/runtime/windows-update-job/host-source";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED = join(ROOT, "src", "generated", "windows-update-job-host.ts");

/** Build-only compiler: shipped update operations never invoke CodeDOM or csc. */
export async function compileWindowsUpdateAssembly(): Promise<Buffer> {
  if (process.platform !== "win32") throw new Error("The Windows update guard requires a native Windows build.");
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot || !/^[a-z]:\\/i.test(systemRoot)) throw new Error("Windows framework compiler is unavailable.");
  const compiler = await realpath(win32.join(systemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"));
  const directory = await mkdtemp(join(tmpdir(), "easyresearch-update-assembly-"));
  try {
    const source = join(directory, "guard.cs");
    const assembly = join(directory, "guard.dll");
    await writeFile(source, WINDOWS_UPDATE_JOB_SOURCE, "utf8");
    await promisify(execFile)(compiler, ["/nologo", "/target:library", "/platform:anycpu", "/optimize+",
      "/reference:System.dll", "/reference:System.Core.dll", "/reference:System.Web.Extensions.dll",
      `/out:${assembly}`, source], { cwd: directory, windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 });
    return await readFile(assembly);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** The accepted binary/bundle contains these exact bytes; the checkout stays a stub. */
export async function withGeneratedWindowsUpdateAssembly<T>(modulePath: string, assembly: Uint8Array, operation: () => Promise<T>): Promise<T> {
  if (assembly.byteLength < 2 || assembly.byteLength > 96 * 1024 || assembly[0] !== 77 || assembly[1] !== 90) {
    throw new Error("Invalid Windows update assembly.");
  }
  const previous = await readFile(modulePath);
  try {
    await writeFile(modulePath, `// Generated only for this Windows build.\nexport const WINDOWS_UPDATE_JOB_ASSEMBLY = ${JSON.stringify(Buffer.from(assembly).toString("base64"))};\n`);
    return await operation();
  } finally { await writeFile(modulePath, previous); }
}

export async function withWindowsUpdateAssembly<T>(windows: boolean, operation: () => Promise<T>): Promise<T> {
  if (!windows) return operation();
  return withGeneratedWindowsUpdateAssembly(GENERATED, await compileWindowsUpdateAssembly(), operation);
}

// Native source tests/diagnostics use the same preparation as the actual bundles.
if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (!command) throw new Error("Usage: bun scripts/windows-update-assembly.ts <command> [arguments...]");
  const code = await withWindowsUpdateAssembly(true, () => new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, env: process.env, stdio: "inherit", shell: false, windowsHide: true });
    child.once("error", reject);
    child.once("close", (code, signal) => signal ? reject(new Error(`Windows verification interrupted: ${signal}`)) : resolve(code ?? 1));
  }));
  process.exitCode = code;
}
