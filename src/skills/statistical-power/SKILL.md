---
name: statistical-power
description: Use when Experiment must justify sample size, minimum detectable effect, precision, sensitivity, clustering or attrition inflation, or simulation-based power before formal evidence collection.
license: MIT
compatibility: Helpers use pinned NumPy, SciPy, Statsmodels, and optional Matplotlib/pandas in the selected experiment environment.
metadata:
  version: "1.0"
  adaptation: "easyresearch.1"
  upstream: https://github.com/K-Dense-AI/scientific-agent-skills/tree/36d8f13a1e754618794bf42f417884940077b4ae/skills/statistical-power
  upstream-commit: 36d8f13a1e754618794bf42f417884940077b4ae
  adapted-by: EasyResearch
---

# Statistical Power

## Scope

Power is a design input, not a retrospective quality score. Use this Skill in
the dispatch-selected experiment root before formal runs when sample size,
minimum detectable effect (MDE), precision, clustering, attrition, multiplicity,
or a nonstandard analysis makes evidence adequacy consequential.

Formal ML seed policy and power answer different questions. Five seeds estimate
run-to-run variation; they do not establish dataset/sample size or detectable
effect.

Record assumptions and accepted results in
`<experiment-root>/formal-experiment-plan.md`. Raw calculations, curves, and
sensitivity tables go under `<experiment-root>/outputs/power/`; accepted formal
copies may be promoted to `<experiment-root>/results/power/`. Power curves are
diagnostic evidence, not final manuscript figures.

## Required Inputs

Derive or return blocked through the caller:

- primary outcome/metric and planned statistical test/model;
- unit of analysis and independent sample/cluster definition;
- effect-size or precision rationale with provenance;
- variance, event/base rate, ICC, attrition, allocation, and correlation
  assumptions when applicable;
- alpha, target power, sidedness, multiplicity, and stopping policy;
- feasible sample/compute range and sensitivity scenarios.

Never ask the user directly. Never choose an optimistic effect size only to make
the feasible sample appear adequate. Report a range when assumptions are weak.

## Procedure

1. Match the power model to the exact planned analysis and experimental unit.
2. Prefer pilot data, prior comparable studies, domain-relevant effect sizes,
   or an explicitly decision-relevant MDE. Record uncertainty and transport
   limits.
3. Calculate required sample size and achieved power/MDE at feasible sizes.
4. Inflate for clustering/design effect, repeated measures, attrition, unusable
   samples, imbalance, and multiplicity when the design requires it.
5. Run sensitivity analysis across plausible effect/variance/rate assumptions.
6. Use Monte Carlo simulation for mixed models, interactions, nonstandard
   estimators, adaptive rules, or analyses without a defensible closed form.
7. Simulate the exact data-generating process and exact planned analysis. Use a
   fixed seed and report Monte Carlo uncertainty.
8. Bound simulation work before launch and never tune assumptions after seeing
   target results without labeling the analysis exploratory.
9. Record formulas/packages/versions, assumptions, output paths, and the chosen
   design consequence in the formal plan and experiment record.

Read `references/effect_sizes.md`, `references/closed_form_recipes.md`, and
`references/simulation_based_power.md` for the selected calculation only.

## Helpers And Dependencies

Use the selected experiment `.venv`, not the global Skill venv. Approved direct
pins used by bundled helpers are:

```text
numpy==2.5.2
scipy==1.18.1
statsmodels==0.14.6
matplotlib==3.11.1
pandas==3.0.5  # only for mixed-model examples
```

Do not install `pingouin` or `lifelines`; neither is required by the adapted
bundled helpers. Record current versions before an install. If replacement could
alter accepted experiment behavior, return blocked rather than silently change
the environment.

For headless curves set `MPLBACKEND=Agg`.

Linux/macOS from the selected experiment root:

```bash
MPLBACKEND=Agg ".venv/bin/python" <skill-dir>/scripts/power.py
".venv/bin/python" <skill-dir>/scripts/simulate_power.py
```

Windows PowerShell:

```powershell
$env:MPLBACKEND = 'Agg'
$python = Join-Path '.venv' 'Scripts\python.exe'
& $python <skill-dir>\scripts\power.py
& $python <skill-dir>\scripts\simulate_power.py
```

For remote work, copy only the required helper source through the verified
`experiment_ssh/` mount into `src/easyresearch_helpers/`, record it, and execute
with `ssh-bash` plus the remote `.venv`.

`scripts/power.py` supports independent/paired/one-sample means, ANOVA,
proportions, correlation, chi-square, and added-predictor regression. Always
state whether returned `n` is per-group or total. `scripts/simulate_power.py`
provides a bounded seeded harness; each generator closes over its own declared
alpha and planned model.

## Reporting

Report assumptions before the result:

```markdown
| Scenario | Effect/variance/rate assumptions | Alpha/power | Required n | Unit | Caveat |
|---|---|---|---|---|---|
```

Do not claim that a powered design proves an effect, that a nonsignificant result
is equivalent, or that retrospective observed power validates evidence.

## Completion

Complete when every consequential assumption is sourced or explicitly bounded,
the calculation matches the design/analysis unit, sensitivity results are
recorded, and the formal plan states the chosen sample/seed/compute consequence.
Apply `specialist-handoff` and list every input, plan, script/helper copy,
environment record, raw output, and promoted result path.
