---
name: hypothesis-generation
description: Use when Experiment must turn observations or literature limitations into evidence-bounded rival hypotheses, discriminating predictions, controls, measurements, or a preregistration-ready empirical plan before implementation or trials.
license: MIT
compatibility: Python 3.11+ standard library for bundled local validators.
metadata:
  version: "2.1"
  adaptation: "easyresearch.1"
  upstream: https://github.com/K-Dense-AI/scientific-agent-skills/tree/36d8f13a1e754618794bf42f417884940077b4ae/skills/hypothesis-generation
  upstream-commit: 36d8f13a1e754618794bf42f417884940077b4ae
  adapted-by: EasyResearch
---

# Hypothesis Generation

Adapted from K-Dense for EasyResearch's Experiment-owned artifact roots and
Research Assistant-owned user interaction.

## Scope

Use this Skill before code or trials when the empirical question needs a
testable hypothesis package. A hypothesis is a candidate to challenge, not a
finding, causal conclusion, novelty proof, or recommendation.

Apply it inside the experiment root selected by the dispatch:

- local: exact-cwd `experiments/`;
- remote: only the verified exact-cwd `experiment_ssh/` mount.

Do not create a second planning root. Record the accepted hypothesis, rivals,
predictions, controls, measurements, and analysis plan in
`<experiment-root>/formal-experiment-plan.md`. Optional structured working files
may live under `<experiment-root>/outputs/planning/`; promote only accepted plan
evidence to `<experiment-root>/results/planning/`.

This Skill does not replace `autoresearch`: autoresearch owns an already
authorized metric-bound trial campaign. This Skill may strengthen the campaign
contract or a normal Experiment plan but does not select a winner without data.

## Readiness And Safety

Inspect the dispatch, `ref_papers/source.json`, `ref_papers/paper-notes.md`,
readable sources, existing experiment plan/record, and relevant preliminary
results. Distinguish:

- observation;
- research question;
- hypothesis and mechanism;
- prediction;
- rival explanation;
- operationalization;
- analysis plan;
- observed evidence.

Never ask the user directly. Return a blocked handoff when existing decisions
cannot resolve a consequential objective, sensitive-data authority, ethics or
safety gate, target population, metric, intervention, or resource boundary.
Never send unpublished/sensitive content to search or another external endpoint
without authority carried by the dispatch.

Stop at required human, animal, biosafety, dual-use, privacy, clinical, legal,
or regulatory review. Do not provide harmful operational optimization.

## Procedure

1. Freeze the observation with source, unit, population/system, preprocessing,
   uncertainty, missingness, and whether it was expected or selected after
   looking at outcomes.
2. Frame one answerable research question and declare its claim type:
   descriptive, associational, predictive, causal, or mechanistic.
3. Record the dated evidence boundary: indexes, queries, filters, included and
   excluded source types, and known coverage limitations. Search absence never
   proves global novelty.
4. Generate genuinely different rivals where plausible: proposed mechanism,
   measurement artifact, confounding/common cause, selection, reverse causation,
   context/boundary effects, stochastic variation, and competing mechanisms.
5. If no human-independent rival set exists, label the set AI-generated and
   require later human review; never pretend independent ideation occurred.
6. For causal work, define target population/system, intervention/exposure,
   comparator, outcome/time horizon, estimand, and identification assumptions.
7. Derive predictions that distinguish at least two rivals. State observable,
   measurement, expected pattern, incompatible result, boundary conditions, and
   indeterminate outcomes.
8. Specify positive/procedural/negative controls only when scientifically
   valid; a negative control must share relevant bias paths but not the target
   mechanism.
9. Operationalize every construct with units, timing, instrument, calibration,
   reliability, validity, missingness, transforms, thresholds, and bias risks.
10. Match experimental unit, sampling/allocation, randomization, masking,
    outcomes, models, uncertainty, multiplicity, missing-data handling,
    stopping, sensitivity, and replication to the claim.
11. Mark confirmatory versus exploratory decisions and preserve later
    deviations instead of rewriting them as a priori.
12. Write/update `formal-experiment-plan.md`, validate structured sidecars when
    used, and reference the plan in `experiment-record.md`.

## Local Validators And Templates

The bundled scripts are local, deterministic, non-scoring, and standard-library
only. They check declared structure/internal consistency, not scientific truth.

| Need | Template | Validator |
|---|---|---|
| Hypothesis record | `assets/hypothesis_record_template.json` | `scripts/validate_hypothesis_schema.py` |
| Measurement | `assets/operationalization_template.json` | `scripts/check_operationalization.py` |
| Rival predictions | `assets/prediction_rival_matrix_template.csv` | `scripts/validate_prediction_matrix.py` |
| Controls | `assets/falsification_controls_template.json` | `scripts/check_falsification_controls.py` |
| Evidence boundary | `assets/evidence_ledger_template.csv`, `assets/search_boundary_template.json` | `scripts/audit_evidence_ledger.py` |
| Causal wording | annotated Markdown | `scripts/lint_causal_claims.py` |
| Preregistration draft | `assets/preregistration_scaffold_template.md` | `scripts/generate_preregistration_scaffold.py` |

Linux/macOS example from this Skill directory:

```bash
"$EASYRESEARCH_VENV/bin/python" scripts/validate_hypothesis_schema.py hypothesis.json
```

Windows PowerShell:

```powershell
$python = Join-Path $env:EASYRESEARCH_VENV 'Scripts\python.exe'
& $python scripts\validate_hypothesis_schema.py hypothesis.json
```

Use an existing Python 3.11+ fallback when the EasyResearch interpreter is
unavailable. Do not install packages for these helpers. Exit 1 means validation
completed with findings; exit 2 means malformed/unsafe input. Preserve both in
the experiment record and handoff.

Load detailed references only for the active need: causal claims, design
patterns, preregistration/open science, literature search, ethics/safety, or
tool schemas. The bundled source ledger is a dated provenance aid and must not
replace current policy verification.

## Completion

Complete when `formal-experiment-plan.md` has an evidence-bounded question,
candidate/rival hypotheses, discriminating predictions, valid measurements and
controls, declared analysis/design assumptions, claim limits, and actionable
implementation criteria. A missing consequential decision is blocked; a useful
but incomplete candidate package is partial.

Apply `specialist-handoff` before normal termination and enumerate every source,
plan, structured sidecar, validation report, and experiment-record path used or
changed.
