---
name: specialist-handoff
description: Use before a bundled specialist writes a long report or manuscript, recovers an interrupted write, or reaches an actual task outcome requiring a durable handoff for its immediate caller.
license: MIT
metadata:
  hermes:
    tags: [research, handoff, artifacts, audit]
    category: research
---

# Specialist Handoff

## Purpose

At an actual normal task outcome, write one immutable project-local record
of what this specialist inspected, did, produced, could not resolve, and
recommends next before the terminal response. The Markdown file lets the caller
verify the work without reconstructing it from transcript prose.

This is an artifact contract, not runtime state. Pi session JSONL and durable
`<background-result>` notifications carry runtime outcomes and outstanding work.
These user-role notices are harness input, not human user speech; never fabricate
or reproduce their XML. Reports occur after each busy period, not just at task
completion. An idle specialist with required background work remaining gives a
brief pending-work summary and ends its response for automatic wakeup, without
publishing a final handoff or claiming `complete`. Do not sleep, poll, proactively
check progress, or duplicate pending work.

## When To Apply

The immutable handoff and terminal template apply to actual specialist children,
not the user-facing Research Assistant. In single-Agent mode the Research
Assistant may use the long-document recovery recipe below, but gives a natural
user-facing result without creating a specialist handoff for itself.

Apply this Skill to every actual normal task outcome from Search, Experiment,
Writing, Figures, or Review, including:

- `complete`, `partial`, and `blocked` outcomes;
- the outcome of a fresh child task;
- the outcome of later work continued through that child's native `sessionID`.

Running direct-child follow-ups join the current busy period. They do not require
one handoff per tool call or intermediate idle reply. Publish when the assigned
work actually concludes as complete, partial, or blocked, and reference the
previous published handoff only when one exists.

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
smaller writes cannot fix these. Explicit task-tree cancellation is not permission
to restart that work. Composer Stop interrupts only the current run; it does not
cancel every background child. Terminal Exit cancels all owned work. After a
runtime restart, resume from confirmed artifacts without repeating completed
work. Runtime Error may still prevent a final handoff; never fabricate success.

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

Use `shell` with the exact session cwd as `workdir` and use the
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
- unresolved evidence, dependency, permission, safety, or scope gaps;
- one concrete recommended next action, or `none`;
- one caller-resolvable or user-owned input for `blocked`, or `none`.

Do not list transient shell output, caches, package-manager internals, or files
merely discovered but not inspected. Do list source, configuration, result,
report, figure, and manifest files actually used to reach the outcome.

## Status Semantics

- `complete`: the delegated outcome and its completion criteria are satisfied.
- `partial`: useful work exists, but requested scope or evidence remains
  incomplete.
- `blocked`: this specialist cannot continue until its caller resolves a
  dependency or decision.

These are semantic task outcomes. Do not write `Error`, `interrupted`, or
`aborted` as a substitute. Runtime failure/cancellation belongs to the harness.
After a caller resolves a `blocked` dependency, it may continue its direct child
with the returned `sessionID`; the actual outcome of that continuation writes a
new handoff and names this one as previous.

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
