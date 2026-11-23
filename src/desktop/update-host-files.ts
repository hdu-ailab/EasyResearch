import { createRequire } from "node:module";
import { physicalUpdateFilePath, updateFileHash, type UpdateFileReader } from "./update-files";

/** Host-only raw bytes: Electron's normal fs exposes an ASAR container as a directory. */
export async function hashDesktopUpdateFile(path: string): Promise<string> {
  // The installed executable anchors only builtin lookup; no baked source path,
  // external package or process-wide ASAR switch is needed.
  const disk = createRequire(process.execPath)("original-fs") as typeof import("node:fs");
  const reader: UpdateFileReader = {
    lstat: file => disk.promises.lstat(file),
    realpath: file => disk.promises.realpath(file),
    read: file => disk.createReadStream(file, { fs: disk }),
  };
  return updateFileHash(await physicalUpdateFilePath(path, reader), reader);
}
