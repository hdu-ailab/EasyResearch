import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { isLlmRetryControl, type LlmRecoveryController } from "../../runtime/llm-recovery";

/** Keep native history and usage intact; project only the provider context. */
export function createLlmRecoveryExtension(recovery: LlmRecoveryController): ExtensionFactory {
  return (pi) => {
    pi.on("context", (event) => {
      recovery.observeRequest();
      const messages = event.messages.filter((message) => !isLlmRetryControl(message)
        && !(message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")));
      return messages.length === event.messages.length ? undefined : { messages };
    });
  };
}
