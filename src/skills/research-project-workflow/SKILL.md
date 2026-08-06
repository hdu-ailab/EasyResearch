---
name: research-project-workflow
description: |-
  Orchestrate a full ML/AI paper project from user idea to literature package, model-driven or problem-driven research route, readable paper notes, experiment workspace, model-component recombination, formal results, and final Markdown draft. Use proactively as the first skill when the user asks to write a paper, start a publishable research project, turn papers into experiments, or organize the full workflow across paper-search, arxiv, experiment, and research-paper-writing.

  Examples:
  - user: "I want to write a paper on fault diagnosis" then create the workspace, collect papers, convert PDFs to readable text, and start experiment planning
  - user: "Help me turn these papers into a model idea" then read converted references, extract components, and hand off to experiment
  - user: "Now write the manuscript" then verify experiments are complete and hand off to research-paper-writing
license: MIT
metadata:
  hermes:
    tags: [research, workflow, papers, experiments, manuscript, orchestration]
    category: research
    related_skills: [paper-search, arxiv, pdf-to-markdown, experiment, research-paper-writing]
---

# Research Project Workflow

## Purpose
Use this skill as the top-level workflow when the user asks for a paper-oriented research project, not just a single paper search, single experiment, or single manuscript edit.

This skill decides the order of work and when to hand off to other skills:
- `paper-search`: collect candidate papers.
- `arxiv`: verify arXiv metadata, BibTeX, and citation details.
- `pdf-to-markdown`: convert public or user-provided PDFs into readable Markdown.
- `experiment`: build baselines, recombine model components, run experiments, and promote formal results.
- `research-paper-writing`: write or revise the manuscript only after experimental evidence is ready.

## Workspace Layout
Create or maintain this project-level workspace:

```text
workspace/
  experiments/
  ref_papers/
    pdf/
    text/
    source.json
  draft/
```

Directory rules:
- `experiments/`: experiment root. Apply the `experiment` skill here, so it contains `.venv/`, `src/`, `outputs/`, `results/`, `logs/`, `datasets/`, and `experiment-record.md`.
- `ref_papers/pdf/`: publicly accessible PDFs only. Do not bypass paywalls, logins, captcha, or institutional access.
- `ref_papers/text/`: converted Markdown or plain-text versions for agent reading.
- `ref_papers/source.json`: machine-readable manifest for all candidate and selected papers.
- `draft/`: manuscript drafts and writing reports. Create this only after the writing readiness gate is close to passing or when the user explicitly asks for a preliminary outline.

If the user already has a different workspace path, adapt the names but preserve the same separation of references, experiments, and drafts.

## Phase 1: Clarify The Paper Goal
If the topic is vague, ask one short question about the target task or domain.

Extract:
- Research topic or application domain.
- Target paper type, if known.
- Preferred dataset/domain constraints, if any.
- Whether the user wants a safe applied paper, a stronger novelty attempt, or an exploratory research direction.

Do not ask for a venue unless venue constraints will immediately affect the work.

## Phase 1.5: Choose The Research Route
Choose one primary route before deep experiment planning. Both routes are valid and can later merge.

### Model-Driven Route
Use this route when there is a strong, reproducible top-conference, top-journal, or widely recognized model for the target task.

Process:
- Collect recent literature from the last 3 years, mainly top conferences/top journals plus lower-tier or application-oriented journal papers.
- Choose a strong top-tier or authoritative model as the baseline.
- Inspect lower-tier, application-oriented, or adjacent papers for modules that may address unresolved problems in the domain.
- Mentally pre-screen combinations before coding: ask what problem the added module might help with, such as robustness, small-sample learning, cross-domain transfer, class imbalance, noisy labels, efficiency, or feature redundancy.
- Test whether the enhanced baseline is stronger or more useful than the original baseline.
- If stronger, run complete experiments and write the paper around the problem the enhanced model solves.

### Problem-Driven Route
Use this route when the user cares more about a domain problem than a specific baseline model.

Process:
- Collect and read recent literature from the last 3 years, plus older foundational papers if needed.
- Summarize recurring problems reported by authors, especially limitations, failure cases, weak ablations, cross-dataset failures, noise sensitivity, data scarcity, or deployment constraints.
- Convert each problem into measurable evidence: metric, dataset condition, robustness setting, efficiency target, or qualitative diagnostic.
- Combine models or modules from different papers to address one or more of those problems.
- Compare the new model against a strong baseline under the same protocol.
- If the new model is more effective, run complete experiments and write the paper around the solved problem.

Route rule:
- Do not treat novelty as simply adding modules. The paper story should be problem, mechanism, combination, evidence.
- The hypothesis may be about a combination, not every individual module. Some modules may be weak alone but beneficial through interaction with another module.

## Phase 2: Literature Collection
Use `paper-search` to collect candidate papers.

Recommended search process:
- Run 2-5 searches: one direct topic query and several adjacent subtopic queries.
- Prefer papers from the last 3 years, but include older foundational baselines when relevant.
- Include both high-standard papers and lower-tier/application-oriented papers: top papers provide strong baselines and standards, while lower-tier/application papers often contain practical modules, variants, and problem-specific tricks worth testing.
- Save the candidate list into `ref_papers/source.json`.
- Mark selected papers for deep reading.

`source.json` should contain records like:

