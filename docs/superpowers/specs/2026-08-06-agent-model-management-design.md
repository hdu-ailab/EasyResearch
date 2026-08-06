# Agent Model Management & Homepage Config Page

Date: 2026-08-06
Branch: `feat/webui-opencode-rewrite` (worktree), backend parity with main.
Supersedes: ADR-008 (frontmatter `model:`), ADR-020 (global-only Web config editing).

## Problem

- The agents view shows no real per-agent model, and there is no way to change an agent's
  model for only the current session.
- ADR-008's frontmatter `model:` is the only per-agent default, and it lives in the agent
  `.md` definition files — the user wants configuration in JSON, not in agent definitions.
- The homepage has no configuration surface at all.

## Model Resolution (4-level, evaluated at subagent spawn)

```
1. Session override  — custom entry `lazyresearch:agent_model` on the orchestrator's own
                       session line. Value `"provider/id"` → use it; `null` (reset marker)
                       → treated as no override, fall through.
2. Project config    — <cwd>/.lazyresearch/settings.json → lazyresearch.agentModels[agent]
3. Global config     — ~/.lazyresearch/agent/settings.json → lazyresearch.agentModels[agent]
4. Orchestrator      — current orchestrator model (ctx.model at spawn)
```

- Levels 2+3 use `SettingsManager.create(cwd, getAgentDir())` deep-merged settings
  (project wins over global — Pi-native semantics, no custom merge code).
- Level 1 storage: `appendCustomEntry("lazyresearch:agent_model", { agent, model })` on the
  **orchestrator's** session line — NOT the agent's line, because agent lines are
  `(cwd, agent)`-shared across sessions; the orchestrator line is the current session the
  user is viewing. The subagent tool runs in the orchestrator runtime, where
  `ctx.sessionManager` is bound to that session (exposes `getSessionFile`/`getEntries`).
- ADR-008 removal: delete `model` from `AgentConfig` (src/subagent/agents.ts), from
  `buildPiArgs` (src/subagent/tool.ts), from agent templates (src/agents/*.md), and from
  `AgentDto` (src/web/contracts.ts). The `?` help text and docs must not mention it.
- Orchestrator per-session model = the session model itself: RPC `set_model` (native
  `model_change` entry, restored on resume per sdk.md). Reset = `set_model(global default)`,
  where global default = `defaultProvider`/`defaultModel` from merged settings
  (`SettingsManager.create(cwd)`); if unset, the reset action is rejected with a clear error.
- settings.json key (global and project):
  ```json
  { "lazyresearch": { "agentModels": { "search": "openai/gpt-4o" } } }
  ```
  Missing agent key = inherit (level 4).

## Backend API

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/models` | GET | Available models via `ModelRuntime.getAvailable()` → `[{provider, id}]` |
| `/api/sessions/:id/agents/effective-models` | GET | Per roster agent: `{name, model, source}` where source ∈ override/project/global/inherit |
| `/api/sessions/:id/agents/:name/model` | PUT | Body `{model: "provider/id" \| null}`. Stage agent: append custom entry on orchestrator session line. Orchestrator: RPC `set_model`, or `null` → set to global default |
| `/api/config/projects` | GET | `{ home, projects: [{cwd}] }` — all session cwds (deduped) + home |

- `RpcSessionAdapter` gains `setModel(provider, modelId)` passthrough to upstream
  `RpcClient.setModel` (exists in pinned 0.83.0, rpc-client.d.ts:93).
- Custom entry read/write: new module `src/web/agent-models.ts` using
  `SessionManager.open(orchestrator session file)` + `appendCustomEntry("lazyresearch:agent_model", { agent, model })` /
  `getEntries` filtering that custom type (latest wins). Export a pure
  `resolveEffectiveModel(override, projectSettings, globalSettings, orchestratorModel)`
  function for unit testing.
- Config file read/write reuses existing `ConfigFileService` (already supports
  `scope: "project"` + cwd, routes already accept both roots).

## Agents Page (work page)

- Each agent card shows the effective model + a source badge (session/project/global/
  inherits).
- Model dropdown (from `/api/models`), button "Set for this session", button
  "Reset to default" (disabled when no override).
- Orchestrator card: same, but set/reset route through RPC `set_model`.
- Loading/error states per existing patterns (muted rows, no layout shift).

## Homepage Config Page

- Homepage topbar gains a config button → expands config page (modal layer, no new route).
- Level 1: project folder list = all session cwds (deduped), **home always pinned on top,
  labeled `~（全局配置）`**.
- Level 2: clicking a folder opens that root's `settings.json` as an editable JSON file
  (start from `{}` if missing; save creates it atomically via ConfigFileService; other
  fields preserved on write). Home root = `getAgentDir()` (`~/.lazyresearch/agent`); project
  root = `<cwd>/.lazyresearch`.
- A `?` button opens a help overlay describing the `lazyresearch` settings fields with an
  example config (agentModels map).
- ADR-020 change: Web config editing is no longer global-only. `ConfigBrowser` gains a
  scope/root switch (global + project list). Backend already supports project scope.

## Frontend api.ts additions

- `listModels()`, `getEffectiveModels(sessionId)`, `setAgentModel(sessionId, name, model|null)`,
  `listConfigProjects()`.

## Docs

- `.docs/decisions.md`: append ADR — model resolution hierarchy; ADR-008 superseded;
  ADR-020 amended (project-level editing).
- `.docs/agents.md`: rewrite Model Fallback section (4-level chain, no frontmatter).
- `.docs/architecture.md`: document `lazyresearch.agentModels` key.
- `.docs/webui.md`: agents view model UI; homepage config page.
- `.docs/pi-backend-parity.md`: new endpoints; ADR-020 scope change.

## Testing

- Unit: model resolution function (override → project → global → inherit) with fake
  settings; custom-entry read/write round-trip against a temp session file; reset marker.
- Backend integration: new endpoints with fakes (server.test.ts pattern).
- Frontend component: agents card model display + set/reset; homepage config page
  folder list + JSON edit + help overlay (ConfigBrowser test pattern).
- Existing tests updated: remove `model` from AgentConfig/AgentDto fixtures; ADR-020
  global-only assertions relaxed.
