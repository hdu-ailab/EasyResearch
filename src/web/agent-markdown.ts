import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function readTextFile(path: string): string {
  return readFileSync(path, "utf8");
}

export function writeTextFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
}

export function updateFrontmatter(content: string, updates: Record<string, string | null>): string {
  if (!content.startsWith("---\n")) throw new Error("Agent Markdown must start with YAML frontmatter");
  const end = content.indexOf("\n---", 4);
  if (end < 0) throw new Error("Agent Markdown frontmatter is not closed");
  const header = content.slice(4, end).split("\n");
  const handled = new Set<string>();
  const result: string[] = [];
  for (const line of header) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):/);
    const key = match?.[1];
    if (!key || !(key in updates)) {
      result.push(line);
      continue;
    }
    handled.add(key);
    const value = updates[key];
    if (value !== null) result.push(`${key}: ${value}`);
  }
  for (const [key, value] of Object.entries(updates)) {
    if (!handled.has(key) && value !== null) result.push(`${key}: ${value}`);
  }
  return `---\n${result.join("\n")}\n---${content.slice(end + 4)}`;
}

export function starterAgentMarkdown(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} agent\nenable: true\n---\n\nDescribe this agent's role and operating procedure here.\n`;
}
