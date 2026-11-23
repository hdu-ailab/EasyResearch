export const fileReferenceEn = {
  "files.reference.choose": "Choose a file",
  "files.reference.incomplete": "Search was incomplete. Choose a listed file or open it from the file tree.",
  "files.reference.failed": "Could not resolve this file reference.",
  "files.source.label": "File source",
  "files.source.lines": "Lines {start}–{end} of {total}",
  "files.source.previous": "Previous lines",
  "files.source.next": "Next lines",
  "files.source.selection": "Selected lines {start}–{end}",
  "files.source.outside": "The referenced lines are outside the loaded text.",
} as const;
export const fileReferenceZh: Record<keyof typeof fileReferenceEn, string> = {
  "files.reference.choose": "选择文件",
  "files.reference.incomplete": "搜索未完成。请选择已列出的文件，或从文件树打开。",
  "files.reference.failed": "无法解析此文件引用。",
  "files.source.label": "文件源码",
  "files.source.lines": "第 {start}–{end} 行，共 {total} 行",
  "files.source.previous": "上一页",
  "files.source.next": "下一页",
  "files.source.selection": "已选择第 {start}–{end} 行",
  "files.source.outside": "引用行超出了已加载文本范围。",
};
