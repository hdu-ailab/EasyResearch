import { lstatSync, opendirSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readAgentAliases } from "../subagent/agent-alias";
import { readSubagentJournal } from "../subagent/job-journal";
import { readSubagentSessionLinks } from "../subagent/session-links";
import type { SubagentSessionStore } from "./subagent-sessions";

export interface SessionHistoryTarget {
  id: string;
  path: string;
  cwd: string;
}

export interface DeleteSessionHistoryOptions {
  sessionsDir: string;
  store: SubagentSessionStore;
  allowMissingRoot?: boolean;
  removeFile?: (path: string) => void;
}

export class SessionHistoryConflictError extends Error {}

export async function deleteSessionHistory(
  target: SessionHistoryTarget,
  options: DeleteSessionHistoryOptions,
): Promise<string[]> {
  const { store, removeFile = unlinkSync } = options;
  const listed = await store.listAll();
  const sessionsDir = resolve(options.sessionsDir);
  const physicalStore = realpathSync(sessionsDir);
  const conflict = (message: string): never => { throw new SessionHistoryConflictError(message); };
  const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
  const parentPaths = new Map<string, string>();

  const inspect = (session: { id?: string; cwd?: string; path: string }, allowMissing: boolean) => {
    const within = relative(sessionsDir, session.path);
    if (
      !isAbsolute(session.path) || resolve(session.path) !== session.path
      || !within || isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)
      || extname(session.path) !== ".jsonl"
      || realpathSync(sessionsDir) !== physicalStore
    ) conflict("Session history is outside the physical session store.");

    // Check every component, including ancestors of an already-missing file.
    const parts = within.split(sep);
    let path = sessionsDir;
    try {
      for (const [index, part] of parts.entries()) {
        path = join(path, part);
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
          conflict("Session history must be an ordinary file without symlink redirection.");
        }
        if (realpathSync(path) !== join(physicalStore, ...parts.slice(0, index + 1))) {
          conflict("Session history has a redirected physical path.");
        }
      }
      if (session.id === undefined) return conflict("Session fork source is missing from the verified inventory.");
      // Pi skips malformed lines and normalizes cwd in memory; neither may repair deletion authority.
      const header = JSON.parse(readFileSync(session.path, "utf8").split("\n", 1)[0]!) as {
        type?: unknown; id?: unknown; cwd?: unknown; parentSession?: unknown;
      } | null;
      if (header?.type !== "session" || header.id !== session.id
        || typeof header.cwd !== "string" || !header.cwd.trim()
        || session.cwd !== undefined && header.cwd !== session.cwd) {
        conflict("Session history has no matching original header.");
      }
      const manager = store.open(session.path);
      if (
        manager.getSessionId() !== session.id || manager.getCwd() !== header?.cwd
        || manager.getSessionFile() !== session.path
      ) conflict("Session history UUID, cwd, or mapped path changed.");
      if (header?.parentSession !== undefined) {
        if (typeof header.parentSession !== "string" || !header.parentSession) return conflict("Session fork provenance is invalid.");
        parentPaths.set(session.id, header.parentSession);
      }
      return manager;
    } catch (error) {
      if (allowMissing && isMissing(error)) return undefined;
      if (error instanceof SessionHistoryConflictError) throw error;
      if ((error as NodeJS.ErrnoException | null)?.code && !isMissing(error)) throw error;
      return conflict("Session history cannot be verified.");
    }
  };

  const matches = listed.filter((session) => session.id === target.id || session.path === target.path);
  if (matches.length > 1 || matches.some((session) =>
    session.id !== target.id || session.path !== target.path || session.cwd !== target.cwd)) {
    conflict("Session history does not match its native listing.");
  }
  const root = inspect(target, options.allowMissingRoot === true);
  if (!root) {
    if (matches.length) conflict("A listed root session disappeared.");
    return [target.id];
  }
  if (matches.length !== 1) conflict("Root session is missing from the native listing.");

  type History = { id: string; cwd?: string; path?: string; children: Set<string> };
  const histories = new Map<string, History>();
  const paths = new Map<string, string>();
  const pending: History[] = [];
  const ownerEdges = new Map<string, Array<{ owner?: string; child: string; launchId?: string }>>();
  const remember = (id: string, cwd: string | undefined, path?: string): History => {
    const previous = histories.get(id);
    if (
      previous && (cwd !== undefined && previous.cwd !== undefined && previous.cwd !== cwd
        || path !== undefined && previous.path !== undefined && previous.path !== path)
      || path !== undefined && paths.has(path) && paths.get(path) !== id
    ) conflict("Session history has ambiguous UUID/path mappings.");
    const history = previous ?? { id, cwd, children: new Set<string>() };
    if (cwd !== undefined) history.cwd = cwd;
    if (path !== undefined) {
      paths.set(path, id);
      if (previous && history.path === undefined) pending.push(history);
      history.path = path;
    }
    if (!previous) {
      histories.set(id, history);
      pending.push(history);
    }
    return history;
  };
  remember(target.id, target.cwd, target.path);
  for (const session of listed) remember(session.id, session.cwd, session.path);

  for (const history of pending) {
    if (!history.path) continue;
    const manager = history.id === target.id ? root
      : inspect({ ...history, path: history.path }, true);
    if (!manager) continue;
    remember(history.id, manager.getCwd(), history.path);
    const entries = manager.getEntries();
    const jobs = readSubagentJournal(entries).jobs;
    const aliases = readAgentAliases(entries);
    const aliasesById = new Map(aliases.map((alias) => [alias.id, alias]));
    const links = readSubagentSessionLinks(entries);
    const mapped = (id: string, path?: string, owner?: string, launchId?: string) => {
      // Forks supply references, not a cwd for children that may never have existed.
      const cwd = parentPaths.has(history.id) ? undefined : history.cwd;
      remember(id, cwd, path);
      history.children.add(id);
      let edges = ownerEdges.get(history.id);
      if (!edges) ownerEdges.set(history.id, edges = []);
      edges.push({ owner, child: id, launchId });
    };
    // Display state is not ownership: created and suppressed launches count too.
    for (const job of jobs.values()) {
      const alias = aliasesById.get(job.agentId);
      if (alias && job.childSessionId && (
        alias.sessionId !== job.childSessionId || alias.sessionPath !== job.sessionPath || alias.agent !== job.agent
      )) conflict("Session alias contradicts its journaled identity.");
      if (job.childSessionId && job.sessionPath) mapped(job.childSessionId, job.sessionPath, job.ownerSessionId, job.launchId);
    }
    for (const alias of aliases) mapped(alias.sessionId, alias.sessionPath);
    for (const link of links) {
      const job = link.launchId === undefined ? undefined : jobs.get(link.launchId);
      const alias = link.agentId === undefined ? undefined : aliasesById.get(link.agentId);
      if (job && (
        job.childSessionId !== link.childSessionId || job.agent !== link.agent || job.toolCallId !== link.toolCallId
        || job.ownerSessionId !== (link.ownerSessionId ?? history.id)
        || link.agentId !== undefined && job.agentId !== link.agentId
      ) || alias && (alias.sessionId !== link.childSessionId || alias.agent !== link.agent)) {
        conflict("Session link contradicts its journaled or aliased identity.");
      }
      mapped(link.childSessionId, histories.get(link.childSessionId)?.path, link.ownerSessionId, link.launchId);
    }
  }

  // Native summary parsing can silently omit a readable owner. Prove completeness
  // against its current two-level layout, without discovering new deletion targets.
  let remainingEntries = 100_000;
  const verifyPhysicalInventory = (directory: string, projectDirectory = false): void => {
    const stat = lstatSync(directory === sessionsDir ? physicalStore : directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || realpathSync(directory) !== join(physicalStore, relative(sessionsDir, directory))) {
      conflict("Session inventory has an unsafe directory.");
    }
    const handle = opendirSync(directory);
    try {
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
        if (--remainingEntries < 0) conflict("Session inventory exceeds the verification limit.");
        const path = join(directory, entry.name);
        if (!projectDirectory) {
          if (entry.isSymbolicLink()) conflict("Session inventory has an unverified linked directory.");
          if (entry.isDirectory()) verifyPhysicalInventory(path, true);
          continue;
        }
        if (!entry.name.endsWith(".jsonl")) continue;
        const file = lstatSync(path);
        if (!file.isFile() || file.isSymbolicLink()
          || realpathSync(path) !== join(physicalStore, relative(sessionsDir, path))) {
          conflict("Session inventory has an unsafe history file.");
        }
        // Native forks retain ownership entries even when their cwd changes.
        if (!paths.has(path)) conflict("Session inventory omits a potentially related history.");
      }
    } finally {
      handle.closeSync();
    }
  };
  verifyPhysicalInventory(sessionsDir);

  const postorder = (roots: Iterable<string>, cwd?: string): string[] => {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const ordered: string[] = [];
    const visit = (id: string) => {
      if (cwd !== undefined && histories.get(id)!.cwd !== cwd) return;
      if (visiting.has(id)) conflict("Session history ownership contains a cycle.");
      if (visited.has(id)) return;
      visiting.add(id);
      for (const child of histories.get(id)!.children) visit(child);
      visiting.delete(id);
      visited.add(id);
      ordered.push(id);
    };
    for (const id of roots) visit(id);
    return ordered;
  };
  for (const [sourceId, edges] of ownerEdges) {
    const source = histories.get(sourceId)!;
    const reachable = new Set(postorder([sourceId]));
    const ancestors = new Set<string>();
    let parentPath = parentPaths.get(sourceId);
    let missingParent = false;
    while (parentPath !== undefined) {
      const parentId = paths.get(parentPath);
      if (parentId === undefined) {
        // A removed source is provenance only. Never derive its UUID from its filename
        // or add a synthetic owner that would keep the fork's children alive forever.
        inspect({ path: parentPath }, true);
        missingParent = true;
        break;
      }
      if (parentId === sourceId || ancestors.has(parentId)) conflict("Session fork provenance contains a cycle.");
      ancestors.add(parentId);
      parentPath = parentPaths.get(parentId);
    }
    for (const edge of edges) {
      const child = histories.get(edge.child)!;
      const ownerId = edge.owner ?? sourceId;
      const owner = histories.get(ownerId);
      const inherited = [...ancestors].some((id) => ownerEdges.get(id)?.some((record) =>
        record.child === edge.child && (edge.owner === undefined || record.owner === edge.owner)))
        || missingParent && (edge.owner === undefined || !owner
          || ownerId !== sourceId && (owner.cwd === undefined || child.cwd === undefined || owner.cwd === child.cwd) && (reachable.has(ownerId)
            || edge.launchId !== undefined && ownerEdges.get(ownerId)?.some((record) =>
              record.launchId === edge.launchId && record.owner === ownerId && record.child === edge.child)));
      if (child.cwd !== undefined && child.cwd !== source.cwd && !inherited) conflict("Session history has an unverifiable foreign-cwd reference.");
      if (!reachable.has(ownerId)) {
        if (!inherited) conflict("Session history owner is outside its recorded tree.");
        continue;
      }
      // Implicit aliases in a foreign fork are references, not new dispatch owners.
      if (!owner || owner.cwd !== undefined && child.cwd !== undefined && owner.cwd !== child.cwd) {
        if (edge.owner === undefined && inherited) continue;
        return conflict("Session history has an unknown owner.");
      }
      owner.children.add(edge.child);
    }
  }

  const intended = postorder([target.id], target.cwd);
  const intendedIds = new Set(intended);
  // Any surviving history can retain a reference, irrespective of its display name.
  // Unobserved missing nodes protect descendants only through a surviving reference.
  const protectedIds = new Set(postorder([...histories.keys()].filter((id) =>
    histories.get(id)!.cwd !== undefined && !intendedIds.has(id))));
  if (protectedIds.has(target.id)) conflict("The root history is referenced by another surviving session.");
  const removed: string[] = [];
  for (const id of intended) {
    if (protectedIds.has(id)) continue;
    const history = histories.get(id)!;
    if (history.path && inspect({ ...history, path: history.path }, id !== target.id)) {
      try {
        removeFile(history.path);
      } catch (error) {
        if (id === target.id || !isMissing(error)) throw error;
      }
    }
    removed.push(id);
  }
  return removed;
}
