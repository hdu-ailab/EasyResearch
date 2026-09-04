import { createRequire } from "node:module";
import type { PluginOption } from "vite";

const require = createRequire(import.meta.url);
const workerEntries = new Map([
  ["decode-named-character-reference", require.resolve("decode-named-character-reference")],
  ["hast-util-from-html-isomorphic", require.resolve("hast-util-from-html-isomorphic")],
]);

export function workerPlugins(): PluginOption[] {
  return [
    {
      name: "easyresearch-worker-conditions",
      enforce: "pre",
      resolveId(source) {
        return workerEntries.get(source);
      },
    },
  ];
}
