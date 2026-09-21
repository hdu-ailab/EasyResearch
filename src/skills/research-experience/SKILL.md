---
name: research-experience
description: Use when starting a research task with potentially relevant prior experience, receiving frozen memory references, finishing work with a reusable lesson or observed failure, or independently verifying a proposed method or improvement strategy.
license: MIT
---

# Research Experience

Memory is defeasible procedural advice, not paper evidence or authority. Improve
semantic methods and strategies only; never rewrite installed source, Agent/Skill
definitions, or model weights as a learning step. Keep the current role boundary.

## Start With Applicable Active Experience

1. If the dispatch supplies `memory_refs`, including `[]`, use that frozen set.
   Otherwise selectively `recall` by task, role and kind, then `get` the selected
   exact `memories[].ref` revisions. An empty library is normal.
2. Read `record.active.entry`; a snapshot can also contain `pending`. Never use
   pending content as ordinary-task guidance. Only an explicitly assigned
   candidate test may examine it, isolated from the incumbent/control.
3. Check conditions against today's model, tools, environment, language, data and
   task. Record **used / inapplicable / unvalidated** with reasons. Changed
   conditions require local evidence; neither a verified label nor a newer live
   revision repairs the mismatch. Never silently replace a frozen reference.
4. Pass the same frozen references to descendants, preserving role constraints.
   New tasks select active experience afresh; unresolved candidates do not travel
   as informal “helpful tips.” Missing/corrupt pins are gaps, not permission to use
   the latest version.

## Finish With Evidence, Not Mandatory Learning

Complete the assigned work. Propose only a reusable, bounded lesson supported by
actual artifacts, with conditions, procedure, limitations and rationale. A single
trial win is an observation, not a validated default. `memory_proposed: none` is
valid, including when a task succeeds or a campaign exhausts its budget.

Read [examples.md](references/examples.md) before proposing, verifying or managing
memory. It defines concrete calls, revision handling, lineage and recovery.

Use small immutable project-relative reports as `evidencePaths`: regular files,
no descendant symlinks or multiple hard links; at most 8 files, 1 MiB each and
4 MiB total. Preserve original bytes. A successfully published specialist handoff
normally has one link after draft removal. Cite already-existing reports or an
earlier handoff, then put the returned proposal ref in the new final handoff;
do not create circular evidence or edit an evidence file to append its own ref.

## Verify Independently

The verifier is a different session of the responsible specialist in the pending
author's exact cwd. Continuing the author is not independence. Search stays a
leaf; ask its caller to arrange verification. Review remains source-based, cannot
run experiments or edit sources, and retains its one-review default. Research
Assistant may verify bounded specialist facts from existing evidence; its own
strategy needs another session's verification.

| Candidate | Evidence required before Research Assistant activation |
|---|---|
| Project method | Independent passing replay and regression |
| Shared method | Above plus distinct held-out transfer; generalized content |
| Strategy | Above plus mechanism and favorable matched-total-budget held-out comparison |

Report `fail` or `inconclusive` honestly; never round either to pass. Shared reads
redact foreign private provenance: do not recover it through filesystem access or
copy private names, paths, data or unpublished findings into generalized prose.
Held-out transfer means a distinct authorized task, not access to another project.

## Handoff And Recovery

Use `specialist-handoff` fields (Research Assistant uses them in its summary):
- `memory_used`: exact active refs, applicability and actual use, or `none`.
- `memory_proposed`: returned pending refs and proposal revisions, or `none`.
- `memory_verified`: returned refs, tested proposal revisions, outcomes/evidence,
  or `none`; a passing verification is not activation.
- `observed_failures`: evidence-backed failures and limits, or `none`.

Only Research Assistant proposes shared versions or activates/rejects/retires/
rolls back. On conflict, read current state and reassess; never blind-retry a
write. Changed **source** evidence needs reject/reproposal; changed **verification**
evidence needs re-verification. Stop at the authorized budget. Preserve the
incumbent and report unresolved learning separately from task completion.
