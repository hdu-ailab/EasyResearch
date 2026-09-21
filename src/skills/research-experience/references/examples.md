# Research-memory calls and provenance

These are worked hypothetical calls, not measured research results. Substitute
real inspected evidence and **returned** ids/revisions. Calls go to the
`research-memory` tool, not a shell command. The tool supplies actual Agent,
session, model and cwd; never send those identity fields.

## Read, freeze and distinguish slots

```json
{"action":"recall","query":"identifier metadata verification","role":"search","kind":"method","limit":3}
```

Omitted recall scope searches this exact project plus shared active experience;
explicit `scope` restricts it. Results are `{memories, diagnostics, truncated}`.
Select relevant `memories[].ref`, then pin each read:

```json
{"action":"get","scope":"project","id":"12345678-1234-5234-8234-123456789abc","revision":3}
```

Get/mutations return `{record}`. Read `record.active.entry` and its
`proposalRevision`; inspect `record.pending` only for assigned candidate work.
`record.revision` pins the whole snapshot, not just a proposal. A recalled r4
snapshot may still have active proposal 1 plus pending proposal 4. It supplies
only the active method for ordinary reuse. A historical r3 read stays frozen even
after r6 activates. `historical:true` means an older snapshot, not failure.

Pass a concrete dispatch block:

```text
memory_refs: [{"scope":"project","id":"12345678-1234-5234-8234-123456789abc","revision":3}]
Use only each snapshot's active method if applicable; report condition mismatches.
Return memory_used/proposed/verified and observed_failures in your handoff.
```

Use `memory_refs: []` for a deliberately memory-free control. Only a designated
test additionally receives `candidate_ref` and `candidate_proposal_revision` in
its task text; these are **dispatch prose fields, not tool parameters**.

## Project method: propose → verify → activate

Search finishes a source report before proposing:

```json
{
  "action":"propose","scope":"project",
  "entry":{
    "kind":"method","title":"Resolve stable identifiers before title matching",
    "roles":["search"],"tags":["metadata","identifiers"],
    "conditions":"Public paper metadata with DOI or arXiv identifiers; check current endpoint and parser behavior.",
    "procedure":"Resolve the supplied identifier first; compare title, authors and version against the source page; keep ambiguous matches unresolved.",
    "limitations":"No guarantee for papers lacking identifiers or for full-text claim support.",
    "rationale":"The inspected metadata cases distinguish identifier collisions from title variants.",
    "evidencePaths":["ref_papers/memory-source.md"]
  }
}
```

Suppose the response has `record.id = 12345678-1234-5234-8234-123456789abc`,
`record.revision = 1`, `pending.proposalRevision = 1`, and no `active`.
Record that pending ref in the handoff; nothing from it is recalled yet. New
ids are UUIDv5; existing UUIDv4 ids also work. Copy returned lowercase ids exactly,
never invent an id or enforce a v4-only assumption.

Research Assistant dispatches a **fresh Search session**, not the author's child
id. It receives candidate snapshot r1/proposal 1, source report, frozen baseline,
replay and prior-case regression tasks, authorized budget, and a disjoint report
path. The verifier inspects evidence and performs the checks within Search's role.
Only after its report actually supports these outcomes does it call:

```json
{
  "action":"verify","scope":"project",
  "id":"12345678-1234-5234-8234-123456789abc","expectedRevision":1,
  "verification":{
    "outcome":"pass","summary":"Identifier replay resolves the observed ambiguity; prior unambiguous cases retain their verified matches.",
    "evidencePaths":["ref_papers/memory-verify.md"],
    "checks":[
      {"name":"Ambiguous identifier replay","kind":"replay","outcome":"pass","details":"Reproduced the source cases with exact identifiers and source-page locators."},
      {"name":"Prior metadata cases","kind":"regression","outcome":"pass","details":"Checked the fixed prior-case packet; no verified match was lost."}
    ]
  }
}
```

Successful verify returns snapshot r2, still pending proposal 1. Research
Assistant inspects the report and current record, then publishes in that same cwd:

```json
{"action":"activate","scope":"project","id":"12345678-1234-5234-8234-123456789abc","expectedRevision":2}
```

Success returns r3 with `active.proposalRevision = 1` and no pending. A fresh task
can now recall/get r3. Every successful mutation creates a new snapshot; do not
use proposal revision 1 as the next CAS value. Never assume success from an issued
call. If a concurrent writer advances the record, inspect the conflict/current
record before deciding; keep already-dispatched frozen reads unchanged.
For management reads, omit `revision` to obtain current state. If inspecting a
pinned snapshot instead, `historical:true` means it is not the current CAS base.

## Upgrade while retaining the incumbent

After additional actual evidence, propose a replacement on the same id:

```json
{
  "action":"propose","scope":"project",
  "id":"12345678-1234-5234-8234-123456789abc","expectedRevision":3,
  "entry":{
    "kind":"method","title":"Identifier resolution with explicit version disambiguation",
    "roles":["search"],"tags":["metadata","versions"],
    "conditions":"Public versioned paper metadata; identifier and source-page access available.",
    "procedure":"Resolve the identifier, distinguish preprint revisions from published versions, and retain separate supported venue/version fields rather than merging conflicts.",
    "limitations":"Do not infer publication status or full-text claims from a metadata match.",
    "rationale":"Observed version conflicts require a distinct check after identifier resolution.",
    "evidencePaths":["ref_papers/memory-upgrade-source.md"],
    "basedOn":[{"scope":"project","id":"12345678-1234-5234-8234-123456789abc","revision":3}]
  }
}
```

