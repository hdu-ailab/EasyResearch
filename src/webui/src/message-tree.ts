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

/**
 * The transcript message list is the session context, which pi builds from
 * the leaf path with compaction semantics (summarized entries before the
 * latest compaction's `firstKeptEntryId` are omitted). Mirror that here so
 * tree entries zip 1:1 onto transcript bubbles (ADR-066).
 */
function contextPath(byId: Map<string, WebTreeEntryDto>, leafId: string | null): string[] {
  const pathIds: string[] = [];
  let current: string | null = leafId;
  while (current !== null) {
    const entry = byId.get(current);
    if (!entry) break;
    pathIds.push(current);
    current = entry.parentId;
  }
  pathIds.reverse();
  const compaction = pathIds.map((id) => byId.get(id)).find((candidate) => candidate?.firstKeptEntryId !== undefined);
  if (!compaction?.firstKeptEntryId) return pathIds;
  const compactionIdx = pathIds.indexOf(compaction.id);
  const contextIds = [compaction.id];
  let foundFirstKept = false;
  for (const id of pathIds.slice(0, compactionIdx)) {
    if (id === compaction.firstKeptEntryId) foundFirstKept = true;
    if (foundFirstKept) contextIds.push(id);
  }
  contextIds.push(...pathIds.slice(compactionIdx + 1));
  return contextIds;
}

/**
 * Zip the session context (leaf-path) tree entries onto the session view's
 * user/assistant messages (same order) and attach version-group info to user
 * messages (ADR-066). The transcript messages are exactly the active path,
 * so every zipped message corresponds to the currently active version of its
 * group.
 */
export function buildMessageTreeMeta(
  messages: SessionMessageView[],
  tree: WebTreeEntryDto[],
  leafId: string | null,
): Record<string, SessionMessageMeta> {
  const index = indexTree(tree);
  const pathEntries = contextPath(index.byId, leafId)
    .map((id) => index.byId.get(id))
    .filter((candidate) => candidate?.role === "user" || candidate?.role === "assistant");
  const viewMessages = messages.filter(
    (message) => !message.usageOnly && (message.role === "user" || message.role === "assistant"),
  );
  const meta: Record<string, SessionMessageMeta> = {};
  for (let i = 0; i < Math.min(pathEntries.length, viewMessages.length); i++) {
    const entry = pathEntries[i];
    const view = viewMessages[i];
    if (!entry || !view) break;
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
