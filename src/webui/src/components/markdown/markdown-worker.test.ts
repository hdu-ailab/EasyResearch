import { describe, expect, it, vi } from "vitest";
import { createMarkdownWorkerHandler } from "./markdown.worker";
import type { MarkdownWorkerResponse } from "./protocol";

describe("createMarkdownWorkerHandler", () => {
  it("echoes validated identity with parsed blocks", async () => {
    const responses: MarkdownWorkerResponse[] = [];
    const handler = createMarkdownWorkerHandler(
      (response) => responses.push(response),
      async () => [{ signature: "a".repeat(64), tree: { type: "root", children: [{ type: "text", value: "ok" }] } }],
    );
    await handler({ type: "parse", scope: "s", key: "k", revision: 3, source: "hello" });
    expect(responses).toEqual([
      {
        type: "parsed",
        scope: "s",
        key: "k",
        revision: 3,
        source: "hello",
        blocks: [{ signature: "a".repeat(64), tree: { type: "root", children: [{ type: "text", value: "ok" }] } }],
      },
    ]);
  });

  it("ignores malformed requests and reports safe parse failures", async () => {
    const post = vi.fn<(response: MarkdownWorkerResponse) => void>();
    const handler = createMarkdownWorkerHandler(post, async () => {
      throw new Error("bad markdown");
    });
    await handler({ type: "parse", scope: "", key: "k", revision: 0, source: "x" });
    expect(post).not.toHaveBeenCalled();
    await handler({ type: "parse", scope: "s", key: "k", revision: 4, source: "x" });
    expect(post).toHaveBeenCalledWith({
      type: "error",
      scope: "s",
      key: "k",
      revision: 4,
      source: "x",
      message: "bad markdown",
    });
  });
});
