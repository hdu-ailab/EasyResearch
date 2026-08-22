# 模型配置

[English](./model-configuration.md)

EasyResearch 将 provider、凭据和 Agent 默认模型保存在全局配置目录中。推荐在
Web UI 的**设置**中完成配置；只有在接入自定义 provider、本地模型服务或需要可复现
的手工配置时，才直接编辑下面的文件。

## 文件位置

| 用途 | 路径 |
|---|---|
| 通用设置与 Agent 默认值 | `~/.easyresearch/agent/settings.json` |
| 自定义 provider 与模型 | `~/.easyresearch/agent/models.json` |
| 已保存的 API key 与 OAuth 凭据 | `~/.easyresearch/agent/auth.json` |

EasyResearch 不读取 `~/.pi`、`.lazypaper` 或旧 `config.json`。Provider 凭据和
Agent 模型默认值均为全局配置；项目 `.easyresearch/settings.json` 不能覆盖 Agent
的模型或思考强度。

## 推荐配置方式

1. 打开**设置**并连接 provider。
2. 为研究助手选择模型和思考强度。
3. 按需为检索、实验、写作、图表或自定义 Agent 选择不同模型。

设置页与工作页 Agent 卡片修改的是同一组全局默认值，不存在会话级模型覆盖。

## 自定义 Provider

创建 `~/.easyresearch/agent/models.json`，可接入 OpenAI 兼容端点、本地服务、
代理或其他受支持 API：

```json
{
  "providers": {
    "my-openai": {
      "baseUrl": "https://api.example.com/v1",
      "api": "openai-completions",
      "apiKey": "$MY_OPENAI_API_KEY",
      "models": [
        {
          "id": "research-model",
          "name": "Research Model",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 32000
        }
      ]
    }
  }
}
```

支持的 API 类型包括：

- `openai-completions`
- `openai-responses`
- `anthropic-messages`
- `google-generative-ai`

Ollama 等无需鉴权的本地服务仍应填写占位 `apiKey`，以便模型被视为可用：

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [{ "id": "qwen2.5-coder:7b" }]
    }
  }
}
```

`apiKey` 和自定义 header 可使用字面值、`$MY_API_KEY` 形式的环境变量，或以
`!` 开头的命令。不要把明文密钥提交到仓库；优先使用 Web 凭据流程、环境变量或
`auth.json`。

## 凭据

Web **Providers** 区域是连接受支持 provider 的首选入口。手工保存 API key 时，
在 `~/.easyresearch/agent/auth.json` 中使用 provider id 作为键：

```json
{
  "my-openai": {
    "type": "api_key",
    "key": "sk-..."
  }
}
```

内置 provider 也支持标准环境变量，例如 `OPENAI_API_KEY`、
`ANTHROPIC_API_KEY`、`GEMINI_API_KEY` 和 `OPENROUTER_API_KEY`。不要提交
`auth.json` 或任何明文密钥。

## Agent 默认值

Agent 模型与思考强度只保存在全局 `settings.json` 的
`easyresearch.agentDefaults` 中：

```json
{
  "easyresearch": {
    "agentDefaults": {
      "research-assistant": {
        "model": "my-openai/research-model",
        "thinking": "high"
      },
      "experiment": {
        "model": "ollama/qwen2.5-coder:7b",
        "thinking": "medium"
      }
    }
  }
}
```

- 研究助手未设置模型时，使用解析出的具体自动默认模型。
- 阶段或自定义 Agent 未设置模型时，继承研究助手模型。
- 研究助手未设置思考强度时，使用该模型支持的最高强度。
- 阶段或自定义 Agent 未设置思考强度时，继承研究助手的有效强度，并受自身模型
  支持范围约束。
- Agent Markdown 中的 `model` 和 `thinking` 字段会被忽略。

尽量使用 Web 下拉框，因为其中只会显示当前模型支持的思考强度。

## 实时更新与恢复

有效的 `models.json` 或 `easyresearch.agentDefaults` 修改会自动刷新已打开的
设置页和工作页。运行中的 Agent 会先完成当前模型响应和工具批次，再在下一次模型
请求前应用新配置。

如果修改无效，EasyResearch 会继续使用最后一份有效模型目录，并在 Web UI 中显示
诊断信息。请检查 JSON 语法、provider `baseUrl`、`api`、模型 id 和凭据是否可用。
