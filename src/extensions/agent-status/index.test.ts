import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentStatusExtension } from "./index";
import { SUBAGENT_SESSION_LINK_ENTRY } from "../../subagent/session-links";
import { AGENT_STATUS_TYPE, SUBAGENT_COMPLETED_TYPE, SUBAGENT_ERRORED_TYPE } from "./status";

const [importPiMock] = vi.hoisted(() => [vi.fn()]);
vi.mock("../../runtime/pi-import", () => ({ importPi: importPiMock }));

function fakePi() {
  const handlers = new Map<string, ((event: any, ctx?: any) => Promise<any>)[]>();
  const appended: Array<{ type: string; data: unknown }> = [];
  return {
    on: (event: string, handler: (event: any, ctx?: any) => Promise<any>) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
    handlers,
    appended,
  };
}

function link(toolCallId: string, agent: string, childSessionId: string) {
  return { type: "custom", customType: SUBAGENT_SESSION_LINK_ENTRY, data: { toolCallId, agent, childSessionId } };
}

beforeEach(() => {
  importPiMock.mockReset().mockResolvedValue({ SessionManager: { list: async () => [] } });
});

describe("createAgentStatusExtension", () => {
  const factory = createAgentStatusExtension() as (pi: unknown) => Promise<void>;
  const tFactory = createAgentStatusExtension({ now: () => "t" }) as (pi: unknown) => Promise<void>;

  it("registers tool_execution_end and before_agent_start handlers", async () => {
    const pi = fakePi();
    await factory(pi as never);
    expect(pi.handlers.has("tool_execution_end")).toBe(true);
    expect(pi.handlers.has("before_agent_start")).toBe(true);
  });

  it("persists a completion marker when the subagent tool finishes cleanly", async () => {
    const pi = fakePi();
    await factory(pi as never);
    const handler = pi.handlers.get("tool_execution_end")![0]!;
    await handler({ toolName: "subagent", toolCallId: "call-9", isError: false }, {});
    await handler({ toolName: "read", toolCallId: "call-10", isError: false }, {});
    expect(pi.appended).toEqual([{ type: SUBAGENT_COMPLETED_TYPE, data: { toolCallId: "call-9" } }]);
  });

  it("persists an error marker when the subagent tool fails or aborts", async () => {
    const pi = fakePi();
    await factory(pi as never);
    const handler = pi.handlers.get("tool_execution_end")![0]!;
    await handler({ toolName: "subagent", toolCallId: "call-9", isError: true }, {});
    expect(pi.appended).toEqual([{ type: SUBAGENT_ERRORED_TYPE, data: { toolCallId: "call-9" } }]);
  });

  it("injects a status message with working children and hides it from users", async () => {
    const pi = fakePi();
    await tFactory(pi as never);
    importPiMock.mockResolvedValue({
      SessionManager: { list: async () => [{ id: "s0", path: "/sessions/0.jsonl" }] },
    });
    const handler = pi.handlers.get("before_agent_start")![0]!;
    const result = await handler(
      { prompt: "continue", images: [], systemPrompt: "", systemPromptOptions: {} },
      { cwd: "/paper", sessionManager: { getEntries: () => [link("d0", "search", "s0")] } },
    );
    expect(result).toMatchObject({
      message: { customType: AGENT_STATUS_TYPE, display: false, content: expect.stringContaining("Working subagent:") },
    });
  });

  it("does not inject when the rendered block is unchanged", async () => {
    const pi = fakePi();
    await tFactory(pi as never);
    const previous = "<agent_status>\nCurrent time: t\n</agent_status>";
    const handler = pi.handlers.get("before_agent_start")![0]!;
    const entries = [
      { type: "custom_message", customType: AGENT_STATUS_TYPE, content: previous, display: false },
    ];
    const result = await handler(
      { prompt: "again", images: [], systemPrompt: "", systemPromptOptions: {} },
      { cwd: "/paper", sessionManager: { getEntries: () => entries } },
    );
    expect(result).toEqual({});
  });
});