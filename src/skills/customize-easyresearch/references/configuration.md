# Configuration Reference

## Settings and state

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

Other Pi settings, including `theme`, `retry`, and resource lists, retain their
native semantics and documented application timing. `compaction.enabled` is a
native opt-out; EasyResearch derives reserve/keep budgets from its percentage,
so changing Pi `reserveTokens` is not a replacement for the product threshold.
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
