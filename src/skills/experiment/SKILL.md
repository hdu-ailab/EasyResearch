---
name: experiment
description: |-
  Use when Experiment must build, run, compare, or record reproducible ML/AI paper experiments locally or through the Research Assistant-configured ssh-bash tool and verified SSHFS workspace, including baselines, datasets, controlled trials, multi-seed formal evidence, ablations, and results promotion.

  Examples:
  - user: "Set up experiments for this paper idea" then create the workspace, read papers, choose datasets, and define baselines
  - user: "Try a new model based on these papers" then identify reusable components, run baselines first, and record every run
  - user: "The model beats baseline on one dataset" then expand datasets and promote formal outputs to results/
  - user: "Make these results paper-ready" then require five seeds where feasible, compute mean/std, paired deltas, tests, and formatted tables
license: MIT
metadata:
  hermes:
    tags: [research, experiments, ml, baselines, datasets, reproducibility]
    category: research
    related_skills: [research-project-workflow, paper-material-package, paper-search, arxiv, research-paper-writing, ssh-experiment, remote-experiment-preflight]
---

# Experiment Workspace

## Purpose
Use this skill to constrain research experiment workspaces and enforce a paper-driven experimental process. The goal is to find a model that is either clearly stronger than baselines or more innovative while remaining experimentally defensible.

Most practical model innovations are not invented from nothing. They are discovered by reading papers, identifying what each component is useful for, systematically recombining components from different papers, and validating which combinations actually work.

Do not jump directly to a proposed model. Read papers first, build baselines first, then try component combinations.

In the bundled paper workflow, select exactly one root from the dispatch before
editing: exact-cwd `experiments/` for local execution or the Research
Assistant-created and marker-verified exact-cwd `experiment_ssh/` mount for SSH
execution. Do not mix or mirror the two roots.

## Required Directory Layout
Create or maintain this structure under the user-specified experiment root:

```text
<experiment-root>/
  .venv/
  src/
  external/
    baselines/
      <baseline_name>/
        repo/
        .venv/
    benchmarks/
      <benchmark_name>/
        repo/
        .venv/
  outputs/
  results/
  logs/
  datasets/
  experiment-record.md
```

For local mode, `<experiment-root>` is `experiments/`. For SSH mode, it is only
`experiment_ssh/`, which is the local view of the configured remote project
root. An explicitly supplied existing user layout may replace the local-mode
root, but it never replaces the verified bundled SSH mount.

Directory rules:
- `.venv/`: main experiment environment managed by `uv`; use it only for this project's own experiment code, routers, models, analysis, plotting, and lightweight adapters.
- `src/`: source code written for this project, including data loading, models, training, evaluation, adapters, analysis, and utilities.
- `external/`: all external author repositories, official benchmark repositories, and their isolated environments. Do not place cloned third-party repos directly under `src/`.
- `external/baselines/<baseline_name>/repo/`: checkout or symlink to the author-maintained baseline repository.
- `external/baselines/<baseline_name>/.venv/`: isolated `uv` environment for that baseline only.
- `external/benchmarks/<benchmark_name>/repo/`: checkout or symlink to the official benchmark/evaluator repository.
- `external/benchmarks/<benchmark_name>/.venv/`: isolated `uv` environment for that benchmark only.
- `outputs/`: all raw outputs from experiment scripts, including failed trials, temporary models, trial models, and formal model runs.
- `results/`: clean copy of formal experiment outputs only. Use this directory later for paper writing, figures, statistical analysis, and tables.
- `logs/`: command logs, runtime logs, error traces, and environment snapshots.
- `datasets/`: raw or processed datasets, plus dataset manifests when useful.
- `experiment-record.md`: human-readable experiment progress record. Update it after every experiment run.

Keep `results/` clean. Do not store failed trials, exploratory artifacts, debug files, or duplicate raw outputs there.

## Environment Rules
Use `uv` for the experiment environment:

```bash
uv venv .venv
uv pip install <packages>
uv run <command>
```

