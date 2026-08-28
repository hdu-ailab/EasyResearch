---
name: research-project-workflow
description: |-
  Use when the Research Assistant must classify and orchestrate a multi-stage paper request, continue an existing project from exact-cwd artifacts, choose between survey, empirical, or hybrid routes, acceptance-review specialist handoffs, or decide whether missing authority, access, evidence, cost, or safety requires a user question.
license: MIT
metadata:
  hermes:
    tags: [research, workflow, survey, experiments, manuscript, orchestration]
    category: research
    related_skills: [paper-material-package, survey-paper-writing, experiment, research-paper-writing, remote-experiment-preflight]
---

# Research Project Workflow

## Scope

Use this Skill only to coordinate the paper pipeline. Clarify and classify the
requested outcome, inspect evidence state, construct specialist tasks,
acceptance-review handoffs, continue one correctable child, escalate genuine
blocks, and complete the authorized outcome.

Do not retrieve papers, download or convert PDFs, create paper notes, design or
execute experiments, draft manuscript prose, compile LaTeX, or produce figures.
Those actions belong to Search, Experiment, Writing, and Figures. The only
direct infrastructure exception is a user-selected remote empirical route: use
the separate `remote-experiment-preflight` Skill for SSH/connectivity/compute/
mount checks before dispatching Experiment.
Independent source-based manuscript critique belongs to Review. This Skill may
select and acceptance-route Review but never writes a review report itself.

## Classify The Route

Choose the smallest route that produces the requested outcome:

- **Survey:** survey, review, tutorial, taxonomy, research landscape, or
  literature synthesis. Search -> Writing. Do not require Experiment.
- **Empirical:** new method, model improvement, hypothesis test, benchmark,
  baseline comparison, ablation, or reproducible evaluation. Search ->
  Experiment -> Writing when drafting is authorized.
- **Hybrid:** survey plus an explicitly requested original benchmark or
  evaluation. Search -> Experiment for only that empirical component -> Writing.
- **Narrow task:** literature-only, experiment-only, readiness, revision,
  citation audit, independent review, figure-only, or compilation. Dispatch only
  the owner.

Ask one focused route-deciding question only when the request and existing
artifacts do not distinguish these routes. Do not turn every request into a
questionnaire.

For a survey, derive the expected paper count from the request or existing
decision. Ask for it only when absent. Use that count to bound Search completion
and Writing coverage; do not silently invent a count.

## Capture Existing Authority

Treat the user's initial request as authority for its plainly stated outcome. A
request to complete a paper authorizes downstream full drafting and the default
derived PDF. A request only to search, plan, experiment, review, or assess
readiness does not authorize full manuscript drafting.

Record constraints already supplied: topic/scope, source and date limits,
expected count, local/remote compute, budgets, mutable paths, output format,
venue, and accepted limitations. Do not ask again at each stage.

Ask the user only when progress requires:

- drafting authority not present in the original request;
- user-only access, authentication, permission, or missing source material;
- an unapproved system/mount change, external cost, or remote resource use;
- a consequential scope reduction or evidence-standard compromise; or
- an unrecoverable safety, privacy, leakage, or conflicting-evidence decision.

## Inspect Evidence State

Treat the exact session cwd as the paper-project root. Inspect only enough to
classify readiness:

```text
ref_papers/source.json
ref_papers/pdf/
ref_papers/text/
ref_papers/paper-notes.md
experiments/experiment-record.md
experiments/outputs/
experiments/results/
experiment_ssh/experiment-record.md
experiment_ssh/outputs/
experiment_ssh/results/
manuscript/writing-readiness-report.md
manuscript/survey-plan.md
manuscript/manuscript.md
manuscript/citation-verification.md
manuscript/latex/
manuscript/manuscript.pdf
figures/
```

Inspect `experiments/` only for local execution and `experiment_ssh/` only for a
remote execution mapping accepted by `remote-experiment-preflight`; they are
alternative experiment roots, not duplicate readiness requirements.

Follow an explicitly supplied existing user layout for that dispatch. Artifacts
plus specialist handoffs are authoritative; conversation claims alone do not
establish readiness.

## Choose The Responsible Specialist

- Dispatch `search` when verified readable sources or
  `ref_papers/paper-notes.md` are missing or insufficient.
- Dispatch `experiment` when an empirical/hybrid question lacks reproducible
  formal evidence or needs correction.
- Dispatch `writing` for survey planning/synthesis, empirical or survey
  readiness, authorized drafting/revision, citation verification, and PDF.
