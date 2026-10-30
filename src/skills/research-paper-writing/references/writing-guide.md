# Evidence-Grounded Manuscript Writing

Read before drafting or substantially rewriting an empirical paper. Use the
parent Skill for authority, readiness, artifact paths and owner boundaries.
The goal is a coherent scholarly argument whose technical claims can be checked
against the completed study.

## Contents

- [Build the argument](#build-the-argument)
- [Write each section for its purpose](#write-each-section-for-its-purpose)
- [Explain results](#explain-results)
- [Calibrate scope and author concerns](#calibrate-scope-and-author-concerns)
- [Integrate figures and tables](#integrate-figures-and-tables)
- [Revise paragraphs and sentences](#revise-paragraphs-and-sentences)
- [Check the assembled paper](#check-the-assembled-paper)

## Build the argument

Start with the accepted evidence, including inconvenient results. Identify:

1. The specific question and why answering it matters to the intended reader.
2. The closest existing approaches and their demonstrated limitations in this
   setting. Use source passages, not a generic claim that prior work is inadequate.
3. What was actually changed, tested or learned, relative to those approaches.
4. Which comparisons distinguish the proposed explanation from alternatives.
5. The strongest conclusion that remains true across the reported evidence.

Write that conclusion in one sentence for the internal argument map. Give each
section a job in establishing it, with supporting sources, results, figures and
limits. A negative result, replication, controlled comparison or useful boundary
condition can be the contribution; it need not be a new architecture.

Describe combinations, extensions and replications accurately. Use "combine"
when components are combined and "extend" when a known method is extended.
Explain the substantive difference and its evidence. Stronger verbs cannot
turn an incremental change into a new mechanism. Claims such as "first",
"universal" and "state of the art" require correspondingly broad evidence.

Use the requested paper type, audience and verified venue requirements to choose
length and structure. A workshop page limit, fixed number of figures or one
conference's contribution-list convention is not a universal writing rule.

## Write each section for its purpose

### Title

Name the actual object of study and the useful distinction or finding. Match
the scope of the evidence. Replace a proposal title when experiments change
the conclusion. Avoid advertising a mechanism or application that was not tested.

### Abstract

Write or revise it after the other sections. Unless the venue requires a
structured abstract, use one connected paragraph covering:

- the concrete question or gap;
- the implemented approach or investigation;
- the evaluation setting and important comparator;
- the main observed result, with a meaningful number when supported;
- the bounded implication, including a material mixed or negative outcome.

Keep every result and qualifier consistent with Results. A method description
without findings reads like a proposal; a list of favorable numbers without
conditions overstates the study. Avoid generic openings that could introduce
almost any machine-learning paper. Do not introduce new evidence in the abstract.

### Introduction

Develop a causal sequence in the explanation, without claiming scientific
causality that the study does not establish: relevant problem → specific
limitation supported by literature → research question → approach → findings
and contribution. Explain why the question is worth testing before presenting
technical details.

Make the contribution concrete and checkable. If a short contribution list
helps navigation, each item names a distinct result, method or insight and its
scope. "Extensive experiments" alone is not a finding. State material mixed
outcomes precisely when they change the central message, rather than adding a
generic disclaimer about the method's value.

### Related Work

Organize around approaches, assumptions or competing explanations rather than
one paragraph per paper. For each relevant group, explain its problem setting,
mechanism, evidence and relationship to the present study. Cite the original
method, dataset or optimizer when that is the object being attributed.

Separate conceptual similarity from empirical comparability. Different splits,
metrics, data or compute budgets do not support a direct numerical ranking.
Identify the closest work explicitly and explain the supported difference.
Read the passage behind each comparison; a title or abstract keyword is not
proof of the claimed relationship.

### Background and Method

Include only background needed to understand the question and method. Define
the task, input/output spaces and notation before using them. For each component:

1. Explain its role and the hypothesis or design requirement it addresses.
2. Describe the actual computation with consistent symbols and dimensions.
3. Connect it to the rest of the model, training objective and inference.
4. Attribute reused components and identify the implemented change.
5. Point to an ablation or other evidence when claiming its benefit.

Reconcile this account with the executed implementation and configuration.
Distinguish embeddings from recurrent states, summed from averaged losses,
training from inference, and validation-based selection from test reporting.
Keep coefficients, reduction axes, schedules and selection rules reproducible.
Pseudocode is useful for control flow; equations are useful for mathematical
operations. Explain what each central equation does and why it belongs here.
Do not manufacture a derivation, theorem or complexity result to make the method
look more formal. A prose/code conflict that changes the science goes to Experiment.

### Experimental Setup

Describe the question each comparison tests, datasets and their relevance,
splits, preprocessing, baselines, controlled budgets, selection protocol,
metrics and direction, seeds, uncertainty definition, and necessary execution
details. State what was held fixed and what changed. Distinguish authoritative
benchmarks from synthetic probes and exploratory from formal evidence.

Record enough detail for an informed reader to reproduce the comparison,
using an appendix for lengthy settings when useful. Do not fill missing settings
with familiar defaults or point readers to private EasyResearch-local files.

### Results

Organize around research questions, not the order in which runs finished.
Use the result-paragraph recipe below. Cover the strongest baseline, component
ablations, and relevant weak or negative cases. Recompute descriptive summaries
from supplied records when needed; new experiments or inferential analyses
belong to their authorized owner.

### Discussion and Limitations

Connect observations to the initial question and prior work. Distinguish
measured effects from possible explanations. A proposed mechanism should be
presented as a hypothesis until a discriminating test supports it.

For each scientific limit, name the claim affected and explain the consequence
using actual data, protocol, uncertainty or coverage. A non-significant result
does not establish equivalence. If missing controls prevent a mechanism claim,
state the supported observation and remove that attribution. Untested deployment
or another out-of-scope extension is not itself evidence of a method defect.
Put actionable follow-ups and reviewer-response preparation in author notes.
Use a separate Limitations section when these scientific facts warrant it or the
verified venue requires it; describe actual scope rather than inventing warnings.

### Conclusion and Appendix

Conclude with the supported answer and its importance at the demonstrated scope.
Do not introduce a new result, stronger claim or unsupported future capability.
Use the appendix for reproducibility detail and supporting evidence, with clear
main-text references. Keep central contradictory evidence visible in the main
argument. Avoid duplicating the same evidence as multiple figures or tables.

## Explain results

Each major result paragraph should let the reader recover three things:

1. **Question:** what comparison or hypothesis is being tested?
2. **Observation:** what changed, relative to which comparator, by how much and
   with what uncertainty or variation?
3. **Interpretation:** what answer or supported insight follows?

The task, protocol, table caption or named comparison can already establish
scope. Add a local qualification only when its omission would materially change
the interpretation. There is no required final Boundary sentence or list of
untested alternatives in every paragraph.

Illustrative mixed-result pattern, not a result to copy into a paper:

> We test whether the added penalty reduces error under both conditions. Mean
> error decreases in condition A but increases in B under the matched protocol.
> The penalty's observed effect is condition-dependent, with an error reduction
> in A and an increase in B.

The direction reversal is the finding. A possible diagnostic for its cause can
be an optional author note; it is not an automatic paragraph-ending admission.
For a consistently supported result, state the measured improvement directly
with its tested conditions, comparator and uncertainty.

Replace general phrases such as "significantly better" with the actual metric,
effect and uncertainty. Use "statistically significant" only with an appropriate
reported analysis. Report absolute versus relative changes and percentage points
unambiguously. Do not infer a mechanism from a prediction score alone.

## Calibrate scope and author concerns

Lead with the method's operation, observed result or demonstrated contribution.
Use positive scope, such as "We evaluate offline classification on the specified
benchmarks," rather than defining the study through what it does not claim.
Keep a negative contrast when it resolves a real conceptual ambiguity, such as
distinguishing association from causation; do not mechanically delete negation.

Keep real adverse findings and uncertainty where they change interpretation.
Consolidate a shared qualification and repeat it only where omission would
mislead. Compare wording with the original evidence in both directions: remove
unsupported claims and restore supported conclusions weakened by stacked hedges,
"merely/only" judgments or generalized statements that the method is inadequate.

Speculative failure predictions, preventive disclaimers and anticipated reviewer
objections stay out of all manuscript prose, including first drafts, section
fragments and appendices. Put actionable concerns in `manuscript/author-notes.md`
with the affected claim, evidence or untested status, next action and optional
versus required status. Reviewer-response points cite actual evidence; unresolved
questions remain unresolved in those notes. Irrelevant guesses need no record.

## Integrate figures and tables

Select a table when exact comparisons matter, a plot when it reveals a pattern,
and a diagram when it explains structure or computation. Include an artifact
because it contributes evidence or understanding, not because a file exists.

For each included figure, inspect the actual image and its numeric/source data,
then read its caption and every substantive in-text interpretation together.
Check axes, units, legend-to-method mapping, direction, uncertainty and ranges.
A caption identifies the comparison, setting, abbreviations and uncertainty;
the surrounding paragraph explains the inference. Add a qualification only when
the inference needs one beyond the scope already clear from the caption/setup.

Group related panels when they answer one question and remain readable at the
final size. Keep useful detail in the appendix; remove redundant presentations
without hiding adverse results. Route plotting/source corrections to Figures.
Check tables' best-value emphasis according to metric direction. A visually
small difference may still matter numerically; choose a clearer representation
rather than dropping evidence merely because bars look similar.

## Revise paragraphs and sentences

Use connected scholarly prose. A paragraph introduces one point, supports it
with evidence or reasoning, and explains its role in the argument. Merge tiny
subsections whose content belongs to one point. Use lists for genuinely parallel
items, short contributions or procedural steps, not as a substitute for analysis.

Introduce context before unfamiliar terms, keep subjects close to their verbs,
and use one name and symbol for each concept. Prefer concrete actions and
quantities over vague praise. A sentence should add information or a necessary
logical connection. Remove repeated motivation and mechanically repeated
phrases such as "as shown in Table..." when the reference is already clear.

Use "We" for the study's actions. Preserve uncertainty where evidence warrants
it and remove unsupported or stacked hedging. Precision, not a blanket confident
or cautious tone, determines claim strength. Move author-only cautions out of
prose; keep the evidence that readers need. Match sentence length to the idea
rather than enforcing an arbitrary word count.

## Check the assembled paper

Read title, abstract, introduction, main results, figure captions and conclusion
as a sequence. They should describe the same method, question, findings and
limits. Then read adjacent sections for missing definitions, duplicated content
and abrupt transitions. Confirm that every promised contribution is actually
demonstrated and every major conclusion has a source.
Check that shared qualifications are not mechanically repeated and that supported
contributions remain clear. Author notes are a separate companion, not a section
or input to manuscript/TeX/PDF assembly.

Use the parent Skill's bounded author revision passes and
`manuscript-revision-audit.md` for concrete corrections. Keep original evidence
available through revision, preserve stable citation/figure identifiers, and
recheck affected claims after each edit. A fluent final draft still needs
evidence checks and, when requested, inspection of the actual rendered PDF.
