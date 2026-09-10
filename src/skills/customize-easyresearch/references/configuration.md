# Configuration Reference

Examples are selective `settings.json` fragments, not replacement files or
automatically installed defaults. Merge only the requested fields into existing
objects; preserve unrelated settings and resource lists. The native settings
below were checked against Pi 0.84.3's settings documentation and SDK/provider
implementation. Recheck matching documentation when the pinned runtime changes.

## API timeouts, retries, and transport

These native Pi fields belong at the **root** of global
`~/.easyresearch/agent/settings.json` or exact-project
`.easyresearch/settings.json`. Project objects deep-merge over global objects.
They do not belong in `models.json`, Agent Markdown, or an `easyresearch.retry`
object, and are not per-Agent defaults.

| Setting | Default | Meaning |
| --- | --- | --- |
| `retry.enabled` | `true` | Automatic Agent-level retry for transient errors |
| `retry.maxRetries` | `3` | Additional Agent attempts after failure; `0` disables this layer's retries |
| `retry.baseDelayMs` | `2000` | Agent exponential backoff base: normally 2s, 4s, 8s |
| `retry.provider.timeoutMs` | Unset | Provider request timeout in milliseconds; ordinary AgentSession requests fall back to `httpIdleTimeoutMs`, normally `300000` |
| `retry.provider.maxRetries` | `0` for supporting Pi adapters | Additional Provider-level attempts; normally leave at zero |
| `retry.provider.maxRetryDelayMs` | `60000` | Reject an excessive server-requested retry delay; `0` removes this wait cap, not the retry count |
| `httpIdleTimeoutMs` | `300000` | Pi HTTP/stream idle setting and SDK request-timeout fallback; `0` disables the configured idle limit, subject to the host/provider caveats below |
| `websocketConnectTimeoutMs` | `15000` for supporting providers | WebSocket open/handshake timeout only; `0` disables that timer |
| `transport` | `"auto"` | Supporting LLM providers: `"auto"`, `"sse"`, `"websocket"`, or `"websocket-cached"` |

