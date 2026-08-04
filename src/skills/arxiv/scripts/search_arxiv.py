#!/usr/bin/env python3
"""Retrieve arXiv metadata and display results in a clean format.

Usage:
    python search_arxiv.py --id 2402.03300
    python search_arxiv.py --id 1706.03762 --bibtex
    python search_arxiv.py --id 2402.03300,2401.12345
    python search_arxiv.py --author "Yann LeCun" --max 5
    python search_arxiv.py --category cs.AI --sort date --max 10
"""
import html
import re
import sys
import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET

NS = {
    'a': 'http://www.w3.org/2005/Atom',
    'arxiv': 'http://arxiv.org/schemas/atom',
}


def clean_text(text):
    return ' '.join((text or '').strip().split())


def fetch_url(url, timeout=15):
    req = urllib.request.Request(url, headers={'User-Agent': 'HermesAgent/1.0'})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def arxiv_id_from_entry(entry):
    raw_id = entry.find('a:id', NS).text.strip()
    return raw_id.split('/abs/')[-1] if '/abs/' in raw_id else raw_id


def base_arxiv_id(full_id):
    if 'v' in full_id and full_id.rsplit('v', 1)[-1].isdigit():
        return full_id.rsplit('v', 1)[0]
    return full_id


def format_bibtex(entry):
    title = clean_text(entry.find('a:title', NS).text)
    authors = ' and '.join(
        clean_text(author.find('a:name', NS).text)
        for author in entry.findall('a:author', NS)
    )
    year = entry.find('a:published', NS).text[:4]
    full_id = arxiv_id_from_entry(entry)
    primary = entry.find('arxiv:primary_category', NS)
    primary_class = primary.get('term') if primary is not None else ''
    first_author = entry.find('a:author', NS).find('a:name', NS).text
    last_name = clean_text(first_author).split()[-1]
    key = f"{last_name}{year}_{full_id.replace('.', '').replace('/', '')}"

    return "\n".join([
        f"@article{{{key},",
        f"  title         = {{{title}}},",
        f"  author        = {{{authors}}},",
        f"  year          = {{{year}}},",
        f"  eprint        = {{{full_id}}},",
        "  archivePrefix = {arXiv},",
        f"  primaryClass  = {{{primary_class}}},",
        f"  url           = {{https://arxiv.org/abs/{full_id}}}",
        "}",
    ])


def meta_values(page, name):
    pattern = rf'<meta\s+name="{re.escape(name)}"\s+content="(.*?)"\s*/?>'
    return [html.unescape(match).strip() for match in re.findall(pattern, page, re.S)]


def category_codes(page):
    match = re.search(r'<span\s+class="primary-subject">(.*?)</span>', page, re.S)
    if not match:
        return []
    text = clean_text(re.sub(r'<[^>]+>', ' ', html.unescape(match.group(1))))
    codes = re.findall(r'\(([^()]+)\)', text)
    return codes or [text]


def web_metadata(arxiv_id):
    requested_id = arxiv_id.strip()
    url_id = urllib.parse.quote(requested_id, safe='/')
    page = fetch_url(f"https://arxiv.org/abs/{url_id}", timeout=30).decode()
    citation_id = (meta_values(page, 'citation_arxiv_id') or [requested_id])[0]
    effective_id = requested_id if re.search(r'v\d+$', requested_id) else citation_id
    authors = meta_values(page, 'citation_author')
    date = (meta_values(page, 'citation_date') or [''])[0]
    year = date[:4] if date else ''

    return {
        'id': effective_id,
        'title': (meta_values(page, 'citation_title') or [''])[0],
        'authors': authors,
        'year': year,
        'published': date.replace('/', '-') if date else '',
        'abstract': (meta_values(page, 'citation_abstract') or [''])[0],
        'categories': category_codes(page),
    }


def format_web_bibtex(meta):
    first_author = meta['authors'][0] if meta['authors'] else 'arXiv'
    last_name = clean_text(first_author).split(',')[0].split()[-1]
    key = f"{last_name}{meta['year']}_{meta['id'].replace('.', '').replace('/', '')}"
    primary_class = meta['categories'][0] if meta['categories'] else ''
    return "\n".join([
        f"@article{{{key},",
        f"  title         = {{{meta['title']}}},",
        f"  author        = {{{' and '.join(meta['authors'])}}},",
        f"  year          = {{{meta['year']}}},",
        f"  eprint        = {{{meta['id']}}},",
        "  archivePrefix = {arXiv},",
        f"  primaryClass  = {{{primary_class}}},",
        f"  url           = {{https://arxiv.org/abs/{meta['id']}}}",
        "}",
    ])


