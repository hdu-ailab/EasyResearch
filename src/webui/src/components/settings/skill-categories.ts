import type { SkillResourceDto } from "../../../../web/contracts";

export const skillCategories = [
  "all",
  "search",
  "experiments",
  "figures",
  "writing",
  "review",
  "utilities",
  "other",
] as const;
export type SkillCategory = (typeof skillCategories)[number];

const bundledRoles: Record<string, Exclude<SkillCategory, "all">> = {
  arxiv: "search",
  "paper-search": "search",
  "paper-lookup": "search",
  "paper-material-package": "search",
  experiment: "experiments",
  "experimental-design": "experiments",
  "hypothesis-generation": "experiments",
  "statistical-power": "experiments",
  "huggingface-datasets": "experiments",
  "ssh-experiment": "experiments",
  "remote-experiment-preflight": "experiments",
  drawio: "figures",
  "drawio-academic-skills": "figures",
  "scientific-visualization": "figures",
  "research-paper-writing": "writing",
  "survey-paper-writing": "writing",
  "latex-pdf": "writing",
  "peer-review": "review",
  grill: "review",
  autoresearch: "utilities",
  "customize-easyresearch": "utilities",
  "find-skills": "utilities",
  "pdf-to-markdown": "utilities",
  "playwright-cli": "utilities",
  "research-project-workflow": "utilities",
  "skill-creator": "utilities",
  "specialist-handoff": "utilities",
};

const signals = {
  search: /\b(search|retriev(?:e|al)|arxiv|literature lookup)\b|搜索|检索/,
  experiments: /\b(experiments?|training|datasets?|benchmark|statistical)\b|实验|训练|数据集/,
  figures: /\b(figures?|charts?|diagrams?|visualization|drawio)\b|图表|绘图|可视化/,
  writing: /\b(writing|manuscripts?|latex|drafting)\b|写作|撰写|排版/,
  review: /\b(review|referee|critique)\b|审稿|评审/,
  utilities: /\b(utilit(?:y|ies)|convert(?:er|ing)?|automation|browser|workflow)\b|实用|转换|自动化|浏览器/,
} satisfies Record<Exclude<SkillCategory, "all" | "other">, RegExp>;

/** Presentation only: ambiguous metadata deliberately has no inferred role. */
export function classifySkill(skill: Pick<SkillResourceDto, "name" | "description">): Exclude<SkillCategory, "all"> {
  const name = skill.name.toLowerCase();
  const known = Object.hasOwn(bundledRoles, name) ? bundledRoles[name] : undefined;
  if (known) return known;
  const text = `${skill.name} ${skill.description ?? ""}`;
  const matches = Object.entries(signals).filter(([, pattern]) => pattern.test(text.toLowerCase()));
  const match = matches[0];
  return matches.length === 1 && match ? (match[0] as Exclude<SkillCategory, "all">) : "other";
}
