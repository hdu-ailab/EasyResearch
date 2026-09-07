# Model Reference

## Catalog probing

Probe the configured provider's model endpoint first; an OpenAI-compatible
catalog is commonly `<baseUrl>/models` when `baseUrl` already ends in `/v1`.
Use the provider's documented URL rather than blindly appending another `/v1`.
OpenRouter's public catalog is `https://openrouter.ai/api/v1/models` and needs
no authentication. Its metadata shape is provider-specific, not a universal
OpenAI schema.

Use `webfetch` or the native local shell. This Bash example for Linux/macOS
prints capability metadata without printing credentials:

```bash
curl -fsS --max-time 30 https://openrouter.ai/api/v1/models | python3 -c '
import json, sys
for m in json.load(sys.stdin)["data"]:
    tp = m.get("top_provider") or {}
    print(m["id"],
          "| ctx:", m.get("context_length") or tp.get("context_length"),
          "| maxOut:", tp.get("max_completion_tokens"),
          "| input:", (m.get("architecture") or {}).get("input_modalities"),
          "| reasoning:", m.get("reasoning"))
'
```

On Windows use `webfetch` or PowerShell `Invoke-RestMethod`, not Bash syntax.
For an authenticated endpoint, use the provider's configured credential through
its supported auth path; do not print keys, headers, or credential-bearing URLs.
An absent metadata field means unknown: consult provider documentation before
asking the user, and do not infer unsupported reasoning from absence alone.

| Catalog information | Pi model field |
| --- | --- |
| `context_length` or `top_provider.context_length` | `contextWindow` |
| Verified input modalities | `input: ["text"]` or `["text", "image"]` |
| Verified reasoning support | `reasoning` |
| `reasoning.supported_efforts`, if supplied | `thinkingLevelMap` values |
| `reasoning.mandatory: true`, if supplied | `thinkingLevelMap.off: null` |
| `top_provider.max_completion_tokens` | Diagnostic limit only; apply the main Skill's half-window rule |

## Provider entry

Example global `models.json` entry for a model with three reasoning strengths
and no reasoning-off mode. `ACME_API_KEY` is a placeholder environment-variable
name, not a literal key; replace the provider/model identifiers with verified
values and use the user's configured credential source.

```json
{
  "providers": {
    "acme-llm": {
      "baseUrl": "https://llm.acme.example/v1",
      "api": "openai-completions",
      "apiKey": "ACME_API_KEY",
      "models": [
        {
          "id": "acme-reasoner",
          "name": "Acme Reasoner",
          "contextWindow": 131072,
          "maxTokens": 65536,
          "input": ["text"],
          "reasoning": true,
          "thinkingLevelMap": {
            "off": null,
            "minimal": null,
            "low": "low",
            "medium": "medium",
            "high": "high",
            "xhigh": null,
            "max": null
          }
        }
      ]
    }
  }
}
```

For a verified non-reasoning model, omit `reasoning` and `thinkingLevelMap`.
For fixed-strength reasoning, set `reasoning: true` without inventing effort
levels; if reasoning cannot be disabled, add `thinkingLevelMap: { "off": null }`.
If support remains unknown after consulting the user, leave reasoning disabled
and disclose the uncertainty rather than inventing support.

## Thinking and compatibility

A `thinkingLevelMap` string is the provider value; `null` marks a Pi level
unsupported and hides it from the UI. Omitted keys through `high` use the
provider's default mapping, so omission is not a way to disable a level.
`xhigh` and `max` need explicit mappings to appear. When updating a model that
uses old `compat.reasoningEffortMap`, replace it with model-level
`thinkingLevelMap`; this is not migration of legacy config roots or Agent
frontmatter.

For nonstandard OpenAI-compatible servers, set only verified compatibility
options: `compat.thinkingFormat` (such as `deepseek`, `zai`, or `qwen`),
`compat.supportsDeveloperRole: false`, or
`compat.supportsReasoningEffort: false`. Preserve unrelated `samplingParams`,
`cost`, and `compat` settings.

Alternatively, API-key credentials can be stored in global `auth.json` as
`{ "provider-id": { "type": "api_key", "key": "<actual-key>" } }`.
Write the actual key only to its authorized credential store, never into the
proposal or a committed example. Models/auth are global; project Pi defaults
do not create project-specific EasyResearch Agent model overrides.
