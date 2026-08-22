# Model Configuration

[简体中文](./model-configuration.zh-CN.md)

EasyResearch keeps providers, credentials, and Agent defaults in the global
EasyResearch configuration root. The recommended path is **Settings** in the
Web UI; use the files below for custom providers, local model servers, or
reproducible manual setup.

## File Locations

| Purpose | Path |
|---|---|
| General settings and Agent defaults | `~/.easyresearch/agent/settings.json` |
| Custom providers and models | `~/.easyresearch/agent/models.json` |
| Stored API keys and OAuth credentials | `~/.easyresearch/agent/auth.json` |

EasyResearch never reads `~/.pi`, `.lazypaper`, or a legacy `config.json`.
Provider credentials and Agent model defaults are global. Project
`.easyresearch/settings.json` files do not override an Agent's model or thinking
strength.

## Recommended Setup

1. Open **Settings** and connect a provider.
2. Choose a model and thinking strength for the Research Assistant.
3. Optionally choose different models for Search, Experiment, Writing, Figures,
   or custom Agents.

Settings and the Agent cards in a work session edit the same global defaults.
There are no per-session model overrides.

## Custom Providers

Create `~/.easyresearch/agent/models.json` to add an OpenAI-compatible endpoint,
local server, proxy, or another supported API:

```json
{
  "providers": {
    "my-openai": {
      "baseUrl": "https://api.example.com/v1",
      "api": "openai-completions",
      "apiKey": "$MY_OPENAI_API_KEY",
      "models": [
        {
          "id": "research-model",
          "name": "Research Model",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 32000
        }
      ]
    }
  }
}
```

Supported API types include:

- `openai-completions`
- `openai-responses`
- `anthropic-messages`
- `google-generative-ai`

For keyless local servers such as Ollama, use a placeholder `apiKey` so the
model is considered available:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [{ "id": "qwen2.5-coder:7b" }]
    }
  }
}
```

`apiKey` and custom header values may be literals, environment references such
as `$MY_API_KEY`, or commands beginning with `!`. Prefer the Web credential flow,
an environment variable, or the auth file over committing a literal secret.

## Credentials

The Web **Providers** section is the safest way to connect supported providers.
For manual API-key setup, use the provider id as the key in
`~/.easyresearch/agent/auth.json`:

```json
{
  "my-openai": {
    "type": "api_key",
    "key": "sk-..."
  }
}
```

Built-in providers also accept their standard environment variables, such as
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, and
`OPENROUTER_API_KEY`. Do not commit `auth.json` or literal secrets.

## Agent Defaults

Agent model and thinking defaults live only under
`easyresearch.agentDefaults` in the global `settings.json`:

```json
{
  "easyresearch": {
    "agentDefaults": {
      "research-assistant": {
        "model": "my-openai/research-model",
        "thinking": "high"
      },
      "experiment": {
        "model": "ollama/qwen2.5-coder:7b",
        "thinking": "medium"
      }
    }
  }
}
```

- An unset Research Assistant model uses the concrete automatic fallback.
- An unset stage or custom Agent model inherits the Research Assistant model.
- An unset Research Assistant thinking strength uses the model's highest
  supported level.
- An unset stage or custom Agent thinking strength inherits the Research
  Assistant's effective level and is constrained to its own model.
- `model` and `thinking` fields in Agent Markdown are ignored.

Use the Web selectors whenever possible because they expose only thinking levels
supported by the selected model.

## Live Updates And Recovery

Valid changes to `models.json` or `easyresearch.agentDefaults` automatically
refresh open Settings and work pages. A running Agent completes its current
model response and tool batch, then applies the new configuration before the
next model request.

If an edit is invalid, EasyResearch keeps the last valid model catalog and shows
a diagnostic in the Web UI. Check JSON syntax, provider `baseUrl`, `api`, model
ids, and credential availability before retrying.
