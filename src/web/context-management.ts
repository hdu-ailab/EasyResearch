import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SystemMessage, Tool } from "@earendil-works/pi-ai";
import type { AgentSession, ContextEditEntry, SessionEntry, SessionManager, SessionProjection } from "@earendil-works/pi-coding-agent";
import { isLlmRetryControl } from "../runtime/llm-recovery";
import type { ContextEditRequestDto, ContextItemDto, ContextItemTextDto, ContextPreviewDto, ContextSegmentDto, ContextSnapshotDto } from "./context-contracts";

export const FOLDED_CONTEXT_OUTPUT = "已折叠的工具输出";
export const CONTEXT_TEXT_PAGE_CHARS = 16_000;
export const CONTEXT_METADATA_BYTES = 8 * 1024 * 1024;
type ErrorCode = "CONTEXT_BUSY" | "CONTEXT_STALE" | "CONTEXT_INVALID" | "CONTEXT_TOO_LARGE" | "CONTEXT_UNAVAILABLE";
const messages: Record<ErrorCode, string> = {
  CONTEXT_BUSY: "Wait for all session work to finish before editing context.",
  CONTEXT_STALE: "Context changed. Refresh and review your edits again.",
  CONTEXT_INVALID: "This context edit or item is not valid. Refresh and review your selection.",
  CONTEXT_TOO_LARGE: "Context metadata is too large to inspect. Use native compaction and try again.",
  CONTEXT_UNAVAILABLE: "Context could not be read or fully updated. Refresh before trying again.",
};
export class ContextManagementError extends Error {
  readonly status: number;
  constructor(readonly code: ErrorCode) {
    super(messages[code]);
    this.status = code === "CONTEXT_INVALID" ? 400 : code === "CONTEXT_TOO_LARGE" ? 413 : code === "CONTEXT_UNAVAILABLE" ? 503 : 409;
  }
}

type NativeApi = Pick<typeof import("@earendil-works/pi-coding-agent"), "SessionManager" | "estimateTokens" | "buildSessionProjection" | "sessionEntryToContextMessages">;
type NativeRequestState = Pick<typeof import("@earendil-works/pi-ai"), "getCurrentSystemPrompt" | "getCurrentTools" | "createInitialSystemMessage" | "toToolDeclaration">;
export type ContextRuntime = Pick<AgentSession, "sessionId" | "sessionManager" | "model" | "systemPrompt" | "isIdle" | "getActiveToolNames" | "getAllTools" | "refreshContext">
  & { readonly agent: { readonly state: { readonly tools: readonly Tool[] } } };
type Item = { dto: ContextItemDto; source?: SessionEntry; message: AgentMessage; messageIndex: number; blockIndex?: number; original: string; text: string; pairKey?: string };
type Projection = { snapshot: ContextSnapshotDto; items: Item[]; native: SessionProjection; effectiveMessages: AgentMessage[] };
type Replacement = { targetId: string; replacement: ContextEditEntry["replacement"] };

