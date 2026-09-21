# Verification and successor inheritance

## 1. Freeze a comparison that can answer the question

A **method** changes research procedure. A **strategy** changes how improvements
are generated, diagnosed, practiced, verified or selected. Better paper F1 alone
does not show that a strategy produces reliable improvements more efficiently.

Specify the unit of evaluation before observing results, for example independently
verified metadata resolutions or independently accepted methods per fixed total
budget. Keep duplicates, failed attempts, inconclusive checks and regressions
visible. Self-counted proposals are not verified improvements.

Freeze these in the dispatch and responsible specialist's evidence report:

| Field | Required record |
|---|---|
| Lineage | Exact active baseline `scope/id/revision`, pending candidate snapshot and `proposalRevision`, strategy delta |
| Conditions | Same actual model/provider, thinking, tools, environment, data access, evaluator/version and task difficulty |
| Resource accounting | Same positive total budget per arm, unit/conversion weights, setup/diagnosis/trials/tool/model/verification cost, failed attempts included |
| Exposure | Practice packets, prior-case regression packet and distinct held-out tasks; no held-out feedback for learning in this campaign |
| Mechanism | Observable changes in choices: which diagnosis, practice task or proposal selection the strategy caused; costs and resulting verified outcomes |
| Acceptance | Replay, regression, mechanism, favorable held-out comparison; transfer additionally required for shared scope |
| Stop | Budget/deadline, target, user Stop, no useful next task, or unrecoverable/repeated infrastructure failure |

Live model/environment changes invalidate a matched comparison: pause the affected
comparison, record the change, and use separately authorized matched conditions
or report inconclusive. Never compensate by relabeling budgets, changing score
weights after results, swapping evaluators, or dropping failed attempts. An
unchanged total with a cheaper model is still a model confound for this claim.

Budget allocation example: 200 authorized total units, 100 per arm including
verification/reporting. Reserve capacity before practice. If either arm cannot
complete required checks inside its cap, record inconclusive; do not expand the
budget to secure a winner. A zero-improvement campaign may be complete.

## 2. Local feedback before end-to-end validation

For missing units in scanned-table extraction, Search can first compare a cell
whose unit is in a header with one whose scale is in a footnote. The local check
requires printed value, unit, scale and page/table/cell locator, distinguishing
header association from OCR error. Then independently replay and check prior
straightforward cases before a fresh original-target attempt. Keep the original
target and scoring fixed. Search owns factual notes and eligible small reports
under `ref_papers/`; it does not draft manuscript claims. Other specialists use
their existing Skill roots; Review writes only its immutable report/handoff.

For empirical strategies, one Experiment owner runs each inner campaign under
`autoresearch`; do not distribute its trials across a wave of Experiment children.
After the campaign, a fresh Experiment verifier can test the exact pending method
within the separately allocated verification budget and disjoint output paths.

No new RSI project-state file or scheduler is needed. Keep orchestration in Pi
history; cite immutable, inspectable specialist reports/handoffs as memory proof.
Finish the source report before proposal and verification report before verify.
Adding the returned ref to a new handoff avoids changing either hashed report.

## 3. Worked strategy upgrade and returned revisions

Hypothetical fixtures, not measured results: a project strategy at active snapshot
r3 uses broad query expansion. Its actual id here is
`72345678-1234-5234-8234-123456789abc`. Research Assistant inspected a Search report
showing identifier ambiguities and the cost of repeated queries. A bounded
candidate prioritizes diagnosis before expansion. Read the current record (omit
`revision` for current CAS), then propose:

```json
{
  "action":"propose","scope":"project",
  "id":"72345678-1234-5234-8234-123456789abc","expectedRevision":3,
  "entry":{
    "kind":"strategy","title":"Diagnose identifier ambiguity before expanding retrieval",
    "roles":["research-assistant","search"],"tags":["improvement","diagnosis"],
    "conditions":"Public metadata tasks with stable identifiers and fixed model, tools, evaluator and total budget matching the verification protocol.",
    "procedure":"Classify each retrieval failure before selecting practice: test identifier/version ambiguity locally first; expand queries only for genuine coverage gaps. Compare resulting resolutions independently and preserve unsuccessful attempts in total cost.",
    "limitations":"Evidence is bounded to metadata tasks; a single comparison does not prove broad improvement efficiency or paper-quality gains.",
    "rationale":"Local diagnostics can avoid repeated broad queries that cannot distinguish version collisions.",
    "evidencePaths":["ref_papers/strategy-source.md"],
    "basedOn":[{"scope":"project","id":"72345678-1234-5234-8234-123456789abc","revision":3}]
  }
}
```

Success returns `{record}` at r4 with active incumbent retained and pending
proposal 4. Its `basedOn` must already resolve to the accessible active r3
snapshot. Do not add lineage to `verify` or rewrite pending content: changed
content needs reject/reproposal.

Research Assistant dispatches a fresh Search verifier in the same exact cwd.
It keeps baseline r3 separate from candidate r4/proposal 4 and uses eligible
local reports. It cannot merely agree with the author's summary. Suppose its
actual replay/regression/mechanism report supports the following observations:

