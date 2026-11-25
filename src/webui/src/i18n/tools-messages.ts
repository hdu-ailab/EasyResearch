export const toolsEn = {
  "tools.loadFailures": "{n} tool extensions failed to load. Loaded tools remain available.",
  "tools.atLeastLoadFailures": "At least {n} tool extensions failed to load. Loaded tools remain available.",
  "tools.registrationIssues": "{n} tool extensions have registration issues. Loaded tools remain available.",
  "tools.atLeastRegistrationIssues":
    "At least {n} tool extensions have registration issues. Loaded tools remain available.",
  "tools.registrationExtensions": "Tool registration issues",
  "tools.truncated": "Some extension diagnostics are omitted.",
  "tools.refresh": "Refresh tools",
  "tools.failedExtensions": "Failed tool extensions",
  "tools.loaded": "Loaded tools",
  "tools.loading": "Loading tools…",
  "tools.empty": "No tools loaded.",
  "tools.readError": "Could not load the tool inventory.",
  "tools.refreshError": "Could not synchronize the tool inventory.",
  "tools.cached": "Showing the last loaded inventory.",
} as const;

export const toolsZh: Record<keyof typeof toolsEn, string> = {
  "tools.loadFailures": "{n} 个工具扩展加载失败。已加载的工具仍可使用。",
  "tools.atLeastLoadFailures": "至少 {n} 个工具扩展加载失败。已加载的工具仍可使用。",
  "tools.registrationIssues": "{n} 个工具扩展存在注册问题。已加载的工具仍可使用。",
  "tools.atLeastRegistrationIssues": "至少 {n} 个工具扩展存在注册问题。已加载的工具仍可使用。",
  "tools.registrationExtensions": "工具注册问题",
  "tools.truncated": "部分扩展诊断已省略。",
  "tools.refresh": "刷新工具",
  "tools.failedExtensions": "加载失败的工具扩展",
  "tools.loaded": "已加载的工具",
  "tools.loading": "正在加载工具…",
  "tools.empty": "暂无已加载的工具。",
  "tools.readError": "无法加载工具列表。",
  "tools.refreshError": "无法同步工具列表。",
  "tools.cached": "当前显示上次加载的列表。",
};
