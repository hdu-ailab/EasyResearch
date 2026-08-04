#!/usr/bin/env python3
"""
paper-search: 从 OpenReview 和 arXiv 搜索用户指定方向与时间范围的论文。
输出 JSON 格式的结构化论文列表。

OpenReview 依据 API 文档使用 /notes/search，并显式传入 term 参数：
https://api2.openreview.net/docs/api.yml
"""

import argparse
import html
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OPENREVIEW_SEARCH = "https://api2.openreview.net/notes/search"
ARXIV_API = "https://export.arxiv.org/api/query"
DEFAULT_SINCE = datetime(2026, 1, 1).date()
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Safari/537.36"
)
PLAYWRIGHT_SESSION = "paper-search-openreview"

OPENREVIEW_VENUES = [
    ("ICLR.cc", "ICLR"),
    ("NeurIPS.cc", "NeurIPS"),
    ("ICML.cc", "ICML"),
    ("COLM.cc", "COLM"),
]


def parse_args():
    parser = argparse.ArgumentParser(
        description="Search papers from OpenReview and arXiv."
    )
    parser.add_argument("--query", required=True, help="Search topic or keywords")
    parser.add_argument(
        "--since", help="Start date in YYYY-MM-DD (default: 2026-01-01)"
    )
    parser.add_argument("--until", help="End date in YYYY-MM-DD (default: today)")
    parser.add_argument(
        "--max-results", type=int, default=10, help="Number of papers to return"
    )
    parser.add_argument(
        "--sources",
        nargs="+",
        choices=["openreview", "arxiv"],
        default=["openreview", "arxiv"],
        help="Sources to search",
    )
    parser.add_argument(
        "--openreview-limit",
        type=int,
        default=25,
        help="Per-conference fetch limit for OpenReview after search",
    )
    parser.add_argument(
        "--arxiv-max-results",
        type=int,
        default=50,
        help="Raw fetch size for arXiv before post-filtering",
    )
    parser.add_argument(
        "--openreview-max-groups",
        type=int,
        default=12,
        help="Maximum OpenReview venue-year groups to query (newest first)",
    )
    parser.add_argument(
        "--http-timeout",
        type=int,
        default=15,
        help="HTTP timeout in seconds per request",
    )
    parser.add_argument(
        "--openreview-browser-timeout",
        type=int,
        default=25,
        help="Timeout in seconds for Playwright OpenReview requests",
    )
    parser.add_argument(
        "--openreview-retries",
        type=int,
        default=2,
        help="Retries for transient OpenReview errors such as HTTP 429",
    )
    parser.add_argument(
        "--openreview-time-budget",
        type=int,
        default=90,
        help="Total time budget in seconds for OpenReview fetching",
    )
    return parser.parse_args()


def parse_date(value):
    if not value:
        return None
    return datetime.strptime(value, "%Y-%m-%d").date()


def timestamp_to_date(ts_ms):
    if not ts_ms:
        return None
    try:
        return datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).date()
    except Exception:
        return None


def in_date_range(date_obj, since, until):
    if date_obj is None:
        return True
    if since and date_obj < since:
        return False
    if until and date_obj > until:
        return False
    return True


def normalize_text(text):
    return re.sub(r"\s+", " ", (text or "").strip().lower())


def unwrap_value(value, default=None):
    if isinstance(value, dict):
        return value.get("value", default)
    return value if value is not None else default


def as_list(value):
    value = unwrap_value(value, default=[])
    if value is None:
        return []
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    text = str(value).strip()
    return [text] if text else []


def as_text(value):
    value = unwrap_value(value, default="")
    return re.sub(r"\s+", " ", str(value or "")).strip()


def tokenize_query(query):
    return [
        tok
        for tok in re.findall(r"[a-zA-Z0-9][a-zA-Z0-9+.#_-]*", query.lower())
        if len(tok) >= 2
    ]


def relevance_score(query, title, abstract, keywords=None):
    keywords = keywords or []
    combined = " ".join([title or "", abstract or "", " ".join(keywords)]).lower()
    tokens = tokenize_query(query)
    if not tokens:
        return 0

    score = 0
    phrase = normalize_text(query)
    if phrase and phrase in normalize_text(combined):
        score += 5

    for token in dict.fromkeys(tokens):
        if token in combined:
            score += 1

    return score


