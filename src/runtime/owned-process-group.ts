import { readFileSync, readdirSync } from "node:fs";

/** Call only for the detached process group created by this owner's spawn. */
export function hasLiveOwnedProcessGroup(group: number): boolean {
  try { process.kill(-group, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  if (process.platform !== "linux") return true;
  // An orphan zombie cannot run, mutate the installation or retain an open
  // executable. Its eventual reaping belongs to the machine's init process.
  const entries = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  if (entries.length > 131_072) throw new Error("Process group inspection exceeded its limit.");
  for (const pid of entries) {
    let text: string;
    try { text = readFileSync(`/proc/${pid}/stat`, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") continue; throw error; }
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    if (Number(fields[2]) === group && fields[0] !== "Z" && fields[0] !== "X") return true;
  }
  return false;
}

export async function waitForOwnedProcessGroupExit(group: number, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + Math.max(0, timeoutMs);
  do {
    try { if (!hasLiveOwnedProcessGroup(group)) return true; } catch { /* Unknown scope retains custody. */ }
    if (performance.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(20, Math.max(1, deadline - performance.now()))));
  } while (true);
}
