---
name: experimental-design
description: Use when Experiment must choose experimental units, randomization, blocking, replication, factorial or response-surface structure, controls, or a reproducible allocation before collecting formal evidence.
license: MIT
compatibility: Optional helpers use Python 3.12 with pinned NumPy, pandas, and pyDOE3 in the selected experiment environment.
metadata:
  version: "1.0"
  adaptation: "easyresearch.1"
  upstream: https://github.com/K-Dense-AI/scientific-agent-skills/tree/36d8f13a1e754618794bf42f417884940077b4ae/skills/experimental-design
  upstream-commit: 36d8f13a1e754618794bf42f417884940077b4ae
  adapted-by: EasyResearch
---

# Experimental Design

## Scope

Use this Skill inside the dispatch-selected `experiments/` or verified
`experiment_ssh/` root before formal runs. No analysis can repair confounding or
pseudoreplication after data collection.

Write the accepted structure and assumptions into
`<experiment-root>/formal-experiment-plan.md`. Raw generated schedules/designs
go under `<experiment-root>/outputs/design/`; copy only accepted formal versions
to `<experiment-root>/results/design/`. Record each generated seed, package
version, and path in `experiment-record.md`.

## Required Decisions

Derive from accepted artifacts or return a blocked handoff for the caller:

- research question, treatment/intervention, comparator, outcomes, and metrics;
- experimental unit and unit of analysis;
- population/system and sampling frame;
- nuisance factors, batches, sites, time/order, and likely interactions;
- independent replication level and repeated-measure structure;
- constraints, exclusions, stopping, and resource bounds;
- confirmatory versus exploratory scope.

Never ask the user directly. Never substitute a convenience row/measurement for
an independent replicate.

## Design Procedure

1. Define the experimental unit before sample size. Repeated observations on one
   unit do not increase independent `n`.
2. Identify treatment assignment, controls, response variables, covariates,
   nuisance variables, and potential confounders.
3. Randomize at the correct unit when causal interpretation requires it. Record
   the algorithm, seed, strata/blocks, and allocation ratio.
4. Block on known high-impact nuisance variation without blocking on a
   post-treatment variable.
5. Use independent replication at the level targeted by inference. Separate
   technical repeats from biological/site/seed/dataset replication.
6. Choose the smallest design that estimates the intended effects:
   completely randomized, randomized block, paired/crossover, factorial,
   fractional factorial, response surface, repeated-measures, cluster, or
   explicitly bounded sequential/adaptive design.
7. For multiple factors, predeclare main effects/interactions and ensure they are
   estimable. Do not apply a universal "change one variable" rule when a
   factorial design is the correct test.
8. Define masking, allocation concealment, preprocessing, missing-data,
   multiplicity, exclusion, and stopping rules before target outcomes.
9. Pair this plan with `statistical-power` when sample size, MDE, or precision is
   consequential. Five ML seeds do not replace sample-size/power reasoning.
10. Generate and inspect the actual allocation/design, then save its accepted
    version and update the experiment record.

Read `references/randomization_and_blocking.md`, `references/design_types.md`,
`references/factorial_and_doe.md`, or
`references/sequential_and_adaptive.md` only when the selected structure needs
that detail.

## Optional Helpers

Use the selected experiment environment, never the global Skill venv. Approved
direct pins are:

```text
numpy==2.5.2
pandas==3.0.5
pyDOE3==1.6.2
```

Before changing an existing environment, record installed direct versions. If a
replacement could alter accepted experiment behavior, return blocked rather
than silently upgrading/downgrading.

Local Linux/macOS example from the selected experiment root:

```bash
".venv/bin/python" <skill-dir>/scripts/randomization.py --help
".venv/bin/python" <skill-dir>/scripts/doe_designs.py --help
```

Windows PowerShell:

```powershell
$python = Join-Path '.venv' 'Scripts\python.exe'
& $python <skill-dir>\scripts\randomization.py --help
& $python <skill-dir>\scripts\doe_designs.py --help
```

For remote mode, copy the required helper source through the verified
`experiment_ssh/` mount into `<experiment-root>/src/easyresearch_helpers/`,
record the copied source, and execute it only through `ssh-bash` with the remote
`.venv`. Never execute a local helper against an unverified remote path.

## Completion

Complete when the plan identifies the correct independent unit, assignment,
replication, blocks, factors/interactions, controls, outcomes, analysis link,
seeds, and reproducible generated layout. Label domain-specialist, ethics, or
adaptive-design review still required. Apply `specialist-handoff` and list every
input, plan, schedule, helper copy, environment record, and promoted design path.
