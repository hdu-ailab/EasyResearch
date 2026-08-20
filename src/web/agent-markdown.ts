export function starterAgentMarkdown(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} agent\nenable: true\n---\n\nDescribe this agent's role and operating procedure here.\n`;
}
