---
name: research-paper-writing
description: |-
  Write and revise ML/AI manuscripts only after evidence is complete enough: inspect experiment-record.md and results/, verify citations, check five-seed formal reporting where feasible, draft Markdown by default, require a formula-rich Method section, use first-person "We" style, format tables with `(ours)` labels and bold best scores, and list uncertain references for manual verification. Drafting requires explicit user consent — produce readiness reports by default. Use proactively when the user asks to write, revise, audit, or prepare a paper.

  Examples:
  - user: "Write the paper from these experiment results" then check readiness before drafting
  - user: "Draft the method section" then write notation, model equations, loss, and training/inference procedure
  - user: "Some citations are uncertain" then separate verified citations from references requiring manual verification
  - user: "Polish the result tables" then label `(ours)`, bold best scores, and report mean±std/seed counts
license: MIT
metadata:
  hermes:
    tags: [research, paper-writing, manuscript, markdown, citations, method-section]
    category: research
    related_skills: [research-project-workflow, experiment, paper-search, arxiv, pdf-to-markdown]
---

# Research Paper Writing

## Scope
Use this skill for writing or revising a research manuscript after there is enough experimental evidence to support the claims.

This skill is not responsible for exploratory experiments or PDF conversion. Use `research-project-workflow` to orchestrate the full paper project. Use `experiment` for experiment setup, baselines, model trials, dataset expansion, and experiment-record management. Use `paper-search` for paper discovery. Use `arxiv` for arXiv metadata, BibTeX, and citation checks. Use `pdf-to-markdown` to convert public or user-provided PDFs before reading them deeply.

## Non-Negotiable Rule
Do not start writing the manuscript body just because a few small or incomplete experiments exist.

Even when evidence is sufficient, **never start drafting the full paper without explicit user consent**. Only write the manuscript when the user explicitly says to draft, write, or compose the paper. Without such a directive, produce readiness reports and gap analyses instead.

## Writing Readiness Gate
Before drafting Introduction, Method, Experiments, or Abstract, inspect the available experiment evidence.

Read when available:
- `experiments/experiment-record.md`
- `experiments/results/`
- `experiments/outputs/` only for context or failed-run diagnosis
- `experiments/logs/` only when needed to verify commands or failures
- result summary CSV/JSON/Markdown files
- ablation files and dataset/split manifests

These paths are relative to the exact session cwd. Follow another existing
layout only when the dispatch explicitly supplies it.

The manuscript body may be drafted only when ALL of:
- These conditions are satisfied (or explicitly waived by the user).
- The user has explicitly requested to start writing the draft (e.g. "write the paper", "draft the manuscript", "start writing").

Specific section drafting (e.g. "draft the method section") is allowed when the user explicitly asks for that section; the full-paper consent rule still applies for the complete manuscript.

Required conditions:
- At least one strong baseline has completed on 1-2 complete authoritative datasets.
- The proposed model has completed on the same initial datasets.
- The comparison against the strongest baseline is recorded.
- Formal stochastic performance tables use at least 5 seeds by default, or the manuscript explicitly marks the smaller seed count as a limitation/preliminary result.
- The result is strong enough to support a paper claim, or the user explicitly wants a negative-result/analysis paper.
- Core ablations are completed, scheduled, or clearly marked as missing blockers.
- Dataset splits, metrics, seeds, and protocols are sufficiently documented.
- There is no known data leakage in the promoted results.

If the gate fails, write this instead of the paper body:

```markdown
# Writing Readiness Report

## Verdict
Not ready / Ready with caveats / Ready

## Evidence Available
- Baselines:
- Proposed model runs:
- Datasets:
- Ablations:
- Metrics:

## Blocking Gaps
- <missing complete dataset run, missing ablation, missing baseline, leakage risk, missing seed, etc.>

## Next Experiments Before Writing
- <specific command or experiment description>

## Drafting Scope Allowed Now
- <outline only, method notes only, related work notes only, or full manuscript>
```

## Default Output Format
Unless the user explicitly asks for LaTeX or a venue template, write the paper draft in Markdown.

