---
name: survey-paper-writing
description: |-
  Use when Writing must assess, outline, draft, revise, or complete a survey, review, tutorial, or literature-synthesis paper from a verified multi-paper material package, especially when the contribution is a taxonomy, comparative synthesis, coverage map, or research agenda rather than a new experimentally evaluated method.
license: MIT
metadata:
  hermes:
    tags: [research, survey, review-paper, taxonomy, synthesis, citations]
    category: research
    related_skills: [paper-material-package, research-project-workflow, research-paper-writing, arxiv, latex-pdf]
---

# Survey Paper Writing

## Scope

Use this Skill for a survey, review, tutorial, or literature-synthesis
manuscript. The core contribution is evidence-backed organization and synthesis
across papers. Do not require baselines, a proposed model, five seeds, or
ablations unless the requested survey includes an original benchmark or other
empirical study.

Use `research-paper-writing` for an empirical method paper. Use
`paper-material-package` through Search when the source package is missing or
does not support the requested coverage. Never invent a citation, result,
taxonomy assignment, or field-wide conclusion.

## Required Inputs

Inspect these exact-cwd artifacts:

- `ref_papers/source.json`
- `ref_papers/paper-notes.md`
- selected readable sources under `ref_papers/text/` and PDFs when needed
- existing files under `manuscript/`
- the topic, review scope, expected paper count, date/source constraints, target
  audience or venue when supplied, and drafting authority carried by dispatch

Follow another existing layout only when the dispatch explicitly identifies it.

## Survey Readiness Gate

Draft survey prose only when all required conditions hold or the dispatch
records an explicit accepted limitation:

- The intended review scope and exclusions are clear enough to judge coverage.
- The material package meets the expected paper count, or the accepted shortfall
  and its consequence are explicit.
- `source.json` and `paper-notes.md` have one-to-one stable `note_key` coverage.
- Papers used for substantive claims have complete factual cards and readable
  sources with evidence locators.
- Foundational work and relevant recent work are represented for the stated
  scope; frontier-only search results are not presented as field-complete.
- Bibliographic metadata and planned citation keys are verified.
- The dispatch explicitly authorizes the requested full draft or section. An
  initial request to complete the survey counts as full-draft authority.

Partial cards may remain as metadata-only context, but do not use them to support
claims beyond their available evidence. If the gate fails, write
`manuscript/writing-readiness-report.md` with the verdict, usable coverage,
blocking gaps, a targeted Search request, and the drafting scope currently safe.

## Review Orientation

Infer the orientation from the request and evidence:

- **Technical/narrative survey:** emphasize taxonomy, mechanisms, comparisons,
  development history, limitations, and open problems.
- **Systematic/scoping review:** additionally preserve reproducible queries,
  sources, dates, deduplication, inclusion/exclusion rules, screening counts,
  and reasons for exclusion. Do not claim PRISMA or another reporting standard
  unless its required records actually exist.
- **Tutorial survey:** add a pedagogical progression, formal background,
  implementation guidance, and worked examples supported by sources.
- **Hybrid survey with benchmark:** keep literature synthesis and original
  experiment evidence separate; apply the empirical readiness requirements from
  `research-paper-writing` only to benchmark-derived claims.

## Durable Survey Plan

Before drafting, create or update `manuscript/survey-plan.md`:

```markdown
# Survey Plan

## Scope And Orientation
Topic, audience, review type, date/source bounds, included and excluded areas.

## Material Readiness
Requested/selected/complete counts, source coverage, accepted gaps.

## Candidate Taxonomies
### Candidate A
Axes, categories, assignment rule, strengths, weaknesses.
### Candidate B
...

## Selected Taxonomy
Chosen axes and categories, selection rationale, overlap policy, edge cases.

## Paper Coverage Matrix
| note_key | primary category | secondary category | role in survey | evidence status |

## Final Outline
Each section/subsection with purpose, covered categories, and planned sources.

## Claim-Source Plan
| planned claim or comparison | supporting note_keys and locators | manuscript section | status |

## Coverage Gaps And Limits
Missing areas, partial sources, search bias, date/venue/language limits.
```

