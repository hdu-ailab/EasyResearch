---
name: arxiv
description: |-
  Retrieve and verify arXiv paper metadata by arXiv ID, generate BibTeX, inspect abstract/PDF pages with webfetch, and query Semantic Scholar citation/reference metadata. Use as a complement to paper-search after candidate papers are already found; do not use for broad paper search unless paper-search is unavailable.

  Examples:
  - user: "帮我核验 1706.03762 的标题、作者和版本" → fetch arXiv metadata by ID
  - user: "给 Attention Is All You Need 生成 BibTeX" → query arXiv ID and output BibTeX
  - user: "看一下 2402.03300 的引用和参考文献" → query Semantic Scholar by arXiv ID
license: MIT
metadata:
  hermes:
    tags: [research, arxiv, papers, bibtex, citations]
    category: research
    related_skills: [research-project-workflow, paper-search, pdf-to-markdown, paper-material-package, survey-paper-writing]
---

# arXiv Metadata

## When To Use
- An arXiv ID is already known and the title, authors, abstract, version, category, or links need verification
- BibTeX is needed for an arXiv paper
- The content of an arXiv abstract/PDF page needs inspection
- Semantic Scholar is needed for citation counts, references, citing papers, or author information

Use `paper-search` for topic-level paper search; this skill only handles
known papers or a small number of precise queries.

## Workflow Integration
- In a full paper project, the Search agent maintains `ref_papers/source.json`
  under the exact cwd; if the dispatch explicitly supplies an existing user
  layout, follow that layout.
- This skill verifies arXiv ID, version, title, authors, BibTeX, citation
  counts, and reference information for already-selected papers.
- If `source.json` exists, fill in verification results as fields; do not
  re-run broad topic searches with this skill.
- PDF acquisition and PDF-to-Markdown conversion are the Search agent's
  responsibility, preferring the `pdf-to-markdown` skill; the orchestration
  layer never performs conversion directly.

## Helper Script
Run from the skill directory (prefer the EasyResearch skill venv Python;
fall back to system python3 when unset):

```bash
$EASYRESEARCH_VENV/bin/python scripts/search_arxiv.py --id 1706.03762
$EASYRESEARCH_VENV/bin/python scripts/search_arxiv.py --id 1706.03762 --bibtex
$EASYRESEARCH_VENV/bin/python scripts/search_arxiv.py --id 1706.03762,2402.03300
```

Windows layout:

```powershell
& (Join-Path $env:EASYRESEARCH_VENV 'Scripts\python.exe') scripts\search_arxiv.py --id 1706.03762
```

The script depends only on the Python standard library. When
`EASYRESEARCH_VENV` is unset, native Windows can use `py -3` and Linux/macOS
can use `python3`.

If the arXiv Atom API returns `429`, the script automatically falls back to
parsing the `arxiv.org/abs/{id}` page for basic metadata and BibTeX.

A small number of precise queries also work, but do not replace `paper-search`
topic search:
```bash
python scripts/search_arxiv.py --author "Yann LeCun" --max 5
python scripts/search_arxiv.py --category cs.LG --sort date --max 5
```

## Read Pages
Use the current OpenCode `webfetch` tool to read pages:
```text
https://arxiv.org/abs/{id}
https://arxiv.org/pdf/{id}
https://arxiv.org/html/{id}
```

Rules:
- Prefer `https://arxiv.org/abs/{id}` for abstract pages
- Read the PDF only when the full text is needed
- HTML pages may not exist; fall back to the PDF or abstract page on failure

## BibTeX Requirements
Include in generated BibTeX:
- `title`
- `author`
- `year`
- `eprint`
- `archivePrefix = {arXiv}`
- `primaryClass`
- `url`

Preserve a version suffix given by the user, e.g. `1706.03762v7`; when the
user provides only the base ID, use the latest version returned by the API.

## Semantic Scholar
arXiv does not provide citation data. Use the Semantic Scholar public API for
citations, references, related papers, or author metrics.

Paper details:
```bash
curl -s "https://api.semanticscholar.org/graph/v1/paper/arXiv:2402.03300?fields=title,authors,citationCount,referenceCount,influentialCitationCount,year,abstract,externalIds" | python3 -m json.tool
```

Citing papers:
```bash
curl -s "https://api.semanticscholar.org/graph/v1/paper/arXiv:2402.03300/citations?fields=title,authors,year,citationCount&limit=10" | python3 -m json.tool
```

References:
```bash
curl -s "https://api.semanticscholar.org/graph/v1/paper/arXiv:2402.03300/references?fields=title,authors,year,citationCount&limit=10" | python3 -m json.tool
```

Author search:
```bash
curl -s "https://api.semanticscholar.org/graph/v1/author/search?query=Yann+LeCun&fields=name,hIndex,citationCount,paperCount" | python3 -m json.tool
```

## Common Categories
| Category | Field |
|----------|-------|
| `cs.AI` | Artificial Intelligence |
| `cs.CL` | Computation and Language |
| `cs.CV` | Computer Vision |
| `cs.LG` | Machine Learning |
| `cs.CR` | Cryptography and Security |
| `stat.ML` | Machine Learning Statistics |

Full list: `https://arxiv.org/category_taxonomy`

## Notes
- arXiv API returns Atom XML; use `scripts/search_arxiv.py` for cleaner output.
- arXiv rate limit is roughly 1 request per 3 seconds. If `429` occurs, wait and retry later.
- arXiv IDs can be old format such as `hep-th/0601001` or new format such as `2402.03300`.
- `https://arxiv.org/abs/{id}` resolves to the latest version unless a version suffix is included.
- Withdrawn papers may have incomplete metadata; check the abstract for `withdrawn` or `retracted` before citing.

## Directory Structure
```text
arxiv
├─ SKILL.md
└─ scripts
   └─ search_arxiv.py
```