- Dispatch `figures` for evidence-grounded publication figures or corrections.
- Dispatch `review` for independent critique of accepted Markdown/TeX sources
  against supplied material and experiment evidence. Never dispatch a PDF-only
  review input.

For remote empirical work, run `remote-experiment-preflight` first. Configure and
test the project's single `easyresearch.ssh` object through `ssh-bash`, let that
Skill create the selected remote project directory, then verify its exact-cwd
`experiment_ssh/` SSHFS mapping. Never dispatch an SSH task with missing
authentication, an unverified mount, or machine placeholders.

## Construct The Dispatch

Every task states:

- requested outcome and route;
- exact-cwd artifact inputs or the explicit existing layout;
- relevant evidence, known gaps, and user decisions already made;
- constraints, authority, and accepted resource/side-effect bounds;
- exact project-relative output paths;
- completion criteria; and
- the required `complete | partial | blocked` handoff.

Every specialist task also requires a fresh immutable
`handoffs/<role>-YYYYMMDD-HHmmss-SSS.md`, all inspected input paths, and every
created or modified work-file path in both that file and final text. A
continuation writes a new handoff and names the previous one. Runtime Error or
Stop may have no file; never ask the runtime or another Agent to fabricate one.

An Experiment task explicitly names `local` or `remote` execution. Local tasks
use `experiments/`; remote tasks use only the accepted `experiment_ssh/` mount
and require exact record/output/result paths under that root.

Search survey tasks require `ref_papers/source.json`, selected PDF/text material,
and `ref_papers/paper-notes.md` at the expected count. Writing survey tasks
require every selected in-scope `note_key` to appear in the
`manuscript/survey-plan.md` coverage matrix; the accepted count is the minimum
coverage target, not permission to omit additional selected papers. They also require
`manuscript/manuscript.md`, citation verification, and complete-paper derived
output unless the user limited scope. Writing tasks carry the exact drafting
authority already supplied.

A Review task carries source/material authority, exact Markdown/TeX source
paths, relevant material/experiment/figure evidence, the preceding specialist
handoff, and timestamped report/handoff completion criteria. After one Review,
read both files and dispatch each finding to its artifact owner. Do not
automatically re-review corrected work without an explicit user request.

A `subagent` call returns only `<agent_id> is working.` after materialization.
This is not terminal output. Continue useful non-overlapping orchestration while
children run. Fresh concurrent children need distinct goals and output paths.

A bare agent name starts a fresh child. Continue only a completed child by
passing its agent id as `agent`; never continue a running id. There is no
`session` or `cwd` parameter.

## Acceptance Review

On the hidden terminal status+handoff:

1. Read the handoff and inspect the exact artifacts required by the dispatch.
   The terminal text must name a timestamped disk handoff; read that file first
   and verify its listed work paths.
2. For `complete`, confirm paths, counts, required sections/fields, evidence
   support, disclosed failures, and next-stage inputs. Advance automatically when
   they satisfy the authorized outcome.
3. For `partial`, preserve usable work. Continue only if the remaining gaps do
   not affect the requested outcome or an accepted limitation already covers
   them; otherwise request one targeted correction.
4. For `blocked`, first derive the missing dependency from existing decisions,
   artifacts, and other handoffs. Ask the user only when one
   `required_user_input` remains genuinely user-owned. A stale SSH connection or
   mount re-enters Research Assistant preflight before Experiment may continue.
5. For one correctable failure class, continue the same completed child once
   with the observed failure and unchanged criteria. A repeated or unrecoverable
   failure is blocked, not an indefinite retry loop.
6. After accepted Writing source artifacts, decide whether one independent
   Review is warranted. Review completion means the critique was produced, not
   that the paper passed. Route findings to Search, Experiment, Writing, or
   Figures and keep final acceptance with the Research Assistant.

This is routine acceptance against dispatch criteria. Independent deeper
critique is delegated to Review when the Research Assistant selects it or the
user explicitly requests it.

## Completion

Stop when the authorized outcome is supported by accepted inspectable artifacts.
Report:

- `status: complete | partial | blocked`;
- relevant specialist-produced artifact paths;
- unresolved gaps;
- one next action, or `none` when complete; and
- for `blocked`, one user-owned `required_user_input` not derivable from current
  evidence, or `none` when no user action can resolve the failure.

Do not create a separate workflow-state or checkpoint file. Keep decisions in
Pi session history and specialist-owned artifacts.
