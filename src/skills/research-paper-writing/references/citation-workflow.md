# Citation Identity, Purpose, and Claim Support

Read before adding, replacing or verifying citations. A usable citation needs
both a verified bibliographic identity and support for the statement where it
is used. Keep these checks separate in the parent Skill's existing
`manuscript/citation-verification.md`.

## Start with the intended use

For a missing citation, identify the statement that needs support and its role:
background, original method/dataset/optimizer attribution, closest prior work,
comparison, research gap, or interpretation. Search for that need rather than
collecting a quota of popular papers.

Reuse the accepted material package, including readable text and source
locators. Use the mounted `arxiv` Skill or available `web-search`/`webfetch` for
precise verification. In specialist mode, dispatch Search for a broader missing
source package. Follow the selected execution mode and existing authority for
access or paid services. Do not invent a tool or install a new citation manager
just to format references.

## Verify identity

Check title, authors, year, publication type/venue, and a stable identifier or
URL against an authoritative record: the publisher or DOI registration record,
arXiv, OpenReview, ACL Anthology, or another suitable scholarly source. An
existing verified user-supplied bibliography can provide this evidence.

Resolve conflicting records explicitly. Distinguish preprint versions from
published versions, and confirm that the version cited matches the content
used. A second source helps resolve ambiguity; counting two mirrors of the same
incorrect record does not establish correctness. Do not automatically choose
the first search result or the most-cited candidate.

Search snippets are leads. A failed request, rate limit, login wall, or 403 does
not prove a paper is nonexistent. Try an available authoritative alternative
within scope; otherwise record the unresolved identity and evidence needed.

## Verify support

Read the passage, equation, table or figure that supports the intended claim.
Record its locator and the conditions under which the finding holds. Check:

- Does the source assert this, or merely cite another work that does?
- Does the claim preserve the source's population/task, method, comparator,
  metric, uncertainty and qualifications?
- Is a broad claim being inferred from one narrow setting?
- Are the paper's actual findings consistent with the sentence citing it?

An abstract can support only what it explicitly establishes. A keyword match,
successful DOI lookup or valid BibTeX entry does not verify a scientific claim.
Use full-text evidence for details not established by the abstract. If access is
partial, narrow the claim to the verified passage or leave support unresolved.

Illustrative distinction:

| Evidence | Supported use | Unsupported use |
|---|---|---|
| Authoritative metadata identifies a paper about regularization | Bibliographic identity | Its method improves robustness |
| A passage evaluates recurrent-state smoothing at fixed lengths | Describe that method and setting | Attribute results to input-embedding smoothing or unseen lengths |
| A table compares methods on one shared benchmark | Report that controlled comparison with its uncertainty | Claim universal superiority across tasks |

Use a textbook for background it actually supports. Attribute a method's
introduction to its original source when making a priority/origin claim. A
methodological comparison should state similarities and differences, not just
place several citations after a vague sentence.

## Record the decision

Use a compact table in the internal citation-verification record:

| Key / work | Identity and version evidence | Intended claim and manuscript location | Supporting passage locator | Support and limits | Disposition |
|---|---|---|---|---|---|
| <stable key> | <authoritative record> | <purpose and section> | <page/section/table/equation> | <what is established and under which conditions> | <use / narrow / replace / unresolved> |

Keep unresolved candidates in the existing manual-verification section with
the missing evidence. Do not cache or label them as verified because a warning
was printed, a request completed, or a formatter produced an entry. A narrowed
claim can use a source only when the narrower statement is actually supported.

If identity or required support remains unresolved, omit the candidate from
normal manuscript citations and references and remove, narrow or replace the
dependent claim. Return a scoped gap when the authorized deliverable depends
on it. Keep the unresolved queue and local evidence paths out of the paper.

## Add and maintain the bibliography

Retrieve BibTeX from the verified source when available. If formatting it from
verified metadata, copy the known fields faithfully and leave unavailable
optional fields absent; do not guess authors, venue, year, pages or DOI.
Validate retrieved metadata too, since an API can return the wrong version or
an imperfect export. Parsing an entry proves syntax, not claim support.

- Reuse stable citation keys across drafts. Do not rename keys just for style.
- Deduplicate the same work under different identifiers while preserving a
  materially different version when it is intentionally discussed.
- Use the bibliography system required by the actual template. Do not add
  BibLaTeX to a template that requires BibTeX/natbib, or mix their commands.
- Match citation placement to the specific supported statement. Avoid one
  ambiguous citation at the end of a paragraph with several different claims.
- Ensure every in-text key resolves and every normal reference is cited, unless
  the verified venue explicitly permits an additional bibliography.
- For numeric citations, expand ranges when checking coverage and preserve
  ordering after edits. Check captions, appendices and tables as well as prose.

After revisions, recheck the claims whose wording changed even if the citation
keys did not. A source that supported an earlier narrow sentence may not support
its stronger replacement. Mechanical key checks complement this semantic check.

## Completion

The bibliography is ready for the requested scope when cited identities are
verified, the adjacent claims are supported at the stated scope, versions and
keys are consistent, and unresolved candidates are isolated in the internal
record. Do not infer acceptance, scientific validity, or source agreement from
the number of citations or API responses.
