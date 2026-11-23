import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { assertNativeJournalEntryDurable } from "../background/execution-claims";

/** Own partial append progress until the same idle native queue is safely released. */
export class RootSuspensionQueue {
  private pending?: AgentMessage[];
  private cursor = 0;
  private entryId?: string;
  private steeringCleared = false;

  preserve(session: Pick<AgentSession, "agent" | "sessionManager" | "isIdle" | "clearQueue">): void {
    if (!session.isIdle) throw new Error("Root suspension requires native idle before preserving queued input.");
    if (session.agent.steeringMode !== "all") throw new Error("Root suspension requires the accepted all-steers policy.");
    const journal = session.sessionManager;
    this.pending ??= session.agent.peekQueuedMessages();
    while (this.cursor < this.pending.length) {
      const message = this.pending[this.cursor]!;
      if (!this.entryId) {
        if (message.role === "custom") {
          this.entryId = journal.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
        } else if (message.role === "user") {
          this.entryId = journal.appendMessage(message);
        } else throw new Error("Root suspension cannot preserve this queued message through the public native input API.");
      }
      assertNativeJournalEntryDurable(journal, journal.getEntries().find((entry) => entry.id === this.entryId));
      this.entryId = undefined;
      this.cursor++;
    }
    if (!this.steeringCleared) {
      session.agent.clearSteeringQueue();
      this.steeringCleared = true;
    }
    // Pi previews only the selected queue. Never clear an additional, uninspected
    // follow-up queue or guess which identical custom payload belongs to which queue.
    if (session.agent.hasQueuedMessages()) throw new Error("Pending native follow-up input prevents safe restart; use terminal Exit or complete that input first.");
    session.clearQueue();
  }
}
