import type { WebTreeEntryDto } from "../../web/contracts";
import type { SessionMessageView } from "./session-reducer";

export interface SessionMessageMeta {
  entryId: string;
  version?: { index: number; count: number };
}

interface TreeIndex {
  byId: Map<string, WebTreeEntryDto>;
  childrenByParent: Map<string | null, WebTreeEntryDto[]>;
}

function indexTree(tree: WebTreeEntryDto[]): TreeIndex {
  const byId = new Map<string, WebTreeEntryDto>();
  const childrenByParent = new Map<string | null, WebTreeEntryDto[]>();
  for (const entry of tree) {
    byId.set(entry.id, entry);
    const children = childrenByParent.get(entry.parentId);
    if (children) children.push(entry);
    else childrenByParent.set(entry.parentId, [entry]);
  }
  return { byId, childrenByParent };
}

function subtreeLeaf(index: TreeIndex, entryId: string): string {
  let current = entryId;
  for (;;) {
    const last = index.childrenByParent.get(current)?.at(-1);
    if (!last) return current;
    current = last.id;
  }
}

/** ADR-098 displays the complete branch, not Pi's compacted LLM context. */
function branchPath(byId: Map<string, WebTreeEntryDto>, leafId: string | null): string[] {
  const pathIds: string[] = [];
  let current: string | null = leafId;
  while (current !== null) {
    const entry = byId.get(current);
    if (!entry) break;
    pathIds.push(current);
    current = entry.parentId;
  }
  return pathIds.reverse();
}

/** Join persisted bubbles by id; only live user rows need an ordered fallback. */
export function buildMessageTreeMeta(
  messages: SessionMessageView[],
  tree: WebTreeEntryDto[],
  leafId: string | null,
): Record<string, SessionMessageMeta> {
  const index = indexTree(tree);
  const path = branchPath(index.byId, leafId);
  const activeIds = new Set(path);
  const userEntries = path.map((id) => index.byId.get(id)).filter((entry) => entry?.role === "user");
  const meta: Record<string, SessionMessageMeta> = {};
  let userIndex = 0;
  for (const view of messages) {
    if (view.usageOnly || (view.role !== "user" && view.role !== "assistant")) continue;
    // Tool-only assistant turns have no bubble; they must not shift user edits.
    const liveUserEntry = view.role === "user" ? userEntries[userIndex++] : undefined;
    const entry = view.entryId === undefined ? liveUserEntry : index.byId.get(view.entryId);
    if (!entry || !activeIds.has(entry.id) || entry.role !== view.role) continue;
    const entryMeta: SessionMessageMeta = { entryId: entry.id };
    if (entry.role === "user") {
      const group = (index.childrenByParent.get(entry.parentId) ?? []).filter((candidate) => candidate.role === "user");
      if (group.length > 1) {
        const index = group.findIndex((candidate) => candidate.id === entry.id);
        if (index >= 0) entryMeta.version = { index: index + 1, count: group.length };
      }
    }
    meta[view.key] = entryMeta;
  }
  return meta;
}

/** Target entry for switching to the previous/next version of a user message. */
export function versionTarget(tree: WebTreeEntryDto[], fromEntryId: string, direction: -1 | 1): string | undefined {
  const treeIndex = indexTree(tree);
  const entry = treeIndex.byId.get(fromEntryId);
  if (entry?.role !== "user") return undefined;
  const group = (treeIndex.childrenByParent.get(entry.parentId) ?? []).filter((candidate) => candidate.role === "user");
  const position = group.findIndex((candidate) => candidate.id === fromEntryId);
  if (position < 0) return undefined;
  const neighbor = group[position + direction];
  if (!neighbor) return undefined;
  return subtreeLeaf(treeIndex, neighbor.id);
}