Prefer `uv run` for Python commands so runs use the workspace environment consistently.

Record dependency changes in `experiment-record.md`, especially when a package affects data processing, model behavior, metrics, or plotting.

External code environment rules:
- Keep the main experiment `.venv` clean. Do not install official benchmark dependencies, old paper-baseline dependencies, browser stacks, Docker harness packages, or conflicting framework versions into the main `.venv`.
- Install each external baseline's dependencies only in `external/baselines/<baseline_name>/.venv`.
- Install each official benchmark/evaluator's dependencies only in `external/benchmarks/<benchmark_name>/.venv`.
- Run author baseline code from `external/baselines/<baseline_name>/repo/` or the baseline component directory that owns its `.venv`.
- Run official benchmark evaluators from `external/benchmarks/<benchmark_name>/repo/` or the benchmark component directory that owns its `.venv`.
- If using a symlink for `repo/`, keep the environment next to the component under `external/`; do not rely on global/shared Python environments.
- Recreate virtual environments when changing the directory layout. Python virtual environments are often not safely relocatable.
- If old layout directories exist, such as top-level `src/baselines/<name>/.venv` or `src/benchmarks/<name>/.venv`, treat them as legacy until the replacement under `external/` is created and a smoke test passes.

When running experiment related script or shell command, extend tool timeout to 2 hours(or above if needed).

## Execution Location

Use the execution mode carried by the dispatch. Do not choose a remote host,
mount, credential, or cost boundary on the user's behalf.

Run locally when the request or existing project decision selects local work and
the machine has the required resources. Use `ssh-experiment` only when Research
Assistant has configured exact-cwd `easyresearch.ssh`, `ssh-bash` test passed,
and the SSHFS mount identity was verified.

Before remote code changes or commands, call `ssh-bash` test, repeat mount
identity verification, and recheck required compute. This is a freshness guard,
not permission to reconfigure credentials, remount over files, install system
components, or select a different server. If configuration or mount is missing,
stale, or inconsistent, preserve local work and return `blocked` with one
`required_user_input` for Research Assistant.

Edit remote experiment code only through the verified exact-cwd
`experiment_ssh/` mount; execute only through `ssh-bash`. Never create, inspect,
or use local-only `experiments/` for that SSH task. Never read credential files
or copy their contents into commands, logs, records, or project files. Record
actual hardware and environment facts rather than assuming GPU models, indices,
CUDA versions, usernames, or package locations.

## Paper-First Workflow
Use the mounted methodology Skills before implementation when their trigger
applies:

- `hypothesis-generation` produces evidence-bounded candidates, rivals,
  discriminating predictions, controls, operationalization, and a
  preregistration-ready `formal-experiment-plan.md`;
- `experimental-design` fixes experimental units, randomization, blocking,
  independent replication, factors/interactions, and reproducible allocations;
- `statistical-power` records sourced effect/variance assumptions, sample size,
  MDE, sensitivity, clustering/attrition inflation, or bounded simulation;
- `huggingface-datasets` provides public read-only Dataset Viewer evidence only.

These Skills augment this experiment workflow. They do not create a second
experiment root, replace baseline-first execution, turn planning scores into
findings, or supersede the separate metric-bound `autoresearch` campaign.

Before designing the proposed model:
- Read multiple relevant papers, not only one. Prefer the last 3 years for current models and modules, while keeping older foundational baselines when needed.
- Include both high-standard papers and lower-tier/application-oriented papers. Strong papers often provide baselines and rigorous protocols; lower-tier/application papers often contain practical modules and domain-specific tricks worth testing.
- Identify 2-5 authoritative datasets that appear in those papers or are widely accepted in the target domain.
- Extract recurring problems from limitations, failure cases, weak ablations, robustness tests, dataset shifts, or deployment constraints.
- Extract the purpose of each reusable component from the papers, such as backbone, attention module, multiscale block, domain adaptation module, augmentation, loss, regularization, feature fusion, decoder, or evaluation protocol.
- Separate component purpose from component name. For example, record whether an attention module improves long-range context, robustness, cross-domain alignment, feature selection, or interpretability.
- Design a new model by combining components with a clear rationale, not by stacking modules blindly.

