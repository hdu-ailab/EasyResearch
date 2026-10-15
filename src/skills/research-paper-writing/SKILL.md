---
name: research-paper-writing
description: |-
  Use when Writing must assess, draft, revise, or audit an empirical ML/AI method paper whose claims depend on experiment-record.md and results/, including baseline fairness, multi-seed reporting, ablations, formula-rich methods, result tables, citation verification, and derived submission artifacts. Do not use its empirical readiness gate for a survey-only paper.

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
    related_skills: [research-project-workflow, experiment, paper-search, arxiv, pdf-to-markdown, survey-paper-writing]
---

# Research Paper Writing

## Scope
Use this skill for writing or revising an empirical research manuscript after
there is enough experimental evidence to support its method and result claims.
For a survey, review, tutorial, taxonomy, or literature-synthesis paper, use
`survey-paper-writing`; do not apply this Skill's baseline, seed, proposed-model,
or ablation gate to literature synthesis. For a hybrid survey with an original
benchmark, apply this Skill only to benchmark-derived claims.

This skill is not responsible for exploratory experiments or PDF conversion. Use `research-project-workflow` to orchestrate the full paper project. Use `experiment` for experiment setup, baselines, model trials, dataset expansion, and experiment-record management. Use `paper-search` for paper discovery. Use `arxiv` for arXiv metadata, BibTeX, and citation checks. Use `pdf-to-markdown` to convert public or user-provided PDFs before reading them deeply.

## Load The Relevant Writing Instructions

Read these files from this Skill's resolved directory at the indicated step.
Their contents are not automatically loaded with this Skill:

| Task | Required reference |
|---|---|
| Draft or substantially rewrite scholarly prose | `references/writing-guide.md` before organizing the argument |
| Add, replace, or verify citations | `references/citation-workflow.md` before choosing sources |
| Finalize a draft or address review findings | `references/manuscript-revision-audit.md` before checking and revising |

Use `references/reviewer-guidelines.md` for deeper author self-critique and
`references/checklists.md` for a supplied venue. Verify current venue rules;
historical examples do not impose a universal page count or review score.

## Non-Negotiable Rule
Do not start writing the manuscript body just because a few small or incomplete experiments exist.

Even when evidence is sufficient, **never start drafting the full paper without explicit user consent**. Only write the manuscript when the user explicitly says to draft, write, compose, or complete the paper. An initial end-to-end request to complete a paper carries that authority through accepted stages; do not ask again. Without such a directive, produce readiness reports and gap analyses instead.

## Writing Readiness Gate
Before drafting Introduction, Method, Experiments, or Abstract, inspect the available experiment evidence.

Read when available:
- `<experiment-root>/experiment-record.md`
- `<experiment-root>/results/`
- `<experiment-root>/outputs/` only for context or failed-run diagnosis
- `<experiment-root>/logs/` only when needed to verify commands or failures
- result summary CSV/JSON/Markdown files
- ablation files and dataset/split manifests
- executed implementation and saved configuration for the reported runs
- figure exports, plotting code and the numeric data behind intended figures

The accepted Experiment handoff selects `<experiment-root>`: `experiments/` for
local execution or `experiment_ssh/` for SSH execution. These paths are relative
to the exact session cwd. Never merge evidence across both roots or guess the
mode when the handoff is missing. Follow another existing local layout only when
the dispatch explicitly supplies it.

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

Keep outputs separated by audience:

- Submission-facing source: `manuscript/manuscript.md`.
- Internal evidence and workflow records:
  `manuscript/citation-verification.md`,
  `manuscript/writing-readiness-report.md` for readiness and the full-draft argument map,
  `manuscript/revision-report.md` after revision or audit passes, and the
  immutable timestamped Writing handoff.
- Derived submission files: `manuscript/latex/` and
  `manuscript/manuscript.pdf`.

Create `manuscript/` only when an authorized deliverable or readiness report needs it. Keep `manuscript/manuscript.md` authoritative and LaTeX/PDF derived.

Markdown drafts may contain LaTeX math. A complete-paper request includes
derived LaTeX/PDF; a draft-, section-, or Markdown-only request does not. Use a
venue template only when the task identifies that venue; otherwise use a
suitable neutral layout without inventing a submission target.

## Manuscript And Internal Records

The submission-facing manuscript contains the title and supplied or venue-
required author metadata, abstract, scholarly sections, figures/tables and
captions, acknowledgments only when appropriate for the submission phase, and
the verified references actually cited by the paper.

Internal records contain readiness verdicts, evidence inventories, exact local
experiment/result/log paths, commands, `note_key` values, unresolved-reference
queues, changed-file lists, audit findings, correction ownership, and workflow
status. Put those details in the dedicated internal files and Writing handoff,
not in the title page, abstract, body, captions, acknowledgments, appendices, or
references.

