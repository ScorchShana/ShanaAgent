# ShanaAgent

单 Agent、仅 TUI 的本地编码代理：TypeScript · Node.js · 内置 shana-tui，基于 [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai) 接入 OpenAI Completions 兼容端点。单进程单活动 Run，多进程可共用同一工作区。

## 功能

- 六个内置工具：`read` / `glob` / `grep` / `write` / `edit` / `bash`
- bash 运行中实时输出：命令执行期间每秒刷新输出尾部（最后 5 行），完成后折叠回最终结果
- 写操作与命令执行的人工审批，diff 预览
- 会话持久化为 JSONL（`~/.shana/sessions/`），诊断日志独立存放（`~/.shana/logs/`）且自动脱敏 API Key
- 上下文自动压缩，长会话可持续工作
- 项目规则：自动读取工作区 `AGENTS.md` 注入系统提示

## 环境要求

- Node.js >= 22.19.0
- Windows（Git Bash）或 Linux（含 WSL）

## 安装

```bash
git clone <仓库地址>
cd ShanaAgent
npm install
npm run build
npm link
```

`npm link` 后可在任意目录使用 `shana` 命令。

## 配置模型

编辑 `~/.shana/model.json`（凭据仅支持明文 `apiKey` 一种方式；该文件只在本机，请勿提交到任何仓库）：

```json
{
  "current": { "provider": "deepseek", "model": "deepseek-chat" },
  "providers": {
    "deepseek": {
      "api": "openai-completions",
      "baseUrl": "https://api.deepseek.com",
      "apiKey": "sk-你的密钥",
      "models": [{ "id": "deepseek-chat", "contextWindow": 65536, "maxTokens": 8192 }]
    }
  }
}
```

- `api` 目前仅支持 `"openai-completions"`，可接入任何 OpenAI Completions 兼容端点
- `current` 可省略，默认取第一个 Provider 的第一个模型
- 模型条目必填 `id` / `contextWindow` / `maxTokens`；可选 `name` / `reasoning` / `reasoningEffort` / `samplingParams` / `cost` 等

## 使用

```bash
cd 你的工作区
shana
```

在 TUI 中直接输入需求即可开始对话；写文件与执行命令前会按配置请求审批。

## 开发

```bash
npm run dev    # tsx 直跑源码
npm run build  # 编译到 dist/
npm test       # 应用测试（vitest）+ 内置 TUI 框架测试（node:test）
npm run lint   # ESLint（含层依赖边界强制）
```

架构与开发约束见 [`ShanaAgentArchitecture.md`](./ShanaAgentArchitecture.md)、[`Tool.md`](./Tool.md)、[`AGENTS.md`](./AGENTS.md)。

## 许可证

[MIT](./LICENSE)
