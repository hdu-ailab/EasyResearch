import { lstatSync, realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  defaultAgentTools, isUserExtensionTool, selectAgentTools,
  type AgentConfig, type RegisteredAgentTool,
} from "../subagent/agents";

export interface RuntimeToolSnapshot {
  cwd: string;
  agentName: string;
  generation: number;
  tools: readonly RegisteredAgentTool[];
  errors?: readonly { path: string; scope?: "user" | "project" }[];
}

interface InventorySnapshot extends RuntimeToolSnapshot {
  sequence: number;
}

/** Observational metadata only. Pi retains all executable definitions and ownership. */
export class RuntimeToolInventory {
  private readonly snapshots = new Map<object, InventorySnapshot>();
  private sequence = 0;
  private readonly extensionsRoot?: string;

  constructor(agentDir?: string) {
    if (agentDir) this.extensionsRoot = join(resolve(agentDir), "extensions");
  }

  update(owner: object, snapshot: RuntimeToolSnapshot | undefined): boolean {
    if (!snapshot) return this.snapshots.delete(owner);
    const previous = this.snapshots.get(owner);
    if (previous && previous.generation > snapshot.generation) return false;
    const next = {
      cwd: snapshot.cwd,
      agentName: snapshot.agentName,
      generation: snapshot.generation,
      tools: snapshot.tools.slice(0, 1024).map(tool => ({
        name: tool.name.slice(0, 256),
        ...(tool.sourceInfo ? { sourceInfo: { path: tool.sourceInfo.path.slice(0, 4096), scope: tool.sourceInfo.scope } } : {}),
      })),
      errors: (snapshot.errors ?? []).slice(0, 16).map(error => {
        const scope = this.errorScope(error);
        return { path: error.path.slice(0, 4096), ...(scope ? { scope } : {}) };
      }),
    };
    if (previous) {
      const { sequence: _, ...data } = previous;
      if (isDeepStrictEqual(data, next)) return false;
    }
    this.snapshots.set(owner, { ...next, sequence: ++this.sequence });
    return true;
  }

  project(agents: AgentConfig[], cwd?: string): AgentConfig[] {
    const ordered = [...this.snapshots.values()].sort((a, b) =>
      b.generation - a.generation || b.sequence - a.sequence);
    const scoped = cwd === undefined ? [] : ordered.filter(snapshot => snapshot.cwd === cwd);
    // A project override or a newer owner does not revoke another live registry.
    const globalTools = ordered.flatMap(snapshot => snapshot.tools.filter(tool =>
      isUserExtensionTool(tool) && tool.sourceInfo?.scope === "user"));
    const tools = scoped.length
      ? scoped.flatMap(snapshot => snapshot.tools.filter(isUserExtensionTool))
      : globalTools;
    const diagnostics = [...new Set(ordered.flatMap(snapshot => (snapshot.errors ?? [])
      .filter(error => error.scope === "user" || snapshot.cwd === cwd)
      .map(error => `Could not load extension: ${error.path}`)))].slice(0, 16);
    return agents.map(agent => {
      const runtimes = ordered.filter(snapshot => snapshot.agentName === agent.name
        && (cwd === undefined || snapshot.cwd === cwd));
      const registered = cwd !== undefined && runtimes.length
        ? runtimes.flatMap(snapshot => snapshot.tools)
        : [
            ...(runtimes.length
              ? runtimes.flatMap(snapshot => snapshot.tools.filter(tool =>
                !isUserExtensionTool(tool) && tool.sourceInfo?.scope !== "project"))
              : defaultAgentTools(agent.name).map(name => ({ name }))),
            ...tools,
          ];
      return {
        ...agent,
        effectiveTools: [...new Set(selectAgentTools(agent, registered))],
        ...(diagnostics.length ? { toolDiagnostics: diagnostics } : {}),
      };
    });
  }

  private errorScope(error: { path: string; scope?: "user" | "project" }): "user" | "project" | undefined {
    if (error.scope === "user" || error.scope === "project") return error.scope;
    // In particular, do not infer scope after normalizing ".." across a symlink.
    if (!this.extensionsRoot || !isAbsolute(error.path) || error.path.length > 4096
      || error.path !== resolve(error.path)
      || !within(this.extensionsRoot, error.path)) return undefined;
    const root = physicalPath(this.extensionsRoot);
    const path = physicalPath(error.path);
    return root && path && within(root, path) ? "user" : undefined;
  }
}

function within(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

/** Resolve missing leaves through an existing ancestor, never through a dangling symlink. */
function physicalPath(path: string): string | undefined {
  let ancestor = path;
  for (;;) {
    try {
      lstatSync(ancestor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      const parent = dirname(ancestor);
      if (parent === ancestor) return undefined;
      ancestor = parent;
      continue;
    }
    try {
      return resolve(realpathSync.native(ancestor), relative(ancestor, path));
    } catch {
      return undefined;
    }
  }
}