- same model A, tools T, evaluator E and environment;
- untouched public metadata task H2, 100 total units each, failures counted;
- baseline 2 vs candidate 4 independently verified resolutions;
- the candidate selected identifier checks before query expansion, a documented
  change in improvement decisions, not just a higher final paper score.

Only then may that **different verifier session** call:

```json
{
  "action":"verify","scope":"project",
  "id":"72345678-1234-5234-8234-123456789abc","expectedRevision":4,
  "verification":{
    "outcome":"pass",
    "summary":"Bounded identifier-first comparison passed; independent resolutions increased on the untouched public task under matched conditions.",
    "evidencePaths":["ref_papers/strategy-verify.md"],
    "checks":[
      {"name":"Diagnostic replay","kind":"replay","outcome":"pass","details":"Independent replay confirmed the source ambiguity diagnosis."},
      {"name":"Prior-case retention","kind":"regression","outcome":"pass","details":"The fixed prior-case packet retained its supported resolutions."},
      {"name":"Improvement decision trace","kind":"mechanism","outcome":"pass","details":"Recorded identifier-first practice selection before broad expansion, its cost and resulting independently verified resolutions."},
      {"name":"Untouched public H2","kind":"transfer","outcome":"pass","details":"Distinct held-out task used neither for practice nor candidate tuning; all attempts recorded."}
    ],
    "comparison":{
      "baseline":2,"candidate":4,"direction":"maximize",
      "baselineBudget":100,"candidateBudget":100,"budgetUnit":"total protocol units",
      "protocol":"Model A, tools T, evaluator E and environment fixed; independently verified resolutions; identical cost weights including setup, failed attempts, diagnosis and verification. No H2 feedback used for learning.",
      "heldOutTask":"Public metadata packet H2, distinct from practice and prior-case regression"
    }
  }
}
```

`comparison` is mandatory for strategy activation; embedding the numbers in
check `details` alone is insufficient. All check names are distinct; every
outcome is an observed `pass`, `fail` or `inconclusive`. Never copy a fixture pass
into a real run. The tool mechanically checks fields, budgets, independence and
hashes; it does not certify the scientific truth of the report.

Verification success returns r5 with pending proposal 4. After inspecting report
and current state, Research Assistant in the pending origin calls:

```json
{"action":"activate","scope":"project","id":"72345678-1234-5234-8234-123456789abc","expectedRevision":5}
```

Success returns r6 with active proposal 4, no pending. Capture actual returned
revisions, not predicted integers; on conflict reread/reassess. If source bytes
changed, reject/repropose; if only verifier proof changed, reverify first. See
[memory examples](../../research-experience/references/examples.md) for reject,
retire, rollback, shared-scope transfer and pending-origin restrictions.

## 4. Measure inheritance in the next improvement round

After confirmed activation, within existing authority, send a fresh task:

```text
agent: search
task: Start the next bounded metadata-improvement round on the authorized H3
practice packet. memory_refs: [{"scope":"project","id":"72345678-1234-5234-8234-123456789abc","revision":6}].
Read that snapshot's active strategy; diagnose identifier/version ambiguities
before choosing practice. Keep model A/tools T/evaluator E and the allocated
total budget fixed. Record the first failure classification, chosen local check,
query-expansion decision, all attempts/costs and independently checkable outcomes
in ref_papers/strategy-reuse.md. Do not reuse H2 as an untouched holdout or tune
from its final-test feedback. Return a fresh immutable Search handoff with
memory_used/proposed/verified and observed_failures; none is valid for no lesson.
```

The exact real H3 input paths, budget and disjoint outputs must be resolved before
dispatch. A completed task's actual handoff should connect r6 to its observed
choice and result, for example “used r6 to select the version-header check before
query expansion,” supported by its report. Merely listing r6 is not mechanism
evidence. A later proposal derived from that round uses active r6 in `basedOn`,
not the older r3 or pending r4. Descendants keep the dispatch pin even if live r9
appears. Verify the later proposal independently; recursion does not confer trust.

## 5. Closure and common traps

| Pressure | Concrete decision |
|---|---|
| “A finished; consolidate while B works” | Inspect A's artifacts now; wait for the designated wave barrier before learning consolidation or selection |
| “C crashed, so the candidate lost” | Record unverified infrastructure outcome, honor one-correction limit, fabricate no handoff |
| “6 beats 2 despite a different model/evaluator/budget” | Invalid comparison; retain incumbent, require matched conditions or record inconclusive |
| “Higher F1 proves a better improvement strategy” | Measure the changed improvement choices and downstream verified yield/cost separately |
| “Keep going until there is a lesson” | Stop at budget; return none and complete if the authorized outcome is satisfied |
| “Use the latest shared pending in another project” | Use applicable active pins; pending-origin verify/activate restriction and semantic privacy still apply |
| “Ask Review again for RSI evidence” | Route work to its responsible owner; no experiments/source editing or automatic second manuscript Review |

Report task status separately from learning: accepted/rejected/inconclusive
attempts, evidence gaps, exact active successor (if any), pending disposition,
budget consumed/remaining, actual reuse, and regressions. Do not claim statistical
efficacy, effective meta-improvement, or recursive acceleration from a few cases.
