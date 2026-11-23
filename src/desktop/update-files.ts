import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export async function regularUpdateFile(path: string, max = 2 * 1024 * 1024 * 1024): Promise<number> {
  if (!isAbsolute(path) || path.includes("\0")) throw new Error("Invalid update file path.");
  const stat = await lstat(path);
  const physical = await realpath(path);
  const expected = resolve(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > max
    || (process.platform === "win32" ? physical.toLowerCase() !== expected.toLowerCase() : physical !== expected)) throw new Error("Invalid update file.");
  return stat.size;
}

export async function updateFileHash(path: string): Promise<string> {
  await regularUpdateFile(path);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function writeUpdateJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
}

/** A recoverable same-filesystem copy; never traverse links or partially replace the old tree. */
export async function backupWindowsInstallation(source: string, destination: string, signal: AbortSignal, onCreated: () => void): Promise<void> {
  if (dirname(source) !== dirname(destination)) throw new Error("Update backup must share the installation filesystem.");
  await mkdir(destination, { mode: 0o700 });
  onCreated();
  let entries = 0; let bytes = 0;
  const copy = async (from: string, to: string, depth: number): Promise<void> => {
    signal.throwIfAborted();
    if (++entries > 20_000 || depth > 24) throw new Error("Installation backup exceeds its limits.");
    const stat = await lstat(from);
    if (stat.isSymbolicLink()) throw new Error("Linked installations require a manual update.");
    if (stat.isDirectory()) {
      await mkdir(to, { mode: stat.mode });
      for (const child of await readdir(from)) await copy(join(from, child), join(to, child), depth + 1);
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > 4 * 1024 * 1024 * 1024) throw new Error("Installation backup exceeds its size limit.");
      const output = await open(to, "wx", stat.mode);
      try {
        let copied = 0;
        for await (const chunk of createReadStream(from)) {
          signal.throwIfAborted();
          const data = chunk as Buffer;
          copied += data.length;
          if (copied > stat.size) throw new Error("Installation changed during backup.");
          let offset = 0;
          while (offset < data.length) {
            const result = await output.write(data, offset, data.length - offset);
            if (!result.bytesWritten) throw new Error("Installation backup write failed.");
            offset += result.bytesWritten;
          }
        }
        if (copied !== stat.size) throw new Error("Installation changed during backup.");
        await output.sync();
      } finally { await output.close(); }
    } else throw new Error("Unsupported installation file.");
  };
  for (const child of await readdir(source)) await copy(join(source, child), join(destination, child), 0);
}
