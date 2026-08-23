import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireServerLease,
  acquireTransitionLease,
  serverLeasePath,
  transitionLeasePath,
} from "./runtime-lease";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "easyresearch-runtime-lease-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("runtime leases", () => {
  it("allows only one live server owner and releases by token", async () => {
    const first = await acquireServerLease(root, "cli", "token-a", {
      isAlive: () => true,
    });

    await expect(acquireServerLease(root, "desktop", "token-b", {
      isAlive: () => true,
      timeoutMs: 0,
    })).rejects.toThrow(/live EasyResearch server lease/i);

    expect(first.release()).toBe(true);
    expect(existsSync(serverLeasePath(root))).toBe(false);
  });

  it("recovers a valid lease only after proving its process is dead", async () => {
    writeFileSync(serverLeasePath(root), JSON.stringify({
      schema: 1,
      kind: "server",
      owner: "cli",
      pid: 4242,
      token: "dead-token",
    }));

    const lease = await acquireServerLease(root, "desktop", "new-token", {
      isAlive: (pid) => pid !== 4242,
    });

    expect(JSON.parse(readFileSync(serverLeasePath(root), "utf8"))).toMatchObject({
      owner: "desktop",
      pid: process.pid,
      token: "new-token",
    });
    expect(lease.release()).toBe(true);
  });

  it("does not let an older handle release a successor lease", async () => {
    const first = await acquireServerLease(root, "cli", "token-a");
    writeFileSync(serverLeasePath(root), JSON.stringify({
      schema: 1,
      kind: "server",
      owner: "desktop",
      pid: process.pid,
      token: "token-b",
    }));

    expect(first.release()).toBe(false);
    expect(JSON.parse(readFileSync(serverLeasePath(root), "utf8"))).toMatchObject({
      token: "token-b",
    });
  });

  it("fails closed for a malformed unverifiable lease", async () => {
    writeFileSync(transitionLeasePath(root), "not-json");

    await expect(acquireTransitionLease(root, "cli", { timeoutMs: 0 }))
      .rejects.toThrow(/cannot verify/i);
    expect(readFileSync(transitionLeasePath(root), "utf8")).toBe("not-json");
  });

  it("waits for a live transition owner and acquires after release", async () => {
    const first = await acquireTransitionLease(root, "cli");
    let waits = 0;

    const second = acquireTransitionLease(root, "desktop", {
      isAlive: () => true,
      timeoutMs: 1_000,
      wait: async () => {
        waits += 1;
        first.release();
      },
    });

    await expect(second).resolves.toMatchObject({ token: expect.any(String) });
    expect(waits).toBe(1);
  });
});