```json
{
  "query": "fault diagnosis domain adaptation",
  "title": "...",
  "authors": ["..."],
  "year": 2026,
  "venue": "...",
  "source": "arxiv/openreview/publisher",
  "paper_url": "https://...",
  "pdf_url": "https://...",
  "local_pdf": "ref_papers/pdf/name.pdf",
  "local_text": "ref_papers/text/name.md",
  "status": "candidate/selected/read/used",
  "notes": "..."
}
```

Use `arxiv` for exact metadata, BibTeX, and citation checks after candidate papers are found.

## Phase 3: PDF Download And Text Conversion
Download only publicly accessible PDFs or user-provided PDFs.

Use the global `pdf-to-markdown` skill for conversion. It wraps a local Microsoft MarkItDown CLI (see that skill's `{{MARKITDOWN_BIN}}` placeholder).

Default command:

```bash
markitdown ref_papers/pdf/paper.pdf -o ref_papers/text/paper.md
```

If shell aliases are unavailable, use the absolute path:

```bash
{{MARKITDOWN_BIN}} ref_papers/pdf/paper.pdf -o ref_papers/text/paper.md
```

After conversion:
- Verify that the text is readable.
- If extraction is poor, record the issue in `source.json` and use abstract/sections that are available from HTML or arXiv pages.
- If MarkItDown output is unusable, fallback options are `pdftotext -layout`, `pymupdf4llm`, `docling`, or `marker-pdf`, in that order of increasing complexity.
- Do not spend excessive time perfecting PDF conversion before the key papers are identified.

## Phase 4: Read Papers And Extract Components
Read converted texts from `ref_papers/text/`, not only abstracts.

For each selected paper, extract:
- Task and problem setting.
- Datasets and split protocol.
- Baselines.
- Reported problems, limitations, and failure cases.
- Model components.
- Purpose of each component.
- Training strategy, losses, augmentation, or domain adaptation.
- Main metrics and reported limitations.

Create a problem map before or alongside the component map:

```markdown
| Problem | Evidence in papers | Measurable test | Candidate baseline | Candidate modules |
|---|---|---|---|---|
| Cross-domain degradation | A and B report poor target accuracy | source-to-target accuracy/F1 | top-tier model A | pseudo-labeling, alignment loss |
| Noise sensitivity | C fails under low SNR | noisy test accuracy | model B | denoising block, augmentation |
```

Create a component map before model design:

```markdown
| Paper | Component | Purpose | Reusable? | Risk | Candidate combination |
|---|---|---|---|---|---|
| A | multiscale CNN block | local pattern extraction | yes | may overfit | combine with B's selector |
| B | confidence-balanced pseudo-labeling | target adaptation | yes | label noise | combine with A's backbone |
```

Treat model innovation as systematic recombination of paper components plus experimental evidence, not as spontaneous invention.

Build candidate combinations from either direction:
- Model-driven: strong baseline plus selected modules.
- Problem-driven: unresolved problem plus compatible modules and baseline.

## Phase 5: Experiments
Hand off to `experiment` with `workspace/experiments/` as the experiment root.

Required order:
- Select 2-5 authoritative datasets from the literature.
- Run baselines on 1-2 complete datasets first.
- Try component-combination candidate models on the same 1-2 complete datasets.
- Evaluate combinations as combinations. Do not reject a module solely because it is weak alone if the full combination improves the target problem.
- Compare against the strongest baseline.
- Run ablations for promising combinations.
- Expand to more datasets only after the proposed model beats the strongest baseline or shows a meaningful innovation.
- Keep all raw outputs in `experiments/outputs/` and only formal outputs in `experiments/results/`.
- Update `experiments/experiment-record.md` after every run.

Do not create a full manuscript draft during this phase. If the user asks for writing early, produce an outline or writing-readiness report only.

## Phase 6: Writing Readiness Check
Before creating `draft/` or writing manuscript prose, verify:
- Strong baseline results exist.
- Proposed model results exist on the same initial datasets.
- The comparison against the strongest baseline is recorded.
- Core ablations are complete or explicitly listed as missing.
- Dataset splits, metrics, seeds, and protocols are documented.
- No known leakage affects the formal results.

If this check fails, call `research-paper-writing` only to produce a writing-readiness report, not a full paper body.

## Phase 7: Manuscript Draft
After experiments are ready, create `workspace/draft/` and hand off to `research-paper-writing`.

Default draft output:
- `draft/manuscript-draft.md`
- `draft/citation-verification.md`
- `draft/revision-report.md` when revising

Writing rules:
- Markdown by default unless the user explicitly requests LaTeX.
- Use first-person plural: "We propose", "We evaluate", "Our method".
- Require a formula-rich Method section.
- Use only verified citations in the main References.
- Put uncertain citations in a manual-verification list.

## Phase Gate Summary
- Literature not collected: use `paper-search` and `arxiv`.
- Papers collected but not readable: download/convert public PDFs into `ref_papers/text/`.
- Papers read but no route/problem map: choose model-driven or problem-driven route and build problem/component maps.
- Papers read but no baselines: use `experiment` to run baselines first.
- Baselines done but proposed model incomplete: continue `experiment`.
- Proposed model promising but no ablations: run ablations before full writing.
- Formal results complete: use `research-paper-writing` to draft in `draft/`.

## Do Not Do
- Do not write a full manuscript from a few toy experiments.
- Do not let `draft/` become a dumping ground for experiment artifacts.
- Do not place exploratory outputs in `experiments/results/`.
- Do not include unverified citations as normal references.
- Do not bypass paywalls or access restrictions to download PDFs.