Default files:
- `manuscript/manuscript.md`
- `manuscript/citation-verification.md`
- `manuscript/writing-readiness-report.md` when needed
- `manuscript/revision-report.md` after revision or audit passes
- `manuscript/latex/` for derived LaTeX
- `manuscript/manuscript.pdf` for the compiled PDF

Create `manuscript/` only when an authorized deliverable or readiness report needs it. Keep `manuscript/manuscript.md` authoritative and LaTeX/PDF derived.

Markdown drafts may contain LaTeX math blocks for formulas. Do not convert to a conference LaTeX template unless the user asks.

## Manuscript Structure
For a standard empirical ML/AI paper, use this default Markdown structure:

```markdown
# Title

## Abstract

## 1. Introduction

## 2. Related Work

## 3. Method

## 4. Experiments

## 5. Discussion

## 6. Limitations

## 7. Conclusion

## References

## References To Verify Manually
```

Adjust the structure only when the target venue, paper type, or user request requires it.

## Voice And Style
Use first-person plural for the paper's contribution and actions.

Preferred:
- "We propose ..."
- "We evaluate ..."
- "We find that ..."
- "Our method ..."
- "This work shows ..."

Avoid as the default authorial voice:
- "This paper proposes ..."
- "The paper evaluates ..."
- "The authors show ..."

Use "this paper" only when referring to the document itself, such as "The rest of this paper is organized as follows," and avoid that phrase when possible.

Do not overclaim. Use "state-of-the-art" only if the experiments actually support it against comparable methods and protocols.

## Method Section Requirements
The Method section must be technically complete. A short prose-only Method section is not acceptable for a model paper.

The Method section should usually be one of the longest and most formal sections in the manuscript.

Required Method content:
- Problem formulation.
- Notation table or notation paragraph.
- Input, output, dataset, and prediction definitions.
- Full model architecture description.
- Formula for each proposed component or module.
- Formula for how components are combined.
- Training objective and loss terms.
- Inference procedure.
- Implementation details needed for reproduction.

If the proposed model is a combination of components from multiple papers, describe the novelty as an evidence-backed component combination unless there is a genuinely new mechanism.

For each combined component, state:
- Source paper or baseline family.
- Original purpose of the component.
- Why it is compatible with the other components.
- How it changes the model mathematically.
- Which experiment or ablation supports keeping it.

Minimum formula checklist:
- Define data: `x`, `y`, dataset `D`, train/validation/test split.
- Define feature extraction or encoder mapping.
- Define each added module with equations.
- Define final prediction function.
- Define loss function and any regularization terms.
- Define the optimization objective.

If formulas cannot be written because the model is not clearly specified, stop and write a method-gap report instead of producing a weak Method section.

## Experiments Section Requirements
The Experiments section must map evidence to claims.

Include:
- Datasets and why they are authoritative.
- Baselines, including the strongest baseline.
- Metrics and whether higher or lower is better.
- Train/validation/test or cross-validation protocol.
- Seed policy and number of runs.
- For stochastic training, default to at least 5 formal seeds when feasible.
- Report mean plus sample standard deviation over formal seeds, using `ddof=1` semantics.
- Use paired deltas for proposed-vs-baseline comparisons when runs share the same seed list.
- Add confidence intervals and paired statistical tests when they materially support or limit a claim.
- Main comparison table.
- Ablation table or ablation summary.
- Negative or weak cases when they exist.
- Reproducibility details pointing to `experiments/results/` and `experiments/experiment-record.md`.

Do not hide failed or underperforming settings if they are relevant to the claim.

## Result Table Formatting Rules
Make paper-facing tables easy for reviewers to parse.

Required table conventions:
- Label the proposed method as `<method name> (ours)` in every main performance, SNR, ablation, and paired-delta table where it appears.
- Bold the highest score for the primary metric within each fair comparison group, such as dataset, dataset/SNR, task, or split.
- If accuracy and macro-F1 are both reported, bold the highest value in each metric column only when the values are directly comparable.
- Do not bold a proposed method just because it is proposed; bold the actual best score, even if a baseline wins.
- Keep numeric precision consistent across methods and datasets.
- State whether values are `mean ± sample std`, confidence intervals, or single-run values.
- Include the seed count in table captions or nearby text.
- Put paired-delta and significance tables near the main comparison when the strongest-baseline margin is small or high-variance.
- If a method is best in mean but not statistically significant over a strong baseline, state that clearly and avoid overclaiming.

