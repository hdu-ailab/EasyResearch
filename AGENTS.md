# EasyResearch - Development Guide

EasyResearch is a CLI tool (package name `easyresearch`) for automated academic paper writing, built on the Pi agent harness. This document is the master specification for developing and maintaining this project.

## What EasyResearch Is

- A standalone npm CLI: `easyresearch`, bundling the full pi-coding-agent runtime. Self-contained and distributable.
- Users launch a **paper pipeline** with `easyresearch`: multiple agents cooperate, from topic selection to a finished manuscript.
- Design goal: an automated pipeline where a "lazy person can still produce a paper", with quality checkpoints confirmed by the user.

## Core Design Principles

1. **Paper Assistant autonomous loop**: The `paper-assistant` agent is the default user-facing window. It inspects available evidence, dispatches only the needed stage agents via the `subagent` tool, waits in place for each result, and autonomously decides the next step until the requested paper task is done.
2. **Agent responsibility isolation**: Bundled agents declare non-empty role-specific tool and Skill allowlists. Subagent policies are role-specific allowlists or `subagents: []` for the Search leaf. The assistant does not create specialist artifacts or substitute for stage agents.
3. **Documentation-driven development** (highest priority): This project is pure Vibe Coding. **Before adding features, fixing bugs, or changing design, you MUST read the documents specified in the reading table below, and synchronize the docs per the "Document Update Rules".** Documents are the authoritative source of design; code is the execution of documents.
4. **Artifact conventions live in skills, not code**: Directory structure and artifact formats inside a paper project are defined by the SKILL.md files agents load, not enforced in code.
5. **Pi backend parity and config isolation**: EasyResearch pins unmodified `@earendil-works/pi-coding-agent@0.84.1` (ADR-016) and initializes Pi through a host bootstrap that temporarily supplies EasyResearch's root `piConfig` via `PI_PACKAGE_DIR`. Native identity is `easyresearch`, config directory is `.easyresearch`, global state lives under `~/.easyresearch/agent`, and project settings/resources live only at `<exact-session-cwd>/.easyresearch`. Never statically import Pi before the bootstrap, read `~/.pi`/`.lazypaper`, or search parent directories for project config.
6. **Multi-project parallelism**: One easyresearch instance can run multiple paper projects concurrently, each with its own set of agents and sessions.
7. **Pi first**: Use Pi native capabilities (SessionManager, subagent extension pattern, ModelRuntime, event streams) instead of re-inventing wheels.
8. **Concise Web copy**: Prefer headings, control labels, statuses, and visible structure over explanatory prose that repeats them. Keep supporting copy only for non-obvious defaults, scope, consequences, safety constraints, recovery behavior, errors, or necessary next actions; agent responsibility descriptions are content, not interface explanation.

## System Overview

### Agent Roster (ADR-022/ADR-055 - five agents, all shipped)

| Agent | Responsibility and boundary | Tool scope | Skills to mount | Subagents |
|---|---|---|---|---|
| `paper-assistant` | Clarify, inspect evidence, dispatch, confirm checkpoints, and synthesize; never creates specialist artifacts | Read-only project inspection plus `subagent`; no write/edit or direct Web search | research-project-workflow | every enabled specialist permitted by the effective definition |
| `search` | Retrieve candidates, verify metadata, acquire permitted PDFs, convert readable text, and produce the material package; no literature-review/manuscript prose | File inspection/material-package writing, Bash, web-search | paper-search, arxiv, pdf-to-markdown | none (`subagents: []`) |
| `experiment` | Create reproducible experiments and promote formal evidence; no manuscript drafting or publication figures | Coding, file, command, and `subagent` capabilities | experiment, ssh-experiment (sanitized) | search |
| `writing` | Check readiness, draft and revise authoritative Markdown, verify citations, produce LaTeX and PDF; never invents evidence or runs experiments | File editing, compilation commands, and `subagent` | research-paper-writing, latex-pdf, arxiv | search, figures |
| `figures` | Produce evidence-grounded editable publication figures and exports; never invents claims or values | File inspection/writing, Bash, and `subagent` | drawio, drawio-academic-skills | search |

### Capability Semantics

- Missing, YAML-empty, or `tools: []` loads every controlled Pi built-in and registered tool; a non-empty `tools` list is a strict Pi-native allowlist.
- Missing, YAML-empty, or `skills: []` loads every controlled project/global/optional-home/bundled Skill; a non-empty `skills` list is a strict resolved allowlist.
- Missing explicitly configured Skills are ignored at runtime while valid Skills continue to load. Diagnostics appear only in Web Settings Skills, never chat, stage results, or runtime failures.
- `subagents` remains distinct: omitted means all enabled agents, `subagents: []` means a leaf agent, and a non-empty list is an allowlist.
- Paper Assistant and stage/custom runtimes consume the same effective exact-cwd definition with project-over-global-over-bundled precedence.
- Every bundled Agent prompt states its role boundary, inputs and artifact
  checks, procedure, nested dispatch targets, completion criteria, and final
  `complete | partial | blocked` handoff with artifacts, gaps, and next action.