Explicit long-request example: one-hour Provider timeout, three additional
Agent retries, and no additional Provider retries. The one-hour value is an
example from Pi's docs, **not** the default or a promise that a complete streamed
response can run for an hour:

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "provider": {
      "timeoutMs": 3600000,
      "maxRetries": 0,
      "maxRetryDelayMs": 60000
    }
  },
  "httpIdleTimeoutMs": 300000,
  "websocketConnectTimeoutMs": 15000,
  "transport": "auto"
}
```

To change only one project's request timeout to ten minutes, merge
`{"retry":{"provider":{"timeoutMs":600000}}}` into its settings. Existing
Agent retry counts, backoff, and Provider retry controls still inherit unless
explicitly overridden. Use positive integer milliseconds for request timeouts
and non-negative integer retry counts; do not apply one field's zero/negative
sentinel to another field.

### Retry and timeout boundaries

- Agent retry counts apply to retryable failures, not a whole paper task or
  subagent campaign. Three additional retries allow an initial attempt plus
  three Agent retries for that failure sequence, not three total attempts.
- Provider retries run inside an Agent attempt. Increasing both layers can
  multiply requests and waiting, including retrying quota errors before the
  Agent sees them. `retry.enabled: false` disables only Agent-level retries;
  use `retry.provider.maxRetries: 0` for supporting Provider retry wrappers.
  Neither setting disables every transport recovery or intermediary retry.
- In ordinary AgentSession requests, an explicit request override wins over
  `retry.provider.timeoutMs`, then Pi falls back to `httpIdleTimeoutMs`. In that
  fallback, `httpIdleTimeoutMs: 0` becomes `2147483647` ms (about 24.9 days), not
  literal infinity. An explicit Provider timeout is not removed by setting the
  HTTP idle field to zero.
- `retry.provider.timeoutMs: 0` is **not** a portable unlimited timeout:
  OpenAI/Anthropic SDKs treat it as an immediate timer; Codex disables its
  explicit timeout timers. Prefer a positive bounded value unless the actual
  provider's zero behavior is verified.
- EasyResearch uses Pi's SDK inside Bun, not Pi's standalone CLI HTTP-dispatcher
  setup. `httpIdleTimeoutMs` does not establish a universal watchdog over all
  HTTP headers and streamed bodies. Request timeout, stream idle, connection
  handshake, server backoff, and total elapsed task time are distinct.

Provider limitations in the verified runtime:

| Provider/API | Boundary |
| --- | --- |
| OpenAI-compatible/Responses/Azure and Anthropic | Request timeout covers the initial fetch until response headers, not the whole streamed body; supporting adapters use Pi's Provider retry wrapper |
| Codex | `timeoutMs` controls SSE header waiting and WebSocket inter-event idle time; WebSocket handshake has its separate setting; transport recovery/fallback is not eliminated by zero retry counts |
| Google/Vertex | Pi's Provider retry wrapper is used, but `timeoutMs` is not wired into Google HTTP client options |
| Bedrock | These Provider timeout/retry fields are not mapped to AWS client configuration; AWS behavior remains |
| Mistral | Timeout uses an abort signal for request/body consumption; these Provider retry controls are not implemented |

If a gateway does not support WebSocket, try `"transport": "sse"` for a provider
that supports transport selection. This changes LLM transport, not the browser's
Web UI EventSource connection or the configured HTTP proxy. A transport choice
is not a guarantee against provider fallback. API retry/timeout controls also
do not configure `web-search`, `webfetch`, shell commands, or Web idle retention.

## Context, thinking budgets, and images

These are also native top-level global/project settings:

| Setting | Default | Meaning |
| --- | --- | --- |
| `compaction.enabled` | `true` | Enable automatic compaction; project `false` can opt out |
| `compaction.keepRecentTokens` | `20000` | Recent-token budget ceiling before EasyResearch's model-aware cap; not a guaranteed exact retained length |
| `thinkingBudgets` | Unset; provider/model-dependent | Optional numeric budget keys: `minimal`, `low`, `medium`, `high`; no separate `xhigh`/`max` keys |
| `images.autoResize` | `true` | Resize supported image attachments/read/tool images to at most 2000x2000 |
| `images.blockImages` | `false` | Prevent image content from reaching the LLM, including user/tool images; not just hiding images in the UI |

This example keeps the documented compaction/image defaults and demonstrates
**custom**, optional thinking budgets. Copy only the requested entries:

```json
{
  "compaction": {
    "enabled": true,
    "keepRecentTokens": 20000
  },
  "thinkingBudgets": {
    "minimal": 1024,
    "low": 4096,
    "medium": 10240,
    "high": 32768
  },
  "images": {
    "autoResize": true,
    "blockImages": false
  }
}
```

EasyResearch's threshold is the **global-only**
`easyresearch.compaction.triggerPercent` (default 70), not native
`compaction.reserveTokens`. For model window `W` and percentage `P`, the retained
budget is at most `floor(floor(W * P / 100) / 2)`, capped by the valid configured
`keepRecentTokens`, with a minimum of one token. Zero/invalid keep-recent values
fall back to 20000, not disabled retention. Raising the configured ceiling cannot
force a small-window model to retain that many tokens.

Numeric thinking budgets are not a universal reasoning cap or the selected
thinking level. Pi's token-budget path normalizes extended levels to `high`, so
that budget may still apply; do not invent separate extended-level keys.
Adaptive Claude and Gemini 3 use effort/levels instead; other Google models can
have model-specific budgets. OpenAI-compatible models need a verified
budget-carrying request format: for example, `compat.thinkingTokenBudgetField`
(or `supportsThinkingTokenBudget`), or `{"$var":"thinking.budget"}` inside
`chatTemplateKwargs`/`chatTemplateArgs` for the corresponding
`chat-template`/`baseten` format. A `high` level alone does not establish
numeric-budget support; do not add unnecessary fields.
Keep Agent level selection in global `easyresearch.agentDefaults`; see the
[Model reference](models.md) for model-specific capability configuration.
Blocking images removes visual evidence, so explain that consequence before
enabling it for a research/figure workflow.

### Applying native settings

General native settings above require a new/recreated Agent runtime for reliable
application: finish or explicitly stop active work, disconnect/reopen the
session, or use the owner's normal daemon restart. `transport` and
`thinkingBudgets` are captured at construction; a browser refresh, Settings
Refresh, or ordinary resource reload is not a substitute. Do not restart or
interrupt active work without the user's authority.

The live exceptions are global `compaction.enabled`/`keepRecentTokens` and
`easyresearch.compaction.triggerPercent`: accepted changes apply at the next
safe LLM/compaction boundary, not by modifying an in-flight request or forcing
immediate compaction. Project values retain the documented new-runtime guidance.
Test the actual selected Provider after applying settings before claiming its
timeouts/retries are verified; use a small authorized request and avoid exposing
credentials or creating a costly deliberate retry loop.

## EasyResearch policies and state

Preserve Pi's settings shape and unknown fields. EasyResearch policies use
`settings.json` under `easyresearch`, except Pi's existing top-level `httpProxy`.
The entries below are global-only unless a project scope is explicitly stated.

| Setting | Meaning |
| --- | --- |
| `easyresearch.web.sessionIdleTimeoutMs` | Connected idle retention in milliseconds; default `3600000`, `0` immediate, `-1` never; read at server startup |
| `easyresearch.enable_dot_agents_skill` | Enable the optional home Skill layer; boolean, default false |
| `easyresearch.logging` | `level`: debug/info/warn/error (default info); `keepDays`: default 7; optional `logDir` |
| `easyresearch.compaction.triggerPercent` | Integer 10-90, default 70; live model-aware compaction threshold |
| `easyresearch.web.showApiUsageDetails` | Boolean, default true; live display policy, explicit false preserved |
| `httpProxy` | All-traffic HTTP/HTTPS proxy origin; restart required |
| `easyresearch.network.llmProxy`, `searchProxy` | Category proxy origins overriding All traffic; restart required |
| `easyresearch.ssh` | Project-only server metadata and credential-file paths; use `remote-experiment-preflight` for setup |

Proxy origins must be unauthenticated. Explicit settings override inherited
proxy variables; mandatory loopback bypass remains direct. Use Network Settings
to test candidates and request an owner-aware restart; active work requires the
busy confirmation. Do not bypass Desktop ownership with CLI process commands.

Other Pi settings and resource lists retain their native semantics and documented
application timing. Terminal-only settings such as `theme` do not configure the
Web UI; `steeringMode` does not override EasyResearch's runtime-local `all` policy.
For Pi `settings.json` only, one leading decoded UTF-8 BOM is accepted; other
JSON files remain strict.

Web font sizes and language live in browser localStorage under
`easyresearch.webui.preferences`, not settings. Global state also includes
`models-store.json` (catalog cache), `sessions/` (JSONL grouped by exact cwd),
and `logs/easyresearch-YYYY-MM-DD.log`; these are not alternate config files.

## Extensions and other resources

User extensions are TypeScript files at `extensions/*.ts` or
`extensions/<name>/index.ts` under the global/project config root, or explicit
entries in the settings `extensions` array. The entry default-exports a function
receiving Pi's `ExtensionAPI`. Extensions run with full system permissions;
review their behavior before enabling them.

Startup refuses a non-empty `packages` array and extension entries resolving
inside foreign `~/.pi`. Do not enable a package or foreign config path as a
shortcut. Adding an Agent tool allowlist entry does not register a missing tool.
Bundled extensions use post-bootstrap in-process factories, not materialized
TypeScript sources or spawned Pi processes.

Prompt templates and themes belong in their corresponding global/project
resource directories. For full schemas or extension APIs, consult the Pi docs
matching EasyResearch's installed runtime version. In a source checkout these
are `.docs/pi/docs/settings.md`, `models.md`, `skills.md`, `extensions.md`,
`prompt-templates.md`, and `themes.md`; EasyResearch overrides are documented in
`.docs/architecture.md`, `.docs/agents.md`, and `.docs/pi-backend-parity.md`.
These `.docs/` paths are developer-only, not paths to assume exist in a paper
project or npm installation. Outside a checkout, use the available matching
Pi documentation; if it is unavailable, obtain it before inventing an API.
Upstream `.pi` examples must use EasyResearch's roots, not the upstream roots.

## Web editor integration

Settings edits global Agent defaults and Agent/Skill resources. Config exposes
the chosen global or exact-project root. JSON is validated before atomic writes;
other text is saved verbatim. Canonicalize paths and reject traversal outside
the chosen root.

For Web integrations, `PATCH /api/agents/:name` accepts
`{ model?: string | null, thinking?: string | null }`. A `null` removes that
property and restores fallback; the endpoint preserves unrelated Pi settings.
Direct file edits remove the property instead of writing a sentinel value.
`GET /api/agents` exposes effective/configured tools, Skills, model, and thinking
without the system prompt; exact cwd changes Skill resolution, not Agent scope.
Settings Refresh synchronizes resources before refetching, so use it for stale
views rather than assuming a browser reload applied the configuration.

## Diagnostics

Use only the relevant diagnostic switch, and do not introduce environment
variables as a second product settings system:

- `EASYRESEARCH_LOG_LEVEL=debug|info|warn|error`: override logging verbosity.
- `DEBUG_AGENT_DISCOVERY=1`: Agent parse/discovery diagnostics on stdout.
- `PI_SKIP_VERSION_CHECK=1`: suppress Pi's version check; EasyResearch sets it.
- `PI_OFFLINE=1`: Pi offline/startup-network control, not an egress sandbox.
- `EASYRESEARCH_CODING_AGENT_DIR`: internal identity override for isolated
  development/tests; do not set it during ordinary user configuration.

Redact credentials before sharing logs. Saved provider definitions and usable
credentials are separate: a visible model does not prove authentication or a
successful provider request.
