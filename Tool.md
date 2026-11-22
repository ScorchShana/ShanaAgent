# ShanaAgent 工具边界（read / glob / grep / write / edit / bash / view_image）

> 边界摘要。完整行为以代码为唯一依据：模型可见描述在 `prompts/tools/`，参数 Schema 在 `src/tools/registry.ts`，实现与错误模板在 `src/tools/*.ts`。数值限额为 settings.json 可配置项 + 代码命名常量，默认值以代码为准。权限与审批策略见架构 §5。

## 总则

- 按响应中的调用顺序逐个 `await`，不并行、不建调度队列。
- 参数严格校验，不模糊纠正、不强制转换；非有限数值拒绝执行；参数解析与有限修复见 `src/llm/argument-parser.ts`。
- 错误以 `Error:` 开头单行返回（bash 执行错误例外：错误首行 + Stdout/Stderr 区块）。模型可见信息只含修正调用所需内容；快照/Diff 机制、内部阶段、系统错误码、堆栈不进 Error，底层异常写 `~/.shana/logs/` 诊断日志并脱敏。
- 拒绝分类包括用户明确拒绝审批 `User denied.`、OS 权限不足 `Permission denied.` 和执行前用户取消 `Cancelled by user.`。审批超时、取消与审批系统异常各有独立结果。
- IO 失败无法可靠细分 `File operation failed.`；内部非预期异常 `Internal error. Stop and ask user.`（要求模型停止并询问用户，不新增门控或 Session 状态）。
- read/glob/grep：正常裁剪返回成功；实际失败或取消只返回一条 Error，不附部分正文/路径/匹配，不误报无匹配。
- 同批任一工具结果 unknown：保留真实结果，停止同批剩余调用并逐个记录 `not_executed`，进入 Run 收尾，不发下一 Turn、不自动重试。
- **UTF-8 ground rule**：read/write/edit 只操作 UTF-8 文本；解码失败或含 NUL 即判二进制拒绝，不降级、不覆盖（架构 §5）。carve-out：仅 read/write/edit 受此约束，view_image 是显式二进制只读通道。
- **路径目标复验**：审批后及读取、破坏性打开、临时文件创建、rename 等关键操作前复验真实目标；变化返回 `Path target changed. Stop and ask user.`，不自动重试。复验与操作间的竞态窗口不承诺抵御。
- 文件工具按真实路径判断区内外。read/glob/grep/view_image 对 `~/.shana/skills` 享有只读豁免。其余区外文件读写在 confirm/auto 下匹配同一工具、同一真实目标的会话授权，未命中时询问。
- 结果路径的显示转义仅作用于展示，调用历史保留原文；模型再次调用前须还原真实路径。

## 审批模式（confirm / auto / full）

每 Session 持久化（meta `approvalMode`，缺省 auto），Run 起点冻结；`/mode` 查询或切换，运行中切换只影响后续 Run。完整矩阵与门控顺序见架构 §5，判定实现以 `src/security/permissions.ts` / `approval-manager.ts` / `bash-policy.ts` 为准。

- 所有工具先校验参数并准备实际目标，再匹配活动会话内的授权。区内文件工具按工具名和工作区匹配，区外按工具名和真实目标精确匹配，glob/grep 核对指定搜索根。多目标调用须全部命中。Bash 按原始命令精确匹配。
- 未命中授权时，`confirm` 放行区内和 skills 目录读取，以及能确认只读的 Bash 调用。`auto` 也放行区内 write/edit 和能确认范围的 Bash 普通写入。两种模式下其余调用询问用户。`full` 免除审批，参数、内容、限额和取消检查照常执行。
- 「允许一次」批准当前调用。「本会话允许」保存面板列出的范围，切换 confirm/auto 时可复用，切换会话或退出进程时清空。

## read

按行读取 UTF-8 文本，带行号。offset/limit 续读（默认 2000 行、上限 5000 行）；输出预算 24000 字符，单行超 2000 字符截断（增大 offset 不能恢复被截行内部分）；空文件与超 EOF offset 返回信息性结果。

## glob

globby 递归路径搜索，结果 newest first，每行一个路径。不跟随目录符号链接，文件符号链接返回；尊重 .gitignore，含非忽略隐藏文件，排除 .git/。搜索路径为相对时结果相对工作区，绝对搜索路径返回绝对路径。上限 200 文件且总输出 24000 字符；超时 `globTimeoutMs`（默认 30s）。`(No files found)` 是完成的空结果。

## grep

