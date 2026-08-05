import { describe, expect, it, vi } from "vitest";
import { runCli } from "./index";

describe("runCli", () => {
  it("starts native TUI only for an empty argv", async () => {
    const runTui = vi.fn(async () => undefined);
    const runWeb = vi.fn(async () => undefined);
    expect(await runCli([], { runTui, runWeb })).toBe(0);
    expect(runTui).toHaveBeenCalledOnce();
    expect(runWeb).not.toHaveBeenCalled();
  });

  it("starts Web only for the exact web command", async () => {
    const runTui = vi.fn(async () => undefined);
    const runWeb = vi.fn(async () => undefined);
    expect(await runCli(["web"], { runTui, runWeb })).toBe(0);
    expect(runWeb).toHaveBeenCalledOnce();
  });

  it.each([["run"], ["new"], ["web", "--port", "4000"], ["--mode", "rpc"]])(
    "rejects non-public argv %j",
    async (...argv) => {
      const runTui = vi.fn(async () => undefined);
      const runWeb = vi.fn(async () => undefined);
      expect(await runCli(argv, { runTui, runWeb })).toBe(1);
      expect(runTui).not.toHaveBeenCalled();
      expect(runWeb).not.toHaveBeenCalled();
    },
  );
});