Success: r4, active proposal 1 retained, pending proposal 4. `basedOn` is the exact
active snapshot actually inherited, not a pending-only ref. A verifier reads
pinned r4/proposal 4; independent verify using `expectedRevision:4` returns r5;
activation using returned r5 yields r6 with active proposal 4. Use a new report
and real outcomes; do not copy the earlier verification as new evidence.

Alternative failure branch from r4: verifier reports `outcome:"fail"` (or
`"inconclusive"`) with evidence, distinct check names and honest outcomes, yielding
r5. Research Assistant can clear pending without losing the incumbent:

```json
{"action":"reject","scope":"project","id":"12345678-1234-5234-8234-123456789abc","expectedRevision":5,"reason":"Regression failed; retain the verified incumbent."}
```

This alternative returns r6 with active proposal 1. Budget exhaustion can instead
justify rejection with reason “Inconclusive; campaign budget exhausted,” which
does not turn inconclusive into a scientific failure. An intentionally retained
pending candidate remains inert, with an explicit unresolved disposition; it
cannot be carried into later ordinary tasks.

## Shared transfer without private-content transfer

Only Research Assistant submits shared proposals. Generalize procedure,
conditions, limitations, rationale, title and tags **before** storage: remove
private names, paths, identifiers, raw excerpts and unpublished findings. Evidence
paths remain actual local paths in `evidencePaths`, never embedded in generalized
prose. The runtime's literal checks/redaction do not establish semantic privacy.

For an already verified project method, the source/upgrade entry above can be
submitted with `action:"propose", scope:"shared"`, no id/expectedRevision (new
shared record), and `basedOn` naming the active project r3 or r6 actually used.
Use a separately inspected sanitized-transfer source report. From the returned
shared r1, another session **in that pending author's exact cwd** replays, checks
regressions and tests a distinct authorized held-out task, then supplies:

```json
{
  "action":"verify","scope":"shared",
  "id":"22345678-1234-4234-8234-123456789abc","expectedRevision":1,
  "verification":{
    "outcome":"pass","summary":"Generalized metadata procedure replayed and transferred to the untouched public holdout.",
    "evidencePaths":["ref_papers/shared-transfer-verify.md"],
    "checks":[
      {"name":"Source packet","kind":"replay","outcome":"pass","details":"Replayed the fixed source metadata cases."},
      {"name":"Prior matches","kind":"regression","outcome":"pass","details":"Preserved supported matches and ambiguity reporting."},
      {"name":"Public holdout H2","kind":"transfer","outcome":"pass","details":"Applied the frozen procedure to a distinct public packet never used for practice; recorded all cases and source locators."}
    ]
  }
}
```

The id illustrates a valid older UUIDv4; use the actual returned id. On success
r2, Research Assistant activation with shared scope and `expectedRevision:2`
returns r3. Another project can recall the generalized active method, not its
origin's private paths/session or project lineage. Do not verify or activate that
origin's pending in the other cwd. After pending work is resolved, Research
Assistant in the new project may propose a new shared replacement at the current
revision using its **own** evidence and a shared active `basedOn` pin. Verification
and activation for that new pending now belong to its new origin.

## Retirement, rollback and stale proofs

In the successful upgrade branch (active successor at r6), Research Assistant:

```json
{"action":"retire","scope":"project","id":"12345678-1234-5234-8234-123456789abc","expectedRevision":6,"reason":"Newly observed conditions invalidate the successor's applicability."}
```

Success r7 stops recall. After confirming the old method is applicable:

```json
{"action":"rollback","scope":"project","id":"12345678-1234-5234-8234-123456789abc","expectedRevision":7,"revision":3,"reason":"Restore the prior verified method for its original supported conditions."}
```

Success r8 restores the prior active content as a **new** snapshot; r3 and r6
remain readable. Resolve pending work first. Rollback reuses an already active
historical snapshot, not a failed candidate, and does not prove new applicability.

| Observed condition | Action |
|---|---|
| Source evidence changed since proposal | Reject pending, repropose against the new source, independently verify again; never rewrite the source digest |
| Only verification evidence changed | Inspect corrected evidence and independently `verify` again on current pending/current CAS, then reassess activation |
| Missing, oversized, symlinked or multi-linked evidence | Use an eligible inspectable report; do not bypass the evidence guard or fabricate content |
| `CONFLICT` | Get current record, compare pending identity and ownership, reassess; no blind retry |
| `LIMIT`, unavailable/corrupt library | Report the learning gap; keep valid task work. Existing-id replacement may remain possible at capacity |
| No lesson | `memory_proposed: none`; task completion remains valid |

Strategy comparison and inherited improvement rounds are in
`recursive-self-improvement`'s [verification reference](../../recursive-self-improvement/references/verification.md).
