---
name: specialist-handoff
description: Use when a bundled specialist is about to finish a normal run or continuation and must leave a durable, inspectable handoff for its immediate caller.
license: MIT
metadata:
  hermes:
    tags: [research, handoff, artifacts, audit]
    category: research
---

# Specialist Handoff

## Purpose

Before every normal terminal response, write one immutable project-local record
of what this specialist inspected, did, produced, could not resolve, and
recommends next. The chat response wakes the caller; the Markdown file lets the
caller verify the work without reconstructing it from transcript prose.

This is an artifact contract, not runtime state. Pi session JSONL and the hidden
`<agent_status>` plus `<agent_handoff>` notification remain authoritative for
runtime completion, Error, Stop, and continuation.

## When To Apply

Apply this Skill to every normally terminating Search, Experiment, Writing,
Figures, or Review run, including:

- `complete`, `partial`, and `blocked` outcomes;
- a fresh child run;
- every turn that continues a completed agent id.

A hard runtime Error or external interruption may prevent file creation. Never
invent a handoff for work the specialist did not complete or observe.

## Immutable Path

Create:

```text
handoffs/<role>-YYYYMMDD-HHmmss-SSS.md
```

Use UTC and filesystem-safe digits with no colon. The bundled publisher uses
Python's cross-platform UTC clock; do not use GNU-only `date %N`. Examples:

```text
handoffs/search-20260827-153012-123.md
handoffs/experiment-20260827-153015-004.md
handoffs/review-20260827-153101-877.md
```

Write the complete content first to a unique
`handoffs/.draft-<role>-<UUID>.md`, then publish it atomically. Generate the UUID
with Python `uuid.uuid4()` or PowerShell `[guid]::NewGuid()`; the draft is not a
handoff and is removed only after successful publication.

Run the shell with the exact session cwd as its working directory and use the
absolute path of this loaded Skill's publisher. Linux/macOS:

```bash
"$EASYRESEARCH_VENV/bin/python" <specialist-handoff-skill-dir>/scripts/publish_immutable.py \
  --directory handoffs --prefix search \
  --source handoffs/.draft-search-<UUID>.md
```

Windows PowerShell, also from the exact session cwd:

```powershell
$python = Join-Path $env:EASYRESEARCH_VENV 'Scripts\python.exe'
& $python <specialist-handoff-skill-dir>\scripts\publish_immutable.py `
  --directory handoffs --prefix search `
  --source handoffs\.draft-search-<UUID>.md
```

Use the current specialist role as the prefix. The helper atomically hard-links
the already complete draft to a new final name, appends `-01`, `-02`, and so on
on collision, refuses symlinks/path traversal, and never exposes a partial or
overwritten handoff. If draft cleanup fails, it rolls back the final hard link
and returns an error rather than leaving a mutable alias. If no Python 3.11+
interpreter is available, return blocked rather than using a check-then-write
sequence that can race.

## Required Content

Use `references/handoff-template.md`. Every section remains present. Write
`none` where a field has no value instead of deleting the field.

The handoff must include:

- exact assigned task and semantic status;
- prior handoff path for a continuation, or `none`;
- every project file inspected as task evidence;
- a concise account of work and findings;
- every file created or modified, with action and purpose;
- memory used, proposed and independently verified with exact references and
  observed failures, using the contract below;
- unresolved evidence, dependency, permission, safety, or scope gaps;
- one concrete recommended next action, or `none`;
- one caller-resolvable or user-owned input for `blocked`, or `none`.

Do not list transient shell output, caches, package-manager internals, or files
merely discovered but not inspected. Do list source, configuration, result,
report, figure, and manifest files actually used to reach the outcome.

### Research Experience Fields

Apply `research-experience` and keep each field, writing `none` when absent:

- `memory_used`: exact `{scope,id,revision}` active snapshot references, active
  proposal revision when known, applicability and what was actually done with
  them. Mark considered-but-inapplicable guidance explicitly; listing a reference
  alone is not evidence of use.
- `memory_proposed`: successful tool-returned snapshot refs, pending
  `proposalRevision`, evidence paths and pending disposition. Distinguish newly
  proposed from already-pending work. An attempted/failed call is not a stored ref.
- `memory_verified`: returned verification snapshot refs, tested pending proposal
  revisions, `pass | fail | inconclusive`, checks and report paths. Passing
  verification alone is not activation.
- `observed_failures`: actual failed checks, fragile successes, mismatches or
  infrastructure outcomes with evidence and limits; runtime Error is not a
  scientific negative and may have no file.

Propose or verify against already-existing immutable reports or earlier handoffs,
then put returned refs in this new final handoff. Never cite a not-yet-published
handoff or edit hashed source evidence to insert its own memory ref. After
successful publication the helper removes its draft, so the final handoff
normally has one link and is eligible evidence for a later operation. No new
lesson, proposal, verification, or extra work is required merely to fill fields.

## Status Semantics

- `complete`: the delegated outcome and its completion criteria are satisfied.
- `partial`: useful work exists, but requested scope or evidence remains
  incomplete.
- `blocked`: this specialist cannot continue until its caller resolves a
  dependency or decision.

These are semantic task outcomes. Do not write `Error`, `interrupted`, or
`aborted` as a substitute. Runtime Error/Stop belongs to the supervisor. After a
caller resolves a `blocked` dependency, it may continue the same completed agent
id; that continuation writes a new handoff and names this one as previous.

## Final Response

After the file exists, return all of:

```text
status: complete | partial | blocked
handoff: <new handoff path>
inputs_reviewed:
- <every inspected project file>
artifacts:
- <every created or modified work file, including Review report when applicable>
memory_used: <exact active refs, applicability and actual use, or none>
memory_proposed: <returned pending refs/proposal revisions and evidence, or none>
memory_verified: <returned refs, tested proposal revisions, outcomes/evidence, or none>
observed_failures: <evidence-backed failures and limits, or none>
unresolved_gaps:
- <gap or none>
next_action: <one action or none>
required_user_input: <one user-owned dependency or none>
```

The final response and disk handoff must agree. Include the handoff itself in
`artifacts`. Do not claim a path that does not exist.

## Caller Acceptance

The immediate caller reads the handoff and the listed work artifacts before
accepting, continuing, or routing the result. A terminal chat summary alone is
not evidence that the stage criteria passed.