Write manuscript limitations as scholarly limits of the method, evidence, or
external validity. Do not expose internal TODOs, missing-artifact checklists,
draft/readiness labels, or instructions to the user as paper content. A
reproducibility section or appendix describes the protocol and may name a real
public repository, DOI, archive, or submission supplement supplied for readers;
it never points readers to EasyResearch-local project paths.

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

Reconcile every central equation and algorithm step with the executed code and
saved configuration: tensors being transformed, normalization/reduction axes,
loss coefficients, training versus inference, and data used for selection.
An early proposal or a polished summary is not proof that a component was
implemented. Correct the description when implementation evidence is clear;
route scientific implementation errors or missing evidence to Experiment.

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
- Reproducibility details needed by readers: data and split definitions,
  preprocessing, model/training configuration, seeds, hardware/software, and
  code/data/supplement availability when a real reader-accessible location
  exists. Record the selected `<experiment-root>/results/` and
  `<experiment-root>/experiment-record.md` paths only in internal records and
  the Writing handoff.

Do not hide failed or underperforming settings if they are relevant to the claim.

## Result Table Formatting Rules
Make paper-facing tables easy for reviewers to parse.

Required table conventions:
- Label the proposed method as `<method name> (ours)` in every main performance, SNR, ablation, and paired-delta table where it appears.
- Bold the best value according to the metric's declared direction within each
  fair comparison group: highest for accuracy/F1, lowest for loss/error/latency.
  Mark direction in the header or caption and compare only like protocols.
- Treat exact ties consistently. If rounding hides a difference, increase
  precision or explain the tie; formatting does not establish significance.
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

Separately verify support for the adjacent claim in a readable source passage,
equation, table or figure. In `citation-verification.md`, record the citation's
purpose, intended manuscript location, source locator and support limits.
Metadata verification or a keyword match cannot establish scientific support.

If a citation cannot be verified, do not silently include it as a normal
reference. Record it in `manuscript/citation-verification.md`, not in the
submission-facing manuscript:

```markdown
## References Requiring Manual Verification

| Candidate | Reason verification failed | Evidence needed |
|---|---|---|
| <title or description> | <missing DOI, conflicting metadata, inaccessible page, etc.> | <stable metadata or source needed> |
```

Omit every unresolved candidate from manuscript citations and references and
rewrite the surrounding claim so it depends only on verified evidence. If the
authorized scope depends on that candidate, return `partial` or `blocked` and
put the required evidence in the Writing handoff rather than addressing the
user inside the paper.

Do not leave fake BibTeX entries, placeholder venues, or invented author lists in the draft.

## Claim Discipline
Every main scientific claim needs support from an actual experiment, ablation,
analysis or verified source passage, with its limits stated accurately.

Before a full draft, put a compact argument map in the existing
`manuscript/writing-readiness-report.md`. Record the research question, audience
or supplied venue, one evidence-bounded central contribution, and each section's
purpose. Use the following table to connect claims with their actual support:

```markdown
| Claim / question | Result or source locator | Code / config / figure locator | Counterevidence and limits | Manuscript location |
|---|---|---|---|---|
| <bounded claim> | <actual run/table or source passage> | <implementation and visual evidence, or not applicable> | <negative cases, uncertainty, untested conditions> | <section and purpose> |
```

If a claim has no evidence, weaken it or remove it.

A limitation bounds a claim; it is not positive evidence for that claim. Keep
planned experiments distinct from completed runs. Include relevant negative
results and all formal seed/ablation evidence, not only a selected winner.
For a section-only request, prepare only the relevant entries. For revisions,
update changed entries and preserve the evidence behind unaffected claims.

## Drafting Workflow

Before generating long prose, apply `specialist-handoff`'s Long Documents And
Interrupted Writes recipe. Save and verify one small section per call under a
unique `manuscript/.parts-writing-<UUID>/` workspace, then assemble locally and
inspect the draft before replacing the authoritative manuscript. After failure,
inspect existing pieces and resume missing sections. `write` overwrites; it is
not append. Keep temporary paths and recovery details out of manuscript prose.
Follow this order:
1. Check readiness and authority, read the writing guide, and build the argument
   map. Scope the work to the actual requested deliverable.
2. Read the accepted evidence directly. Reconcile code/configuration with the
   method, verify citation identity and claim support, and inventory real
   figures and their numeric sources. Resolve conflicts before writing claims.
3. Draft Method and Experimental Setup from the implementation and protocol.
   Explain why each design choice tests the question; equations formalize the
   actual operations rather than decorate the prose.
4. Draft Results from formal artifacts. For each main comparison, explain the
   question, controlled comparison, observed magnitude and uncertainty, and the
   bounded answer. Distinguish observations from proposed explanations.
5. Write Related Work by comparing mechanisms, assumptions and evaluation
   settings. Write Introduction around the supported gap and contribution;
   write Discussion/Limitations from counterevidence and untested conditions.