Generate at least two meaningfully different candidate taxonomies before
selecting one. A cosmetic renaming of the same categories is not a different
candidate. Prefer axes that explain methodological or problem differences.
Allow secondary categories when real methods overlap, but require one primary
placement or an explicit cross-cutting designation. Every included paper must
appear in the coverage matrix; unexplained clusters and empty categories must be
fixed before drafting.

The included set is every selected `source.json` entry that satisfies the
accepted review scope. Do not silently omit a selected paper to shrink the
coverage matrix; record an explicit exclusion with its reason or return the
coverage incomplete.

## Drafting Workflow

1. Pass the survey readiness gate and create the durable survey plan.
2. For each subsection, select relevant `note_key` entries, then inspect their
   readable sources at the recorded locators before writing claims.
3. Write synthesis rather than a sequence of paper summaries: explain category
   logic, compare mechanisms and assumptions, separate comparable from
   incomparable evidence, and expose tradeoffs and contradictions.
4. Attach stable citation keys while drafting. Do not use temporary paper-title
   placeholders that require fragile global replacement later.
5. Update the claim-source plan as claims change. A strong claim needs direct
   source support; a field-wide claim needs representative coverage, not one
   paper.
6. Validate every citation against both metadata and the source passage that
   supports the adjacent claim. Remove, weaken, or qualify unsupported claims.
7. Run a coherence pass across adjacent sections. Preserve citation keys,
   numeric values, category assignments, and limitations while removing
   repetition and abrupt transitions.
8. Recheck recent coverage before final delivery when the search period extends
   to the present.

Do not impose arbitrary subsection word counts. Length follows the evidence,
venue, audience, and user request.

## Default Manuscript Structure

Adapt this structure to the selected orientation:

```markdown
# Title

## Abstract
## 1. Introduction
## 2. Scope And Review Method
## 3. Background And Problem Formulation
## 4. Taxonomy Overview
## 5-N. Category Synthesis
## Cross-Category Comparison And Discussion
## Open Problems And Research Directions
## Limitations Of This Survey
## Conclusion
## References
## References To Verify Manually
```

For a technical field, include notation and equations when they materially
clarify shared assumptions or method differences. A survey does not need a
formula-rich proposed Method section merely to imitate an empirical paper.

## Citation Verification

Maintain `manuscript/citation-verification.md`:

```markdown
# Citation Verification

| citation key | verified metadata source | claim or comparison | evidence locator | verdict | action |
|---|---|---|---|---|---|
```

Verdicts are `supported`, `partially-supported`, `unsupported`, or
`metadata-only`. Resolve every `unsupported` item before completion. Keep
unresolvable candidates under `References To Verify Manually`; do not include
them as ordinary support.

## Figures, LaTeX, And PDF

Dispatch Figures for a taxonomy diagram, timeline, workflow, or comparison
visual only when its categories and values already exist in accepted artifacts.
Keep `manuscript/manuscript.md` authoritative. A request for a complete survey
paper includes derived LaTeX/PDF by default unless the user explicitly limits
the deliverable to a draft, section, or Markdown. Derive files under
`manuscript/latex/`, generate verified BibTeX, and use `latex-pdf` to produce
`manuscript/manuscript.pdf` and inspect build/citation warnings.

## Completion

Complete when the authorized survey scope has:

- a readiness-supported `survey-plan.md` with meaningful candidate taxonomies,
  complete coverage matrix, final outline, and claim-source plan;
- an authoritative manuscript that synthesizes rather than lists papers;
- verified citation metadata and claim support, with uncertainty isolated;
- explicit survey coverage limitations and no hidden partial-source claims; and
- every requested derived LaTeX/PDF or figure deliverable verified.

Return `partial` when a useful plan or draft exists but coverage, citation
support, requested sections, or derived outputs remain incomplete. Return
`blocked` when progress requires unavailable source evidence, drafting
authority, a consequential scope decision, or another dependency Writing cannot
derive; include one user-owned `required_user_input`, or `none` when no user
action can resolve the failure.
