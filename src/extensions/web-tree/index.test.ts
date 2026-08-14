import { describe, expect, it, vi } from "vitest";
import { createWebTreeExtension } from "./index";

interface FakeCommandOptions {
  description?: string;
  handler: (args: string, ctx: { navigateTree: (entryId: string) => Promise<void> }) => Promise<void>;
}

function setup() {
  let captured: { name: string; options: FakeCommandOptions } | undefined;
  const fakePi = {
    registerCommand: (name: string, options: FakeCommandOptions) => {
      captured = { name, options };
    },
  } as never;
  const navigateTree = vi.fn(async () => {});
  const extension = createWebTreeExtension();
  const factory = extension as (pi: unknown) => Promise<void>;
  return { factory, fakePi, getCommand: () => captured, ctx: { navigateTree } };
}

describe("web-tree extension", () => {
  it("registers the web-tree command", async () => {
    const { factory, fakePi, getCommand } = setup();
    await factory(fakePi);
    expect(getCommand()?.name).toBe("web-tree");
  });

  it("navigates to the entry id", async () => {
    const { factory, fakePi, getCommand, ctx } = setup();
    await factory(fakePi);
    await getCommand()?.options.handler("navigate entry-42", ctx);
    expect(ctx.navigateTree).toHaveBeenCalledWith("entry-42");
  });

  it("rejects missing or unknown arguments", async () => {
    const { factory, fakePi, getCommand, ctx } = setup();
    await factory(fakePi);
    await expect(getCommand()?.options.handler("", ctx)).rejects.toThrow();
    await expect(getCommand()?.options.handler("jump entry-1", ctx)).rejects.toThrow();
    expect(ctx.navigateTree).not.toHaveBeenCalled();
  });
});
