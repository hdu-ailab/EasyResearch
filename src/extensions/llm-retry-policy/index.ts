import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { LlmRetryPolicyBinding } from "../../runtime/llm-retry-policy";

/** Runtime-owned policy references survive extension reload; hooks own summary scope only. */
export function createLlmRetryPolicyExtension(binding: LlmRetryPolicyBinding): ExtensionFactory {
  return (pi) => {
    pi.on("session_before_compact", () => binding.beginSummary("compaction"));
    pi.on("session_before_tree", () => binding.beginSummary("branchSummary"));
    pi.on("session_compact", () => binding.finishSummary());
    pi.on("session_compact_failed", () => binding.finishSummary());
    pi.on("session_tree", () => binding.finishSummary());
    pi.on("session_start", (_event, ctx) => {
      if (ctx.isIdle()) binding.finishSummary();
    });
  };
}

export default createLlmRetryPolicyExtension;
