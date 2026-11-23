import { describe, expect, it } from "vitest";
import { windowsUpdateCommandLine, startWindowsUpdateJob } from "./windows-update-job";

describe("Windows updater command line", () => {
  it("preserves empty, quoted, Unicode and trailing-backslash arguments", () => {
    expect(windowsUpdateCommandLine("C:\\Program Files\\node.exe", ["", "a b", 'a"b', "雪 λ", "a b\\", "plain\\"]))
      .toBe('"C:\\Program Files\\node.exe" "" "a b" "a\\"b" "雪 λ" "a b\\\\" plain\\');
  });

  it("leaves NSIS's final directory suffix raw while protecting the executable token", () => {
    expect(windowsUpdateCommandLine("C:\\some folder\\setup.exe", ["/S", "/currentuser", "/D=C:\\用户 files\\EasyResearch"], true))
      .toBe('"C:\\some folder\\setup.exe" /S /currentuser /D=C:\\用户 files\\EasyResearch');
  });

  it.each(["node.exe", "C:node.exe", "\\node.exe", "C:\\npm.cmd", 'C:\\bad"name.exe', "C:\\bad\0.exe"])("rejects non-executable or ambiguous application paths (%s)", (command) => {
    expect(() => windowsUpdateCommandLine(command, [])).toThrow();
  });

  it("rejects NUL and overlong command lines before any target admission", () => {
    expect(() => windowsUpdateCommandLine("C:\\node.exe", ["secret\0suffix"])).toThrow();
    expect(() => windowsUpdateCommandLine("C:\\node.exe", ["x".repeat(32767)])).toThrow();
  });

  it("honors an already aborted signal before any platform/source preflight", async () => {
    const abort = new AbortController(); abort.abort();
    await expect(startWindowsUpdateJob("C:\\node.exe", [], { env: {}, signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it.skipIf(process.platform === "win32")("fails closed on a non-Windows host", async () => {
    await expect(startWindowsUpdateJob("C:\\node.exe", [], { env: {} })).rejects.toThrow(/Windows/);
  });
});
