# Agent 与 Skill 定制

[English](./agent-customization.md)

最简单的定制方式是直接让研究助手处理：

```text
/customize-easyresearch 添加一个负责核查医学论文证据质量的 Agent。
```

也可以在**设置**中直接查看和编辑 Agent Markdown 与 Skill 指令。

## 资源位置

| 资源 | 全局 | 项目 |
|---|---|---|
| Agents | `~/.easyresearch/agent/agents/<name>.md` | 不支持 |
| Skills | `~/.easyresearch/agent/skills/<name>/SKILL.md` | `<cwd>/.easyresearch/skills/<name>/SKILL.md` |

Agent 定义按全局目录、内置 fallback 的顺序解析。同名全局文件会完整替换内置定义；
项目 `.easyresearch/agents/` 目录不会被读取。

Skill 按以下顺序解析：

1. `<cwd>/.easyresearch/skills/<name>`
2. `~/.easyresearch/agent/skills/<name>`
3. 明确启用时的 `~/.agents/skills/<name>`
4. 内置 Skills

同名 Skill 替换低优先级版本，不同名称则合并。

## 创建 Agent

创建 `~/.easyresearch/agent/agents/reviewer.md`：

```md
---
name: reviewer
description: Reviews claims, citations, and evidence quality in research artifacts.
enable: true
tools: [read, bash, web-search, webfetch]
skills: [arxiv]
subagents: [search]
---

You are an evidence reviewer.

## Role Boundary

Inspect claims and supporting artifacts. Do not invent evidence or rewrite the
manuscript unless explicitly asked.

## Procedure

1. Identify each material claim.
2. Trace it to a verified source or experiment artifact.
3. Report unsupported, overstated, or ambiguous claims with exact file paths.

## Completion

Return `complete`, `partial`, or `blocked`, followed by artifacts inspected,
remaining gaps, and one recommended next action.
```

为保证文件名、派发和斜杠命令的可移植性，建议 id 使用小写连字符格式。Markdown
正文就是 Agent 的 system prompt。

### Frontmatter 语义

| 字段 | 含义 |
|---|---|
| `name` | Agent id；应与文件名主干一致。 |
| `description` | 用于判断何时选择该 Agent。 |
| `enable` | 默认 `true`；只有 `false` 会禁用 Agent。 |
| `tools` | 缺失、空值或 `[]` 表示加载全部受控工具；非空列表是严格 allowlist。 |
| `skills` | 缺失、空值或 `[]` 表示加载全部受控 Skills；非空列表是严格的已解析名称 allowlist。 |
| `subagents` | 缺失表示允许全部已启用目标；`[]` 表示叶子 Agent；非空列表是 allowlist。 |

常用受控工具名包括 `read`、`bash`、`edit`、`write`、`subagent`、
`web-search` 和 `webfetch`。工具注册与权限是两件事：allowlist 不能让尚未注册的
工具凭空出现。

不要在 Agent Markdown 中配置模型。模型和思考强度应写入全局
`easyresearch.agentDefaults`；参见[模型配置](./model-configuration.zh-CN.md)。

## 创建 Skill

全局 Skill 可创建在 `~/.easyresearch/agent/skills/evidence-audit/SKILL.md`；
只服务一个论文项目时，使用项目 Skill 路径：

```md
---
name: evidence-audit
description: Audit research claims against citations and experiment artifacts when evidence quality must be checked.
---

# Evidence Audit

1. Read the requested claims and their cited artifacts.
2. Separate directly supported facts from interpretations.
3. Report missing evidence with exact paths and identifiers.
```

Skill 还可以包含 `scripts/`、`references/` 和 `assets/`，并使用相对于 Skill
目录的路径引用。`description` 应同时说明 Skill 做什么以及何时触发。

把 Skill 名称加入 Agent 的 `skills` 列表即可挂载。未找到的已配置 Skill 会在运行时
被忽略，并只在**设置**中报告。

当前 Agent 加载的每个 Skill 都可在 Web 输入框中通过 `/<skill-name>` 调用。若名称
与扩展命令或 Prompt Template 冲突，候选项会显示 `/skill:<skill-name>`，且只有该
显式形式会调用 Skill。

## 可选的 Home Skills

为避免无关工具进入 EasyResearch，通用 `~/.agents/skills` 默认关闭。确实需要时，
在全局 `~/.easyresearch/agent/settings.json` 中启用：

```json
{
  "easyresearch": {
    "enable_dot_agents_skill": true
  }
}
```

项目 settings 不能启用这一层。

## 编辑内置资源

在**设置**中编辑内置 Agent 或 Skill 时，EasyResearch 会先把它复制到对应的全局
目录，此后由你的副本覆盖内置 fallback。相比削弱内置专家的职责边界，更推荐新增
一个职责明确的自定义 Agent 或 Skill。

有效的全局 Agent 修改会自动刷新已打开的 Web 页面。运行中的 Agent 会先完成当前
模型响应和工具批次，再在下一次模型请求前应用新的 prompt、工具、Skills 与
subagent 策略。
