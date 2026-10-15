# Manuscript Revision Audit

Read before finalizing a draft or acting on reviewer feedback. Use the parent
Skill's bounded author revision passes, authority and artifact conventions.
This is Writing's self-check and correction procedure, not independent Review.

## Establish the correction scope

Read the current authoritative manuscript, its argument/evidence map, and any
exact Review report supplied by the caller. Preserve original finding IDs and
their owners. Identify which findings affect claims, which affect presentation,
and which require missing evidence or another owner's source changes.

Keep the usable manuscript until its replacement is assembled and inspected.
Use `specialist-handoff`'s long-document recipe for long revisions. Record
changes in the existing `manuscript/revision-report.md`; do not leave multiple
ambiguous final manuscripts or modify an immutable Review report.

## Check scientific consistency first

1. Compare central method statements, equations and algorithm steps with the
   actual executed code/configuration. Check the object of each operation,
   dimensions, coefficients, reduction axes, split usage and selection protocol.
2. Trace reported values to formal result files and their run identities. Check
   metric direction, units, paired comparisons, actual seed counts and the
   definition of uncertainty. Distinguish mean, sample SD, SE and confidence
   intervals. Recalculate descriptive summaries when the records permit it;
   route new experiments or inferential analyses to Experiment.
3. Check title, abstract, contribution statements and conclusion against those
   results. Keep relevant failures, mixed effects and boundary conditions.
   A non-significant comparison does not establish equivalence or no effect.
4. Recheck citation identity and support for changed claims using
   `citation-workflow.md`. A syntactically valid reference or matching keyword
   is not evidence that the source supports the interpretation.

Correct a description when the evidence establishes the intended correction.
If the implementation or scientific evidence itself is wrong or incomplete,
preserve that gap for its owner. Editing the prose must not conceal it.

## Check the argument and prose

Read the assembled paper as a reader, not only as separate sections. Check that
the question motivates the method, comparisons test the stated question, and
results justify the contribution. Each main result should explain a comparison,
observation, interpretation and scope limit.

Merge one- or two-sentence subsections when they fragment one idea. Replace
table-by-table narration with analysis, remove repeated motivation, define
symbols before use and keep terminology consistent. Preserve evidence-qualified
language when improving fluency. Equations should describe the actual method;
counting them is not a sufficiency test.

## Audit figures with their captions and discussion

For each included figure:

1. Locate the actual export, source/plotting code and data needed to understand
   it. Render SVG/PDF to a supported image if necessary using an available
   local renderer and the platform-native shell.
2. Use the available image-capable `read` tool or an authorized browser image
   view to inspect the pixels at the intended reading size. If the model or
   tools cannot inspect images, record the visual check as unreviewed.
3. Read the caption and relevant manuscript paragraphs alongside the image.
   Confirm axes, units, legend mappings, trend direction, averaging, error bars,
   selected cases and the numerical basis for each interpretation.
4. Check that the caption identifies the setting and uncertainty and that the
   text explains the figure's contribution to the argument. Flag missing or
   exaggerated interpretations rather than inventing one from the title.
5. Check readability, clipping, color/line distinguishability and duplication
   with other figures or tables. Combine related panels only if readable; move
   supporting detail to the appendix without hiding counterevidence.

Figures owns changes to figure sources/exports. Writing owns selection,
placement, captions and discussion. A misleading plot should be corrected by
its owner, not explained away in a caption. Keep a clear table instead of a
redundant plot when exact numbers carry the evidence. There is no fixed figure
quota or blanket ban on synthetic-data or diagnostic figures.

## Audit tables and references

- Select bold best values using each metric's declared direction within fair
  comparison groups. Preserve uncertainty, seed counts, units and paired signs.
- Resolve ties consistently; distinguish percentage points from relative
  percentages. Use enough precision to preserve meaningful comparisons.
- Check table/figure numbering and first-use references after moves or merges.
- Check every citation key, including ranges, captions and appendices, against
  the bibliography. Verify the claims as well as mechanical key coverage.
- Treat access failures as unresolved access, not proof of nonexistence. Replace
  a demonstrably broken link with a verified stable source when available.
- Keep detailed settings and supporting tables in a referenced appendix when
  appropriate. The main paper must still expose evidence that changes its answer.

## Verify and record the correction

Use the parent Skill's revision table: finding ID, owner, disposition, changed
location, evidence checked, remaining action. Give exact internal source/result
locators so the caller can verify the correction. Re-read each changed location
and its dependencies before marking it corrected.

For example, removing an unsupported unseen-condition claim can correct a
Writing wording issue while an Experiment request to test that condition stays
unresolved. Record both outcomes. Do not silently close another owner's finding,
claim an independent re-review, or replace the reviewer's original report.

Record unreviewed scope separately from unresolved scientific defects. Stop at
the authorized scope/budget; return usable work and the precise remaining owner
action when another correction cannot be completed here.

## Final artifact checks

Confirm referenced artifacts exist and the assembled manuscript is complete.
Keep claims, numeric values, citations and notation consistent across Markdown
and derived TeX. Use `latex-pdf` to compile and inspect the actual final PDF when
that deliverable is requested. After a layout change, inspect affected pages
and downstream figure/table/reference placement again.

Distinguish build success, mechanical source checks, visual inspection and
scientific evidence checks in `revision-report.md`. Do not mark an unavailable
check as passed. Internal findings, paths, status, owner actions and verification
queues stay in that report and the handoff, not the manuscript or its appendix.
