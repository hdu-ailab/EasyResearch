import { lstatSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { readAgentAliases } from "../subagent/agent-alias";
import { readSubagentJournal } from "../subagent/job-journal";
import { readSubagentSessionLinks } from "../subagent/session-links";
import type { SessionHistoryTarget } from "./session-deletion";
import type { SubagentSessionStore } from "./subagent-sessions";

type Reader = ReturnType<SubagentSessionStore["open"]>;

/** Compatibility evidence for this deletion only. It never changes a header or a reader's cwd. */
export function prepareHistoryMigration(input: {
  sessionsDir: string;
  listed: readonly SessionHistoryTarget[];
  readers: Map<string, Reader>;
  parents: Map<string, string>;
  conflict(message: string): never;
}) {
  const { sessionsDir, listed, readers, parents, conflict } = input;
  const byId = new Map(listed.map((item) => [item.id, item]));
  const byPath = new Map(listed.map((item) => [item.path, item]));
  const recovered = new Map<string, SessionHistoryTarget>();
  const references = new Map<string, SessionHistoryTarget>();
  const oldPaths = new Set<string>();
  let relocation: { oldStore: string; oldHome: string; newHome: string } | undefined;
  const homeOf = (store: string) => basename(store) === "sessions" && basename(dirname(store)) === "agent"
    && basename(dirname(dirname(store))) === ".easyresearch" ? dirname(dirname(dirname(store))) : undefined;
  const newHome = homeOf(sessionsDir);
  const suffix = (home: string, path: string) => {
    const value = relative(home, path);
    return value && !isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`) ? value : undefined;
  };
  const absent = (path: string) => {
    if (!isAbsolute(path) || resolve(path) !== path) conflict("Recorded migration path is not absolute and canonical.");
    let current = parse(path).root;
    for (const component of path.slice(current.length).split(sep)) {
      current = join(current, component);
      let stat;
      try {
        stat = lstatSync(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
        return conflict("Recorded migration path cannot be inspected.");
      }
      if (stat.isSymbolicLink() || current !== path && !stat.isDirectory()) {
        conflict("Recorded migration path has a linked or invalid ancestor.");
      }
    }
    conflict("Recorded migration path still exists; its identity cannot be substituted.");
  };
  const sameProject = (a: string, b: string, pair = relocation) => {
    if (!pair) return false;
    const aSuffix = suffix(pair.oldHome, a) ?? suffix(pair.newHome, a);
    const bSuffix = suffix(pair.oldHome, b) ?? suffix(pair.newHome, b);
    return aSuffix !== undefined && aSuffix === bSuffix;
  };
  const absentSource = (path: string, oldStore: string) => {
    const oldSource = join(oldStore, relative(sessionsDir, path));
    absent(oldSource);
    oldPaths.add(oldSource);
  };

  // Matching materialized dispatch records establish identity. Fork copies remain
  // references: the ownership graph must verify their native provenance, and a
  // different project suffix never gains migrated-workspace membership.
  for (const source of listed) {
    const inherited = parents.has(source.id);
    const reader = readers.get(source.id);
    if (!reader) continue;
    const entries = reader.getEntries();
    const aliases = readAgentAliases(entries);
    const links = readSubagentSessionLinks(entries);
    for (const job of readSubagentJournal(entries).jobs.values()) {
      if (!job.childSessionId || !job.sessionPath) continue;
      const child = byId.get(job.childSessionId);
      if (child?.path === job.sessionPath) continue;
      const oldStore = dirname(dirname(job.sessionPath));
      const oldHome = homeOf(oldStore);
      // Normal in-store missing children need no compatibility interpretation.
      if (!child && suffix(sessionsDir, job.sessionPath)) continue;
      if (!newHome || !oldHome || oldHome === newHome
        || relative(oldStore, job.sessionPath).split(sep).length !== 2
        || child && join(sessionsDir, relative(oldStore, job.sessionPath)) !== child.path) {
        conflict("Recorded child path cannot be verified as a global-store home migration.");
      }
      const pair = { oldStore, oldHome: oldHome!, newHome: newHome! };
      if (relocation && relocation.oldStore !== oldStore) conflict("Session history has inconsistent migration prefixes.");
      const alias = aliases.find((item) => item.id === job.agentId);
      const link = links.find((item) => item.launchId === job.launchId);
      // Incomplete launches (including interrupted continuations) cannot establish
      // a transformation, but may use one established by an earlier full dispatch.
      if (!alias || !link) continue;
      const name = child && readers.get(child.id)?.getSessionName();
      if (!alias || alias.sessionId !== job.childSessionId || alias.sessionPath !== job.sessionPath || alias.agent !== job.agent
        || !link || link.childSessionId !== job.childSessionId || link.agent !== job.agent || link.agentId !== job.agentId
        || link.toolCallId !== job.toolCallId || link.ownerSessionId !== job.ownerSessionId
        || child && (name !== `easyresearch:${job.agent}` && name !== `lazyresearch:${job.agent}`
          || !inherited && !sameProject(source.cwd, child.cwd, pair))) {
        conflict("Session migration lacks matching role, ownership, path, or workspace evidence.");
      }
      absent(job.sessionPath);
      // A copied coordinator in the old store is a potentially surviving owner,
      // even when its child has already moved. Never omit it from exclusivity.
      absentSource(source.path, oldStore);
      if (!child) {
        // Root-last retries may have removed every migrated child. The verified
        // coordinator (with either old or updated cwd) remains the anchor;
        // both child locations must be absent.
        // This admits absence only, never a previously unverified physical file.
        if (!suffix(pair.oldHome, source.cwd) && !suffix(pair.newHome, source.cwd)) {
          conflict("Missing migrated child has no surviving home-migration anchor.");
        }
        absent(join(sessionsDir, relative(oldStore, job.sessionPath)));
      }
      relocation = pair;
      if (child) {
        references.set(child.id, child);
        if (sameProject(source.cwd, child.cwd, pair)) recovered.set(child.id, child);
      }
      oldPaths.add(job.sessionPath);
    }
  }

  const rebase = (path: string): string | undefined => {
    if (!relocation) return;
    const tail = suffix(relocation.oldStore, path);
    if (!tail || tail.split(sep).length !== 2 || !path.endsWith(".jsonl")) return;
    absent(path);
    oldPaths.add(path);
    return join(sessionsDir, tail);
  };
  return {
    resolveChild(id: string, path: string | undefined, agent: string, sourcePath: string): string | undefined {
      if (references.has(id)) {
        absentSource(sourcePath, relocation!.oldStore);
        const name = readers.get(id)?.getSessionName();
        if (name !== `easyresearch:${agent}` && name !== `lazyresearch:${agent}`) {
          conflict("Migrated child references disagree about the persisted Agent role.");
        }
      }
      if (!path || byId.get(id)?.path === path) return path;
      const current = rebase(path);
      if (!current) return path;
      absentSource(sourcePath, relocation!.oldStore);
      const child = references.get(id);
      if (child?.path === current) return current;
      // Created-but-never-materialized mappings acquire no synthetic identity.
      if (!byId.has(id) && !byPath.has(current)) { absent(current); return current; }
      return conflict("Session migration has an unverified child mapping.");
    },
    allows(sourceCwd: string | undefined, childId: string): boolean {
      const child = recovered.get(childId);
      return !!child && sourceCwd !== undefined && sameProject(sourceCwd, child.cwd);
    },
    resolveParent(path: string): string {
      if (byPath.has(path)) return path;
      const current = rebase(path);
      if (!current) return path;
      const parent = byPath.get(current);
      // The ownership graph separately verifies that this native source actually
      // contains the inherited edges; prefix similarity alone grants no ownership.
      if (parent) return current;
      absent(current);
      return current;
    },
    revalidate(): void { for (const path of oldPaths) absent(path); },
  };
}
