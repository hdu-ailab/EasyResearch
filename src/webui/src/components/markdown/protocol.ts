import type { Root } from "hast";

export interface MarkdownWorkerBlock {
  signature: string;
  tree: Root;
}

export interface MarkdownParseRequest {
  type: "parse";
  scope: string;
  key: string;
  revision: number;
  source: string;
}

export interface MarkdownParseSuccess extends Omit<MarkdownParseRequest, "type"> {
  type: "parsed";
  blocks: MarkdownWorkerBlock[];
}

export interface MarkdownParseFailure extends Omit<MarkdownParseRequest, "type"> {
  type: "error";
  message: string;
}

export type MarkdownWorkerResponse = MarkdownParseSuccess | MarkdownParseFailure;

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function identity(
  value: Record<string, unknown>,
): value is Record<string, unknown> & Omit<MarkdownParseRequest, "type"> {
  return (
    typeof value.scope === "string" &&
    value.scope.length > 0 &&
    typeof value.key === "string" &&
    value.key.length > 0 &&
    Number.isSafeInteger(value.revision) &&
    (value.revision as number) >= 0 &&
    typeof value.source === "string"
  );
}

function root(value: unknown): value is Root {
  return record(value) && value.type === "root" && Array.isArray(value.children);
}

export function parseMarkdownWorkerRequest(value: unknown): MarkdownParseRequest | null {
  if (!record(value) || value.type !== "parse" || !identity(value)) return null;
  return {
    type: "parse",
    scope: value.scope,
    key: value.key,
    revision: value.revision,
    source: value.source,
  };
}

export function isMarkdownWorkerResponse(value: unknown): value is MarkdownWorkerResponse {
  if (!record(value) || !identity(value)) return false;
  if (value.type === "error") return typeof value.message === "string";
  if (value.type !== "parsed" || !Array.isArray(value.blocks)) return false;
  return value.blocks.every(
    (block) =>
      record(block) &&
      typeof block.signature === "string" &&
      /^[a-f0-9]{64}$/.test(block.signature) &&
      root(block.tree),
  );
}
