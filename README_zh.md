# EasyResearch

[![Release](https://github.com/hdu-ailab/EasyResearch/actions/workflows/release.yml/badge.svg)](https://github.com/hdu-ailab/EasyResearch/actions/workflows/release.yml)

自动化论文写作：一支 AI 专家团队替你完成从文献调研、实验到成稿的整条论文流水线，你只需确认关键检查点。

## 工作原理

EasyResearch 是一条分工明确的论文生产流水线，由多个 agent 专家协作完成：

- **Paper Assistant（论文助手）** —— 你的项目经理。规划流水线、在合适时机派发对应专家、在后台专家 agent 运行时继续编排并自主决定下一步；你只需沿途确认质量检查点。
- **Search（检索）agent** —— 在 OpenReview 和 arXiv 上查找候选论文，核验元数据，下载 PDF，转换为可读文本，并整理文献资料包。
- **Experiment（实验）agent** —— 基于论文构建可复现实验：选择数据集、实现基线、多 seed 受控对比实验，产出正式证据。
- **Writing（写作）agent** —— 起草并修订权威 Markdown 手稿，核验每条引用，导出 LaTeX/PDF。
- **Figures（图表）agent** —— 基于真实实验证据产出可编辑的投稿级图表。

各 agent 通过完整的论文工作流协作——初期调研、论文阅读与综合、实验设计与执行、正式结果、最终手稿——由 Paper Assistant 自始至终编排。你无需亲自做任何手工活，只需审查关键内容并在流水线推进前确认每个检查点。

## 高度可定制的 agent

整个 agent 团队完全可定制。每个 agent 由一份 Markdown 文件定义（角色、工具、skills、模型），skills 就是 `SKILL.md` 文档——你可以快速创建自己的专家 agent 接入流水线，无需写代码：只需让 Paper Assistant 加载 `customize-easyresearch` skill，它就会为你创建、编辑或挂载自定义 agent 与 skills。

## 环境要求

- 通过 npm 安装时需要 `npm`
- 只有在你想从当前仓库组装本地 npm 包时，才需要 [Bun](https://bun.sh) 1.x 或更新

## 安装

### 通过 npm 安装（推荐）

```bash
npm install -g easyresearch
easyresearch
```

各平台为自包含二进制。npm 启动器使用 npm 自带的 Node 运行，但被选中的平台可执行文件本身不需要 Node 或 Bun。首次运行会创建 skill Python venv（留意终端进度）并解压内置 agents/skills。PDF 转换与 arXiv 功能需要 PATH 中有 Python 3；没有时这些功能自动降级。

设置 `EASYRESEARCH_SKIP_SETUP=1` 可跳过首次运行引导。

**支持平台**：linux-x64、darwin-arm64、windows-x64。其他平台上，`npm install` 会给出明确错误提示。

### 组装并安装本地 npm 包

当你需要在本地验证生产安装包，而不是直接从 npm registry 安装时，使用这条路径。

请选择与你实际运行 `easyresearch` 的机器一致的目标平台。

#### POSIX shell

```sh
git clone https://github.com/hdu-ailab/EasyResearch.git
cd EasyResearch
bun install --frozen-lockfile

TARGET=linux-x64 # Apple Silicon 请改为 darwin-arm64
bun scripts/release.ts --dry-run --only "$TARGET"
PLATFORM_TARBALL=$(npm pack "./release/easyresearch-$TARGET" --pack-destination ./release --silent)
META_TARBALL=$(npm pack ./release/easyresearch --pack-destination ./release --silent)
npm install -g "./release/$PLATFORM_TARBALL" "./release/$META_TARBALL"
easyresearch --version
```

#### PowerShell

```powershell
git clone https://github.com/hdu-ailab/EasyResearch.git
cd EasyResearch
bun install --frozen-lockfile

$Target = "windows-x64"
bun scripts/release.ts --dry-run --only $Target
$PlatformTarball = npm pack "./release/easyresearch-$Target" --pack-destination ./release --silent
$MetaTarball = npm pack ./release/easyresearch --pack-destination ./release --silent
npm install -g "./release/$PlatformTarball" "./release/$MetaTarball"
easyresearch --version
```

## 启动

```bash
easyresearch
# 在 http://127.0.0.1:3000 启动后台服务器并打开浏览器

easyresearch -p 4000            # 自定义端口
easyresearch --host 0.0.0.0     # 监听所有网卡（服务器场景）
easyresearch --no-open          # 不自动打开浏览器
easyresearch exit               # 停止后台服务
```

在首页选择一个论文项目目录并开始会话。所选目录即项目边界：项目配置位于
`<cwd>/.easyresearch`，全局状态位于 `~/.easyresearch/agent`。

## 配置模型

三层配置——按场景选择：

### 1. Web UI（推荐）

- **设置页**：为每个 agent 设置全局 `model` 与 `thinking`，写入
  `~/.easyresearch/agent/agents/<name>.md`。
- **工作页 → Agent 面板**：编辑的也是同一组全局字段。不存在按会话生效的
  model 或 thinking 覆盖。

### 2. 模型目录与凭据

`~/.easyresearch/agent/models.json` 注册 provider 及其模型；
凭据放在 `~/.easyresearch/agent/auth.json`、环境变量或 provider 的
`apiKey` 字段。

`models.json` 示例（OpenAI 兼容 provider）：

```json
{
  "providers": {
    "my-openai": {
      "baseUrl": "https://api.openai.com/v1",
      "api": "openai-completions",
      "models": [
        { "id": "gpt-4o", "name": "GPT-4o", "reasoning": true }
      ]
    },
    "local-router": {
      "baseUrl": "http://localhost:20128/v1",
      "api": "openai-completions",
      "apiKey": "local",
      "models": [
        { "id": "deepseek-v4-flash-free", "name": "DeepSeek V4 Flash Free (Local)", "reasoning": true }
      ]
    }
  }
}
```

凭据任选其一：

```bash
# ~/.easyresearch/agent/auth.json
{ "my-openai": { "type": "api_key", "key": "sk-..." } }

# 或环境变量
export OPENAI_API_KEY=sk-...
```

### 3. Agent Markdown frontmatter

```markdown
---
model: my-openai/gpt-4o
thinking: medium
---
```

写入 `~/.easyresearch/agent/agents/paper-assistant.md` 或其他全局 agent
Markdown 文件。Agent 定义只采用 global-over-bundled 规则：
`<cwd>/.easyresearch/agents/` 是惰性的，不参与运行时发现，也不会影响工作页或设置页。阶段 agent 未设置自己的 `model` 时，会继承 Paper Assistant 当前的全局模型。

全局状态位于 `~/.easyresearch/agent`（settings、models、auth、sessions、
agents）；项目级覆盖位于 `<exact-cwd>/.easyresearch`（settings、skills、
prompts、themes、extensions）。
