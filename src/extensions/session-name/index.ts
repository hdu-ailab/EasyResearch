import type { InlineExtension } from "@earendil-works/pi-coding-agent";

/**
 * ADR-078: Pi-native session rename surface (`/name` — TUI parity) exposed
 * to the Web runtime as a bundled extension command. `prompt("/name <name>")`
 * executes the handler through Pi's `_tryExecuteExtensionCommand` before any
 * model/auth checks; `pi.setSessionName` persists the `session_info` entry
 * and emits `session_info_changed`. An empty argument clears the name: Pi
 * writes an empty `session_info`, which `getSessionName` treats as unset.
 */
export function createSessionNameExtension(): InlineExtension {
  return async (pi) => {
    pi.registerCommand("name", {
      description: "Set the session display name (/name <name>; bare /name clears)",
      handler: async (args) => {
        pi.setSessionName(args.trim());
      },
    });
  };
}

export default createSessionNameExtension();