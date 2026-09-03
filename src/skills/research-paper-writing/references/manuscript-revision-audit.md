# Manuscript Revision Audit: References, Figures, and Tables

Use this reference when revising or re-reviewing a near-complete research manuscript after user/reviewer feedback about citations, method completeness, figure readability, figure redundancy, or table organization.

## Class of task

A near-complete empirical research manuscript needs an iterative revision and audit pass focused on citation integrity, method sufficiency, figure/table readability, redundancy reduction, and final artifact consistency.

## Workflow

1. **Preserve prior drafts**
   - Keep `manuscript/manuscript.md` as the one authoritative source. Preserve a
     prior snapshot only when the task explicitly requires one; never leave an
     ambiguous alternate final manuscript.
   - Write changed files, main structural edits, figure/table reductions, and
     unresolved caveats to `manuscript/revision-report.md`, not into the paper.

2. **Verify references mechanically**
   - Parse reference IDs and check the reference list sequence is continuous.
   - Expand citation ranges such as `[R7]-[R9]` before deciding whether a reference is uncited.
   - Check that every in-text citation has a matching reference and that every reference is cited after range expansion.
   - Spot-check URLs/DOIs. Treat publisher 403/418/connection-reset responses as inconclusive rather than automatically broken; remove or replace definite 404/broken URLs.
   - Never leave known-broken file-hosting links in references. If no stable URL is available, keep standard bibliographic metadata without the bad URL.

3. **Check method-section sufficiency**
   - Avoid many tiny method subsections; merge into a few coherent sections.
   - For empirical ML methods, include explicit notation/formulas for data splits, model outputs, predictions/pseudo-labels, selection rules, augmentation/noise generation, losses, total objective, and algorithm/pseudocode when relevant.
   - State leakage-prevention rules explicitly in prose and, when central to the claim, in the algorithm and figure captions.

4. **Audit figures for body worthiness**
   - Count inline/body figures and identify redundancy with tables.
   - Keep only figures that communicate structure or trends better than tables: e.g., core architecture/pipeline and one primary result trend.
   - Move diagnostics such as confusion matrices, PCA plots, per-class breakdowns, pseudo-label histograms, or long case studies to appendix/supplement unless they are essential evidence.
   - Use `vision_analyze` on generated figures or PNG previews to assess text size, layout, colorbar labels, caption needs, and whether the figure remains readable at likely journal column width.
   - For SVG figures, validate XML and render a PNG preview with `rsvg-convert` or equivalent before judging readability.
   - Captions should define abbreviations, arrow semantics, colorbar units, averaging/seeds, and whether deltas are fractions or percentage points.

5. **Audit tables**
   - Put major numeric evidence in compact tables when exact values matter more than visual trends.
   - Ensure table captions appear in first-use numeric order; do not allow Table 7/8/9 to appear before Table 5/6.
   - Round consistently: accuracy/F1/deltas to 3–4 decimals or percentage points as appropriate, pseudo counts to ~1 decimal, confidence to ~3 decimals, params as integers, train time to 1–2 decimals.
   - Move long per-class or per-case diagnostic tables to supplement.

6. **Verify final artifacts**
   - Confirm referenced figure/table files exist.
   - Re-run a quick script to list body figure count, body table order, method equation count, missing citations/references, broken known URLs, and terminology consistency.
   - Save the Writing-owned audit output in `manuscript/revision-report.md` with
     a clear verdict and remaining formatting-only caveats. An independent
     Review report remains owned by the Review Agent under `reviews/`.

## Artifact Boundary

The revised manuscript contains only submission-facing scholarly content. Keep
the changed-file inventory, audit checklist/results, local artifact paths,
unresolved-verification queue, correction ownership, and readiness verdict in
`manuscript/revision-report.md` and the Writing handoff. Resolve unsupported
paper claims, omit them, or express their evidence-backed scientific limitation;
never convert an internal audit note or TODO into manuscript prose.

## Useful checks

- Citation sequence and range expansion:
  - Extract reference IDs with a regex like `^\[R(\d+)\]` or BibTeX keys from the bibliography.
  - Expand ranges before computing uncited references.
- Figure inventory:
  - Extract Markdown images with `!\[...\]\((...)\)` or LaTeX `\includegraphics`.
  - Check files exist relative to the paper directory.
- Table order:
  - Extract captions and first mentions; compare first-use order with numeric order.
- SVG preview:
  - `rsvg-convert -w <width> -h <height> figure.svg -o figure_preview.png`
