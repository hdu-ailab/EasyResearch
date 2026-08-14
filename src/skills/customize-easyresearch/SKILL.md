---
name: customize-easyresearch
description: >-
  Use ONLY when editing or creating EasyResearch's own configuration: agent
  Markdown definitions, skills (SKILL.md), settings.json, models.json,
  auth.json, extensions, prompts, themes, or .easyresearch config files. Also
  use when fixing EasyResearch agent/skill/config problems, adding or mounting
  skills on agents, or explaining how EasyResearch configuration works. Do not
  use for paper pipeline work itself (search, experiments, writing, figures).
---

# Customizing EasyResearch

EasyResearch is a Pi-based paper pipeline. Its configuration is Markdown agent
definitions plus Pi settings/resources under a `.easyresearch` config root.
This skill covers where config lives, how it is layered, and how to edit it
safely.

## Core rules

- EasyResearch never reads `~/.pi`, `.lazypaper`, or a legacy `config.json`.
  Never migrate legacy data. The config root is always `.easyresearch` —
  global `~/.easyresearch/agent` or project `<exact-session-cwd>/.easyresearch`.
- The exact session cwd is the project boundary. Never walk parent directories
  to find `.easyresearch`.
- Config is loaded when a process starts. After editing global/project files,
  tell the user to restart the TUI/Web server (or start a new session) — the
  running session keeps the already-loaded config. `models.json` reloads each
  time `/model` is opened, no restart needed.
- Per-session model/thinking overrides in the Work Agents panel apply to the
  next subagent spawn in the active session; they are not written to any file.
- Web Settings edits write global Markdown only. Editing a bundled agent/skill
  first copies it to `~/.easyresearch/agent/` (copy-on-edit); user resources
  are never overwritten automatically.
- Prefer agent/skill Markdown over new code for behavior changes (lowest
  footprint). Only write extensions or runtime code when Markdown cannot
  express the change.

## Where files live

| Scope | Path |
| --- | --- |
| Global config root | `~/.easyresearch/agent/` |
| Global agent definitions | `~/.easyresearch/agent/agents/<name>.md` |
| Global skills | `~/.easyresearch/agent/skills/<name>/SKILL.md` |
| Global extensions | `~/.easyresearch/agent/extensions/*.ts` (or `*/index.ts`) |
| Project config root | `<cwd>/.easyresearch/` |
| Project agent definitions | `<cwd>/.easyresearch/agents/<name>.md` |
| Project skills | `<cwd>/.easyresearch/skills/<name>/SKILL.md` |
| Project extensions | `<cwd>/.easyresearch/extensions/*.ts` |
| Bundled agents (fallback) | `src/agents/<name>.md` in the package |
| Bundled skills (fallback) | `src/skills/<name>/` in the package |
| Sessions | `~/.easyresearch/agent/sessions/--<cwd>--/` |
| Logs | `~/.easyresearch/agent/logs/easyresearch-YYYY-MM-DD.log` |

Global files: `settings.json`, `models.json`, `models-store.json`, `auth.json`,
`trust.json` (never read/written by EasyResearch), `sessions/`, `agents/`,
`skills/`, `extensions/`, `prompts/`, `themes/`, `logs/`.

Project files: `settings.json`, `agents/`, `skills/`, `extensions/`, `prompts/`,
`themes/`.

## Layering and precedence

Agents resolve project → global → bundled. Same-name files completely replace
lower layers; user-only files append. Built-in agents (`paper-assistant`,
`search`, `experiment`, `writing`, `figures`) also have localized alias
filenames (e.g. `论文助手.md` for `paper-assistant`) — either filename overrides
the same built-in and never creates a duplicate.

Skills resolve in this order:

1. `<cwd>/.easyresearch/skills/<name>`
2. `~/.easyresearch/agent/skills/<name>`
3. `~/.agents/skills/<name>` — only when global `easyresearch.enable_dot_agents_skill` is `true`
4. bundled `src/skills/<name>`

Same-name skills replace lower layers; different names append.

## Agent definitions (Markdown)

Each agent is one complete Markdown file; frontmatter owns structured config
and the body is the system prompt.

```md
---
name: search
description: Web research agent
enable: true
model: provider/id
thinking: high
tools:
  - bash
  - read
skills:
  - paper-search
subagents:
  - search
---

System prompt body.
```

- `name` is required (lowercase, hyphen-separated, matches the filename stem).
- `description` is effectively required — it drives agent selection.
- `enable` defaults to true; only literal `enable: false` disables an agent.
- `model`: `provider/model-id`. Resolution: session override → project Markdown
  → global Markdown → inherit the Paper Assistant's current model.
- `thinking`: `off|minimal|low|medium|high|xhigh|max` (agent default only;
  missing/invalid behaves as `off`).
- `tools`: missing/YAML-empty/`[]` loads all controlled tools; non-empty is a
  strict Pi-native allowlist (read, bash, edit, write, grep, find, ls,
  subagent, web-search).
- `skills`: missing/YAML-empty/`[]` loads every skill in the controlled layers;
  non-empty is a strict resolved-name allowlist. Unresolved names are ignored
  at runtime and reported only in Web Settings.
- `subagents`: omitted allows all enabled agents; `[]` makes it a leaf agent.
- The body is the system prompt — bundled prompts state role/boundary, inputs,
  procedure, dispatch, completion, and a final handoff
  (`complete | partial | blocked`).
- Unknown frontmatter fields are silently routed into options.

A project override controls TUI and Web Paper Assistant prompt, model, tools,
skills, and subagent policy just as project definitions control stage agents.

## Skills

