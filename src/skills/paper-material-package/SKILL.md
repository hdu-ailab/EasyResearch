---
name: paper-material-package
description: |-
  Use when Search must turn a selected paper set into a durable, human-readable material handoff for survey writing, experiment design, related-work analysis, or citation checking, especially when ref_papers/source.json and converted full text already exist but downstream agents need verified per-paper facts and evidence locators.
license: MIT
metadata:
  hermes:
    tags: [research, papers, material-package, evidence, paper-notes]
    category: research
    related_skills: [paper-search, arxiv, pdf-to-markdown, survey-paper-writing, experiment]
---

# Paper Material Package

## Purpose

Create `ref_papers/paper-notes.md` as the readable handoff between Search and
downstream specialists. Keep each paper separate and factual so Writing can
build cross-paper taxonomy and synthesis without guessing what the sources say.

This Skill does not search for candidates, verify metadata by itself, download
PDFs, or convert documents. Use `paper-search`, `arxiv`, and
`pdf-to-markdown` first. It does not write a literature review, compare papers
across the collection, choose a taxonomy, or draft manuscript prose.

## Inputs

Inspect these exact-cwd artifacts when available:

- `ref_papers/source.json`
- `ref_papers/pdf/`
- `ref_papers/text/`
- an existing `ref_papers/paper-notes.md`
- the dispatch topic, inclusion scope, and expected paper count

Follow another existing layout only when the dispatch explicitly identifies it.
Do not infer paper facts from search snippets when readable source text exists.

## Stable Paper Keys

Give every selected paper one stable key, using the first available value:

1. arXiv id, including version only when version-specific evidence matters;
2. DOI;
3. OpenReview forum id;
4. another verified repository identifier;
5. a short normalized title key when no stable identifier exists.

Store the key as `note_key` on the matching `source.json` entry and use it in
note headings, citation checks, and later Writing tasks. Preserve every existing
manifest field. Do not invent an identifier.

## Output Contract

Maintain one file at `ref_papers/paper-notes.md`:

```markdown
# Paper Material Notes

## Material Scope
- Topic:
- Intended use: survey | empirical | hybrid | citation-only
- Requested paper count:
- Selected paper count:
- Full-text-ready count:
- Sources and date range:
- Known coverage gaps:

## <stable-key>: <verified title>
- Citation metadata: <authors; year; venue; DOI/arXiv/OpenReview URL>
- Local sources: <PDF path; readable text path>
- Material status: complete | partial
- Research question: <what problem the paper addresses>
- Method: <factual mechanism or study design>
- Data and evaluation: <datasets, tasks, baselines, metrics, protocol>
- Main findings: <results supported by the source>
- Limitations: <reported or directly evidenced limitations>
- Topic relevance: <why this paper belongs in the requested material set>
- Evidence locators:
  - <section/page/table/figure/text heading>: <fact supported there>
- Unresolved material gaps: <none or exact missing evidence>
```

Repeat the paper section in the same order as `source.json`. Preserve useful
existing notes when refreshing the package, but correct them when current source
evidence or verified metadata disagrees.

For a partial card, keep every field and write `unavailable` or `not established
from available material` rather than omitting the field or guessing. `Local
sources` lists only paths that actually exist. `Unresolved material gaps`
states exactly what would make the card complete.

## Evidence Rules

- Read the available converted text deeply enough to fill the card. Open the PDF
  when layout, equations, figures, tables, or conversion quality make the text
  ambiguous.
- Keep findings quantitative when the paper reports quantities; preserve metric
  direction, dataset, comparison target, and evaluation setting.
- Evidence locators identify where a downstream specialist can verify the fact.
  Prefer section plus page, table, figure, appendix, or converted-text heading.
- Do not fabricate page numbers for conversions that do not preserve pagination.
  Use the strongest locator actually available and record the limitation.
- Distinguish author-reported limitations from limitations inferred directly
  from the documented setup. Do not add speculative criticism.
- Metadata verification is not claim verification. A verified title and DOI do
  not prove that the paper supports a method or result statement.
- Search snippets and abstracts may support candidate selection, but a card based
  only on them is `partial` and says that full-text verification is missing.

## Collection Boundary

Each card describes one paper only. Collection-level conclusions belong to
Writing. Do not add sections such as common themes, taxonomy, consensus,
contradictions, research gaps, best methods, or future directions. Listing a
paper's own stated limitation is allowed; inferring a field-wide gap is not.

## Completion

The material package is `complete` when:

- the dispatch states the requested paper count for a survey, and the selected
  count satisfies it or every shortfall is an accepted scope decision;
- each selected `source.json` entry has one matching card;
- every card required as evidence by the dispatch is complete, with verified
  metadata, readable local source paths,
  substantive factual fields, and usable evidence locators;
- `paper-notes.md` contains no cross-paper synthesis or manuscript prose.

Keep inaccessible or unreadable sources as explicit partial cards rather than
dropping them. Their presence makes the package `partial` unless the dispatch
explicitly accepts those papers as metadata-only context and no downstream
claim depends on them. Return `partial` when usable cards exist but count,
access, conversion, or source support remains incomplete. Return `blocked` only
when progress requires access, permission, scope, or source material unavailable
to Search; include one `required_user_input` that the caller cannot derive from
existing artifacts, or `none` when no user action can resolve the failure.