function fail(code: ErrorCode): never { throw new ContextManagementError(code); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function preview(value: string): string { return Array.from(value.slice(0, 480)).slice(0, 240).join(""); }

/** Only textual content is exposed. Native image tokens are still estimated by Pi. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content.replace(/data:[^\s;,]+;base64,[A-Za-z0-9+/=]+/g, "[binary data omitted]");
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (!object(block)) return "[unavailable content]";
    if (block.type === "text") return contentText(block.text);
    if (block.type === "thinking") return contentText(block.thinking);
    if (block.type === "toolCall") return `${block.name}\n${JSON.stringify(block.arguments, (key, value) => {
      if (object(value) && (value.type === "image" || value.type === "audio" || value.type === "file")) return "[binary content omitted]";
      if ((key === "data" || key === "base64") && typeof value === "string" && /^[A-Za-z0-9+/=\s]+$/.test(value)) return "[binary data omitted]";
      return typeof value === "string" ? contentText(value) : value;
    }, 2)}`;
    return "[binary or non-text content omitted]";
  }).join("\n\n");
}
function messageText(message: AgentMessage): string {
  switch (message.role) {
    case "system": return [contentText(message.content), ...Object.entries(message.sections ?? {}).map(([key, value]) => value === null ? `[removed section: ${key}]` : typeof value === "string" ? `[${key}]\n${contentText(value)}` : ""),
      ...(message.toolsAdded?.length ? [`[tools]\n${contentText(JSON.stringify(message.toolsAdded, null, 2))}`] : []),
      ...(message.toolsRemoved?.length ? [`[removed tools]\n${message.toolsRemoved.map((tool) => tool.name).join(", ")}`] : [])].filter(Boolean).join("\n\n");
    case "compactionSummary": case "branchSummary": return contentText(message.summary);
    case "bashExecution": return contentText(`${message.command}\n${message.output}`);
    case "user": case "custom": case "assistant": case "toolResult": return contentText(message.content);
    default: return fail("CONTEXT_UNAVAILABLE");
  }
}
function visible(message: AgentMessage): boolean {
  return !isLlmRetryControl(message)
    && !(message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted"))
    && !(message.role === "bashExecution" && message.excludeFromContext);
}

export function parseContextEditRequest(value: unknown): ContextEditRequestDto {
  if (!object(value) || Object.keys(value).some((key) => key !== "revision" && key !== "edits")
    || typeof value.revision !== "string" || !value.revision || value.revision.length > 256 || !Array.isArray(value.edits)) fail("CONTEXT_INVALID");
  if (value.edits.length > 10_000) fail("CONTEXT_TOO_LARGE");
  for (const edit of value.edits) {
    if (!object(edit) || Object.keys(edit).some((key) => !["target", "id", "action"].includes(key))
      || !["segment", "item"].includes(edit.target as string) || typeof edit.id !== "string" || !edit.id || edit.id.length > 512
      || !["fold", "delete", "reset"].includes(edit.action as string)) fail("CONTEXT_INVALID");
  }
  return value as unknown as ContextEditRequestDto;
}

/** Synchronous native projection/commit: the adapter owns async admission and lifetime. */
export class RootContextManager {
  private invalidation = 0;
  constructor(private readonly session: ContextRuntime, private readonly pi: NativeApi,
    private readonly busy: () => boolean, private readonly notify: () => void,
    private readonly configurationStamp: () => unknown = () => undefined,
    private readonly requestState: NativeRequestState) {}

  snapshot(): ContextSnapshotDto { return this.guard(() => this.project().snapshot); }

  item(revision: string, itemId: string, view: "original" | "current", offset = 0): ContextItemTextDto {
    return this.guard(() => {
      const current = this.checked(revision);
      if (view !== "original" && view !== "current" || !Number.isSafeInteger(offset) || offset < 0) fail("CONTEXT_INVALID");
      const item = current.items.find((item) => item.dto.id === itemId);
      if (!item) fail("CONTEXT_INVALID");
      const text = view === "original" ? item.original : item.text;
      if (offset > text.length) fail("CONTEXT_INVALID");
      if (offset > 0 && /[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset] ?? "")) fail("CONTEXT_INVALID");
      let end = Math.min(text.length, offset + CONTEXT_TEXT_PAGE_CHARS);
      // Never split a UTF-16 surrogate pair across pages.
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
      return { revision, itemId, view, text: text.slice(offset, end), offset, totalChars: text.length, nextOffset: end < text.length ? end : null };
    });
  }

  preview(request: ContextEditRequestDto): ContextPreviewDto {
    return this.guard(() => {
      const before = this.checked(request.revision);
      const staged = this.stage(before, request);
      const after = this.project(staged.manager);
      this.validatePairs(before, after, staged.actions);
      const afterSegments = new Map(after.snapshot.segments.map((segment) => [segment.id, segment.tokens]));
      return {
        revision: before.snapshot.revision, beforeTokens: before.snapshot.totalTokens, afterTokens: after.snapshot.totalTokens,
        removedTokens: before.snapshot.totalTokens - after.snapshot.totalTokens, remainingTokens: after.snapshot.remainingTokens,
        cache: this.cache(before, after), changes: [...staged.actions].map(([itemId, action]) => ({ itemId, action })),
        segments: before.snapshot.segments.map((segment) => ({ id: segment.id, afterTokens: afterSegments.get(segment.id) ?? 0 })),
      };
    });
  }

  apply(request: ContextEditRequestDto): ContextSnapshotDto {
    return this.guard(() => {
      if (this.busy()) fail("CONTEXT_BUSY");
      const before = this.checked(request.revision);
      const { replacements, manager, actions } = this.stage(before, request);
      // Enforce metadata/role/pair validity before the first real append.
      this.validatePairs(before, this.project(manager), actions);
      if (this.busy()) fail("CONTEXT_BUSY");
      this.checked(request.revision);
      try {
        for (const edit of replacements) this.session.sessionManager.appendContextEdit(edit.targetId, edit.replacement);
      } catch {
        // Native append is not a transaction and can advance memory before an IO error.
        this.invalidation++;
        fail("CONTEXT_UNAVAILABLE");
      } finally {
        try { this.session.refreshContext(); } finally { this.notify(); }
      }
      return this.project().snapshot;
    });
  }

  private checked(revision: string): Projection {
    const projection = this.project();
    if (projection.snapshot.revision !== revision) fail("CONTEXT_STALE");
    return projection;
  }

  private validatePairs(before: Projection, after: Projection, actions: Map<string, "fold" | "delete">): void {
    const affected = new Set(before.items.filter((item) => actions.has(item.dto.id) && item.pairKey !== undefined).map((item) => item.pairKey));
    for (const item of after.items) {
      if (item.pairKey !== undefined && affected.has(item.pairKey) && item.dto.relatedIds.length !== 1) fail("CONTEXT_INVALID");
    }
  }

  private resolvedSystem(messages: AgentMessage[], includeCurrentRuntime: boolean): SystemMessage | undefined {
    // Native selectors replay section replacements and tool removals. Only the
    // resolved state belongs in effective-context accounting, not every delta.
    let prompt = this.requestState.getCurrentSystemPrompt(messages);
    let tools = this.requestState.getCurrentTools(messages);
    if (includeCurrentRuntime && (this.session.isIdle || !messages.some((message) => message.role === "system"))) {
      // Idle reloads have not necessarily persisted their next declaration yet.
      // Public native runtime state is already authoritative for that next request.
      prompt = this.session.systemPrompt;
      tools = [...this.session.agent.state.tools];
    }
    return this.requestState.createInitialSystemMessage(prompt, tools.map((tool) => this.requestState.toToolDeclaration(tool)));
  }

  private project(manager: SessionManager = this.session.sessionManager): Projection {
    const native = manager.buildSessionProjection();
    const items: Item[] = [];
    const segments: ContextSegmentDto[] = [];
    const segmentMembers = new Map<string, Item[]>();
    let metadataBytes = 0;
    let assistantSegment: ContextSegmentDto | undefined;
    let boundary = "start";
    const contributions: Array<{ sourceEntry?: SessionEntry; message: AgentMessage; messageIndex: number }> = native.entries
      .flatMap(({ sourceEntry, messages }) => messages.map((message, messageIndex) => ({ sourceEntry, message, messageIndex })))
      .filter(({ message }) => visible(message) && message.role !== "system");
    const system = this.resolvedSystem(native.messages, true);
    // This fixed item has aggregate native provenance, not a fabricated source row.
    if (system) contributions.unshift({ message: system, messageIndex: 0 });
    for (const { sourceEntry, message, messageIndex } of contributions) {
      const sourceId = sourceEntry?.id ?? "effective-system";
      const type = message.role === "assistant" || message.role === "toolResult" ? "assistant"
        : message.role === "system" ? "system" : message.role === "compactionSummary" || message.role === "branchSummary" ? "summary"
          : message.role === "user" || message.role === "custom" || message.role === "bashExecution" ? "user" : fail("CONTEXT_UNAVAILABLE");
      let segment: ContextSegmentDto;
      if (type === "assistant" && assistantSegment) segment = assistantSegment;
      else {
        const id = type === "assistant" ? `assistant:${boundary}` : `${type}:${sourceId}:${messageIndex}`;
        segment = { id, type, preview: "", tokens: 0, percent: 0, itemIds: [], canFold: type === "assistant", canDelete: type === "assistant" };
        segments.push(segment);
        segmentMembers.set(id, []);
        if (type === "assistant") assistantSegment = segment;
        else if (message.role === "user") {
          assistantSegment = undefined;
          boundary = `${sourceId}:${messageIndex}`;
        }
      }
      const originalMessage = sourceEntry ? this.pi.sessionEntryToContextMessages(sourceEntry)[messageIndex] : message;
      const originals = new Map<string, { text: string; indices: number[]; used: number }>();
      if (originalMessage?.role === "assistant") originalMessage.content.forEach((block, index) => {
        const key = fingerprint(block);
        const value = originals.get(key) ?? { text: contentText([block]), indices: [], used: 0 };
        value.indices.push(index);
        originals.set(key, value);
      });
      const blocks = message.role === "assistant" ? message.content.map((block, blockIndex) => ({ message: { ...message, content: [block] } as AgentMessage, blockIndex })) : [{ message, blockIndex: undefined }];
      for (const part of blocks) {
        const block = message.role === "assistant" && part.blockIndex !== undefined ? message.content[part.blockIndex] : undefined;
        const itemType: ContextItemDto["type"] = block?.type === "thinking" ? "thinking" : block?.type === "toolCall" ? "tool-call"
          : message.role === "toolResult" ? "tool-result" : type;
        const originalBlock = block ? originals.get(fingerprint(block)) : undefined;
        const originalIndex = originalBlock ? originalBlock.indices[originalBlock.used++] : undefined;
        const blockId = block ? originalIndex ?? `replacement-${part.blockIndex}-${fingerprint(block).slice(0, 16)}` : "whole";
        const id = `${sourceId}:${messageIndex}:${blockId}`;
        const text = messageText(part.message);
        // Context edits preserve content blocks, but their array indices may shift.
        // Resolve originals by exact block value, never by a shifted current index.
        const original = block ? originalBlock?.text ?? "[Original block unavailable: native replacement has no block provenance]" : originalMessage ? messageText(originalMessage) : text;
        const tokens = this.pi.estimateTokens(part.message);
        if (!Number.isSafeInteger(tokens) || tokens < 0) fail("CONTEXT_UNAVAILABLE");
        const toolName = block?.type === "toolCall" ? block.name : message.role === "toolResult" ? message.toolName : undefined;
        const pairKey = block?.type === "toolCall" ? block.id : message.role === "toolResult" ? message.toolCallId : undefined;
        const dto: ContextItemDto = { id, segmentId: segment.id, type: itemType, ...(toolName ? { toolName } : {}), preview: preview(text), tokens,
          percent: 0, segmentPercent: 0, canFold: itemType === "tool-result", canDelete: type === "assistant", relatedIds: [],
          folded: message.role === "toolResult" && message.content.length === 1 && message.content[0]?.type === "text" && message.content[0].text === FOLDED_CONTEXT_OUTPUT };
        const item = { dto, source: sourceEntry, message, messageIndex, blockIndex: part.blockIndex, original, text, pairKey };
        metadataBytes += Buffer.byteLength(JSON.stringify(dto));
        if (metadataBytes > CONTEXT_METADATA_BYTES) fail("CONTEXT_TOO_LARGE");
        items.push(item);
        segmentMembers.get(segment.id)!.push(item);
        segment.itemIds.push(id);
        segment.tokens += tokens;
        if (segment.type !== "assistant" && !segment.preview) segment.preview = dto.preview;
      }
      if (message.role === "assistant") {
        const text = contentText(message.content.filter((block) => block.type === "text"));
        segment.preview = preview(text || messageText(message));
      }
    }
    const pairs = new Map<string, Item[]>();
    for (const item of items) if (item.pairKey !== undefined) {
      const pair = pairs.get(item.pairKey) ?? [];
      pair.push(item);
      pairs.set(item.pairKey, pair);
    }
    for (const pair of pairs.values()) {
      const valid = pair.length === 2 && pair[0]!.dto.type === "tool-call" && pair[1]!.dto.type === "tool-result"
        && pair[0]!.dto.segmentId === pair[1]!.dto.segmentId && pair[0]!.dto.toolName === pair[1]!.dto.toolName;
      for (const item of pair) {
        item.dto.relatedIds = valid ? pair.filter((other) => other !== item).map((other) => other.dto.id) : [];
        if (!valid) { item.dto.canDelete = false; item.dto.canFold = false; }
      }
    }
    const totalTokens = items.reduce((sum, item) => sum + item.dto.tokens, 0);
    if (!Number.isSafeInteger(totalTokens)) fail("CONTEXT_TOO_LARGE");
    for (const segment of segments) {
      segment.percent = totalTokens ? segment.tokens / totalTokens * 100 : 0;
      const members = segmentMembers.get(segment.id)!;
      segment.canFold = segment.type === "assistant" && members.some((item) => item.dto.canFold);
      segment.canDelete = segment.type === "assistant" && members.every((item) => item.dto.canDelete);
      for (const item of members) {
        item.dto.percent = totalTokens ? item.dto.tokens / totalTokens * 100 : 0;
        item.dto.segmentPercent = segment.tokens ? item.dto.tokens / segment.tokens * 100 : 0;
      }
    }
    const model = this.session.model;
    const contextWindow = model && Number.isFinite(model.contextWindow) && model.contextWindow > 0 ? model.contextWindow : null;
    const revision = fingerprint([this.session.sessionId, manager.getLeafId(), native, model, system, this.session.systemPrompt,
      this.session.getActiveToolNames(), this.session.getAllTools(), this.configurationStamp(), this.invalidation]);
    const snapshot: ContextSnapshotDto = { sessionId: this.session.sessionId, revision, busy: this.busy(), estimated: true,
      ...(model ? { model: { provider: model.provider, id: model.id, name: model.name } } : {}), contextWindow,
      totalTokens, remainingTokens: contextWindow === null ? null : Math.max(0, contextWindow - totalTokens), segments, items: items.map((item) => item.dto) };
    if (Buffer.byteLength(JSON.stringify(snapshot)) > CONTEXT_METADATA_BYTES) fail("CONTEXT_TOO_LARGE");
    return { snapshot, items, native, effectiveMessages: contributions.map(({ message }) => message) };
  }

  private stage(before: Projection, input: ContextEditRequestDto) {
    const request = parseContextEditRequest(input);
    const actions = new Map<string, "fold" | "delete">();
    const byId = new Map(before.items.map((item) => [item.dto.id, item]));
    for (const edit of request.edits) {
      const segment = edit.target === "segment" ? before.snapshot.segments.find((segment) => segment.id === edit.id) : undefined;
      const item = edit.target === "item" ? byId.get(edit.id) : undefined;
      if (edit.target === "segment" ? !segment || segment.type !== "assistant" : !item || !item.dto.canDelete) fail("CONTEXT_INVALID");
      const scope = segment ? segment.itemIds.map((id) => byId.get(id)!) : [item!, ...item!.dto.relatedIds.map((id) => byId.get(id)!)];
      if (edit.action === "reset" || segment && edit.action === "fold") for (const target of scope) actions.delete(target.dto.id);
      if (edit.action === "reset") continue;
      if (edit.action === "fold") {
        if (item && !item.dto.canFold || segment && !segment.canFold) fail("CONTEXT_INVALID");
        // A later output fold restores a staged pair deletion; otherwise it
        // would leave a folded result whose call was still omitted.
        if (item && actions.get(item.dto.id) === "delete") for (const target of scope) actions.delete(target.dto.id);
        for (const target of (segment ? scope : [item!])) if (target.dto.type === "tool-result") {
          if (!target.dto.canFold) fail("CONTEXT_INVALID");
          actions.set(target.dto.id, "fold");
        }
      } else {
        for (const target of scope) {
          if (!target.dto.canDelete) fail("CONTEXT_INVALID");
          actions.set(target.dto.id, "delete");
        }
      }
    }
    const replacements: Replacement[] = [];
    const sources = new Map<string, Item[]>();
    for (const item of before.items) if (item.source && actions.has(item.dto.id)) {
      const changed = sources.get(item.source.id) ?? [];
      changed.push(item);
      sources.set(item.source.id, changed);
    }
    for (const [targetId, changed] of sources) {
      const message = changed[0]!.message;
      if (message.role === "assistant") {
        const removed = new Set(changed.filter((item) => actions.get(item.dto.id) === "delete").map((item) => item.blockIndex));
        const content = message.content.filter((_block, index) => !removed.has(index));
        replacements.push({ targetId, replacement: content.length ? { content } : null });
      } else if (message.role === "toolResult") {
        replacements.push({ targetId, replacement: actions.get(changed[0]!.dto.id) === "delete" ? null : { content: [{ type: "text", text: FOLDED_CONTEXT_OUTPUT }] } });
      } else fail("CONTEXT_INVALID");
    }
    const original = this.session.sessionManager;
    const header = original.getHeader();
    const manager = this.pi.SessionManager.inMemory(original.getCwd(), { id: original.getSessionId() }, [...(header ? [header] : []), ...original.getEntries()]);
    const leaf = original.getLeafId();
    if (leaf) manager.branch(leaf); else manager.resetLeaf();
    for (const replacement of replacements) manager.appendContextEdit(replacement.targetId, replacement.replacement);
    manager.buildSessionProjection();
    return { manager, replacements, actions };
  }

  private cache(before: Projection, after: Projection): ContextPreviewDto["cache"] {
    const unavailable = { basis: "unchanged-prefix" as const, hitRate: null, reusableTokens: null };
    const branch = this.session.sessionManager.getBranch();
    const latest = [...branch].reverse().find((entry) => entry.type === "message" && entry.message.role === "assistant" && visible(entry.message));
    if (!latest || latest.type !== "message" || latest.message.role !== "assistant" || !latest.parentId || !this.session.model
      || latest.message.provider !== this.session.model.provider || latest.message.model !== this.session.model.id) return unavailable;
    // A later model switch (including away-and-back) or summary loses a useful baseline.
    const later = branch.slice(branch.indexOf(latest) + 1);
    if (later.some((entry) => entry.type === "model_change" || entry.type === "compaction" || entry.type === "branch_summary")) return unavailable;
    const baseline = this.pi.buildSessionProjection(this.session.sessionManager.getEntries(), latest.parentId);
    const summaries = (projection: SessionProjection) => projection.entries.filter((entry) => entry.messages.some((message) => message.role === "compactionSummary" || message.role === "branchSummary")).map((entry) => entry.sourceEntry.id);
    if (fingerprint(summaries(baseline)) !== fingerprint(summaries(before.native))) return unavailable;
    if (!baseline.messages.some((message) => message.role === "system")) return unavailable;
    const previousSystem = this.resolvedSystem(baseline.messages, false);
    const next = after.effectiveMessages;
    const nextSystem = next.find((message) => message.role === "system");
    if (fingerprint(previousSystem ?? null) !== fingerprint(nextSystem ?? null)) return unavailable;
    const previous = [...(previousSystem ? [previousSystem] : []), ...baseline.messages.filter((message) => visible(message) && message.role !== "system")];
    let reusableTokens = 0;
    for (let index = 0; index < Math.min(previous.length, next.length); index++) {
      if (fingerprint(previous[index]) !== fingerprint(next[index])) break;
      const message = next[index]!;
      reusableTokens += message.role === "assistant" ? message.content.reduce((sum, block) => sum + this.pi.estimateTokens({ ...message, content: [block] }), 0) : this.pi.estimateTokens(message);
    }
    return { basis: "unchanged-prefix", reusableTokens, hitRate: after.snapshot.totalTokens ? Math.min(1, reusableTokens / after.snapshot.totalTokens) : 0 };
  }

  private guard<T>(run: () => T): T {
    try { return run(); } catch (error) { if (error instanceof ContextManagementError) throw error; return fail("CONTEXT_UNAVAILABLE"); }
  }
}
