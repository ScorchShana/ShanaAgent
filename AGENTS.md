# AGENTS.md — ShanaAgent 开发约束

> 本文件约束在本仓库工作的所有编码 Agent。权威模型：[`ShanaAgentArchitecture.md`](./ShanaAgentArchitecture.md) 管整体架构与红线，[`Tool.md`](./Tool.md) 管六工具边界摘要；**行为细节（文案、Schema、数值默认、字段格式、展示交互）以代码实现为唯一依据**。文档与代码冲突时以代码为准并修正文档；疑似代码 bug 停下报告，不擅自改行为。

## 1. 项目简介

ShanaAgent 是单 Agent、仅 TUI 的本地编码代理：TypeScript · Node.js >=22.19.0 · 内置 shana-tui · `@earendil-works/pi-ai`（固定 1.4.0），主要面向 DeepSeek Flash / Qwen Flash。单进程单活动 Run，多进程可共用工作区，首发 Windows 与 Linux/WSL。

- `PROGRESS.md` — 当前状态与未验证项索引，每轮会话首选入口（本地保留，不入库）。
- `Optmization.md` — 待优化事项清单（本地保留，不入库）。

## 2. 工作流

1. 开工先读 `PROGRESS.md` 与架构相关章节；列出将修改的文件与关键函数。
2. 目录结构以架构 §10 为基线（允许合并小文件，禁止新增顶层目录或子系统）；保留简单直接的 `await` 控制流，禁止无主 Promise、自建队列与为假想需求预设的抽象。
3. 代码交付前跑 build/lint/test，并如实记录验证结果与未验证项。

## 3. 必须保证（不得违反）

- **架构红线**：Core 禁止依赖 TUI（含内置框架）；状态变更只归 `SessionController`；`run.finished` 每 Run 恰一次。不变量 I1–I9 与已确认设计决策以架构正文为准，重新打开、变通或修改必须经用户同意。
- SDK（pi-ai）无法满足架构承诺时，回到架构层修订并告知用户；**禁止在 Provider Adapter 里静默兜底**。
- **诚实性**：不捏造文件、工具执行结果、模型响应、测试通过或成功状态；未用真实 Provider 验证的能力一律标记"未验证"。凭据仅 `~/.shana/model.json` 明文 `apiKey` 一种方式；配置展示、Provider 错误与诊断日志须脱敏，诊断日志永不包含 API Key；工具调用参数保留原文。诊断日志只写 `~/.shana/logs/`，与 Session JSONL 物理分离。
- 所有提交的文件里面不能有任何有关本机和api的信息

## 4. 代码风格与测试

- TypeScript `strict: true`；ESLint + Prettier；npm scripts 提供 build/dev/test/lint。
- 层依赖方向由 ESLint `no-restricted-imports` 强制（见 `eslint.config.js`，固化架构 §2/§10 矩阵）：非 TUI 层禁止依赖 `tui`，`llm→sessions`、`security→core/llm` 仅允许 `import type`；应用经 `tui/framework/index.js` barrel 引用框架为约定（未机器强制）。新增跨层依赖前先核对此矩阵。
- 标识符英文；`src/` 文件名 kebab-case，`tui/components/` 组件文件 PascalCase。
- **默认写精简注释**：注释中写出不显然的"为什么"（隐藏约束、微妙不变量、特定 bug 的 workaround）、写出简要的代码的作用；不写任务编号等会过期的话。
- 错误信息分层：返回给模型的以 `Error:` 开头、简短准确无猜测；内部错误区分类型（用户拒绝/文件不存在/权限/IO/协议），禁止吞异常或统一压成字符串。
- 测试用 vitest，`tests/` 镜像 `src/` 结构；内置 TUI 框架用独立 Node test runner；故障场景用可注入故障钩子，禁止真实破坏磁盘。不留死代码、兼容 shim、注释掉的旧实现。
