export type NativeLocalShellTool = "bash" | "powershell";

export function nativeLocalShellTool(platform: NodeJS.Platform): NativeLocalShellTool {
  return platform === "win32" ? "powershell" : "bash";
}

export function excludedLocalShellTools(platform: NodeJS.Platform): NativeLocalShellTool[] {
  return [platform === "win32" ? "bash" : "powershell"];
}

export function normalizeLocalShellTools(
  tools: readonly string[],
  platform: NodeJS.Platform,
): string[] {
  const native = nativeLocalShellTool(platform);
  return [...new Set(tools.map((tool) =>
    tool === "bash" || tool === "powershell" ? native : tool
  ))];
}
