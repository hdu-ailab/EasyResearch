import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { MemoryError, parseRequest, safeError } from "../../research-memory/policy";
import { createResearchMemoryStore } from "../../research-memory/store";
import type { MemoryActor } from "../../research-memory/types";
import { getAgentDir } from "../../runtime/pi-import";

const scope = StringEnum(["project", "shared"]);
const kind = StringEnum(["method", "strategy"]);
const outcome = StringEnum(["pass", "fail", "inconclusive"]);
const revision = Type.Integer({ minimum: 1 });
const evidencePaths = Type.Array(Type.String());
const inputSchema = Type.Object({
  action: StringEnum(["recall", "get", "propose", "verify", "activate", "reject", "retire", "rollback"]),
  scope: Type.Optional(scope),
  id: Type.Optional(Type.String({ description: "Memory UUID returned by propose or recall." })),
  expectedRevision: Type.Optional(revision),
  revision: Type.Optional(revision),
  query: Type.Optional(Type.String()),
  role: Type.Optional(Type.String()),
  kind: Type.Optional(kind),
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
  entry: Type.Optional(Type.Object({
    kind,
    title: Type.String(),
    roles: Type.Array(Type.String()),
    tags: Type.Array(Type.String()),
    conditions: Type.String(),
    procedure: Type.String(),
    limitations: Type.String(),
    rationale: Type.String(),
    evidencePaths,
    basedOn: Type.Optional(Type.Array(Type.Object({
      scope, id: Type.String(), revision,
    }, { additionalProperties: false }))),
  }, { additionalProperties: false })),
  verification: Type.Optional(Type.Object({
    outcome,
    summary: Type.String(),
    evidencePaths,
    checks: Type.Array(Type.Object({
      name: Type.String(),
      kind: StringEnum(["replay", "regression", "transfer", "mechanism"]),
      outcome,
      details: Type.String(),
    }, { additionalProperties: false })),
    comparison: Type.Optional(Type.Object({
      baseline: Type.Number(),
      candidate: Type.Number(),
      direction: StringEnum(["maximize", "minimize"]),
      baselineBudget: Type.Number({ exclusiveMinimum: 0 }),
      candidateBudget: Type.Number({ exclusiveMinimum: 0 }),
      budgetUnit: Type.String(),
      protocol: Type.String(),
      heldOutTask: Type.String(),
    }, { additionalProperties: false })),
  }, { additionalProperties: false })),
  reason: Type.Optional(Type.String()),
}, { additionalProperties: false });

export type ResearchMemoryInput = Static<typeof inputSchema>;

function toolError(error: unknown): MemoryError {
  const safe = safeError(error);
  // Pi exposes thrown messages as recoverable tool errors. Never attach causes.
  return new MemoryError(safe.code, `${safe.code}: ${safe.message}`);
}

/** Loaded only from the literal post-bootstrap root/stage extension graph. */
export function createResearchMemoryExtension(options: { agent: () => string }): ExtensionFactory {
  return pi => {
    pi.registerTool(defineTool({
      name: "research-memory",
      label: "Research Memory",
      description: "Recall active research methods and strategies, get pinned revisions, propose candidates, or independently verify them. "
        + "Only Research Assistant may activate, reject, retire, rollback, or propose shared versions. "
        + "Existing-record mutations require id and expectedRevision; get/rollback use revision. "
        + "Propose requires entry; verify requires verification; reject/retire/rollback require reason. "
        + "Evidence paths are project-relative. Recall searches project and shared by default; other actions default to project.",
      parameters: inputSchema,
      prepareArguments(input) {
        try {
          // Validate before Pi's schema diagnostics can echo a private payload.
          return parseRequest(input);
        } catch (error) {
          throw toolError(error);
        }
      },
      async execute(_toolCallId, input, signal, _onUpdate, ctx) {
        try {
          const actor: MemoryActor = {
            cwd: ctx.cwd,
            sessionId: ctx.sessionManager.getSessionId(),
            agent: options.agent(),
            model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "",
            signal,
          };
          const store = createResearchMemoryStore(getAgentDir());
          // Revalidate after native tool_call hooks, which can mutate arguments.
          const result = await store.execute(parseRequest(input), actor);
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
        } catch (error) {
          throw toolError(error);
        }
      },
    }));
  };
}
