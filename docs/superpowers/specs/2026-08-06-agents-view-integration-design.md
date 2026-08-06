# Agents View Backend/Frontend Integration

Date: 2026-08-06
Scope: `src/web/` + `src/webui/src/` (WorkPage).
Branch: `feat/webui-opencode-rewrite` (worktree), backend parity with main.

## Problem

The ADR-022 five-agent pipeline exists in `src/agents/*.md` + `src/subagent/` on main,
but the Web UI Agents view (`WorkPage.tsx` `AgentList`) is a hardcoded placeholder: a single
static Orchestrator card and the text *"Subagent cards appear here while they run in
parallel"* — which contradicts ADR-022 strict serial execution. The frontend does not
consume the real five-agent roster. Test fixtures also still use the removed `literature`
agent name.

## Behavior

- `GET /api/agents` returns the runtime agent roster discovered from the LazyResearch global
  agents dir (`discoverAgents()` in `src/subagent/agents.ts`), as `AgentDto[]`:
  `{ name, description, tools, subagents, model }`. Orchestrator first, others in file order.
- The work page Agents view renders the real roster: the orchestrator card (always present)
  plus cards for each roster subagent. Chips/cards show name, role description, tool count,
  and (when provided) model. The view reflects ADR-022 serial semantics — no "parallel"
  language.
- Subagent cards for agents seen live in the message stream (dynamic `agentId`) merge into
  the view as they appear, matching the existing chip behavior; the roster provides the
  static five cards.
- If `GET /api/agents` fails or returns empty, the Agents view still renders the
  orchestrator card from the local fallback and shows a muted note; the page never crashes.

## Backend

1. `src/web/contracts.ts`: add `AgentDto` (`name`, `description`, `tools?`, `subagents?`,
   `model?`).
2. `src/web/routes.ts`: `RouteServices` gains `listAgents: () => Promise<AgentDto[]>`.
   Handle `GET /api/agents`. Map `AgentConfig` to `AgentDto` (omit `systemPrompt`, `source`,
   `filePath`; keep `description`).
3. `src/web/server.ts`: production `listAgents` calls `discoverAgents()` from
   `src/subagent/agents.ts` and maps to DTOs.
4. Tests: `src/web/server.test.ts` — create a temp global agents dir seeded with two `.md`;
   assert the endpoint returns name + description and never leaks the system prompt.

## Frontend

1. `src/webui/src/api.ts`: `listAgents(): Promise<AgentDto[]>` GETs `/api/agents`.
   `api.test.ts` asserts the transport.
2. `WorkPage.tsx` `AgentList`: fetch the roster on mount (loading/error/idle states), render
   an orchestrator card plus one card per roster subagent (agent name + description +
   `subagents` allowlist). Merge message-driven `agentId`s (e.g. a dynamic chip list) into
   the panel while keeping the existing agent chip row behavior. Replace the “in parallel”
   copy with a serial note.
3. `WorkPage.test.tsx`: replace the `literature` fixture with `search`; add a roster
   rendering test (orchestrator + five names visible) and a serial-copy assertion.

## Docs

- `.docs/pi-backend-parity.md`: add `GET /api/agents` to the API surface list; note
  "agent details" is no longer deferred (minimal roster read) while deeper agent features
  remain deferred.
- `.docs/webui.md`: Agents view paragraph describes the roster-driven card grid and serial
  note.
- `docs/superpowers/plans/…`: record Task 5 step for the Agents view roster hook.