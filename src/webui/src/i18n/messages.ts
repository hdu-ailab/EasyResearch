import type { Language } from "../preferences";

export const en = {
  "settings.title": "Settings",
  "settings.appearance.title": "Appearance",
  "settings.appearance.chatFontSize": "Chat font size",
  "settings.appearance.filesFontSize": "Files font size",
  "settings.appearance.decreaseChat": "Decrease chat font size",
  "settings.appearance.increaseChat": "Increase chat font size",
  "settings.appearance.decreaseFiles": "Decrease files font size",
  "settings.appearance.increaseFiles": "Increase files font size",
  "settings.appearance.previewTitle": "Preview",
  "settings.appearance.previewChat": "A quick brown fox jumps over the lazy dog — chat text at work.",
  "settings.appearance.previewFiles": "index.ts — monospace file text at work.",
  "settings.language.title": "Language",
  "settings.language.selector": "Interface language",
  "settings.language.hint": "Default follows your browser language; you can switch anytime.",
  "settings.agents.title": "Agent models",
  "settings.agents.globalHint": "Global defaults — project overrides are set in the JSON editor",
  "settings.agents.inherit": "inherit (orchestrator's model)",
  "settings.agents.orchestratorHint": "Uses the session model — set in the work page, not configurable here (ADR-027)",
  "settings.config.entry": "Edit JSON config file…",
} as const;

export type MessageKey = keyof typeof en;

export const zhCN: Record<MessageKey, string> = {
  "settings.title": "设置",
  "settings.appearance.title": "外观",
  "settings.appearance.chatFontSize": "聊天字号",
  "settings.appearance.filesFontSize": "文件字号",
  "settings.appearance.decreaseChat": "减小聊天字号",
  "settings.appearance.increaseChat": "增大聊天字号",
  "settings.appearance.decreaseFiles": "减小文件字号",
  "settings.appearance.increaseFiles": "增大文件字号",
  "settings.appearance.previewTitle": "预览",
  "settings.appearance.previewChat": "敏捷的棕色狐狸跳过懒狗 —— 聊天正文效果。",
  "settings.appearance.previewFiles": "index.ts —— 等宽文件文本效果。",
  "settings.language.title": "语言",
  "settings.language.selector": "界面语言",
  "settings.language.hint": "默认跟随浏览器语言，可随时手动切换。",
  "settings.agents.title": "智能体模型",
  "settings.agents.globalHint": "全局默认值 —— 项目级覆盖请在 JSON 编辑器中设置",
  "settings.agents.inherit": "继承（编排者模型）",
  "settings.agents.orchestratorHint": "使用会话模型 —— 在工作页设置，此处不可配置（ADR-027）",
  "settings.config.entry": "编辑 JSON 配置文件…",
};

export const messages: Record<Language, Record<MessageKey, string>> = {
  en,
  "zh-CN": zhCN,
};
