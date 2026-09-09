import type { ExtensionFactory, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";

const name = "compaction-cancellation";

export function createCompactionCancellationExtension(
  isCancelling: () => boolean,
  abortCompaction: () => void,
): { name: string; factory: ExtensionFactory } {
  return {
    name,
    factory: (api) => {
      api.on("session_before_compact", () => {
        // Unlike compaction_start, this awaited boundary has a native controller.
        if (isCancelling()) abortCompaction();
      });
    },
  };
}

export function prioritizeCompactionCancellation(base: LoadExtensionsResult): LoadExtensionsResult {
  // Pi loads filesystem extensions before inline factories; abort before their awaited hooks.
  const index = base.extensions.findIndex((extension) => extension.path === `<inline:${name}>`);
  if (index <= 0) return base;
  return {
    ...base,
    extensions: [base.extensions[index]!, ...base.extensions.slice(0, index), ...base.extensions.slice(index + 1)],
  };
}
