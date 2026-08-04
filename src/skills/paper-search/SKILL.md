---
name: paper-search
description: |-
  搜索并整理 OpenReview 与 arXiv 论文候选，按用户给定主题、时间范围和数据源返回结构化结果。Use proactively when 用户要求找论文、限定时间范围、优先看 OpenReview/arXiv、或需要 3区/4区方向样例。

  Examples:
  - user: "找 2026 年 diffusion model 论文" → 运行 fetch_papers.py 并整理结果
  - user: "只看 arXiv 上 transformer attention 的最新论文" → 用 --sources arxiv 查询
  - user: "这个方向 3区/4区论文长什么样" → 检索候选论文并提示需核验期刊分区
license: MIT
metadata:
  hermes:
    tags: [research, papers, openreview, arxiv, search]
    category: research
    related_skills: [research-project-workflow, arxiv, pdf-to-markdown]
---

# Paper Search

## When To Use
- 用户要求按研究方向搜索论文
- 用户要求限定论文时间范围、返回条数或数据源
- 用户要求优先查看 OpenReview 或 arXiv 结果
- 用户需要结构化论文列表，便于后续阅读、筛选或总结
- 用户想查看某个方向在 3区/4区等目标期刊中的论文样例、实验规模或写法

## Workflow Integration
- 在完整论文项目中，先由 `research-project-workflow` 统筹目录和阶段顺序，再调用本 skill 搜索候选论文。
- 本 skill 只负责返回候选论文列表；PDF 下载、文本转换、实验和正文写作不在本 skill 内完成。
- 若工作流目录存在，把脚本 JSON 输出整理或保存到 `workspace/ref_papers/source.json`。
- 对最终选中的 arXiv 论文，用 `arxiv` skill 进一步核验 ID、版本、BibTeX 和引用信息。
- 若需要把公开 PDF 转为 Markdown，交给 `research-project-workflow` 调用全局 `pdf-to-markdown` skill。

## Inputs
从用户请求中提取以下信息：
- 搜索方向 / 主题（必需）
- 起始日期 `since`（可选，格式 `YYYY-MM-DD`；默认 `2026-01-01`）
- 结束日期 `until`（可选，格式 `YYYY-MM-DD`；默认当前日期）
- 返回条数 `max-results`（可选，默认 10）
- 数据源 `sources`（可选，默认同时搜索 `openreview` 与 `arxiv`）

默认场景下只需要传 `query`，其余参数按默认值工作即可；仅在用户明确要求时再补充时间范围、数据源或返回条数。

如果用户没有明确给出搜索方向，先补问；如果没有给出时间范围，则默认使用 `2026-01-01` 到当前日期。

## Commands
优先使用用户 PATH 中的快速命令；该命令会调用本 skill 自带 `.venv`，确保 arXiv 查询走 `arxiv` Python SDK：
```bash
paper-search \
  --query "{topic}" \
  --since "{since}" \
  --until "{until}" \
  --max-results 10
```

最简调用（推荐默认）：
```bash
paper-search --query "{topic}"
```

如果不是在 Skill 目录内运行，使用绝对路径：
```bash
/mnt/disk2/home/cyy/.config/opencode/skills/paper-search/.venv/bin/python \
  /mnt/disk2/home/cyy/.config/opencode/skills/paper-search/scripts/fetch_papers.py \
  --query "{topic}"
```

若 `.venv` 不存在或缺少依赖，先在 Skill 目录运行：
```bash
python -m venv .venv
.venv/bin/python -m pip install arxiv
```

若 OpenReview 抓取不可用，先确保 `playwright-cli` 可用，并优先使用本机 Chrome Stable：
```bash
playwright-cli open --browser=chrome https://example.com
```

可选参数：
```bash
# 只搜索 OpenReview
paper-search --query "{topic}" --since "{since}" --until "{until}" --sources openreview

# 只搜索 arXiv
paper-search --query "{topic}" --since "{since}" --until "{until}" --sources arxiv

# 调整返回条数
paper-search --query "{topic}" --since "{since}" --until "{until}" --max-results 20
```

