# Agent And Skill Customization

[简体中文](./agent-customization.zh-CN.md)

The easiest way to customize EasyResearch is to ask the Research Assistant:

```text
/customize-easyresearch Add an Agent that prepares grant-planning checklists from verified program guidance.
```

You can also use **Settings** to inspect and edit Agent Markdown and Skill
instructions directly.

## Resource Locations

| Resource | Global | Project |
|---|---|---|
| Agents | `~/.easyresearch/agent/agents/<name>.md` | Not supported |
| Skills | `~/.easyresearch/agent/skills/<name>/SKILL.md` | `<cwd>/.easyresearch/skills/<name>/SKILL.md` |

Agent definitions resolve from the global directory, then bundled fallbacks.
A same-name global file completely replaces the bundled definition. Project
`.easyresearch/agents/` directories are ignored.

Skills resolve in this order:

1. `<cwd>/.easyresearch/skills/<name>`
2. `~/.easyresearch/agent/skills/<name>`
3. `~/.agents/skills/<name>` when explicitly enabled
4. bundled Skills

Same-name Skills replace lower layers; different names are combined.

## Create An Agent

Create `~/.easyresearch/agent/agents/grant-planner.md`:

```md
---
name: grant-planner
description: Prepares evidence-linked grant-planning checklists from current official program guidance.
enable: true
tools: [read, bash, web-search, webfetch]
skills: [playwright-cli]
subagents: [search]
---

You are a grant-planning specialist.

## Role Boundary

Inspect official program guidance and existing project evidence. Do not invent
eligibility, deadlines, budgets, policies, or prior achievements.

## Procedure

1. Verify the current official call and eligibility rules.
2. Map required sections, evidence, budget inputs, and unresolved decisions.
3. Report every source URL and project file used.

## Completion

Return `complete`, `partial`, or `blocked`, followed by artifacts inspected,
remaining gaps, and one recommended next action.
```

Use lowercase hyphen-separated ids for portable filenames, dispatch, and slash
commands. The Markdown body is the Agent's system prompt.

### Frontmatter Semantics

| Field | Meaning |
|---|---|
| `name` | Agent id; keep it aligned with the filename stem. |
| `description` | Used to decide when this Agent should be selected. |
| `enable` | Defaults to `true`; only `false` disables the Agent. |
| `tools` | Missing, empty, or `[]` means all controlled tools; a non-empty list is a strict allowlist. |
| `skills` | Missing, empty, or `[]` means all controlled Skills; a non-empty list is a strict resolved-name allowlist. |
| `subagents` | Omitted means all enabled targets; `[]` makes the Agent a leaf; a non-empty list is an allowlist. |

Common controlled tool names include `read`, `bash`, `edit`, `write`,
`subagent`, `web-search`, and `webfetch`. Registration and permission are
separate: an allowlist cannot make an unavailable tool exist.

`bash` and `powershell` in Agent frontmatter are portable names for the local
shell capability. EasyResearch exposes the real platform tool to the Agent:
`powershell` on Windows and `bash` on Linux/macOS. Only that effective name
appears in tool metadata and prompts. `ssh-bash` is separate and always means
remote POSIX Bash.

Keep model choice out of Agent Markdown. Configure model and thinking defaults
in global `easyresearch.agentDefaults`; see
[Model Configuration](./model-configuration.md).

## Create A Skill

Create `~/.easyresearch/agent/skills/evidence-audit/SKILL.md` for a global Skill,
or use the project Skill path for one paper project:

```md
---
name: evidence-audit
description: Audit research claims against citations and experiment artifacts when evidence quality must be checked.
---

# Evidence Audit

1. Read the requested claims and their cited artifacts.
2. Separate directly supported facts from interpretations.
3. Report missing evidence with exact paths and identifiers.
```

A Skill may also contain `scripts/`, `references/`, and `assets/`; reference
them with paths relative to the Skill directory. A clear description should say
both what the Skill does and when it should trigger.

Mount a Skill by adding its name to an Agent's `skills` list. Missing configured
Skills are ignored at runtime and reported in **Settings**.

Every Skill loaded by the current Agent is available in the Web composer as
`/<skill-name>`. If its name conflicts with an extension command or Prompt
Template, the composer displays `/skill:<skill-name>` and only that explicit
form invokes the Skill.

## Optional Home Skills

The general `~/.agents/skills` directory is disabled by default so unrelated
tools do not enter EasyResearch. Enable it globally only when wanted:

```json
{
  "easyresearch": {
    "enable_dot_agents_skill": true
  }
}
```

This setting belongs in `~/.easyresearch/agent/settings.json`; project settings
cannot enable the home layer.

## Editing Bundled Resources

When you edit a bundled Agent or Skill in **Settings**, EasyResearch first
copies it to the corresponding global directory. Your copy then overrides the
bundled fallback. Prefer adding a focused custom Agent or Skill over weakening
the responsibility boundaries of the built-in specialist team.

Valid global Agent changes refresh open Web pages automatically. Running Agents
finish the current model response and tool batch, then apply updated prompts,
tools, Skills, and subagent policy before the next model request.
