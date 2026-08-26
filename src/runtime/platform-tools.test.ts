import { describe, expect, it } from "vitest";
import {
  excludedLocalShellTools,
  nativeLocalShellTool,
  normalizeLocalShellTools,
} from "./platform-tools";

describe("platform local-shell policy", () => {
  it.each([
    ["win32", "powershell", ["bash"]],
    ["linux", "bash", ["powershell"]],
    ["darwin", "bash", ["powershell"]],
  ] as const)("selects one native shell on %s", (platform, native, excluded) => {
    expect(nativeLocalShellTool(platform)).toBe(native);
    expect(excludedLocalShellTools(platform)).toEqual(excluded);
  });

  it("normalizes both shell spellings on Windows without rewriting ssh-bash", () => {
    expect(normalizeLocalShellTools(
      ["read", "bash", "powershell", "ssh-bash", "bash"],
      "win32",
    )).toEqual(["read", "powershell", "ssh-bash"]);
  });

  it.each(["linux", "darwin"] as const)(
    "normalizes both shell spellings on %s",
    (platform) => {
      expect(normalizeLocalShellTools(
        ["read", "powershell", "bash", "ssh-bash"],
        platform,
      )).toEqual(["read", "bash", "ssh-bash"]);
    },
  );
});
