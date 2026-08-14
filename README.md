# EasyResearch

Automated academic paper writing built on the Pi agent harness. A "lazy person can still produce a paper": the Paper Assistant dispatches stage agents (search, experiment, writing, figures), waits in place, and loops until the manuscript is done.

The **Web panel is the primary interface**.

## Requirements

- [Bun](https://bun.sh) 1.x or newer

## Install

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
EasyResearch never reads `~/.pi` or `.lazypaper`.
