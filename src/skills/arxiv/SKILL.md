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
    related_skills: [research-project-workflow, paper-search, pdf-to-markdown]
---

# arXiv Metadata

## When To Use
- 已有 arXiv ID，需要核验标题、作者、摘要、版本、分类或链接
- 需要为 arXiv 论文生成 BibTeX
- 需要查看 arXiv abstract/PDF 页面内容
- 需要用 Semantic Scholar 查询引用数、参考文献、被引论文或作者信息

优先用 `paper-search` 做主题级论文搜索；本 skill 只处理已知论文或少量精确查询。

## Workflow Integration
- 在完整论文项目中，先由 `research-project-workflow` 收集候选论文并维护 `workspace/ref_papers/source.json`。
- 本 skill 用于核验已选论文的 arXiv ID、版本、标题、作者、BibTeX、引用数和参考文献信息。
- 若 `source.json` 存在，把核验结果作为字段补充进去；不要用本 skill 重新做大范围主题搜索。
- PDF 下载和 PDF 转 Markdown 由 `research-project-workflow` 负责安排，并优先使用全局 `pdf-to-markdown` skill。

## Helper Script
在 skill 目录运行：
```bash
python scripts/search_arxiv.py --id 1706.03762
python scripts/search_arxiv.py --id 1706.03762 --bibtex
python scripts/search_arxiv.py --id 1706.03762,2402.03300
```

如果 arXiv Atom API 返回 `429`，脚本会对 `--id` 查询自动 fallback 到 `arxiv.org/abs/{id}` 页面解析基础元数据和 BibTeX。

少量精确查询也可用，但不要替代 `paper-search` 的主题搜索：
```bash
python scripts/search_arxiv.py --author "Yann LeCun" --max 5
python scripts/search_arxiv.py --category cs.LG --sort date --max 5
```

## Read Pages
使用当前 OpenCode 的 `webfetch` 工具读取页面：
```text
https://arxiv.org/abs/{id}
https://arxiv.org/pdf/{id}
https://arxiv.org/html/{id}
```

规则：
- 摘要页优先用 `https://arxiv.org/abs/{id}`
- PDF 仅用于需要正文时读取
- HTML 页面不一定存在；失败时回到 PDF 或摘要页

## BibTeX Requirements
生成 BibTeX 时包含：
- `title`
- `author`
- `year`
- `eprint`
- `archivePrefix = {arXiv}`
- `primaryClass`
- `url`

保留用户给出的版本后缀，例如 `1706.03762v7`；如果用户只给基础 ID，则使用 API 返回的最新版本。

## Semantic Scholar
arXiv 不提供引用数据。需要引用、参考文献、相关论文或作者指标时，用 Semantic Scholar 公共 API。

论文详情：
```bash
curl -s "https://api.semanticscholar.org/graph/v1/paper/arXiv:2402.03300?fields=title,authors,citationCount,referenceCount,influentialCitationCount,year,abstract,externalIds" | python3 -m json.tool
```

被引论文：
```bash
curl -s "https://api.semanticscholar.org/graph/v1/paper/arXiv:2402.03300/citations?fields=title,authors,year,citationCount&limit=10" | python3 -m json.tool
```

参考文献：
```bash
curl -s "https://api.semanticscholar.org/graph/v1/paper/arXiv:2402.03300/references?fields=title,authors,year,citationCount&limit=10" | python3 -m json.tool
```

作者检索：
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