def print_web_metadata(meta, index):
    print(f"{index}. {meta['title']}")
    print(f"   ID: {meta['id']} | Published: {meta['published']}")
    print(f"   Authors: {', '.join(meta['authors'])}")
    print(f"   Categories: {', '.join(meta['categories'])}")
    print(f"   Abstract: {meta['abstract'][:300]}{'...' if len(meta['abstract']) > 300 else ''}")
    print(f"   Links: https://arxiv.org/abs/{meta['id']} | https://arxiv.org/pdf/{meta['id']}")
    print()


def search_ids_via_abs_pages(ids, bibtex=False):
    for index, arxiv_id in enumerate([item.strip() for item in ids.split(',') if item.strip()], start=1):
        meta = web_metadata(arxiv_id)
        if bibtex:
            print(format_web_bibtex(meta))
            print()
        else:
            print_web_metadata(meta, index)


def search(query=None, author=None, category=None, ids=None, max_results=5, sort="relevance", bibtex=False):
    params = {}
    
    if ids:
        params['id_list'] = ids
    else:
        parts = []
        if query:
            parts.append(f'all:{urllib.parse.quote(query)}')
        if author:
            parts.append(f'au:{urllib.parse.quote(author)}')
        if category:
            parts.append(f'cat:{category}')
        if not parts:
            print("Error: provide a query, --author, --category, or --id")
            sys.exit(1)
        params['search_query'] = '+AND+'.join(parts)
    
    params['max_results'] = str(max_results)
    
    sort_map = {"relevance": "relevance", "date": "submittedDate", "updated": "lastUpdatedDate"}
    params['sortBy'] = sort_map.get(sort, sort)
    params['sortOrder'] = 'descending'
    
    url = "https://export.arxiv.org/api/query?" + "&".join(f"{k}={v}" for k, v in params.items())
    
    try:
        data = fetch_url(url, timeout=15)
    except Exception as exc:
        if ids:
            print(
                f"[WARN] arXiv API failed ({exc}); trying arxiv.org abstract pages",
                file=sys.stderr,
            )
            search_ids_via_abs_pages(ids, bibtex=bibtex)
            return
        print(f"Error: arXiv API request failed: {exc}", file=sys.stderr)
        sys.exit(2)
    
    root = ET.fromstring(data)
    entries = root.findall('a:entry', NS)
    
    if not entries:
        print("No results found.")
        return
    
    total = root.find('{http://a9.com/-/spec/opensearch/1.1/}totalResults')
    if total is not None and not bibtex:
        print(f"Found {total.text} results (showing {len(entries)})\n")
     
    for i, entry in enumerate(entries):
        if bibtex:
            print(format_bibtex(entry))
            print()
            continue

        title = clean_text(entry.find('a:title', NS).text)
        full_id = arxiv_id_from_entry(entry)
        arxiv_id = base_arxiv_id(full_id)
        published = entry.find('a:published', NS).text[:10]
        updated = entry.find('a:updated', NS).text[:10]
        authors = ', '.join(clean_text(a.find('a:name', NS).text) for a in entry.findall('a:author', NS))
        summary = clean_text(entry.find('a:summary', NS).text)
        cats = ', '.join(c.get('term') for c in entry.findall('a:category', NS))
         
        print(f"{i+1}. {title}")
        print(f"   ID: {full_id} | Published: {published} | Updated: {updated}")
        print(f"   Authors: {authors}")
        print(f"   Categories: {cats}")
        print(f"   Abstract: {summary[:300]}{'...' if len(summary) > 300 else ''}")
        print(f"   Links: https://arxiv.org/abs/{arxiv_id} | https://arxiv.org/pdf/{arxiv_id}")
        print()


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        sys.exit(0)
    
    query = None
    author = None
    category = None
    ids = None
    max_results = 5
    sort = "relevance"
    bibtex = False
    
    i = 0
    positional = []
    while i < len(args):
        if args[i] == "--max" and i + 1 < len(args):
            max_results = int(args[i + 1]); i += 2
        elif args[i] == "--sort" and i + 1 < len(args):
            sort = args[i + 1]; i += 2
        elif args[i] == "--author" and i + 1 < len(args):
            author = args[i + 1]; i += 2
        elif args[i] == "--category" and i + 1 < len(args):
            category = args[i + 1]; i += 2
        elif args[i] == "--id" and i + 1 < len(args):
            ids = args[i + 1]; i += 2
        elif args[i] == "--bibtex":
            bibtex = True; i += 1
        else:
            positional.append(args[i]); i += 1
    
    if positional:
        query = " ".join(positional)
    
    search(query=query, author=author, category=category, ids=ids, max_results=max_results, sort=sort, bibtex=bibtex)
