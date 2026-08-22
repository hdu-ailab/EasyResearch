---
name: autoresearch
description: |-
  Use proactively when the user asks for autoresearch, auto research, autonomous experiments, overnight optimization, unattended model search, repeated metric improvement, or to keep trying until stopped. Also use when a paper project needs a bounded automatic exploratory campaign before formal validation.
license: MIT
metadata:
  hermes:
    tags: [research, experiments, autonomous, optimization, autoresearch]
    category: research
    related_skills: [research-project-workflow, experiment, paper-search]
---

# Autoresearch

## Purpose

Turn one explicit user authorization into a sustained, metric-driven research
campaign. Auto means the campaign keeps making valid experimental progress
without asking for routine approval after every trial. It does not mean
unbounded cost, unsafe mutation, metric hacking, or bypassing formal evidence
requirements.

This Skill is orchestration-only. The Research Assistant defines and monitors
the campaign, while one Experiment specialist owns all code changes, commands,
metrics, rollback, and experiment artifacts. The Research Assistant must never
perform those specialist actions itself.

## Activation Contract

Treat an explicit auto/autoresearch/overnight/until-stopped request as approval
for one exploratory campaign within an inspectable contract. Derive values from
the user's request and existing project artifacts before asking anything.

The contract must name:

| Field | Requirement |
|---|---|
| Objective | One measurable experimental question |
| Selection metric | Primary validation metric and maximize/minimize direction |
| Evaluation boundary | Immutable evaluator, split, preprocessing, and anti-leakage rules |
| Mutable scope | Exact files or directories the Experiment specialist may change |
| Immutable scope | Evaluation harness, final-test data, source evidence, and protected files |
| Trial command | Reproducible command plus per-trial timeout |
| Budget | Trial count, wall-clock/compute budget, or explicit until-stopped authorization |
| Acceptance rule | Improvement threshold and simplicity/resource tie-breaker |
| Recovery | Snapshot and rollback method limited to mutable scope |
| Artifacts | Exact campaign, ledger, log, output, and summary paths |

Ask at most one focused question only when a safety-, cost-, or
decision-critical field cannot be derived. Never invent a metric or silently
authorize open-ended paid compute. An explicit until-stopped request is valid
only on compute the user has already authorized.

## Default Artifact Contract

When the user does not supply another existing layout, use:

```text
experiments/
  experiment-record.md
  logs/<trial-id>.log
  outputs/autoresearch/<campaign-id>/
    campaign.json
    trials.jsonl
    snapshots/
    summary.md
```

The explicit autoresearch request accepts these defaults when they do not
collide with existing artifacts. Announce the concrete campaign id and paths,
then dispatch without requesting another routine confirmation. Raw and failed
trials remain under `outputs/`; only later formal evidence belongs in
`results/`.

`campaign.json` is the resumable source of truth for the objective, contract,
baseline, incumbent, budget consumed, and next trial number. `trials.jsonl` is
append-only and records every completed, rejected, crashed, timed-out, or
blocked trial. Also add a concise human-readable entry to
`experiment-record.md` after every trial.

## Dispatch One Campaign Owner

Dispatch one fresh `experiment` child for the whole campaign, not one child per
trial. State the complete contract and exact artifact paths in its task. Require
the child to load its `experiment` Skill, preserve the existing experiment
layout, and return only after a stop condition is reached.

The task must require this autonomous loop:

1. Inspect evidence and current code, validate the evaluator, and run the
   unchanged baseline first.
2. Persist the campaign state and baseline before proposing a candidate.
3. Choose one coherent, evidence-grounded hypothesis. Prefer interpretable
   changes over blind parameter churn.
4. Snapshot only the mutable scope. Never use repository-wide destructive reset
   when unrelated user changes may exist.
5. Apply the candidate, run the exact bounded command with output redirected to
   its trial log, and parse the declared metric.
6. Treat missing/non-finite metrics, timeout, crash, evaluator mutation, or
   leakage as invalid. Record the outcome and restore the incumbent.
7. Accept only a candidate satisfying the declared metric threshold and
   tie-breakers. Keep the accepted state; roll back every rejected state.
8. Atomically update `campaign.json`, append `trials.jsonl`, and update
   `experiment-record.md` before starting another trial.
9. Continue automatically. Do not stop after the first improvement, ask whether
   to try another idea, or wait for routine approval.

The Experiment specialist may dispatch Search only for a specific missing paper
or source fact. Literature retrieval must not fragment the campaign into one
subagent per trial.

## Selection Discipline

- Select on validation evidence, never by repeatedly inspecting the final test
  set.
- Keep the evaluator and metric parser outside mutable scope.
- Compare against the current incumbent and retain the baseline separately.
- Prefer a simpler or cheaper candidate when metric differences fall inside the
  declared threshold.
- Track runtime, memory, parameters, or another resource measure when the
  objective or hardware budget makes it relevant.
- Record negative results. Rejected trials are research evidence, not disposable
  chat history.
- Do not claim novelty or formal superiority from an exploratory winner.

## Stop And Recovery

Stop the loop only when:

- the agreed trial, wall-clock, or compute budget is exhausted;
- the objective or target threshold is reached;
- the user presses Stop or explicitly redirects the campaign;
- no safe valid candidate remains;
- infrastructure, evidence, or compute creates a genuine blocker.

A local foreground command must honor the tool timeout and abort signal. Do not
claim that EasyResearch Stop controls a detached remote process. For remote
work, use an owned foreground launch or persist an exact remote job identifier
and cancellation command in `campaign.json`; otherwise return blocked before
starting unattended work.

After every trial, persisted state must be sufficient for a completed child-id
continuation to resume without guessing. If the campaign child terminates
unexpectedly and the contract remains valid, the Research Assistant may make
one targeted continuation of that completed child using its agent id. Repeated
infrastructure failure is blocked, not an excuse to fabricate progress.

## Campaign Handoff

Require the Experiment specialist to return:

- `status: complete | partial | blocked`
- `campaign:` exact `campaign.json` path
- `ledger:` exact `trials.jsonl` and `experiment-record.md` paths
- `baseline:` primary metric and resource measures
- `best_candidate:` accepted metric, delta, mutable source/config paths, or
  `none`
- `trials:` attempted, accepted, rejected, crashed, and timed-out counts
- `budget:` consumed and remaining
- `formal_status:` always `exploratory` until normal formal gates pass
- `unresolved_gaps:` evidence, compute, robustness, or infrastructure gaps
- `next_action:` formal validation, another authorized campaign, or one user
  decision

After the handoff, inspect the reported artifacts. A promising candidate enters
the existing Experiment workflow for matched protocols, multiple seeds,
multiple datasets where feasible, leakage checks, statistics, and ablations.
Crossing that formal-evidence checkpoint or beginning Writing still requires the
normal user confirmation.