@vscode/ripgrep 内容搜索，默认正则引擎（无 PCRE2），输出 `path:line: content`。目录搜索尊重 ignore 文件、跳过隐藏与二进制文件、不跟随目录符号链接；显式文件路径与 glob 过滤按 ripgrep 过滤优先级。总预算 24000 字符，单行内容限 500 字符（保留首个匹配附近文本），超预算整条丢弃，不拆分 Unicode 与转义序列。诊断 stderr 独立预算 `grepStderrMaxChars`（默认 4000）。`No matches found.` 是完成的空结果；搜索失败只返回 Error。

## write

新建或全量覆盖 UTF-8 文件（部分修改用 edit）。父目录必须存在。准备时目标不存在则排他创建，若其他进程已创建同名文件，保留该文件并返回路径变化错误。已有文件须为有效 UTF-8 无 NUL 且不超过 `WRITE_MAX_EXISTING_FILE_BYTES`（16 MiB）。保留 supplied 内容与行尾，不加 BOM/末尾换行。写入前捕获旧文件全量快照（priorContent，新建文件记空串；仅供 TUI 历史 Diff，不入模型上下文）；捕获失败（ENOENT 之外）不写入。不可逆写入（open/truncate）开始前取消返回 `not_executed`（文件未改动）；写入临界区一旦开始即完成并如实报告 success。

## edit

精确字符串替换。多匹配须 `replace_all`，否则返回匹配数量要求扩大上下文；编辑前须先 read。CRLF/孤立 CR 归一化为 LF 后匹配，其余空白有意义；去除文件头部 BOM，成功结果为 LF 行尾、无头部 BOM、不加末尾换行；old/new 归一化后必须不同，匹配失败不改文件。原文件与最终结果均受 `editMaxFileBytes` 限制；保留原 POSIX 权限位（取得/保留失败不提交）。临时文件 + rename 提交，失败只返回可可靠分类的简短原因，清理失败不追加到模型结果。rename 提交前取消返回 `not_executed`（原文件未改动，临时文件清理）；rename 一旦开始即完成并如实报告。不做版本快照比对，TOCTOU/丢失更新不在首发承诺内。

## bash

全平台统一 bash 语法：Windows → Git Bash，Linux/WSL → 系统 bash；固定工作区根目录执行，每调用独立子进程，不维持常驻 Shell。`timeout` 参数 1–1200 秒、默认 120 秒（代码常量 DEFAULT_SHELL_TIMEOUT_MS，不在 settings.json）。stdout/stderr 分别限 16000/4000 字符，各保头尾。正常退出返回真实退出码（含非零）；启动失败按原因分类，执行错误保留输出区块。

- 会话授权或 full 放行时跳过 Bash 解析。自动判定按整条命令核对各段的参数、重定向和实际路径，启动前复验。见 [Bash 调用审批策略](./bash-policy.md)。
- **超时混合收尾**：尝试终止进程树；确认终止 → 确定超时 ToolResult、Run 继续；无法确认 → 副作用 unknown 收尾，阻塞下个 Run 至用户知情确认。
- 取消请求终止进程树；取消生效前进程已退出按真实退出结果处理。取消且确认终止 → 确定态 ToolResult，文案提示命令可能已部分执行、需先核实副作用（不触发门控）；无法确认终止 → 副作用 unknown 门控。Session 关闭/退出主动终止受管进程树并等待收尾；确认失败如实提示可能遗留进程，不回滚副作用、不谎称清理完成。

## view_image

只读查看图片文件，把图像附给视觉模型。**条件启用**：仅当前模型 `input` 含 `image` 时注册，否则工具集中不存在（调用报 Unknown tool）。

- 扩展名白名单 `.png/.jpg/.jpeg/.webp`（大小写不敏感）+ 文件头 magic 校验（PNG/JPEG/WEBP）；mimeType 以内容为准（扩展名与实际格式不符时按真实格式报告）。不支持 `Unsupported image format. Supported: png, jpg, jpeg, webp.`；magic 不符 `File content does not match a supported image format.`。
- 大小上限 `viewImageMaxBytes`（默认 5 MiB，范围 1024–16777216）；stat 与限量读（max+1）双重检查防竞态增长，超限 `Image exceeds the size limit (N bytes; max M bytes).`。
- 仅成功携带 images（恰 1 项：base64 + mimeType + 宽高）；失败/取消/拒绝只有 Error 文本，不带图。成功结果 `<path>…</path>` + `(Image attached: <mime>, <w>x<h>, <size>.)`。
- view_image 的授权范围独立于 read。区内与 skills 目录读取自动允许，其余区外读取按真实文件精确匹配已有授权。取消在读取前后边界检查。
- 非视觉模型回放含图历史时渲染期替换为显式占位文本（记录保留、切回可逆）；TUI 内联显示仅 kitty 协议 + PNG 出真图，其余文本回退（见架构 §7/§9）。
