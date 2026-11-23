import { createRequire } from "node:module";
import { updateFileHash } from "./update-files";

/** Host-only raw bytes: Electron's normal fs exposes an ASAR container as a directory. */
export function hashDesktopUpdateFile(path: string): Promise<string> {
  // The installed executable anchors only builtin lookup; no baked source path,
  // external package or process-wide ASAR switch is needed.
  const disk = createRequire(process.execPath)("original-fs") as typeof import("node:fs");
  return updateFileHash(path, {
    lstat: file => disk.promises.lstat(file),
    realpath: file => disk.promises.realpath(file),
    read: file => disk.createReadStream(file, { fs: disk }),
  });
}