def build_arxiv_query(query):
    tokens = tokenize_query(query)
    if not tokens:
        return urllib.parse.quote(f'all:"{query}"')
    parts = [f"all:{token}" for token in tokens]
    return urllib.parse.quote(" AND ".join(parts))


def build_arxiv_sdk_query(query):
    tokens = tokenize_query(query)
    if not tokens:
        return f'all:"{query}"'
    return " AND ".join(f"all:{token}" for token in tokens)


def build_openreview_groups(since, until):
    current_year = datetime.now().year
    start_year = since.year if since else current_year - 1
    end_year = until.year if until else current_year
    if start_year > end_year:
        start_year, end_year = end_year, start_year

    groups = []
    for year in range(end_year, start_year - 1, -1):
        for prefix, label in OPENREVIEW_VENUES:
            groups.append(
                {
                    "group": f"{prefix}/{year}/Conference",
                    "label": f"{label} {year}",
                }
            )
    return groups


def build_openreview_search_url(group, query, limit=25):
    params = {
        "group": group,
        "term": query,
        "source": "forum",
        "sort": "tmdate:desc",
        "content": "all",
        "limit": str(limit),
    }
    return f"{OPENREVIEW_SEARCH}?{urllib.parse.urlencode(params)}"


def fetch_url(url, user_agent=DEFAULT_USER_AGENT, timeout=15):
    req = urllib.request.Request(url)
    req.add_header("User-Agent", user_agent)
    req.add_header("Accept", "application/json,text/html,application/xhtml+xml")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode()


def extract_json_payload_from_headless_dom(text):
    stripped = text.strip()
    if not stripped:
        raise ValueError("Empty response from headless browser")
    if stripped.startswith("{") or stripped.startswith("["):
        return json.loads(stripped)

    match = re.search(r"<pre[^>]*>(.*?)</pre>", stripped, re.S | re.I)
    if match:
        return json.loads(html.unescape(match.group(1)))

    start = stripped.find("{")
    end = stripped.rfind("}")
    if start != -1 and end != -1 and end > start:
        return json.loads(html.unescape(stripped[start : end + 1]))

    raise ValueError("Could not locate JSON payload in headless browser output")


def extract_json_payload_from_playwright_raw(text):
    stripped = text.strip()
    if not stripped:
        raise ValueError("Empty response from playwright-cli")

    try:
        decoded = json.loads(stripped)
        if isinstance(decoded, str):
            stripped = decoded.strip()
        else:
            return decoded
    except json.JSONDecodeError:
        pass

    return extract_json_payload_from_headless_dom(stripped)


