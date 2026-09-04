import type { SessionMessageView, SessionSummaryView, ToolView } from "../src/session-reducer";

const bodies = [
  (index: number) => `## Result ${index}\n\nA paragraph with **bold**, _emphasis_, and \`inline code\`.`,
  (index: number) => `| metric | value |\n| --- | ---: |\n| score | ${index}.25 |\n| rank | ${index % 9} |`,
  (index: number) => `- [x] inspect row ${index}\n- [ ] preserve stable Markdown\n- [ ] avoid main-thread reparsing`,
  (index: number) => `The objective is $L_${index} = \\sum_i x_i^2$.\n\n$$\\nabla L_${index}=2x$$`,
  (index: number) => `\`\`\`ts\nexport const row${index} = { stable: true, index: ${index} };\n\`\`\``,
  (index: number) => `\`\`\`bash\nbun test --filter transcript-${index}\ngit diff --check\n\`\`\``,
  (index: number) => `> Historical row ${index}\n\n1. retain identity\n2. measure height\n3. render once`,
  (index: number) => `\`\`\`mermaid\ngraph LR\n  A${index} --> B${index}\n\`\`\``,
];

export const STREAM_DELTAS = Array.from({ length: 160 }, (_, index) =>
  index === 159 ? " benchmark-complete" : ` fragment-${String(index).padStart(3, "0")}`,
);

export const FINAL_STREAM_TEXT = STREAM_DELTAS.join("");

export function createTranscriptFixture(): {
  messages: SessionMessageView[];
  tools: ToolView[];
  summaries: SessionSummaryView[];
} {
  const messages: SessionMessageView[] = [];
  const tools: ToolView[] = [];
  const summaries: SessionSummaryView[] = [];
  let order = 0;

  for (let index = 0; index < 160; index += 1) {
    const body = bodies[index % bodies.length] ?? bodies[0];
    if (!body) throw new Error("benchmark Markdown bodies are missing");
    messages.push({
      key: `user-${index}`,
      role: "user",
      text: `Inspect transcript performance turn ${index}`,
      streaming: false,
      error: false,
      order: order++,
    });
    messages.push({
      key: `assistant-${index}`,
      role: "assistant",
      text: body(index),
      reasoning: index % 5 === 0 ? `Reasoning for row ${index}\n\nKeep the viewport anchor stable.` : undefined,
      isThinking: false,
      streaming: false,
      error: false,
      order: order++,
    });
    if (index % 8 === 2) {
      tools.push({
        key: `tool-${index}`,
        name: "bash",
        args: `benchmark-${index}`,
        output: `completed deterministic tool output ${index}\n`.repeat(3),
        running: false,
        done: true,
        error: false,
        order: order++,
      });
    }
    if (index % 16 === 7) {
      summaries.push({
        key: `summary-${index}`,
        entryId: `summary-entry-${index}`,
        kind: "compaction",
        summary: `Compacted benchmark summary ${index}.`,
        order: order++,
      });
    }
  }

  messages.push({
    key: "stream-user",
    role: "user",
    text: "Run the streaming benchmark",
    streaming: false,
    error: false,
    order: order++,
  });
  messages.push({
    key: "stream-assistant",
    role: "assistant",
    text: "",
    streaming: true,
    error: false,
    order,
  });
  return { messages, tools, summaries };
}
