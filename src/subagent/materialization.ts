import { open, stat } from "node:fs/promises";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

export interface SessionMaterializationBarrier {
  readonly materialized: Promise<void>;
  observe(event: JsonAgentSessionEvent): void;
  settlePrompt(error?: unknown): void;
  dispose(): void;
}

async function assertReadableSessionFile(path: string): Promise<void> {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`Session path is not a regular file: ${path}`);
  const file = await open(path, "r");
  await file.close();
}

export function createSessionMaterializationBarrier(options: {
  sessionPath: string;
  continuation: boolean;
  assertReadable?: (path: string) => Promise<void>;
  defer?: (run: () => void) => void;
}): SessionMaterializationBarrier {
  const assertReadable = options.assertReadable ?? assertReadableSessionFile;
  const defer = options.defer ?? ((run: () => void) => setTimeout(run, 0));
  let state: "pending" | "resolved" | "rejected" = "pending";
  let assistantObserved = false;
  let promptError: unknown;
  let resolveMaterialized!: () => void;
  let rejectMaterialized!: (error: unknown) => void;
  let checks = Promise.resolve();

  const materialized = new Promise<void>((resolve, reject) => {
    resolveMaterialized = resolve;
    rejectMaterialized = reject;
  });

  const reject = (error: unknown) => {
    if (state !== "pending") return;
    state = "rejected";
    rejectMaterialized(error);
  };

  const check = (final: boolean) => {
    checks = checks.then(async () => {
      if (state !== "pending") return;
      try {
        await assertReadable(options.sessionPath);
      } catch (error) {
        if (options.continuation || final) reject(promptError ?? error);
        return;
      }
      if (state !== "pending") return;
      state = "resolved";
      resolveMaterialized();
    });
  };

  if (options.continuation) check(true);

  return {
    materialized,
    observe(event) {
      if (
        state !== "pending"
        || options.continuation
        || assistantObserved
        || event.type !== "message_end"
        || event.message.role !== "assistant"
      ) return;
      assistantObserved = true;
      try {
        defer(() => check(false));
      } catch (error) {
        reject(error);
      }
    },
    settlePrompt(error) {
      if (state !== "pending") return;
      promptError = error;
      check(true);
    },
    dispose() {
      reject(new Error("Session materialization barrier disposed before materialization."));
    },
  };
}