6. Write or revise the title and Abstract last. They summarize the completed
   study, including mixed outcomes, rather than the initial proposal.
7. Load the revision audit and perform the author revision passes below.
8. Inspect the assembled Markdown for coherence and internal-record leakage.
   Derive required LaTeX/PDF from this version, inspect the rendered deliverable,
   and verify that citations, numbers and conclusions still agree.

Do not spend large token budgets writing polished prose before the readiness gate passes.

## Author Revision Passes

Use at most three passes after the initial draft within the authorized budget.
Each pass reads the current manuscript and the evidence for its findings;
previous prose is not a substitute for original sources.

- **Evidence:** check method/code agreement, result values and direction,
  uncertainty, citation support, counterexamples and scope of conclusions.
- **Argument:** check whether sections answer the research question, comparisons
  establish the claimed difference, and paragraphs develop an explanation rather
  than repeat tables or generic motivation. Merge fragments and remove repetition.
- **Presentation:** check actual images, captions and their in-text discussion,
  notation, cross-references and required PDF rendering.

For each pass, fix concrete observed issues and recheck the affected claims.
Stop early when no actionable issue remains. Final artifact verification is
still required. If evidence or another owner's work is missing, preserve the
usable draft, narrow unsupported claims where possible, and report the gap.
Do not fabricate an experiment, alter its results, or start an unlimited polish
loop. These are author self-checks, not independent Review or acceptance scores.

Record self-check findings and supplied Review findings in
`manuscript/revision-report.md`:

| Finding ID | Owner | Disposition | Changed manuscript location | Evidence checked | Remaining action |
|---|---|---|---|---|---|
| <original Review ID or local self-check ID> | <responsible role> | <corrected / claim narrowed / unresolved / unreviewed> | <section, paragraph, equation, table or caption> | <exact source/result locator and check> | <owner action or none> |

Preserve supplied finding IDs and immutable Review reports. Correct only
Writing-owned artifacts. A removed claim can be recorded as narrowed while its
requested Experiment/Figures/Search task remains unresolved; never mark that
task completed by editing prose. Recheck that the recorded change actually
appears in the final artifact. A second independent Review is user-explicit.

## Self-Review Checklist
Before calling a draft usable, check:
- The paper uses "We" for authorial actions.
- The Method section contains complete formulas.
- The proposed model is described precisely enough to implement.
- Central formulas and algorithm steps agree with the executed code/configuration.
- Results are copied from actual experiment artifacts.
- Baseline comparison is fair and uses the same protocol.
- Ablations support the component-combination story.
- Unverified citations are isolated in `citation-verification.md` and omitted
  from the manuscript.
- Claims in Abstract and Introduction are supported by Results.
- Each main result has an interpretation and scope limit, not just a repeated number.
- Every included figure agrees with its caption, discussion and numeric source;
  visual checks actually performed are distinguished from unavailable checks.
- Limitations include weak datasets, failed settings, incomplete ablations, and external validity limits.
- The manuscript contains no workflow status, local project paths, internal
  verification queues, revision log, or instructions to the user.

## LaTeX And Venue Templates
Use `latex-pdf` for a complete paper and for explicitly requested TeX/PDF work.
Skip derived files when the user limits the output to a draft, section or
Markdown. Keep the same scholarly content and claim limits across formats.

Templates under `templates/` are candidates for a supplied venue, not evidence
of current venue rules. Use the task's verified requirements and available tools.

When converting Markdown to LaTeX:
- Keep the Markdown draft as the source working draft unless the user says otherwise.
- Compile after major section changes.
- Verify citations, figure paths, labels, and table formatting.
- Follow `latex-pdf`'s rendered-output inspection; compiling is not visual review.
- Do not modify venue `.sty` files.

## Useful References
Follow the required loading table above. Additional references:
- `references/reviewer-guidelines.md` for self-review and rebuttal framing.
- `references/checklists.md` for venue-specific checklists.
- `references/manuscript-revision-audit.md` for near-complete manuscript audits.

## Do Not Do
- **Do not draft the full manuscript or any complete section without explicit user consent.** Write readiness reports and gap analyses unless the user explicitly says "write the paper", "draft the manuscript", "start writing", or equivalent.
- Do not write full paper prose from incomplete toy experiments. If the user
  explicitly requests writing despite incomplete evidence, record every
  readiness gap in `writing-readiness-report.md` and the Writing handoff. Include
  only evidence-backed scholarly limitations in the manuscript; do not insert
  TODOs, missing-artifact notes, or workflow status.
- Do not treat exploratory runs in `outputs/` as formal evidence unless promoted or clearly justified.
- Do not use `This paper ...` as the default voice.
- Do not produce a prose-only Method section for a model paper.
- Do not include unverifiable citations as normal references.
- Do not commit, push, or create git history unless the user explicitly asks.
