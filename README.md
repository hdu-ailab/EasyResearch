# LazyResearch

Automated academic paper writing — a CLI tool (package `lazyresearch`) built on the Pi agent harness. A "lazy person can still produce a paper": the orchestrator dispatches stage agents, waits in place, and loops until the manuscript is done.

## Status

Backend parity redesign in progress: native Pi TUI/session semantics under the isolated `.lazyresearch` identity, orchestrator + literature agents, subagent tool, and a local Web panel backed by Pi RPC. See `AGENTS.md` (spec) and `.docs/` (design, gitignored) for the authoritative target.

## Quick Start

```bash
bun install
mkdir -p <paper-project>
cd <paper-project> && lazyresearch   # native Pi TUI with the orchestrator
lazyresearch web                     # local Web panel at 127.0.0.1:3000
```

## Commands

- `lazyresearch` — start the native Pi TUI in the shell's exact cwd
- `lazyresearch web` — start the localhost Web panel

## Development

```bash
bun run test            # vitest
bun run typecheck       # tsc --noEmit
bun run build:web       # build the Vite frontend into src/webui/dist
```

Global Pi-compatible state lives under `~/.lazyresearch/agent`; project overrides live at `<exact-cwd>/.lazyresearch/settings.json`. LazyResearch never reads `~/.pi` or `.lazypaper`.