- The bundled `research-project-workflow` Skill is orchestration-only: it may
  classify evidence, construct dispatches, manage checkpoints, interpret
  handoffs, retry/escalate once, and complete the request. It must not retrieve
  papers, convert PDFs, execute experiments, draft manuscripts, or produce
  figures directly.

### Interaction Forms

- **CLI**: only parameterless `easyresearch` (native Pi TUI in the shell's exact cwd) and `easyresearch web`, which also accepts no additional arguments. No `new`, `run`, config/package-management subcommands, or public print/JSON/RPC flags.
- **TUI**: Pi's native TUI and session lifecycle (`/new`, `/resume`, `/tree`, `/login`, `/model`, `/settings`) with the EasyResearch assistant and subagent extension mounted.
- **Web UI**: Two-level pages - homepage is a unified status panel (brief info for all sessions across all projects); after selecting/creating a session, enter the work page (fixed assistant chat tab + dynamic subagent tabs + status area + file browser + agent details).
- **Session model**: The Paper Assistant tab is fixed and cannot be closed. Untouched temporary subagent tabs collapse when done; selecting a temporary tab or pressing View details retains it and promotes it to a UUID-backed closable child tab showing complete history with a disabled composer (ADR-041). Retained child tabs are read-only; users can abort only the active parent run. Subagent invocations are strictly serial and omitted `session` starts a new child; explicit `session: "inherit"` continues only the current parent's mapped child for that agent.

### Tech Stack

- Bun + TypeScript; runtime is the exact unmodified upstream Pi 0.84.1 package initialized through EasyResearch's identity bootstrap
- Session/workflow state: Pi SessionManager JSONL in the global agent directory, grouped by exact cwd; no separate project `state.json`
- Web backend: Bun HTTP + SSE/EventSource managing one Pi RPC child per active session; frontend: React + Vite + Tailwind CSS v4 with design tokens/class names aligned to opencode's v2 light theme (ADR-019); config editing in the Web covers the global and project roots (ADR-020 amended by ADR-027)
- Single npm package carrying both build artifacts and source code (so users can fork)

### Model Configuration

- Pi-native global `~/.easyresearch/agent/settings.json` plus exact-cwd `.easyresearch/settings.json`; models/auth remain global
- Agent behavior lives in complete Markdown files (ADR-049): project `.easyresearch/agents` -> global `~/.easyresearch/agent/agents` -> bundled `src/agents`. The old `easyresearch.agents` JSON registry and `src/agents/agents.json` are removed without migration or compatibility. `enable`, `model`, `tools`, `skills`, and `subagents` are Markdown frontmatter.
- Four-level agent model resolution (ADR-049): session override (`easyresearch:agent_model` custom entry on the Paper Assistant session line) -> project agent Markdown -> global agent Markdown -> inherit the Paper Assistant's current model.
- Missing `enable` defaults true; disabled non-Paper-Assistant agents remain visible but cannot be selected by the subagent tool.

## Documentation System

```text
.docs/                         # Local working docs (gitignored; not committed with the repo)
|-- README.md                  # Doc index and reading guide
|-- decisions.md               # ADRs; source of all active design decisions
|-- decisions-archive.md       # Archived ADR bodies
|-- architecture.md            # Process model, config root, data flow
|-- pi-backend-parity.md       # Pi fork/config/CLI/resource/session/Web RPC contract
|-- agents.md                  # Agent definitions, roles, tools, Skills, models
|-- workflow.md                # Pipeline flow and artifact conventions
|-- webui.md                   # Web panel design
|-- tui.md                     # TUI enhancement design - post-MVP
|-- skills-templates.md        # Sanitized Skill template contract
|-- superpowers/               # Design specs and plans
`-- pi/                        # Symlinks to pinned Pi docs
```

**`.docs/` is not committed to git. Design documents are first-class citizens in this project.**

**Single authoritative location (worktree rule):** the project-root `.docs/` is the only authoritative copy. Worktree `.docs` entries are symlinks to it, so every doc operation from a worktree lands in the authoritative location. Never copy `.docs/` into a worktree, maintain a worktree-local doc copy, or commit docs.

> **Deviation from the `superpowers` skill conventions**: design specs and plans live under `.docs/superpowers/` and are never committed. When a skill instructs writing under `docs/superpowers/` or committing docs, use `.docs/superpowers/` and skip the doc commit. Commit only code and tests.

## Document Reading Table (feature -> required reading)

Before developing or modifying any feature, check this table and read the documents. **Changes not listed also require reading `architecture.md` and `decisions.md` first.**

| Task | Required reading |
|---|---|
| Add/modify an agent definition or Skill mounting | `.docs/agents.md` |
| Modify Assistant behavior, pipeline flow, stage handoff | `.docs/workflow.md` |
| Modify Web pages (panel/work page/tab model) | `.docs/webui.md` + `.docs/pi-backend-parity.md` |
| Modify TUI (subagent window, hotkeys) | `.docs/tui.md` |
| Modify `.easyresearch`, settings/model config, process model, CLI session lifecycle | `.docs/architecture.md` + `.docs/pi-backend-parity.md` + Pi settings/session docs |
| Add/modify sanitized Skill templates | `.docs/skills-templates.md` |
| Change any design decision | `.docs/decisions.md` (append ADR) + affected docs |
| Call Pi SDK / extensions / SessionManager | `.docs/pi/docs/sdk.md`, `.docs/pi/docs/sessions.md`, `.docs/pi/docs/extensions.md` |
| Understand subagent dispatch patterns | Pi official subagent docs under `.docs/pi/docs/` |

## Document Update Rules

**Documents are the authoritative source of design. In the following situations, update the docs BEFORE writing/changing code:**

1. **New feature**: update the corresponding `.docs/` document first (design -> docs -> code order), then implement.
2. **Design change**: append an ADR to `.docs/decisions.md` (decision, rationale, alternatives), then update affected docs, then change code.
3. **Bug fix**: if the bug stems from a mismatch between design docs and implementation, fix the docs first; if it stems from an implementation error, fix the code and check whether the docs need a new constraint.
4. **Skill/artifact convention change**: change only the SKILL.md or `.docs/skills-templates.md`; never add artifact constraints in code.
5. **AGENTS.md change**: when reading rules/table/dev conventions change, update this file too; AGENTS.md and `.docs/` must never contradict each other.
6. **Before ending every session**: check whether this session's changes require doc synchronization; if so, update docs before wrapping up.

## Development Process (Vibe Coding)

1. Read this file's reading table -> read the corresponding `.docs/` documents -> understand the design.
2. Implement per the docs. Test thoroughly (core logic unit tests + Web backend integration tests + frontend component tests).
3. After implementing, check whether docs need syncing (see Document Update Rules).

### Web Frontend Development Gate

Before creating, modifying, or replacing any Web frontend page/component, the agent MUST:

1. Read `.docs/webui.md`, `.docs/pi-backend-parity.md`, and `.docs/architecture.md`.
2. Invoke the `find-skills` skill to locate an appropriate Web/frontend design skill.
3. Load and follow that skill before writing frontend code.

The current Web UI may be replaced rather than incrementally preserved. Backend contracts in the required docs remain authoritative.

Web copy follows ADR-054 and `.docs/webui.md`: do not add captions that merely repeat a section's contents, announce an evident read-only state, or explain where an item will visibly appear. Preserve copy needed to predict behavior or recover from failure.

## Contribution Intent Layer

### What we want

- **Fix real bugs, well.** Fix the whole bug class (sibling call paths included), not just the reported symptom. Reproduce the symptom, point to the exact line, fix the class.
- **Refactor god-files into clean modules.** Extracting a tangled module into focused, single-purpose units is wanted work.
- **Extend, don't duplicate.** Before adding a module/manager/hook, check whether existing infrastructure covers the case.
- **Behavior contracts over snapshots.** Tests assert how two pieces of data must relate (invariants), not freeze current values.

### What we don't want (rejected even when well-built)

- **Speculative infrastructure.** Hooks, callbacks, or extension points with no concrete consumer.
- **Hardcoded paths and parallel config.** Use pinned Pi's native config/path APIs behind the identity bootstrap. Never read `.lazypaper`, recreate ancestor config-root lookup, statically import Pi before bootstrap, or add a second EasyResearch config file beside Pi `settings.json`.
- **Dead code wired in without E2E validation.** Before wiring an unused module into a live path, validate the real resolution chain end-to-end.
- **Change-detector tests, source-reading tests.** See Testing Rules.
- **"Fixes" that fight the design.** Before fixing something, ask whether the isolation is the design.
- **Never run `git checkout <branch> -- <file>` on files with uncommitted work.** It destroys uncommitted changes. Use the `opencode-recovery` skill for recovery.

### Before you call it a bug - verify the premise

- Is this limitation deliberate? Read `.docs/` and the ADR that introduced it.
- Does the premise hold against how the code actually works? Trace the real code path.
- Is the absence of the missing piece load-bearing isolation?

When in doubt about intent, it is cheaper to ask than to ship a change that fights the design.

### The Capability Ladder

Each rung adds more permanent surface. Choose the highest (least-footprint) rung that solves the problem:

1. **Extend existing code** - variation of existing behavior; zero new surface.
2. **Agent/Skill/doc layer** - default for behavior, workflow, and artifacts.
3. **Custom tool / extension** - structured parameters/returns not expressible as agent config.
4. **Pi native feature** - check `.docs/pi/docs/` first.
5. **Core framework modification** - last resort.

## Change-by-Change Reference (feature -> files touched)

| Change | Files touched |
|---|---|
| Add/modify an agent | `src/agents/<name>.md` complete frontmatter + prompt + read `.docs/agents.md` |
| Add a subagent tool/extension | `src/subagent/` extension + tests; read `.docs/pi/docs/sdk.md`, `.docs/pi/docs/extensions.md` |
| Change the two-entry CLI contract | ADR + `src/cli/` + tests; public surface remains `easyresearch` and `easyresearch web` unless explicitly redesigned |
| Add an EasyResearch config option | extend Pi `settings.json` under `easyresearch` + `.docs/architecture.md`; never create another config file |
| Add a Web API endpoint / SSE event | `src/web/` backend + `src/webui/` frontend consumer + `.docs/webui.md` |
| Add a frontend component/page | `src/webui/` + component test + `.docs/webui.md` if UI model changes |
| Add a session/state transition | session lifecycle code + tests + `.docs/architecture.md` if model changes |
| Change model/fallback behavior | model config code + `.docs/agents.md` |

## Config & Path Rules

- **Use Pi-native `.easyresearch` paths** initialized from EasyResearch root package metadata: global `~/.easyresearch/agent` and exact-cwd project `.easyresearch`. Tests may redirect `EASYRESEARCH_CODING_AGENT_DIR`/HOME; application code must not invent a competing config-root resolver.
- **One settings schema**: all future EasyResearch behavioral settings go in the existing Pi `settings.json` under the top-level `easyresearch` namespace. Do not add `config.json`, feature-specific JSON config files, or environment-variable settings.
- **Secrets only in Pi config/auth stores**: API keys, tokens, and passwords belong in `auth.json`, `models.json` where Pi supports provider keys, or Pi-supported credential stores. The local-only Web config editor may edit them but must not log or echo their contents outside the editor response.
- **Dependency pinning**: direct dependencies pinned to exact versions; keep supply chain auditable. Review new dependencies as reviewed code.
- **Tests must never touch real config**: redirect `EASYRESEARCH_CODING_AGENT_DIR` and/or HOME to a temp directory; never read or write real `~/.easyresearch`, `~/.pi`, or `.lazypaper`.

## Testing Rules

- **Test framework**: Vitest. Core logic unit tests + Web backend integration tests + frontend component tests.
- **Don't write change-detector tests.** Test invariants between values rather than expected-to-change model lists, config literals, or enumeration counts.
- **Never read source code in tests.** Extract logic into a pure/DI-testable function and test its behavior.
- **Test environment isolation**: redirect the EasyResearch agent dir/HOME to a temp directory and use an exact temporary cwd.
- **Behavior contracts over snapshots**: assert relationships, not frozen values.

## Design Decision Index

- Multi-agent foundation built on Pi's official subagent extension pattern.
- ADR-022: five-agent roster, parent-scoped new child sessions, explicit opt-in continuation, subagent allowlists, and strictly serial invocations.
- Experiment execution mode is decided by user config; personal information in Skills is sanitized.
- Paper deliverables: authoritative Markdown manuscript plus LaTeX-exported PDF.
- ADR-016/ADR-036: exact upstream Pi 0.84.1 initialized through the identity bootstrap.
- ADR-024: TUI host primes `lastChangelogVersion` to silence the upstream notice.
- ADR-049: complete Markdown Agent configuration, layered discovery, aliases, and generic resource editing.
- ADR-055: empty/missing tools and Skills load all controlled capabilities; non-empty lists are strict allowlists; Assistant/stage parity; missing-Skill Settings diagnostics; unified artifact roots; unchanged bundled `drawio` base.
- ADR-035: localized fixed roster and simplified Agent model cards.
- ADR-041: UUID-backed retained child tabs and user-facing Home sessions.
- ADR-054: concise, task-oriented Web interface copy.
- ADR-057: the built-in main-agent identity is `paper-assistant` (`paper-assistant.md`, `paper-assistant-extension.ts`, Paper Assistant model DTOs); `role: "assistant"` remains the Pi/LLM message protocol role, and no former-`assistant` compatibility is provided.
