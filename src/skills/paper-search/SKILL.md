---
name: paper-search
description: |-
  Search and organize OpenReview and arXiv paper candidates, returning structured results for a user-given topic, time range, and data sources. Use proactively when the user asks to find papers, restrict a time range, prefer OpenReview/arXiv results, or wants examples of what a research direction looks like in target journals.

  Examples:
  - user: "找 2026 年 diffusion model 论文" → run fetch_papers.py and organize the results
  - user: "只看 arXiv 上 transformer attention 的最新论文" → query with --sources arxiv
  - user: "这个方向 3区/4区论文长什么样" → retrieve candidates and note that journal quartiles need verification
license: MIT
metadata:
  hermes:
    tags: [research, papers, openreview, arxiv, search]
    category: research
    related_skills: [research-project-workflow, arxiv, pdf-to-markdown]
---

# Paper Search

## When To Use
- The user asks to search papers for a research direction
- The user wants to restrict the time range, result count, or data sources
- The user wants OpenReview or arXiv results prioritized
- The user needs a structured paper list for later reading, filtering, or summarization
- The user wants to see sample papers, experiment scales, or writing patterns of a direction in target journals (e.g. Q3/Q4 venues)

## Workflow Integration
- In a full paper project, `research-project-workflow` first coordinates the
  directory layout and stage order; then this skill searches candidate papers.
- This skill only returns a candidate paper list; PDF download, text
  conversion, experiments, and manuscript writing are outside its scope.
- In a paper project, organize or save the script JSON output to
  `ref_papers/source.json` under the exact cwd; if the dispatch explicitly
  supplies an existing user layout, follow that layout.
- For finally selected arXiv papers, use the `arxiv` skill to verify ID,
  version, BibTeX, and citation information.
- If public PDFs must be fetched and converted to Markdown, the Search agent
  uses the `pdf-to-markdown` skill; the orchestration layer never performs
  conversion directly.

## Inputs
Extract from the user request:
- Search direction / topic (required)
- Start date `since` (optional, format `YYYY-MM-DD`; default `2026-01-01`)
- End date `until` (optional, format `YYYY-MM-DD`; default today)
- Result count `max-results` (optional, default 10)
- Data sources `sources` (optional; default searches both `openreview` and `arxiv`)

By default only `query` is needed; the remaining parameters use their
defaults. Add a time range, data sources, or result count only when the user
explicitly asks.

If the user gives no search direction, ask for it first; if no time range is
given, default to `2026-01-01` through today.

## Commands
Prefer the Python from the EasyResearch skill venv (auto-created by
postinstall):

```bash
$EASYRESEARCH_VENV/bin/python \
  <skill-dir>/scripts/fetch_papers.py \
  --query "{topic}"
```

From inside the Skill directory:

```bash
$EASYRESEARCH_VENV/bin/python scripts/fetch_papers.py --query "{topic}"
```

Windows layout:

```powershell
%EASYRESEARCH_VENV%\Scripts\python.exe scripts\fetch_papers.py --query "{topic}"
```

If `$EASYRESEARCH_VENV` is unset or its Python lacks the `arxiv` package, the
script automatically falls back to the REST API (no manual `.venv` creation
needed); the system `python3` can also run the script directly.

If OpenReview scraping is unavailable, ensure `playwright-cli` works and
prefer the local Chrome Stable:
```bash
playwright-cli open --browser=chrome https://example.com
```

Optional arguments:
```bash
# OpenReview only
paper-search --query "{topic}" --since "{since}" --until "{until}" --sources openreview

# arXiv only
paper-search --query "{topic}" --since "{since}" --until "{until}" --sources arxiv

# Adjust result count
paper-search --query "{topic}" --since "{since}" --until "{until}" --max-results 20
```

## Advanced Options
Not needed for normal use; only when controlling speed, coverage, or
stability:
- `--openreview-max-groups` (default `12`): caps how many conference-year
  groups OpenReview queries (newest first). Smaller is faster but narrower.
