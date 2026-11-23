import { expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { createDesktopUpdateInput, runUpdateCustody } from "./update-worker";
import { desktopUpdateFailure, windowsInstallationLocation, windowsNsisArguments } from "./update-protocol";

it("retains native failure categories without publishing exception messages, paths or arbitrary codes", () => {
  const error = Object.assign(new Error("private-token and private-path"), { code: "EPERM", path: "private-path" });
  expect(desktopUpdateFailure("rollback-remove-current", error)).toEqual({ operation: "rollback-remove-current", code: "EPERM" });
  for (const code of ["private-token", 123, undefined]) {
    expect(desktopUpdateFailure("rollback-registry", { ...error, code })).toEqual({ operation: "rollback-registry", code: "FAILED" });
  }
});

it("preserves a space-containing original NSIS directory as the raw final argument", () => {
  const args = windowsNsisArguments("C:\\Custom Apps\\EasyResearch");
  expect(args.at(-1)).toBe("/D=C:\\Custom Apps\\EasyResearch");
  expect(args).not.toContain("--force-run");
});

it("reads the exact Unicode installation directory from a native UTF-16 registry export", () => {
  const text = '\ufeffWindows Registry Editor Version 5.00\r\n\r\n[HKEY_CURRENT_USER\\Software\\fixture]\r\n"InstallLocation"="C:\\\\用户 files\\\\EasyResearch"\r\n';
  expect(windowsInstallationLocation(Buffer.from(text, "utf16le"))).toBe("C:\\用户 files\\EasyResearch");
  expect(() => windowsInstallationLocation(Buffer.from('"InstallLocation"="C:\\\\wrong"', "utf8"))).toThrow();
});

function fixture() {
  const order: string[] = [];
  const run = (name: string) => vi.fn(async () => { order.push(name); });
  return { order, prepare: run("prepare"), awaitCommit: vi.fn(async () => true), waitForHostExit: run("host-exit"),
    install: vi.fn(async (admitted: () => void) => { admitted(); order.push("installer-exit"); }), verify: run("verify-installed"), startSuccessor: run("successor-ready"),
    rollback: run("rollback"), recover: run("recovery-ready"), report: vi.fn(async (phase: string) => { order.push(phase); }), release: run("release") };
}

it("parent EOF before explicit commit never installs and releases only after cleanup", async () => {
  const f = fixture(); f.awaitCommit.mockResolvedValue(false);
  await runUpdateCustody(f);
  expect(f.install).not.toHaveBeenCalled(); expect(f.waitForHostExit).not.toHaveBeenCalled();
  expect(f.order.at(-1)).toBe("release"); expect(f.report).toHaveBeenCalledWith("cancelled", expect.objectContaining({ installerAdmitted: false, hostExited: false }));
});

it("retains custody through real installer exit, exact installation check and fresh successor readiness", async () => {
  const f = fixture(); await runUpdateCustody(f);
  expect(f.order.indexOf("host-exit")).toBeLessThan(f.order.indexOf("installer-exit"));
  expect(f.order.indexOf("verify-installed")).toBeGreaterThan(f.order.indexOf("installer-exit"));
  expect(f.order.indexOf("complete")).toBeGreaterThan(f.order.indexOf("successor-ready"));
  expect(f.order.at(-1)).toBe("release");
});

it("failed installation restores recoverable original files and records failure", async () => {
  const f = fixture(); f.install.mockImplementation(async (admitted) => { admitted(); throw new Error("failed"); });
  await expect(runUpdateCustody(f)).rejects.toThrow("failed");
  expect(f.rollback).toHaveBeenCalledOnce(); expect(f.startSuccessor).not.toHaveBeenCalled();
  expect(f.recover).toHaveBeenCalledOnce();
  expect(f.order.indexOf("recovery-ready")).toBeGreaterThan(f.order.indexOf("rollback"));
  expect(f.report).toHaveBeenLastCalledWith("failed", expect.objectContaining({ rollback: "complete", recoveryComplete: true })); expect(f.order.at(-1)).toBe("release");
});

it("does not mutate installation when the old host fails to exit", async () => {
  const f = fixture(); f.waitForHostExit.mockRejectedValue(new Error("still live"));
  await expect(runUpdateCustody(f)).rejects.toThrow("still live");
  expect(f.install).not.toHaveBeenCalled(); expect(f.rollback).not.toHaveBeenCalled();
  expect(f.recover).not.toHaveBeenCalled();
  expect(f.report).toHaveBeenCalledWith("failed", expect.objectContaining({ hostExited: false }));
});

it("never launches recovery before rollback and descendant settlement succeed", async () => {
  const f = fixture(); f.install.mockImplementation(async (admitted) => { admitted(); throw new Error("install failed"); });
  f.rollback.mockRejectedValue(new Error("descendants still live"));
  await expect(runUpdateCustody(f)).rejects.toThrow("descendants still live");
  expect(f.recover).not.toHaveBeenCalled(); expect(f.report).toHaveBeenCalledWith("failed", expect.objectContaining({ rollback: "pending", recoveryComplete: false }));
});

it("a missing installer custody capability relaunches the intact old host without replacing its files", async () => {
  const f = fixture(); f.install.mockRejectedValue(new Error("native job unavailable"));
  await expect(runUpdateCustody(f)).rejects.toThrow("native job unavailable");
  expect(f.rollback).not.toHaveBeenCalled(); expect(f.recover).toHaveBeenCalledOnce();
});

it.each(["EOF", "abort", "early-commit", "wrong-token"])("actual parent protocol cancels on %s before commitment", async (mode) => {
  const stdin = new PassThrough(); const token = "x".repeat(43);
  const input = createDesktopUpdateInput(token, stdin, 1000); const abort = vi.fn(); input.onAbort(abort);
  try {
    stdin.write(`${JSON.stringify({ type: "prepare", token, handoff: { fixture: true } })}\n`);
    await expect(input.prepare()).resolves.toEqual({ fixture: true });
    if (mode === "EOF") stdin.end();
    else stdin.write(`${JSON.stringify({ type: mode === "abort" ? "abort" : "commit", token: mode === "wrong-token" ? "wrong" : token })}\n`);
    await expect(input.commit()).resolves.toBe(false);
    expect(abort).toHaveBeenCalled();
  } finally { input.dispose(); stdin.destroy(); }
});

it("actual parent protocol requires prepared acknowledgement, then survives postcommit EOF", async () => {
  const stdin = new PassThrough(); const token = "x".repeat(43);
  const input = createDesktopUpdateInput(token, stdin, 1000); const abort = vi.fn(); input.onAbort(abort);
  try {
    stdin.write(`${JSON.stringify({ type: "prepare", token, handoff: {} })}\n`); await input.prepare();
    input.allowCommit(); stdin.write(`${JSON.stringify({ type: "commit", token })}\n`);
    expect(await input.commit()).toBe(true); stdin.end(); await input.parentEnded();
    expect(abort).not.toHaveBeenCalled();
  } finally { input.dispose(); stdin.destroy(); }
});
