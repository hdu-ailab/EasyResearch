export type NativeLocalShellTool = "shell";

export function nativeLocalShellTool(_platform: NodeJS.Platform): NativeLocalShellTool {
  return "shell";
}

export function excludedLocalShellTools(_platform: NodeJS.Platform): ("bash" | "powershell")[] {
  return ["bash", "powershell"];
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
