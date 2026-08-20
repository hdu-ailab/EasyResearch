# EasyResearch

[![Release](https://github.com/hdu-ailab/EasyResearch/actions/workflows/release.yml/badge.svg)](https://github.com/hdu-ailab/EasyResearch/actions/workflows/release.yml)

[简体中文](./README_zh.md) | [License](./LICENSE)

Automated academic paper writing: a team of AI experts works the whole paper pipeline for you — from literature research and experiments to a finished manuscript — while you confirm the key checkpoints.

## How it works

EasyResearch is a paper-production pipeline with a clear division of labor among its agent experts:

- **Paper Assistant** — your project manager. It plans the pipeline, dispatches the right expert at the right moment, keeps orchestrating while background specialists run, and decides the next step on its own. You only confirm quality checkpoints along the way.
- **Search agent** — finds candidate papers on OpenReview and arXiv, verifies metadata, downloads the PDFs, converts them into readable text, and packages the literature.
- **Experiment agent** — builds reproducible experiments from the papers: selects datasets, implements baselines, runs controlled trials with multiple seeds, and produces formal evidence.
- **Writing agent** — drafts and revises the authoritative Markdown manuscript, verifies every citation, and exports LaTeX/PDF.
- **Figures agent** — produces editable publication figures grounded in the actual experiment evidence.

The agents cooperate through the complete paper workflow — initial research, paper reading and synthesis, experiment design and execution, formal results, and final manuscript — with the Paper Assistant orchestrating from start to finish. Instead of doing any of the manual work yourself, you inspect what matters and confirm each checkpoint before the pipeline moves on.

## Highly customizable agents

The agent team is fully customizable. Each agent's role and capabilities are
defined in a plain Markdown file, model/thinking defaults live in global
settings, and skills are just `SKILL.md` documents. You can quickly create your
own specialist agents to plug into the pipeline. No code needed: just ask the
Paper Assistant to load the `customize-easyresearch` skill, and it will create,
edit, or mount your custom agents and skills for you.

## Requirements

- `npm` to install from the registry
- [Bun](https://bun.sh) 1.x or newer only when you want to assemble local npm packages from this repository

## Install

### Install from npm (recommended)

```bash
npm install -g easyresearch
easyresearch
```

Self-contained binary per platform. The npm launcher uses npm's Node runtime,
but the selected platform executable needs neither Node nor Bun. The first run
creates the skill Python venv (watch the terminal for progress) and extracts
bundled agents/skills. Requires Python 3 on PATH for PDF conversion and arXiv
features; without it those features degrade.

Set `EASYRESEARCH_SKIP_SETUP=1` to skip setup only when a complete bundled
installation already exists.

**Supported platforms**: linux-x64, darwin-arm64, windows-x64. On other
platforms, `npm install` fails with a clear message.

### Build and install local npm packages

Use this path when you need to validate the production package locally instead
of installing from the registry.

Choose the target that matches the machine where you will run the installed
command.

#### POSIX shell

```sh
git clone https://github.com/hdu-ailab/EasyResearch.git
cd EasyResearch
bun install --frozen-lockfile

TARGET=linux-x64 # use darwin-arm64 on Apple Silicon
bun scripts/release.ts --dry-run --only "$TARGET"
PLATFORM_TARBALL=$(npm pack "./release/easyresearch-$TARGET" --pack-destination ./release --silent)
META_TARBALL=$(npm pack ./release/easyresearch --pack-destination ./release --silent)
npm install -g "./release/$PLATFORM_TARBALL" "./release/$META_TARBALL"
easyresearch --version
```

#### PowerShell

```powershell
git clone https://github.com/hdu-ailab/EasyResearch.git
cd EasyResearch
bun install --frozen-lockfile

$Target = "windows-x64"
bun scripts/release.ts --dry-run --only $Target
$PlatformTarball = npm pack "./release/easyresearch-$Target" --pack-destination ./release --silent
$MetaTarball = npm pack ./release/easyresearch --pack-destination ./release --silent
npm install -g "./release/$PlatformTarball" "./release/$MetaTarball"
easyresearch --version
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

On the home page, pick a paper project directory and start a session. The
chosen directory is the project boundary: project config lives in
`<cwd>/.easyresearch`, global state in `~/.easyresearch/agent`.

## Configure models

Three layers — pick per scenario:

### 1. Web UI (recommended)

- **Settings page**: set each agent's global `model` and `thinking` in
  `~/.easyresearch/agent/settings.json` under `easyresearch.agentDefaults`.
- **Work page → Agent panel**: edits those same global fields. There are no
  per-session model or thinking overrides.

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

### 3. Global Agent defaults

```json
{
  "easyresearch": {
    "agentDefaults": {
      "paper-assistant": {
        "model": "my-openai/gpt-4o",
        "thinking": "medium"
      }
    }
  }
}
```

Set it only in global `~/.easyresearch/agent/settings.json`. Agent definitions
remain global-over-bundled Markdown resources:
`<cwd>/.easyresearch/agents/` is inert and does not affect runtime discovery,
the Work page, or the Settings page. Residual Markdown `model`/`thinking`
fields are ignored. Stage agents inherit the Paper Assistant's current global
model and thinking when they have no values of their own.

Settings and Work edit these same global settings entries. An empty Paper
Assistant model is shown as **Automatic (Pi default)** and is never replaced by
a guessed provider/model; empty thinking uses the model's highest supported
level. There are no per-session Agent overrides or Follow global mode. Valid
Agent Markdown, Agent-default, and `models.json` changes refresh open
Settings/Work surfaces automatically. A
running Agent completes its current response and tool batch, then applies the
new prompt, tools, Skills, subagent policy, model, and thinking before its next
LLM request.

Global state lives under `~/.easyresearch/agent` (settings, models, auth,
sessions, agents); project overrides live at `<exact-cwd>/.easyresearch`
(settings, skills, prompts, themes, extensions).