## Citation Policy
Never fabricate citations.

Use only citations whose metadata can be verified from a reliable source such as:
- arXiv metadata through the `arxiv` skill.
- DOI, publisher page, ACL Anthology, OpenReview, Semantic Scholar, Crossref, or another stable scholarly source.
- Existing verified `.bib` entries supplied by the user.

For each cited work, verify at least:
- Title.
- Authors.
- Year.
- Venue or source.
- Stable URL, DOI, arXiv ID, OpenReview URL, or ACL Anthology URL.

If a citation cannot be verified, do not silently include it as a normal reference. Add it to a dedicated manual-verification list:

```markdown
## References To Verify Manually

| Candidate | Reason verification failed | Needed action |
|---|---|---|
| <title or description> | <missing DOI, conflicting metadata, inaccessible page, etc.> | User should verify or provide source |
```

If the user does not want to manually verify uncertain references, remove those references from the manuscript and rewrite the surrounding claim so it only depends on verified citations.

Do not leave fake BibTeX entries, placeholder venues, or invented author lists in the draft.

## Claim Discipline
Every main claim must be backed by an experiment, ablation, verified citation, or clearly marked limitation.

Use this pattern internally before writing the Results and Abstract:

```markdown
| Claim | Evidence | Manuscript location |
|---|---|---|
| <claim> | <result table, ablation, citation, or limitation> | <section> |
```

If a claim has no evidence, weaken it or remove it.

## Drafting Workflow
Follow this order:
- Check the writing readiness gate.
- Build a claim-evidence table.
- Verify citations and separate uncertain references.
- Draft the Method section with formulas before polishing the Abstract.
- Draft Experiments from `results/`, not from memory.
- Draft Introduction after the contribution and evidence are clear.
- Draft Abstract last or revise it last.
- Run a self-review pass for overclaiming, missing formulas, missing citations, and result mismatches.

Do not spend large token budgets writing polished prose before the readiness gate passes.

## Self-Review Checklist
Before calling a draft usable, check:
- The paper uses "We" for authorial actions.
- The Method section contains complete formulas.
- The proposed model is described precisely enough to implement.
- Results are copied from actual experiment artifacts.
- Baseline comparison is fair and uses the same protocol.
- Ablations support the component-combination story.
- Unverified citations are isolated in `References To Verify Manually`.
- Claims in Abstract and Introduction are supported by Results.
- Limitations include weak datasets, failed settings, incomplete ablations, and external validity limits.

## LaTeX And Venue Templates
Use LaTeX only when the user explicitly asks for it or when preparing a venue submission.

Templates are available under `templates/`, but do not copy or convert to them by default.

When converting Markdown to LaTeX:
- Keep the Markdown draft as the source working draft unless the user says otherwise.
- Compile after major section changes.
- Verify citations, figure paths, labels, and table formatting.
- Do not modify venue `.sty` files.

## Useful References
Load reference files only when needed:
- `references/writing-guide.md` for detailed writing advice.
- `references/citation-workflow.md` for citation verification.
- `references/reviewer-guidelines.md` for self-review and rebuttal framing.
- `references/checklists.md` for venue-specific checklists.
- `references/manuscript-revision-audit.md` for near-complete manuscript audits.

## Do Not Do
- **Do not draft the full manuscript or any complete section without explicit user consent.** Write readiness reports and gap analyses unless the user explicitly says "write the paper", "draft the manuscript", "start writing", or equivalent.
- Do not write full paper prose from incomplete toy experiments. If the user explicitly requests writing despite incomplete evidence, produce a readiness report alongside the draft and mark all gaps.
- Do not treat exploratory runs in `outputs/` as formal evidence unless promoted or clearly justified.
- Do not use `This paper ...` as the default voice.
- Do not produce a prose-only Method section for a model paper.
- Do not include unverifiable citations as normal references.
- Do not commit, push, or create git history unless the user explicitly asks.
