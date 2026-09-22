---
name: specialist-handoff
description: Use before a bundled specialist writes a long report or manuscript, recovers an interrupted write, or finishes a normal run or continuation with a durable handoff for its immediate caller.
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

## Long Documents And Interrupted Writes

Apply this recipe **before** generating a long report, manuscript, or handoff.
A complete draft is required before publication; it need not be generated in one
tool call. Context-window capacity is not an output-token or time budget.

1. Establish the section order. Create a unique hidden `.parts-<role>-<UUID>/`
   directory beside the intended draft, within the role's authorized artifact
   root. Review's report pieces belong under `reviews/`; manuscript pieces under
   `manuscript/`. Record the directory and ordered filenames in working notes.
2. Use one `write` call per small section, for example `01-scope.md`, then
   `02-findings.md`. Split a long section further. Wait for each successful result
   and inspect the saved section before moving on; keep calls comfortably below
   the model's output limit. Do not put all sections into one tool batch or one
   giant shell command. `write` **replaces** a file, never appends.
3. After interruption, inspect the exact attempted file and confirmed pieces.
   A streamed path or prose announcement is not execution evidence. Preserve
   completed pieces; regenerate only missing or incomplete pieces. A read error
   other than confirmed absence is a blocker to resolve, not permission to
   overwrite. Never blindly append a retry or retransmit the whole document.
4. Read the pieces and check required sections, findings, evidence locators and
   ordering. Assemble an **explicit ordered list**, not a wildcard, locally into
   a fresh unique draft. This short Python recipe reads every piece before opening
   the destination, retains pieces on failure, and refuses to overwrite a draft:

   ```python
   # Save as a small assembly script in the task's own temporary directory.
   import sys
   from pathlib import Path
   destination = Path(sys.argv[1])
   parts = [Path(name) for name in sys.argv[2:]]
   if not parts or len({p.resolve() for p in parts}) != len(parts):
       raise ValueError("Provide a non-empty, duplicate-free ordered section list")
   sections = [p.read_text(encoding="utf-8") for p in parts]
   if any(not section.strip() for section in sections):
       raise ValueError("An empty section is not a complete draft")
   payload = ("\n\n".join(s.rstrip() for s in sections) + "\n").encode("utf-8")
   with destination.open("xb") as output:
       output.write(payload)
   ```

   Invoke with the existing Python interpreter, followed by script path, draft
   path, and each section path in order. Use the native shell and quote paths.
   For reports/handoffs, the assembled draft must follow the naming rules below.
5. Inspect the assembled draft for completeness and continuity before using the
   existing publisher. If assembly fails, keep pieces, inspect any partial draft,
   and assemble into a fresh draft after correcting the cause. Preserve an existing
   authoritative manuscript until its validated replacement is ready.
6. If publication returned no confirmed result, inspect the draft and newly
   published candidates and compare content before retrying: a missing draft may
   mean publication succeeded. Do not create duplicate logical reports blindly.
   Confirm the final path, then remove only task-owned temporary pieces/scripts
   when cleanup is permitted. Review retains its temporary workspace because its
   role does not authorize arbitrary deletion; the publisher owns draft cleanup.

For permission, disk-space/quota, or path errors, correct the specific blocker;
smaller writes cannot fix these. A user Stop is not permission to restart work.
Runtime Error may still prevent a final handoff; never fabricate success.

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
- <completed deliverables, including Review report when applicable>
work_files:
- <every other inspected/created/modified path, including temporary fragments,
   assembly scripts and drafts; label retained, removed, incomplete, or published>
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
`artifacts`. List temporary paths under `work_files`, not as completed
deliverables; distinguish removed drafts from existing files. Do not claim a
missing file exists or is a completed artifact.

## Caller Acceptance

The immediate caller reads the handoff and the listed work artifacts before
accepting, continuing, or routing the result. A terminal chat summary alone is
not evidence that the stage criteria passed.