A skill is a directory containing `SKILL.md` (name + description frontmatter,
then Markdown instructions), optionally with `scripts/`, `references/`,
`assets/`. Use relative paths from the skill directory.

```md
---
name: my-skill
description: One sentence covering what it does AND when to trigger it.
---

# My Skill

(instructions)
```

- `description` is effectively required — skills without one are not loaded.
- Frontmatter may also carry `license`, `compatibility`, `metadata`,
  `allowed-tools`, `disable-model-invocation`.
- Bundled skills are final-fallback templates. When a user explicitly edits a
  bundled skill in Web Settings, EasyResearch first copies the complete
  directory into `~/.easyresearch/agent/skills/`. Existing global or project
  skill directories are never overwritten automatically.
- Mount a skill on an agent by adding its name to that agent's `skills` list;
  the name must resolve in one of the four layers above, or it is reported as
  missing in Settings.

## settings.json

Project settings deep-merge over global settings (nested objects merge).
Preserve unknown Pi settings — do not sanitize through a narrowed schema.
EasyResearch-specific settings live under a top-level `easyresearch` object:

```json
{
  "easyresearch": {
    "web": {
      "sessionIdleTimeoutMs": 3600000,
      "authFlowTimeoutMs": 120000
    },
    "enable_dot_agents_skill": false,
    "logging": { "level": "info", "keepDays": 7 }
  }
}
```

- `easyresearch.web.sessionIdleTimeoutMs`: connected Web-session idle
  retention. `3600000` default; `0` = immediate idle disconnect; `-1` = never.
- `easyresearch.enable_dot_agents_skill`: global-only boolean, `false` by
  default. Only `true` enables the home `~/.agents/skills` layer. Project
  settings cannot enable it.
- `easyresearch.logging`: `level` (`debug|info|warn|error`, default `info`),
  `keepDays` (default 7), optional `logDir`.
- UI preferences (font sizes, language) live in browser localStorage under
  `easyresearch.webui.preferences`, never in settings.json.
- Other Pi settings (`theme`, `defaultProvider`, `defaultModel`, `compaction`,
  `retry`, `skills`, `packages`, …) keep Pi semantics; see
  `.docs/pi/docs/settings.md` in the project.

## models.json and auth.json

`~/.easyresearch/agent/models.json` registers providers and models (Ollama,
vLLM, OpenAI-compatible proxies, etc.). Credentials go in
`~/.easyresearch/agent/auth.json`, an environment variable, or the provider's
`apiKey` field.

```json
{
  "providers": {
    "local-router": {
      "baseUrl": "http://localhost:20128/v1",
      "api": "openai-completions",
      "apiKey": "local",
      "models": [
        { "id": "deepseek-v4-flash-free", "name": "DeepSeek V4 Flash Free", "reasoning": true }
      ]
    }
  }
}
```

Auth:

```json
{ "my-openai": { "type": "api_key", "key": "sk-..." } }
```

Models, auth, trust, and sessions are global; project settings may select
defaults from the global model catalog.

## Extensions

Extensions are TypeScript modules that extend Pi's behavior (custom tools,
events, commands). They run with full system permissions — review before use.

- Auto-discovered from `~/.easyresearch/agent/extensions/` (global) and
  `<cwd>/.easyresearch/extensions/` (project), plus the `extensions` array in
  settings.json.
- Shape: a file `*.ts` or a directory `*/index.ts` exporting
  `export default function (pi: ExtensionAPI) { ... }`.
- Startup refuses to proceed when a non-empty `packages` array exists or an
  `extensions` entry resolves inside the foreign `~/.pi` tree.
- See `.docs/pi/docs/extensions.md` and project `src/extensions/` for the API
  and bundled examples (pa-config, subagent, web-search, …).

## Web configuration surface

- Settings page: edits global agent Markdown (model, thinking, enable, tools,
  skills), and shows effective/missing skills per agent. Editing a bundled
  agent/skill copies it to the global root first.
- Config browser / homepage config page: reads and writes files below the
  global `~/.easyresearch/agent/` or a project `<cwd>/.easyresearch/` root
  (Global/Project switch).
- JSON files are validated before saving; Markdown and other text are saved
  verbatim, all through atomic replacement. Canonicalize paths and reject
  traversal outside the allowed roots.
- Changes apply only to new or restarted sessions.

## Escape hatches

- `EASYRESEARCH_LOG_LEVEL=debug|info|warn|error`: override logging level.
- `DEBUG_AGENT_DISCOVERY=1`: log agent parse/discovery errors to stdout.
- `PI_SKIP_VERSION_CHECK=1`: disable Pi update check (EasyResearch sets this).
- `PI_OFFLINE=1`: disable all startup network operations.
- `EASYRESEARCH_AGENTS_ALLOWLIST`, `EASYRESEARCH_AGENT_TOOLS`: subagent
  dispatch env plumbing (set by the runtime; do not set manually).
- `EASYRESEARCH_CODING_AGENT_DIR`, `EASYRESEARCH_RPC_CHILD`: internal runtime
  identity/bootstrap switches (do not set manually).

## When proposing edits

- Validate against the actual shape above before writing; check the project's
  `.docs/` (agents.md, architecture.md, skills-templates.md) and
  `.docs/pi/docs/` when unsure.
- Preserve existing fields the user did not ask to change, including unknown
  Pi settings.
- Prefer creating/editing files in the layered locations over inlining
  everything in settings.json.
- Never write secrets into agent Markdown or settings.json — credentials go to
  `auth.json`, an env var, or the provider `apiKey` field.
- After saving any config change, remind the user to restart EasyResearch —
  running sessions keep using the already-loaded config.