If the research domain or target task cannot be derived from the dispatch,
material package, or existing experiment record, stop before creating datasets
or code and return `blocked` with one `required_user_input` for the caller. Do
not address the user directly.

## Research Routes
Use one of these routes to structure experiments.

Model-driven route:
- Start from a strong, reproducible top-tier or widely accepted model as the baseline.
- Add modules found in lower-tier, application-oriented, adjacent-domain, or other papers.
- Pre-screen whether the module combination may address a current unresolved problem in the domain.
- Test whether the enhanced model beats or meaningfully improves on the original baseline.

Problem-driven route:
- Start from recurring problems found in the literature.
- Convert each problem into measurable tests, such as noisy accuracy, cross-domain F1, small-sample performance, latency, calibration, robustness, or ablation sensitivity.
- Combine modules or models from different papers to address the problem.
- Choose a strong baseline and compare under the same protocol.

Both routes must eventually produce the same evidence chain: problem, combination hypothesis, baseline, controlled experiment, ablation or interaction analysis, and formal result.

## Dataset Policy
Use 2-5 authoritative datasets from the literature whenever feasible.

For every accepted dataset, record an exact version/revision, resolved commit
when available, card and citation, license/access terms, configurations/splits,
preprocessing, and any sensitive or gated-data constraint. A public Hub preview
is not permission to reuse data, and a Dataset Viewer observation is not
commit-pinned unless its observed revision matches the resolved commit.

Initial phase:
- Select 1-2 complete authoritative datasets for baseline and model trial runs.
- Running full experiments on 1-2 complete datasets during model trial-and-error is acceptable and expected.
- Do not expand to all datasets before the proposed model shows a real advantage over baselines.

Expansion phase:
- Expand to additional datasets only after the model outperforms the strongest baseline or demonstrates a clearly useful innovation on the initial 1-2 datasets.
- Keep dataset preprocessing consistent between baselines and proposed models.
- Record dataset source, split protocol, preprocessing, labels, metrics, and any excluded samples.

## Baseline-First Rule
Before trying a new model, run baselines on 1-2 complete datasets.

Baseline candidates:
- Simple or classical baseline used in the target domain.
- Strong basic neural baseline, such as CNN, MLP, Transformer, U-Net, ResNet, or another standard architecture appropriate for the task.
- 1-3 representative models from papers that use the same datasets or protocol.

Baseline requirements:
- Use the same dataset split and metrics intended for the proposed model.
- Prefer author-maintained code or official framework wrappers when a paper baseline has a usable repository.
- If author code cannot be used, record the reason and label the result as a reimplementation or approximation.
- Keep external baseline repositories and environments under `external/baselines/<baseline_name>/`.
- Save raw outputs under `outputs/`.
- Copy only finalized baseline outputs needed for later paper figures/tables into `results/`.
- Record commands, metrics, runtime, failures, and interpretation in `experiment-record.md`.

## Formal Seed And Statistical Reporting Policy
Use a stronger seed policy for formal paper evidence than for exploratory trials.

Default rules:
- Pilot, debugging, and model-search runs may use 1-2 seeds if compute is limited.
- Formal stochastic performance tables should use at least 5 seeds by default unless the user explicitly waives this or the task is deterministic.
- Use the same seed list for proposed methods and baselines in paired comparisons.
- Record the exact seed list in `formal-experiment-plan.md`, `experiment-record.md`, configs, and promoted summaries.
- Report mean plus sample standard deviation over seeds, using `ddof=1`, not population standard deviation.
- For proposed-vs-baseline comparisons, add paired deltas by seed when the same seeds are used.
- When possible, report 95% confidence intervals and paired statistical tests, such as paired t-test and Wilcoxon signed-rank test, especially for the strongest baseline.
- If fewer than 5 seeds are used, label the results as preliminary or explicitly explain the compute/user constraint; do not present them as final paper evidence without caveats.
- If a 5-seed expansion weakens an earlier claim, update the manuscript story instead of hiding the variance.

