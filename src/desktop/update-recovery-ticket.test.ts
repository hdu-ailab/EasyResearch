import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createDesktopRecoveryTicket, validateDesktopRecoveryTicket, validateUpdateHandoff, type DesktopUpdateHandoff } from "./update-protocol";

it("admits a fresh recovery ticket after the original install/startup window expired", () => {
  const started = Date.now(); const now = started + 21 * 60_000;
  const root = join(tmpdir(), "desktop-ticket"); const hash = "a".repeat(64);
  const handoff: DesktopUpdateHandoff = { schema: 1, token: "a".repeat(43), operationId: randomUUID(), hostPid: 40,
    hostPath: join(root, "installed", "EasyResearch.exe"), userDataDir: root, agentDir: join(root, "agent"), directory: join(root, "updates", "update-fixture"),
    currentVersion: "1.0.0", version: "2.0.0", installerName: "EasyResearch-2.0.0-windows-x64.exe", installerSize: 12, installerSha256: hash,
    helperSha256: hash, oldHostSha256: hash, oldAppSha256: hash, oldSidecarSha256: hash, oldBootId: "old-boot", route: "#/", expiresAt: started + 20 * 60_000 };
  const identity = { hostSha256: hash, appSha256: hash, sidecarSha256: hash };
  const context = { directory: handoff.directory, workerPid: 41, token: "b".repeat(43) };
  expect(() => validateUpdateHandoff(handoff, now)).toThrow();
  const ticket = createDesktopRecoveryTicket(handoff, identity, context, hash, now);
  expect(() => validateDesktopRecoveryTicket(ticket, handoff, identity, context, hash, now + 1_000)).not.toThrow();
  expect(handoff.expiresAt).toBe(started + 20 * 60_000);
  expect(() => validateDesktopRecoveryTicket(ticket, handoff, identity, context, hash, now + 3 * 60_000)).toThrow();
  expect(() => validateDesktopRecoveryTicket(ticket, handoff, identity, { ...context, token: "c".repeat(43) }, hash, now)).toThrow();
  expect(() => validateDesktopRecoveryTicket(ticket, handoff, identity, context, "d".repeat(64), now)).toThrow();
  expect(() => createDesktopRecoveryTicket(handoff, { ...identity, sidecarSha256: "d".repeat(64) }, context, hash, now)).toThrow();
});
