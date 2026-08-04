# EasyResearch

[![Release](https://github.com/hdu-ailab/EasyResearch/actions/workflows/release.yml/badge.svg)](https://github.com/hdu-ailab/EasyResearch/actions/workflows/release.yml)

Automated academic paper writing: a team of AI experts works the whole paper pipeline for you — from literature research and experiments to a finished manuscript — while you confirm the key checkpoints.

## How it works

EasyResearch is a paper-production pipeline with a clear division of labor among its agent experts:

- **Paper Assistant** — your project manager. It plans the pipeline, dispatches the right expert at the right moment, waits for each result, and decides the next step on its own. You only confirm quality checkpoints along the way.
- **Search agent** — finds candidate papers on OpenReview and arXiv, verifies metadata, downloads the PDFs, converts them into readable text, and packages the literature.
- **Experiment agent** — builds reproducible experiments from the papers: selects datasets, implements baselines, runs controlled trials with multiple seeds, and produces formal evidence.
- **Writing agent** — drafts and revises the authoritative Markdown manuscript, verifies every citation, and exports LaTeX/PDF.
- **Figures agent** — produces editable publication figures grounded in the actual experiment evidence.

The agents cooperate through the complete paper workflow — initial research, paper reading and synthesis, experiment design and execution, formal results, and final manuscript — with the Paper Assistant orchestrating from start to finish. Instead of doing any of the manual work yourself, you inspect what matters and confirm each checkpoint before the pipeline moves on.

## Highly customizable agents

The agent team is fully customizable. Each agent is defined in a plain Markdown
file (role, tools, skills, model) and skills are just `SKILL.md` documents —
you can quickly create your own specialist agents to plug into the pipeline.
No code needed: just ask the Paper Assistant to load the `customize-easyresearch`
skill, and it will create, edit, or mount your custom agents and skills for you.

## Requirements

- [Bun](https://bun.sh) 1.x or newer (development only — the npm binary needs nothing)

## Install

### Install from npm (recommended)

```bash
npm install -g easyresearch
easyresearch
```

Self-contained binary per platform — no Bun/Node needed. The first run
creates the skill Python venv (watch the terminal for progress) and
extracts bundled agents/skills. Requires Python 3 on PATH for PDF
conversion and arXiv features; without it those features degrade.

Set `EASYRESEARCH_SKIP_SETUP=1` to skip first-run setup.

### Install from source (development)

```bash
git clone <this-repo> easyresearch
cd easyresearch
bun install
bun run build:web     # build the Web frontend (served by the background server)
bun link              # exposes the `easyresearch` command on PATH
```

## Start

```bash
easyresearch
# starts a background server on http://127.0.0.1:3000 and opens the browser

easyresearch -p 4000            # custom port
easyresearch --host 0.0.0.0     # listen on all interfaces (server use)
easyresearch --no-open          # do not open the browser
easyresearch exit               # stop the background server
```

Without linking, run it directly: `bun run src/cli/index.ts`.

On the home page, pick a paper project directory and start a session. The
chosen directory is the project boundary: project config lives in
`<cwd>/.easyresearch`, global state in `~/.easyresearch/agent`.

## Configure models

Three layers — pick per scenario:

### 1. Web UI (recommended)

- **Settings page**: set the model per agent. This writes `model: provider/model-id`
  into the agent's Markdown frontmatter (`~/.easyresearch/agent/agents/<name>.md`
  globally, or `<cwd>/.easyresearch/agents/<name>.md` per project).
- **Work page → Agent panel**: per-session model and thinking-strength
  overrides for the current conversation.

### 2. Model catalog and credentials

`~/.easyresearch/agent/models.json` registers providers and their models;
credentials go in `~/.easyresearch/agent/auth.json`, an environment variable,
or the provider's `apiKey` field.

Example `models.json` (OpenAI-compatible providers):

```json
{
  "providers": {
    "my-openai": {
      "baseUrl": "https://api.openai.com/v1",
      "api": "openai-completions",
      "models": [
        { "id": "gpt-4o", "name": "GPT-4o", "reasoning": true }
      ]
    },
    "local-router": {
      "baseUrl": "http://localhost:20128/v1",
      "api": "openai-completions",
      "apiKey": "local",
      "models": [
        { "id": "deepseek-v4-flash-free", "name": "DeepSeek V4 Flash Free (Local)", "reasoning": true }
      ]
    }
  }
}
```

Credentials — use any one of:

```bash
# ~/.easyresearch/agent/auth.json
{ "my-openai": { "type": "api_key", "key": "sk-..." } }

# or an environment variable
export OPENAI_API_KEY=sk-...
```

### 3. Agent Markdown frontmatter

```markdown
---
model: my-openai/gpt-4o
---
```

Set it in `<cwd>/.easyresearch/agents/paper-assistant.md` (project) or
`~/.easyresearch/agent/agents/paper-assistant.md` (global). Stage agents
inherit the Paper Assistant's current model when they have no `model` of
their own.

## Development

```bash
bun run test          # vitest
bun run typecheck     # tsc --noEmit
bun run build:web     # build the Vite frontend into src/webui/dist
bun run lint:web      # biome
```

Global state lives under `~/.easyresearch/agent` (settings, models, auth,
sessions, agents); project overrides live at `<exact-cwd>/.easyresearch`.
