---
name: research-project-workflow
description: |-
  Orchestrate an evidence-driven ML/AI paper project by clarifying the requested outcome, inspecting exact-cwd artifacts, dispatching only the responsible specialists, managing user checkpoints, interpreting structured handoffs, and escalating blocked work. Use proactively for multi-stage paper projects and requests that require deciding which paper specialist should act next.

  Examples:
  - user: "I want to write a paper on fault diagnosis" then clarify the outcome, inspect existing evidence, and dispatch only the missing stage
  - user: "Continue this paper project" then classify exact-cwd artifacts and resume from the first unresolved checkpoint
  - user: "Now write the manuscript" then verify evidence and authorization before dispatching Writing
license: MIT
metadata:
  hermes:
    tags: [research, workflow, papers, experiments, manuscript, orchestration]
    category: research
    related_skills: [paper-search, experiment, research-paper-writing]
---

# Research Project Workflow

## Scope

Use this Skill only to coordinate the paper pipeline. It may clarify goals,
inspect evidence state, construct specialist tasks, manage checkpoints,
interpret handoffs, request one targeted correction, escalate blocks, and
complete the requested outcome.

Do not retrieve papers, download or convert PDFs, design or execute
experiments, draft manuscript prose, compile LaTeX, or produce figures. Those
actions belong to Search, Experiment, Writing, and Figures.

## Clarify The Outcome

Identify the requested deliverable and constraints. Ask one focused question
only when the topic, requested scope, or a required user decision is too vague
to dispatch safely. Do not require venue details unless they immediately affect
the requested work.

Distinguish a full pipeline from literature-only, experiment-only, readiness,
drafting, revision, review, and figure-only requests. Never force every request
through every stage.

## Inspect Evidence State

Treat the exact session cwd as the paper-project root. Inspect only enough of
the following default artifacts to classify readiness:

```text
ref_papers/source.json
ref_papers/pdf/
ref_papers/text/
experiments/experiment-record.md
experiments/outputs/
experiments/results/
manuscript/manuscript.md
manuscript/citation-verification.md
manuscript/latex/
manuscript/manuscript.pdf
figures/
```

An explicitly supplied existing user layout may replace these paths for that
dispatch. Do not invent another default root.

Classify what exists, whether it is usable for the requested outcome, and what
evidence is missing. Artifacts on disk plus specialist handoffs are
authoritative; conversation claims alone do not establish readiness.

## Choose The Responsible Specialist

- Dispatch `search` when the requested outcome lacks a verified, readable
  material package.
- Dispatch `experiment` when the research question needs reproducible formal
  evidence or experimental correction.
- Dispatch `writing` for readiness analysis, explicitly authorized drafting or
  revision, citation verification, LaTeX, and PDF production.
- Dispatch `figures` for evidence-grounded publication figures or figure
  corrections.

For explicit review, critique, validation, risk analysis, or advice, inspect
available evidence and recommend one action: proceed, dispatch the responsible
specialist with a targeted correction, or stop for a user decision. Review is
not permission to perform specialist work.

## Construct The Dispatch

Every specialist task must include:

- requested outcome;
- exact-cwd artifact inputs or the explicitly supplied existing layout;
- relevant evidence and known gaps;
- constraints and user decisions already made;
- expected output paths;
- completion criteria and required `complete | partial | blocked` handoff.

A Writing task must state whether the user explicitly authorized a full draft
or named section. Without authorization, request only readiness or gap analysis.

A `subagent` call returns only the exact acknowledgement
`<agent_id> is working.` after materialization; this is not terminal output. Do
not expect a separate Agent-id line, session path, terminal result, or handoff
in normal successful tool output. Continue useful non-overlapping orchestration
while children run rather than blindly waiting. Fresh children, including
children of the same role, may overlap only when every task has a distinct goal
and output path. Treat the hidden atomic `<agent_status>` plus
`<agent_handoff>` message as the authoritative terminal result.

A bare agent name (for example, `agent: "search"`) always starts a fresh child.
Continue only a completed child by passing its agent id as `agent` (for example,
`agent: "search_0"`); never continue or reuse a running id. There is no
`session` parameter. Child agents always run in the exact project directory;
there is no `cwd` parameter.

## Interpret Handoffs

Require every specialist handoff to report:

- `status: complete | partial | blocked`;
- produced artifact paths;
- unresolved evidence gaps;
- one recommended next action.

Verify that reported artifacts relevant to the next decision exist. Treat
`complete` as eligible for a checkpoint, not automatic permission to cross into
a new major stage. Preserve usable artifacts from `partial` and decide whether
the remaining gap is required for the user's scope. Stop on `blocked` until its
dependency or user decision is supplied.

## Checkpoints And Retry

Before crossing into a new major stage, summarize the evidence and obtain user
confirmation. Do not request a checkpoint for routine corrections within an
already approved stage unless the correction changes scope, cost, or risk.

For one correctable failure class, issue at most one targeted retry that names
the observed failure, required correction, and unchanged completion criteria.
To retry, continue the completed prior child by passing its agent id as `agent`
(e.g. `agent: "search_0"`). If
the same failure repeats or is unrecoverable, return blocked with the reason,
attempted correction, and required user decision. Never retry indefinitely.

## Completion

Stop when the user's requested outcome is supported by inspectable artifacts
and required checkpoints. Report:

- `status: complete | partial | blocked`;
- relevant specialist-produced artifact paths;
- unresolved gaps;
- one next action, or `none` when complete.

Do not create a separate workflow-state file. Keep decisions in the session and
specialist-owned artifacts.