def fetch_openreview_via_playwright_cli(url, timeout=25):
    playwright_cli = shutil.which("playwright-cli")
    if not playwright_cli:
        raise RuntimeError("playwright-cli command was not found in PATH")

    timeout_ms = max(timeout, 1) * 1000
    script = (
        "async page => { "
        f"await page.goto({json.dumps(url)}, "
        f"{{ waitUntil: 'domcontentloaded', timeout: {timeout_ms} }}); "
        f"return await page.locator('body').innerText({{ timeout: {timeout_ms} }}); "
        "}"
    )

    open_proc = subprocess.run(
        [
            playwright_cli,
            f"-s={PLAYWRIGHT_SESSION}",
            "open",
            "--browser=chrome",
            "about:blank",
        ],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if open_proc.returncode != 0:
        detail = (open_proc.stderr or open_proc.stdout).strip()
        raise RuntimeError(f"Failed to open playwright-cli browser: {detail}")

    try:
        proc = subprocess.run(
            [
                playwright_cli,
                f"-s={PLAYWRIGHT_SESSION}",
                "--raw",
                "run-code",
                script,
            ],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=True,
        )
        return extract_json_payload_from_playwright_raw(proc.stdout)
    finally:
        subprocess.run(
            [playwright_cli, f"-s={PLAYWRIGHT_SESSION}", "close"],
            capture_output=True,
            text=True,
            timeout=10,
        )


def retry_seconds_from_429_detail(detail):
    if not detail:
        return 3
    match = re.search(r"try again in\s+(\d+)\s+seconds", detail, re.I)
    if match:
        return max(int(match.group(1)), 1)
    return 3


def fetch_openreview_payload(url, http_timeout=15, browser_timeout=25, retries=2):
    _ = http_timeout
    attempts = max(retries + 1, 1)
    last_error = None
    for attempt in range(1, attempts + 1):
        try:
            return fetch_openreview_via_playwright_cli(url, timeout=browser_timeout)
        except (
            subprocess.CalledProcessError,
            subprocess.TimeoutExpired,
            ValueError,
            RuntimeError,
            json.JSONDecodeError,
        ) as exc:
            last_error = exc
            if attempt < attempts:
                time.sleep(min(1 + attempt, 3))
                continue
            raise RuntimeError(f"OpenReview Playwright request failed: {exc}") from exc
    raise RuntimeError(f"OpenReview request failed after retries: {last_error}")


def normalize_openreview_note(note, fallback_label, query):
    content = note.get("content") or note.get("forumContent") or {}
    if not content:
        return None

    title_val = as_text(content.get("title"))
    abstract_val = as_text(content.get("abstract"))
    authors_val = as_list(content.get("authors"))
    keywords_val = as_list(content.get("keywords"))
    venue_val = as_text(content.get("venue"))
    venueid_val = as_text(content.get("venueid"))

    venue_text_lower = normalize_text(f"{venue_val} {venueid_val}")
    if any(word in venue_text_lower for word in ["rejected", "withdrawn"]):
        return None

    forum_id = note.get("forum") or note.get("id") or ""
    paper_url = f"https://openreview.net/forum?id={forum_id}" if forum_id else ""

    published_date = None
    for key in ["pdate", "cdate", "tcdate", "tmdate", "mdate", "odate"]:
        published_date = timestamp_to_date(note.get(key))
        if published_date:
            break

    score = relevance_score(query, title_val, abstract_val, keywords_val)
    if not title_val or score <= 0:
        return None

    return {
        "id": f"openreview:{forum_id}"
        if forum_id
        else f"openreview:{fallback_label}:{title_val}",
        "title": title_val,
        "authors": authors_val,
        "abstract": abstract_val,
        "published_date": published_date.isoformat() if published_date else "",
        "source": "openreview",
        "venue": venue_val or venueid_val or fallback_label,
        "paper_url": paper_url,
        "keywords": keywords_val,
        "relevance_score": score,
    }


def fetch_openreview(
    group,
    label,
    query,
    since=None,
    until=None,
    limit=25,
    http_timeout=15,
    browser_timeout=25,
    retries=2,
):
    url = build_openreview_search_url(group=group, query=query, limit=limit)
    try:
        data = fetch_openreview_payload(
            url,
            http_timeout=http_timeout,
            browser_timeout=browser_timeout,
            retries=retries,
        )
    except Exception as e:
        print(f"[WARN] Failed to fetch {label} from OpenReview: {e}", file=sys.stderr)
        return []

    papers = []
    for note in data.get("notes", []):
        paper = normalize_openreview_note(note=note, fallback_label=label, query=query)
        if not paper:
            continue
        published_date = parse_date(paper.get("published_date"))
        if not in_date_range(published_date, since, until):
            continue
        papers.append(paper)
    return papers


def normalize_arxiv_sdk_result(result, query):
    title = re.sub(r"\s+", " ", getattr(result, "title", "") or "").strip()
    abstract = re.sub(r"\s+", " ", getattr(result, "summary", "") or "").strip()
    paper_url = (getattr(result, "entry_id", "") or "").strip()
    if paper_url.startswith("http://arxiv.org/"):
        paper_url = "https://" + paper_url[len("http://") :]
    arxiv_short = paper_url.split("/abs/")[-1] if "/abs/" in paper_url else paper_url

    published_value = getattr(result, "published", None)
    published_date = published_value.date() if hasattr(published_value, "date") else None
    authors = [
        author.name.strip()
        for author in getattr(result, "authors", []) or []
        if getattr(author, "name", "").strip()
    ]
    categories = [
        str(category).strip()
        for category in getattr(result, "categories", []) or []
        if str(category).strip()
    ]

    score = relevance_score(query, title, abstract, categories)
    if not title or score <= 0:
        return None

    journal_ref = getattr(result, "journal_ref", None)
    return {
        "id": f"arxiv:{arxiv_short}",
        "title": title,
        "authors": authors,
        "abstract": abstract,
        "published_date": published_date.isoformat() if published_date else "",
        "source": "arxiv",
        "venue": journal_ref.strip() if journal_ref else "arXiv preprint",
        "paper_url": paper_url,
        "keywords": categories,
        "relevance_score": score,
    }


def strip_html_tags(value):
    value = re.sub(r"<script.*?</script>", " ", value or "", flags=re.S | re.I)
    value = re.sub(r"<style.*?</style>", " ", value, flags=re.S | re.I)
    value = re.sub(r"<[^>]+>", " ", value)
    return re.sub(r"\s+", " ", html.unescape(value)).strip()


def parse_arxiv_web_date(block):
    text = strip_html_tags(block)
    match = re.search(r"Submitted\s+(\d{1,2}\s+[A-Za-z]+,\s+\d{4})", text)
    if not match:
        return None
    try:
        return datetime.strptime(match.group(1), "%d %B, %Y").date()
    except ValueError:
        return None


def normalize_arxiv_web_result(block, query):
    id_match = re.search(
        r'<a\s+href="(https://arxiv\.org/abs/([^"]+))">arXiv:[^<]+</a>',
        block,
        flags=re.S,
    )
    if not id_match:
        return None

    paper_url = id_match.group(1)
    arxiv_short = id_match.group(2)
    title_match = re.search(r'<p\s+class="title[^"]*"[^>]*>(.*?)</p>', block, re.S)
    title = strip_html_tags(title_match.group(1)) if title_match else ""

    authors = []
    authors_match = re.search(r'<p\s+class="authors"[^>]*>(.*?)</p>', block, re.S)
    if authors_match:
        authors = [
            strip_html_tags(author)
            for author in re.findall(r"<a\s+[^>]*>(.*?)</a>", authors_match.group(1), re.S)
        ]
        authors = [author for author in authors if author]

    abstract_match = re.search(
        r'<span\s+class="abstract-full[^"]*"[^>]*>(.*?)<a\s+class="is-size-7"',
        block,
        re.S,
    )
    if not abstract_match:
        abstract_match = re.search(r'<p\s+class="abstract[^"]*"[^>]*>(.*?)</p>', block, re.S)
    abstract = strip_html_tags(abstract_match.group(1)) if abstract_match else ""
    abstract = re.sub(r"^Abstract\s*:\s*", "", abstract).strip()

    categories = [
        strip_html_tags(category)
        for category in re.findall(r'<span\s+class="tag[^"]*"[^>]*>(.*?)</span>', block, re.S)
    ]
    categories = [category for category in categories if category]
    published_date = parse_arxiv_web_date(block)

    score = relevance_score(query, title, abstract, categories)
    if not title or score <= 0:
        return None

    return {
        "id": f"arxiv:{arxiv_short}",
        "title": title,
        "authors": authors,
        "abstract": abstract,
        "published_date": published_date.isoformat() if published_date else "",
        "source": "arxiv",
        "venue": "arXiv preprint",
        "paper_url": paper_url,
        "keywords": categories,
        "relevance_score": score,
    }


def parse_arxiv_web_search_page(data, query, since=None, until=None, max_results=50):
    papers = []
    blocks = re.findall(r'<li\s+class="arxiv-result"[^>]*>(.*?)</li>', data, re.S)
    for block in blocks:
        paper = normalize_arxiv_web_result(block, query=query)
        if not paper:
            continue
        published_date = parse_date(paper.get("published_date"))
        if not in_date_range(published_date, since, until):
            continue
        papers.append(paper)
        if len(papers) >= max_results:
            break
    return papers


def build_arxiv_web_search_url(query, max_results=50):
    if max_results <= 25:
        size = 25
    elif max_results <= 50:
        size = 50
    elif max_results <= 100:
        size = 100
    else:
        size = 200

    params = {
        "query": query,
        "searchtype": "all",
        "size": str(size),
    }
    return f"https://arxiv.org/search/?{urllib.parse.urlencode(params)}"


def fetch_arxiv_via_sdk(query, since=None, until=None, max_results=50):
    if max_results <= 0:
        return []

    import arxiv

    search = arxiv.Search(
        query=build_arxiv_sdk_query(query),
        max_results=max_results,
        sort_by=arxiv.SortCriterion.SubmittedDate,
        sort_order=arxiv.SortOrder.Descending,
    )
    client = arxiv.Client(
        page_size=max(1, min(max_results, 100)),
        delay_seconds=3.0,
        num_retries=3,
    )

    papers = []
    for result in client.results(search):
        paper = normalize_arxiv_sdk_result(result, query=query)
        if not paper:
            continue
        published_date = parse_date(paper.get("published_date"))
        if not in_date_range(published_date, since, until):
            continue
        papers.append(paper)
    return papers


def fetch_arxiv_via_rest(query, since=None, until=None, max_results=50, http_timeout=15):
    search_query = build_arxiv_query(query)
    url = (
        f"{ARXIV_API}?search_query={search_query}"
        f"&sortBy=submittedDate&sortOrder=descending&max_results={max_results}"
    )
    try:
        data = fetch_url(url, timeout=http_timeout)
    except Exception as e:
        print(f"[WARN] Failed to fetch arXiv: {e}", file=sys.stderr)
        return []

    ns = {
        "a": "http://www.w3.org/2005/Atom",
        "arxiv": "http://arxiv.org/schemas/atom",
    }
    root = ET.fromstring(data)

    papers = []
    for entry in root.findall("a:entry", ns):
        published_text = entry.findtext("a:published", default="", namespaces=ns)
        published_date = None
        if published_text:
            published_date = datetime.strptime(published_text[:10], "%Y-%m-%d").date()
        if not in_date_range(published_date, since, until):
            continue

        title = re.sub(
            r"\s+", " ", entry.findtext("a:title", default="", namespaces=ns)
        ).strip()
        abstract = re.sub(
            r"\s+", " ", entry.findtext("a:summary", default="", namespaces=ns)
        ).strip()
        paper_url = entry.findtext("a:id", default="", namespaces=ns).strip()
        if paper_url.startswith("http://arxiv.org/"):
            paper_url = "https://" + paper_url[len("http://") :]
        arxiv_short = (
            paper_url.split("/abs/")[-1] if "/abs/" in paper_url else paper_url
        )

        authors = []
        for author in entry.findall("a:author", ns):
            name = author.findtext("a:name", default="", namespaces=ns).strip()
            if name:
                authors.append(name)

        categories = [
            c.attrib.get("term", "")
            for c in entry.findall("a:category", ns)
            if c.attrib.get("term")
        ]
        score = relevance_score(query, title, abstract, categories)
        if score <= 0:
            continue

        journal_ref = entry.findtext("arxiv:journal_ref", default="", namespaces=ns)

        papers.append(
            {
                "id": f"arxiv:{arxiv_short}",
                "title": title,
                "authors": authors,
                "abstract": abstract,
                "published_date": published_date.isoformat() if published_date else "",
                "source": "arxiv",
                "venue": journal_ref.strip() if journal_ref else "arXiv preprint",
                "paper_url": paper_url,
                "keywords": categories,
                "relevance_score": score,
            }
        )

    return papers


def fetch_arxiv_via_web(query, since=None, until=None, max_results=50, http_timeout=15):
    if max_results <= 0:
        return []

    url = build_arxiv_web_search_url(query=query, max_results=max_results)
    data = fetch_url(url, timeout=http_timeout)
    return parse_arxiv_web_search_page(
        data=data,
        query=query,
        since=since,
        until=until,
        max_results=max_results,
    )


def fetch_arxiv(query, since=None, until=None, max_results=50, http_timeout=15):
    try:
        sdk_papers = fetch_arxiv_via_sdk(
            query=query,
            since=since,
            until=until,
            max_results=max_results,
        )
        if sdk_papers:
            return sdk_papers
        print(
            "[INFO] arXiv SDK returned 0 matched papers; trying REST API",
            file=sys.stderr,
        )
    except ImportError:
        print(
            "[WARN] arXiv SDK package is unavailable; falling back to REST API",
            file=sys.stderr,
        )
    except Exception as e:
        print(
            f"[WARN] Failed to fetch arXiv via SDK: {e}; falling back to REST API",
            file=sys.stderr,
        )

    rest_papers = fetch_arxiv_via_rest(
        query=query,
        since=since,
        until=until,
        max_results=max_results,
        http_timeout=http_timeout,
    )
    if rest_papers:
        return rest_papers

    try:
        print(
            "[INFO] arXiv REST returned 0 matched papers; trying web search fallback",
            file=sys.stderr,
        )
        return fetch_arxiv_via_web(
            query=query,
            since=since,
            until=until,
            max_results=max_results,
            http_timeout=http_timeout,
        )
    except Exception as e:
        print(f"[WARN] Failed to fetch arXiv via web search: {e}", file=sys.stderr)
        return []


def source_priority(paper):
    return 2 if paper.get("source") == "openreview" else 1


def venue_priority(paper):
    venue = normalize_text(paper.get("venue", ""))
    if paper.get("source") != "openreview":
        return 0
    if "oral" in venue:
        return 5
    if "spotlight" in venue:
        return 4
    if "poster" in venue:
        return 3
    if any(word in venue for word in ["accepted", "notable", "top 5%"]):
        return 2
    return 1


def paper_sort_key(paper):
    return (
        source_priority(paper),
        venue_priority(paper),
        paper.get("relevance_score", 0),
        paper.get("published_date", ""),
    )


def sort_papers_for_output(papers):
    return sorted(papers, key=paper_sort_key, reverse=True)


def choose_better(existing, new):
    return new if paper_sort_key(new) > paper_sort_key(existing) else existing


def dedupe_papers(papers):
    by_title = {}
    for paper in papers:
        key = normalize_text(paper.get("title", ""))
        if not key:
            continue
        if key in by_title:
            by_title[key] = choose_better(by_title[key], paper)
        else:
            by_title[key] = paper
    return list(by_title.values())


def main():
    args = parse_args()
    since = parse_date(args.since) or DEFAULT_SINCE
    until = parse_date(args.until) or datetime.now().date()

    if since and until and since > until:
        print("[ERROR] since must be earlier than or equal to until", file=sys.stderr)
        sys.exit(1)

    all_papers = []

    if "openreview" in args.sources:
        groups = build_openreview_groups(since, until)
        if args.openreview_max_groups >= 0:
            groups = groups[: args.openreview_max_groups]

        openreview_start_ts = time.monotonic()
        early_stop_threshold = max(args.max_results, 0) * 3

        for conf in groups:
            elapsed = time.monotonic() - openreview_start_ts
            if (
                args.openreview_time_budget > 0
                and elapsed >= args.openreview_time_budget
            ):
                print(
                    "[WARN] OpenReview time budget reached; stop fetching more groups",
                    file=sys.stderr,
                )
                break

            papers = fetch_openreview(
                conf["group"],
                conf["label"],
                query=args.query,
                since=since,
                until=until,
                limit=args.openreview_limit,
                http_timeout=args.http_timeout,
                browser_timeout=args.openreview_browser_timeout,
                retries=args.openreview_retries,
            )
            all_papers.extend(papers)
            print(
                f"[INFO] OpenReview {conf['label']}: fetched {len(papers)} matched papers",
                file=sys.stderr,
            )

            if early_stop_threshold > 0:
                unique_count = len(dedupe_papers(all_papers))
                if unique_count >= early_stop_threshold:
                    print(
                        "[INFO] OpenReview early stop: collected enough candidates",
                        file=sys.stderr,
                    )
                    break

    if "arxiv" in args.sources:
        arxiv_papers = fetch_arxiv(
            query=args.query,
            since=since,
            until=until,
            max_results=args.arxiv_max_results,
            http_timeout=args.http_timeout,
        )
        all_papers.extend(arxiv_papers)
        print(
            f"[INFO] arXiv: fetched {len(arxiv_papers)} matched papers", file=sys.stderr
        )

    unique_papers = dedupe_papers(all_papers)
    final_papers = sort_papers_for_output(unique_papers)[: max(args.max_results, 0)]

    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    json.dump(final_papers, sys.stdout, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
