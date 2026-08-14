import type { InlineExtension } from "@earendil-works/pi-coding-agent";

/**
 * ADR-066: atomic extension bridging Web tree navigation to Pi's in-place
 * `navigateTree` (leaf-pointer move within the same session file). The RPC
 * surface has no direct navigate command; extension command handlers are the
 * only channel with `ctx.navigateTree`. The Web layer triggers it through
 * `prompt("/web-tree navigate <entryId>")`.
 */
export function createWebTreeExtension(): InlineExtension {
  return async (pi) => {
    pi.registerCommand("web-tree", {
      description: "Web session tree navigation (internal)",
      handler: async (args, ctx) => {
        const match = args.trim().match(/^navigate(?:\s+(\S+))?$/);
        if (!match?.[1]) {
          throw new Error("Usage: /web-tree navigate <entryId>");
        }
        await ctx.navigateTree(match[1]!);
      },
    });
  };
}

export default createWebTreeExtension();
