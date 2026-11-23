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

Follow the session's selected execution mode. In subagent-driven mode, Research
Assistant defines and acceptance-reviews the campaign and one Experiment specialist owns
the trials. In single-Agent mode, Research Assistant applies the `experiment`
Skill and executes the same bounded loop directly, without child dispatch or a
specialist handoff. The campaign contract and evidence requirements apply in both.

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

Select the experiment root from the accepted execution mode before constructing
the campaign: exact-cwd `experiments/` for local execution or the verified
exact-cwd `experiment_ssh/` mount for SSH execution. Never mirror one campaign
across both roots. When the user does not supply another existing layout,
use:

```text
<experiment-root>/
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
trial. Call `subagent` with `agent: "experiment"`, a short `description`, and a
`prompt` containing the complete contract and exact artifact paths. Omit
`sessionID` for the initial dispatch; retain the returned native `sessionID` for
running or idle direct-child follow-ups. Set `model` only for an explicit user
model/variant request after discovery through `models`; the override belongs only
to this child session. Require the child to load its `experiment` Skill and
preserve the existing experiment layout.

The call returns after durable admission, without waiting for inference. Each
busy period reports through a harness `<background-result>` notice, including
outstanding work. Such notices are not human speech; never reproduce or fabricate
their XML. The child may end an intermediate response while a managed command or
Search child runs, then resume automatically. It publishes its final campaign
handoff only at an actual stop condition, not every idle boundary. Do independent
useful work or end the response while waiting; never sleep, poll, proactively
check progress, or launch a duplicate campaign or trial.

The task must require this autonomous loop:

1. Inspect evidence and current code, validate the evaluator, and run the
   unchanged baseline first.
2. Persist the campaign state and baseline before proposing a candidate.
3. Choose one coherent, evidence-grounded hypothesis. Prefer interpretable
   changes over blind parameter churn.
4. Snapshot only the mutable scope. Never use repository-wide destructive reset
   when unrelated user changes may exist.
5. Apply the candidate, run the exact bounded command with output redirected to
   its trial log, and parse the declared metric after confirmed completion.
   For local trials use `shell`; for remote trials use `ssh-bash` with `action: "run"`.
   Both use `background: true` and a positive `timeout` in milliseconds matching
   the accepted per-trial runtime budget. Resume from
   its automatic completion report; do not start the next trial while it runs.
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
- the user cancels the campaign task tree, exits the application, or explicitly
  redirects or ends the campaign;
- no safe valid candidate remains;
- infrastructure, evidence, or compute creates a genuine blocker.

Composer Stop interrupts only the selected session's current run; stopping the
Research Assistant does not cancel its Experiment campaign. Task-specific
cancellation stops the selected campaign's owned subtree; terminal Exit cancels
all owned work. A foreground `shell` or `ssh-bash` run timeout is only a wait budget: omitted/zero
waits two minutes and then backgrounds the original process without killing or
restarting it. Use explicit background execution with a positive millisecond
timeout for the trial runtime limit; omitted/zero background timeout is unlimited,
not a bounded trial. Remote trials remain owned through their SSH channel; do not
manually detach them or poll their completion. Cancellation requests TERM and
closes the connection, but escaped remote descendants may survive. Remote SSH
connections do not survive daemon shutdown/restart: inspect recorded ownership
and artifacts after a lost connection rather than assuming process handover or
launching a duplicate trial.

After every trial, persisted state must be sufficient for a `sessionID`
continuation to resume without guessing. A running direct-child follow-up steers
that campaign; it does not launch another owner or promise to interrupt its
current tool. After restart, use confirmed records and reported process outcomes
without repeating completed work or duplicating surviving trials. If the campaign
reports a terminal recoverable failure and the contract remains valid, the
Research Assistant may make one targeted follow-up using that child's `sessionID`.
Repeated infrastructure failure is blocked, not an excuse to fabricate progress.

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
The Research Assistant acceptance-reviews those formal artifacts and advances
to Writing automatically when the original request already authorizes a paper;
it asks only when drafting authority or a consequential evidence decision is
still missing.

Exhausting the agreed exploratory budget with no accepted trial can satisfy the
assigned scope. Preserve the incumbent and all attempts; do not extend the budget
merely to obtain an improvement.