## Model Trial Process
After baselines exist:
- Create one model hypothesis at a time.
- State which components from which papers are being combined and why.
- Treat innovation as systematic component recombination plus evidence. For example, combine module A from one paper with module B from another paper when the combination plausibly addresses a target problem.
- Record the expected role of the component combination before running the experiment.
- Run the model on 1-2 complete datasets before deciding whether it is promising.
- Compare against the strongest baseline, not only the weakest one.
- Prefer many disciplined experiments over one large untraceable experiment.

## Combination Hypothesis Policy
The hypothesis may be about the full combination, not each module in isolation.

Rules:
- Do not require every added module to independently solve a problem or independently improve metrics.
- Some modules may reduce performance alone but improve the full model through interaction with another module.
- Evaluate the intended combination first, then use ablations to understand interactions.
- Record whether a component appears useful alone, useful only in combination, neutral, harmful, or inconclusive.
- Do not overinterpret a single ablation. If results conflict, run another seed, dataset, or diagnostic before turning it into a paper claim.

Use this table when planning trials:

```markdown
| Combination | Source components | Target problem | Expected interaction | Primary metric | Risk |
|---|---|---|---|---|---|
| A+B | A from paper 1, B from paper 2 | cross-domain degradation | B stabilizes A's pseudo labels | target F1 | confirmation bias |
```

Acceptable trial cost:
- It is acceptable to run full experiments on 1-2 complete datasets during model exploration.
- It is not acceptable to run many datasets blindly before the model beats or meaningfully differs from baselines.

Promote a trial model only when it satisfies at least one condition:
- It improves the strongest baseline on the primary metric.
- It improves robustness, efficiency, stability, interpretability, or another paper-relevant metric with clear evidence.
- It provides a clearly useful component combination worth testing more broadly.

## Ablation Requirement
When a combined model outperforms the strongest baseline or is selected for broader validation, run ablations before treating it as a formal method.

Required ablations:
- Remove or disable each added component one at a time.
- Compare the full model against the strongest baseline and against each partial variant.
- Keep the same dataset split, metric, seed policy, and training budget whenever possible.
- Record whether each component is useful alone, useful only through interaction, neutral, harmful, or inconclusive.

If a component does not help alone but helps in combination, describe the contribution as a combination or interaction, not as a standalone module contribution. If a component is neutral or harmful even in the full combination, remove it or report it as a negative ablation.

## Run ID Convention
Use stable run IDs across `outputs/`, `results/`, `logs/`, and `experiment-record.md`.

Recommended pattern:
```text
YYYYMMDD_HHMM_<model>_<dataset>_seed<seed>
```

Examples:
```text
20260507_1530_resnet_baseline_cifar10_seed42
20260507_1815_ab_fusion_model_datasetA_seed1
```

For multi-dataset or multi-seed batch runs, use a batch ID and store per-run IDs inside the output summary.

## Reproducibility Requirements
Every completed or failed run should preserve enough information to reproduce the result.

Record or save:
- Exact command.
- Run ID.
- Dataset name, version, split, and preprocessing.
- Seed or seed list.
- Model/config path or inline config copy.
- Metric definitions.
- Environment changes and important package versions.
- Output path and log path.
- Promotion status: copied to `results/` or not promoted.
- Method-plan and dependency evidence: `formal-experiment-plan.md`, exact direct
  package versions added for design/power/analysis, and any helper source copied
  into a verified remote root.

Prefer storing configs under `outputs/<run-id>/`. If a run is promoted, copy the exact config into `results/<run-id>/`.

## Leakage Prevention
Do not tune repeatedly on the final test set.

