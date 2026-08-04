# LazyResearch

Automated academic paper writing — a CLI tool (package `lazypaper`) built on the Pi agent harness. A "lazy person can still produce a paper": the orchestrator dispatches stage agents, waits in place, and loops until the manuscript is done.

## Status

Early MVP scaffold: CLI (`new`/`run`/`web`), config isolation (`.lazyresearch`), orchestrator + literature agents, subagent tool, Web panel skeleton. See `AGENTS.md` (spec) and `.docs/` (design, gitignored) for the full picture.

## Quick Start

```bash
bun install
bun run src/cli/index.ts new "Fault Diagnosis 2026"   # create a paper project
cd <project> && lazypaper run                          # start orchestrator session
lazypaper web                                          # start Web panel
```

## Commands

- `lazypaper new <topic>` — create a paper project workspace
- `lazypaper run [--model M]` — start the orchestrator session (terminal)
- `lazypaper web [--port N]` — start the Web panel

## Development

```bash
bun run test            # vitest
bun run typecheck       # tsc --noEmit
bun run build:web       # build the Vite frontend into src/webui/dist
```

Config root: `~/.lazyresearch` (override with `LAZYRESEARCH_CONFIG_DIR`). LazyResearch never touches `~/.pi`.