## Advanced Options
常规使用不需要填写这些参数；仅在需要控制速度、覆盖范围或稳定性时使用：
- `--openreview-max-groups`（默认 `12`）：限制 OpenReview 最多查询多少个会议-年份分组（按新到旧）。值越小越快，覆盖范围越窄。
- `--http-timeout`（默认 `15` 秒）：OpenReview、arXiv REST fallback 和 arXiv web-search fallback 的单次 HTTP 请求超时；arXiv SDK 自带重试与请求节流。
- `--openreview-browser-timeout`（默认 `25` 秒）：OpenReview 通过 `playwright-cli` 抓取时的单次请求超时。
- `--openreview-retries`（默认 `2`）：OpenReview Playwright 抓取失败时的重试次数。
- `--openreview-time-budget`（默认 `90` 秒）：OpenReview 全部抓取的总时间预算；达到后提前停止后续分组抓取。

常见调优示例：
```bash
# 快速模式：优先低延迟
paper-search --query "{topic}" --openreview-max-groups 8 --openreview-time-budget 60 --openreview-browser-timeout 15 --http-timeout 10

# 覆盖优先：允许更长抓取窗口
paper-search --query "{topic}" --openreview-max-groups 20 --openreview-time-budget 150 --openreview-browser-timeout 35 --openreview-retries 3
```

## Script Behavior
- 根据用户给定主题构造 arXiv 检索语句，并优先通过 `.venv` 中的 `arxiv` Python SDK 检索
- 若 `arxiv` SDK 不可用或请求失败，自动降级到原始 arXiv REST API 路径；若 REST 也无结果，再尝试 arXiv 网页搜索 fallback
- 根据 OpenReview API 文档使用 `notes/search`，并显式传入 `term` 参数抓取候选论文
- 根据用户给定时间范围生成 OpenReview 候选会议列表并抓取论文
- OpenReview 默认按较新的会议年份优先抓取，并带有浏览器抓取重试与总时长预算，降低失败风险
- OpenReview 统一通过 `playwright-cli` 管理的浏览器抓取 JSON，避免终端直连 API 在部分环境下被 403 拒绝
- 对 OpenReview 结果做本地标准化与时间过滤
- 对结果按标题去重，并优先保留 OpenReview 来源与更完整的来源信息
- 输出排序优先展示 OpenReview 论文，再展示 arXiv 论文
- 返回 JSON 列表，供 Skill 整理输出

## Output Format
Skill 返回格式：
```
### 检索结果
#### 1. {title}
- 作者: {authors}
- 发表日期: {published_date}
- 来源: {source}
- 会议/期刊: {venue}
- 论文URL: {paper_url}
- 摘要: {abstract}
```

输出要求：
- `来源` 只能写 `openreview` 或 `arxiv`
- `会议/期刊` 必须尽量写详细名称，例如 `ICLR 2026 Poster`、`NeurIPS 2025 Oral`、`arXiv preprint`、具体 `journal_ref`
- `论文URL` 必须是论文主页链接，不要输出 PDF 链接
- 作者列表过长时可做适度截断，但不要遗漏第一作者
- 若无结果，明确说明“在给定方向与时间范围内未找到匹配论文”

## Edge Cases
- 无匹配结果：返回“在给定方向与时间范围内未找到匹配论文”
- 单一数据源失败：保留另一个数据源的结果，并说明部分来源抓取失败
- OpenReview 会议不存在或接口不可用：跳过对应会议并继续搜索
- 用户时间范围非法（`since > until`）：提示用户修正时间范围
- 若机器缺少可用的 `playwright-cli` 或 Chrome Stable：提示安装或修复本机 Chrome，并用 `playwright-cli open --browser=chrome https://example.com` 验证

## Review Rules
- 将脚本结果视为候选池；主题很窄或 OpenReview 结果明显泛化时，手动剔除弱相关论文
- 严格同名论文稀缺时，说明“严格等价项稀缺”，再搜索相邻关键词
- 做方向调研时，可把 OpenReview/arXiv 用作前沿信号；需要期刊、综述或引用量时再补充其他公开来源
- 涉及 3区/4区样例时，必须说明分区口径需要用用户机构认可的最新 JCR/CAS/期刊官网信息核验

## Constraints
- 不在 Skill 内固定研究方向
- 若用户未指定时间范围，默认使用 `2026-01-01` 到当前日期
- 搜索方向由用户决定
- OpenReview / arXiv 接口均为公开接口；若个别接口失败，Skill 应优雅降级
- 输出结果必须包含标题、作者、发表日期、来源、会议/期刊名称与非 PDF 论文链接

## Directory Structure
```
paper-search
├─ .venv/
├─ SKILL.md
├─ references
│  └─ test_fetch_papers.py
└─ scripts
   └─ fetch_papers.py
```
