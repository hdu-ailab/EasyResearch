import { closeSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** Small ownership records only; output itself is streamed, never rewritten here. */
export function writeRecord(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, path);
    if (process.platform !== "win32") {
      const directory = openSync(dirname(path), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* Original publication error wins. */ }
    throw error;
  }
}

export function captureOutput(path: string, maximum = 32_000): { output: string; truncated: boolean } {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const count = Math.min(size, maximum);
    const buffer = Buffer.alloc(count);
    const read = readSync(fd, buffer, 0, count, Math.max(0, size - count));
    let output = buffer.subarray(0, read).toString("utf8");
    const truncated = size > maximum;
    if (truncated) output = `[showing the last ${read} bytes; full output saved to ${path}]\n${output}`;
    return { output: output || "(no output)", truncated };
  } finally { closeSync(fd); }
}

/** A bounded call/pump may end before its writer; never claim the snapshot is full. */
export function captureIncompleteOutput(path: string, reason: string) {
  let output: string;
  try { output = captureOutput(path).output; }
  catch { output = "(captured output is not yet available)"; }
  return {
    output: `${output}\n\n[Output capture is incomplete: ${reason} Captured output: ${path}]`,
    truncated: true, incomplete: true, outputPath: path,
  };
}