Rules:
- Use train/validation/test splits when available.
- Use validation data for model selection, early stopping, threshold selection, and hyperparameter tuning.
- Use the test set only for final reporting or clearly labeled exploratory checks.
- If cross-validation is used, keep folds consistent across baselines and proposed models.
- Do not let target labels, test labels, or full-dataset statistics leak into training or preprocessing.
- If a trial accidentally leaks information, record it as invalid in `experiment-record.md` and do not promote it to `results/`.

## Results Promotion
Use this promotion flow:
- Write all script outputs to `outputs/<run-id>/`.
- After a run is judged formal or paper-relevant, copy only the needed artifacts to `results/<run-id>/`.
- Keep `results/` limited to formal model outputs, formal baseline outputs, summarized metrics, tables, and plotting-ready files.
- Do not delete exploratory outputs from `outputs/` unless the user explicitly asks.

Formal artifacts usually include:
- Metrics CSV/JSON.
- Config file.
- Model identifier or checkpoint reference.
- Dataset/split manifest.
- Prediction or error-analysis file if needed for later figures.
- Summary table or statistical comparison file.

Formal table requirements:
- Label the proposed method as `<method name> (ours)` in performance comparison tables.
- In paper-facing Markdown tables, bold the highest primary metric within each dataset, dataset/SNR, or otherwise comparable group.
- Keep raw numeric CSV tables unformatted for analysis, and apply bolding only to Markdown/LaTeX presentation tables.
- Include paired-delta and statistical-test tables when they materially clarify the claim.
- If the proposed method is not the best in an ablation or subgroup, do not force bolding onto it; bold the true best score and explain the result honestly.

## Experiment Record
Update `experiment-record.md` after every run, including failed runs.

Use this entry pattern:

```markdown
## YYYY-MM-DD HH:MM - <run-id>

- Goal: <why this run was executed>
- Papers/components: <paper modules or baseline source>
- Research route: <model-driven or problem-driven>
- Combination hypothesis: <why this combination may work>
- Dataset(s): <dataset names and split/protocol>
- Seed(s): <seed or seed list>
- Command: `<exact command>`
- Output path: `outputs/<run-id>/`
- Log path: `logs/<run-id>.log` or equivalent
- Result path: `results/<run-id>/` or `not promoted`
- Metrics: <primary and secondary metrics>
- Reproducibility: <config path, environment note, dataset version>
- Runtime/status: <completed/failed/blocked and runtime if known>
- Interpretation: <what changed compared with baseline>
- Next action: <keep, modify, reject, expand datasets, or rerun>
```

The record should make it possible to reconstruct why a model was kept or rejected.

## Decision Gates
Gate 1: Literature and datasets
- Papers read and summarized.
- 2-5 authoritative datasets identified.
- Initial 1-2 datasets selected.

Gate 2: Baselines
- Baselines run on 1-2 complete datasets.
- Metrics and outputs recorded.
- Strongest baseline identified.

Gate 3: Trial model
- Proposed model rationale written.
- Combination-level hypothesis recorded.
- Trial run completed on 1-2 complete datasets.
- Comparison against strongest baseline recorded.
- Leakage risks checked.

Gate 4: Expansion
- Expand to more datasets only if the proposed model beats the strongest baseline or shows a meaningful innovation worth broader validation.
- Component ablations completed or scheduled.
- Promote formal outputs into `results/`.

## Reporting Rules
- Report negative results honestly.
- Do not claim state-of-the-art from trial runs.
- Distinguish exploratory outputs in `outputs/` from formal outputs in `results/`.
- Favor reproducible comparisons over optimistic one-off results.
- When the proposed model underperforms, use the result to redesign the component combination rather than hiding the run.
- Describe novelty as an evidence-backed component combination unless there is a genuinely new mechanism.

## Blocked Work

Stop rather than guess when a required source, dataset permission, configured
SSH connection, mount, compute resource, metric choice,
or consequential protocol decision is unavailable. Preserve usable artifacts
and report one `required_user_input` the caller cannot derive. Do not address the
user directly; the Research Assistant checks existing decisions first and asks
only when needed.
