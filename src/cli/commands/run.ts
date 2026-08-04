import { createInterface } from "node:readline";
import { createOrchestratorSession } from "../../runtime/session";
import { installBundledSkills } from "../../config";

export interface RunCommandOptions {
  model?: string;
}

/**
 * `lazypaper run` — start the orchestrator session for the current paper
 * project and interact with it from the terminal.
 *
 * For the MVP, this is a minimal REPL: the orchestrator is a full coding agent
 * (with the subagent tool), so the user can type natural-language instructions
 * and see streaming output. Session history is persisted by Pi's SessionManager.
 */
export async function runRun(options: RunCommandOptions = {}): Promise<void> {
  const cwd = process.cwd();
  installBundledSkills();
  const { session } = await createOrchestratorSession({ cwd, model: options.model });

  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log("LazyResearch orchestrator started. Type your paper idea, or /exit to quit.");

  const prompt = () => {
    rl.question("> ", async (input) => {
      const text = input.trim();
      if (!text) return prompt();
      if (text === "/exit" || text === "/quit") {
        session.dispose();
        rl.close();
        process.exit(0);
      }
      try {
        await session.prompt(text);
      } catch (err) {
        console.error("\n" + String(err instanceof Error ? err.message : err));
      }
      prompt();
    });
  };
  prompt();
}