- `--http-timeout` (default `15` s): per-request HTTP timeout for OpenReview,
  the arXiv REST fallback, and the arXiv web-search fallback; the arXiv SDK
  has its own retries and throttling.
- `--openreview-browser-timeout` (default `25` s): per-request timeout when
  OpenReview is scraped via `playwright-cli`.
- `--openreview-retries` (default `2`): retry count when OpenReview Playwright
  scraping fails.
- `--openreview-time-budget` (default `90` s): total time budget for all
  OpenReview scraping; stops fetching further groups early once reached.

Common tuning examples:
```bash
# Fast mode: prioritize low latency
paper-search --query "{topic}" --openreview-max-groups 8 --openreview-time-budget 60 --openreview-browser-timeout 15 --http-timeout 10

# Coverage first: allow a longer scraping window
paper-search --query "{topic}" --openreview-max-groups 20 --openreview-time-budget 150 --openreview-browser-timeout 35 --openreview-retries 3
```

## Script Behavior
- Builds the arXiv query from the user topic and searches via the `arxiv`
  Python SDK in `$EASYRESEARCH_VENV` first
- If the `arxiv` SDK is unavailable or the request fails, falls back to the
  raw arXiv REST API path; if REST yields nothing, tries the arXiv web search
  fallback
- Uses `notes/search` per the OpenReview API docs, passing `term` explicitly
  to fetch candidate papers
- Generates the OpenReview candidate conference list from the user's time
  range and fetches papers
- Scrapes newer conference years first by default, with browser retries and a
  total time budget to reduce failure risk
- Scrapes OpenReview JSON uniformly through a `playwright-cli`-managed browser
  to avoid 403 rejections of direct API calls in some environments
- Normalizes and time-filters OpenReview results locally
- Deduplicates by title, preferring OpenReview sources and fuller source info
- Orders output with OpenReview papers first, then arXiv papers
- Returns a JSON list for the Skill to organize into output

## Output Format
Skill return format:
```
### Search Results
#### 1. {title}
- Authors: {authors}
- Published: {published_date}
- Source: {source}
- Venue: {venue}
- Paper URL: {paper_url}
- Abstract: {abstract}
```

Output requirements:
- `Source` must be only `openreview` or `arxiv`
- `Venue` must be as specific as possible, e.g. `ICLR 2026 Poster`, `NeurIPS 2025 Oral`, `arXiv preprint`, or a concrete `journal_ref`
- `Paper URL` must be the paper's homepage link, not a PDF link
- Long author lists may be truncated, but never drop the first author
- If no results, state clearly that no matching paper was found in the given direction and time range

## Edge Cases
- No matches: return "no matching paper found in the given direction and time range"
- A single source fails: keep the other source's results and note the partial source failure
- OpenReview conference missing or API unavailable: skip that conference and continue searching
- Invalid user time range (`since > until`): ask the user to correct it
- If `playwright-cli` or Chrome Stable is missing: suggest installing or
  fixing local Chrome and verify with
  `playwright-cli open --browser=chrome https://example.com`

## Review Rules
- Treat script results as a candidate pool; manually drop weakly relevant
  papers when the topic is narrow or OpenReview results are obviously generic
- When exact same-title papers are scarce, state that strict equivalents are
  scarce, then search adjacent keywords
- For direction surveys, OpenReview/arXiv are frontier signals; add other
  public sources for journals, reviews, or citation counts
- For Q3/Q4 examples, always note that quartile assignments must be verified
  against the latest JCR/CAS or journal-site information accepted by the
  user's institution

## Constraints
- Do not fix a research direction inside the Skill
- If the user gives no time range, default to `2026-01-01` through today
- The search direction is decided by the user
- OpenReview/arXiv APIs are public; degrade gracefully when an individual API fails
- Output must include title, authors, publication date, source, venue name, and a non-PDF paper link

## Directory Structure
```
paper-search
├─ SKILL.md
├─ references
│  └─ test_fetch_papers.py
└─ scripts
   └─ fetch_papers.py
```
