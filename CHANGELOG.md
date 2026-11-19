# CHANGELOG

## 未发布

- 新增：kitty 协议终端下 view_image 的 jpeg/webp 真图显示。sharp 后台异步转码为 PNG：渲染期同步查表，未命中先显示文本回退行，就绪后自动重渲染出真图；EXIF 方向自动旋转，长边超过 2048px 只缩不放（显示最高 14 行，远超所需），动图 webp 取首帧。转码为纯显示层缓存：Session 记录保留原图 base64，不落盘、格式零变更，resume 后按需重转码。iTerm2 与无协议终端行为不变。新增依赖 sharp（native prebuild，Windows x64 / Linux x64）。

## 0.2.5 — 2026-11-19

- **变更**：压缩覆盖的历史记录不再整段淡化——压前的 Prompt/回复/工具卡/提示保留原配色，工具卡背景按真实结果状态着色，压前 view_image 卡展开正常显示真图（失败卡片仍淡化且不渲染图像）。压缩分隔线文案改为 `compacted`，摘要展开/折叠提示改为英文（`Click to expand/collapse the chat summary`）。
- **变更**：删除零 Turn 取消 Run 的独立取消标注（经用户裁决）。取消 Run 的 Prompt 裸进上下文，其下一条 Prompt 渲染期前置 `[The previous request was interrupted before completion.]`：仅渲染期注入、从不落盘，`user_prompt` 记录恒存用户原文，正式请求/压缩摘要输入/锚定重建同源一致；TUI 在对应 Prompt 前显示同构 notice，用户气泡仍为原文。半截文本取消（aborted Turn）的中断标注与失败/未知标注不变；Session v4 Schema 零变更，旧 Session 重建自动获得新行为。
- **变更**：TUI 斜杠命令菜单 Enter 由"补全并立即执行"改为"仅补全"（与 Tab/鼠标点击一致）；命令需第二次 Enter 才执行，选中项先填入输入区供确认或追加参数。
- **新增**：`/compact [重点]`，重点追加到压缩指令末尾的 `Additional focus` 段，仅本次摘要请求可见、不入库、不参与 `promptVersion`。
- **变更**：状态栏 Cache/Speed 改为整段对话累计口径——跨 Run、跨压缩持续累加，压缩不再重置；生成摘要那次请求的用量（随 checkpoint 落盘的 `usage`）同样计入，重启 / `/resume` 后累计完整。Context 口径不变（仍为最近实测，被最新 checkpoint 覆盖时改显 `~` 估算）。
- **破坏性变更**：Session 格式升级 v2 → v4（meta 与首条记录均 `version: 4`；v3 从未发布，不单独留档）。v2 / v3 Session 不再可读（文件保留不删除，列表跳过），不迁移、不降级。**勿混跑新旧版本**：旧版二进制无法读取 v4 Session（列表会被 v4 meta 阻断）。
- **新增**：checkpoint 记录新增可选 `usage`（摘要请求的 `input/cacheRead/output/durationMs`），用于 Cache/Speed 跨重启累计；Provider 未报告耗时时不写 `durationMs`，只计 token。
- 新增：第七工具 `view_image`（条件启用）——仅当前模型 `input` 含 `image` 时注册；只读查看 png/jpg/jpeg/webp（扩展名白名单 + magic 校验，mimeType 以内容为准），大小上限 `viewImageMaxBytes`（默认 5 MiB）；仅成功携带单图（base64 + 宽高），权限同 read。非视觉模型回放含图历史时渲染期替换为显式占位文本，记录永久保留、切回视觉模型可逆。
- 新增：TUI 内联图片——view_image 成功卡片在 kitty 协议终端 + PNG 显示真图（最高 14 行），其余终端/格式显示文本回退行；失败卡片不渲染图像。jpeg/webp → PNG 转码为后续项。
- 变更：上下文/压缩/锚定按模型能力双模态渲染与计费——image 块按 `ceil(w×h/750)` 钳位 [256,16384] 估算（解析失败回退 4096）；压缩回退阶梯每档丢图换占位；视觉↔文本切换由工具集快照校验捕获，锚定保守回退纯估算。

## 0.2.4 — 2026-11-18

- 优化：流式 Markdown 渲染改为"稳定前缀保持解析 + 尾部增量解析"。此前流式期间尾部窗口之前的内容按纯文本输出，前面的粗体/标题/代码块格式会消失、结束后才恢复。现在增量扫描器只在块安全位置（围栏/LaTeX/注释之外的空行、闭合围栏、ATX 标题、分隔线）推进稳定边界；稳定前缀按块增量词法分析并复用块级渲染缓存（每块只渲染一次），每个 delta 只重解析尾部当前开放块。病态超大尾部（>16KB 或 >32 行，如单条超长行/超巨未闭合代码块）降级为原有界纯文本预览；结束流式一律全文重 lex 精确校正（松散列表续接、引用链接、边界间距等漂移在此修正）。Thinking 预览复用同一组件自动受益。
- 修复：压缩完成后状态栏 Context 立即更新。此前 Context 数字取自最后一条 assistant 的实测 usage，压缩不产生新实测 → Run 内压缩要等下一次响应落盘才恢复，手动 /compact 后长期停在压缩前旧值。现在 compaction.finished 携带压后纯估算（Run 内与手动路径均覆盖，重建失败不影响压缩本身），Controller 快照新增 contextEstimateTokens（/new、/resume 清空）；最新 checkpoint 覆盖被测量 assistant 时状态栏改显估算并加 ~ 前缀区分实测，新实测落盘后自动切回；checkpoint 损坏时保持实测显示不崩溃。
- 变更：半截推理"写入剥离 + 读取兜底"（经用户授权修订 I5 审计范围）。取消时 aborted partial 的 thinking 块在落盘前剥离：推理草稿无续写价值，回传可能误导模型与压缩摘要；纯思考取消剥离后无实质内容不落盘，Run 走零 Turn 取消标注。旧记录中已落盘的 aborted thinking 构建上下文时剥离（读取兜底），TUI 同构不显示（含取消收尾窗口期）；完成 Turn 的 thinking 与流式实时 Thinking 展示不变。架构 I5/§6/§7 同步修订；Session v2 Schema 零变更。
- 变更：pi-ai 升级 1.4.0 → 1.5.2（保持精确固定）。工具 Schema 改直传 JSON Schema（1.5.0 起主入口移除 TypeBox 再导出，删除 `Type.Unsafe` 包装，不新增直接依赖）；默认 compat 新增 `requiresToolsWithToolHistory: true`（显式配置优先）：1.5.1 起无工具请求默认省略 tools 字段，此默认值维持压缩摘要请求发送 `tools: []`、与旧版请求前缀逐字一致，保护 prompt cache 前缀与端点兼容性。已对照 1.5.2 源码确认非 OpenAI 端点不新增 `prompt_cache_key` 等字段；真实 Provider 双端点压缩摘要（fallback 路径）、多轮工具回归 11 用例与 Session v2 真实回放全部通过。
- 变更：Run 默认 Turn 上限 40 → 200，长任务不再频繁被轮数上限打断。命中上限仍执行完最后完整工具批次后以 `turn_limit` 收尾；`settings.json` 的 `maxTurns` 覆盖机制与架构 outcome 集合不变。

## 0.2.3 — 2026-11-17

- 新增：用户取消后的上下文重设计。取消不再丢弃已生成的内容：完整生成的响应如实落盘进上下文；未执行的工具调用诚实记 `not_executed`；aborted Turn 在可配对 call 均有确定结果时附中断标注进上下文，半截 call（id/name 缺失或重复）构建上下文时剥离、History 留原文；零 Turn 取消 Run 的 Prompt 附取消标注。门控与恢复语义不变（不自动重放、不继承旧授权）。
- 新增：unknown 工具结果受控进上下文。unknown 结果/缺结果（崩溃窗口）Turn 受控进入上下文：缺结果渲染期合成显式 unknown 占位（不落盘、绝不写成确定态），Turn 末附询问标注（不重试、不假设成败、先请用户核实）；用户 Prompt 恒进上下文，零 Turn 失败 Run 附失败标注；压缩边界相应放宽（纯缺结果 Turn 可以 assistant 作边界，覆盖范围内零 Turn Prompt 进摘要输入，摘要保留未解决 unknown 事实）。迭代中途抛错时以已累积流式片段诚实合成 partial，usage 零值占位表示"未计数"。Session v2 Schema 零变更。
- 新增：TUI 历史标记与上下文同构。失败零 Turn Prompt 与 unknown Turn 附标注 notice、缺结果卡片展示合成占位；被排除 Turn 与压缩覆盖记录段级淡化；压缩分隔线携带摘要正文，默认折叠、点击展开 `<conversation_summary>` 全文。标记全部派生自有效上下文计划，与模型所见一致。
- 新增：压缩/可行性判定的 token 数 usage 锚定。改为"最近一次可信实测 prompt（input+cacheRead+cacheWrite）+ 未测量增量估算"：Turn 结束后以响应 usage 锚定；Run 起点以记录中最近可信实测锚定，须前缀重建逐条一致、模型身份与工具 Schema（run_started settings 快照）校验通过；usage 缺失/全零占位、换模型、校验不符或压后重建时回退纯估算。修复字符估算对代码/JSON 低估约 10%、使 0.8 阈值的实际触发点漂移到真实窗口约 90% 的问题（如 256k 窗口到 230k 才压缩）。架构 §7 补充锚定规则；压缩内部相对预算保持纯估算。
- 修复：write 新建文件后展开卡片的历史 Diff 只显示一行 "Diff unavailable"。write 新建文件现在记录空快照 `priorContent: ""`（覆盖已有文件仍记录旧文件全量快照），TUI 可重建全新增行 Diff，与审批时的预览一致。架构 priorContent 不变量与 Tool.md 同步修订（经用户确认）；旧 Session 中无该字段的记录仍如实显示 unavailable，不捏造 Diff。Session 格式与版本不变。

## 0.2.2 — 2026-11-17

- 新增：审批 UX 自动展开/折叠与视线追踪。工具等待人工审批时自动展开卡片（展示审批摘要与 Diff 预览）并定位；审批结束后自动折叠（仅折叠自动展开的，用户手动展开/折叠的不动），放行时追踪到同 Run 下一个工具，拒绝/取消或无下一个工具时恢复追底。纯展示层，不改 Core 事件、存储与审批焦点。

## 0.2.1 — 2026-11-17

- 新增：bash 运行中实时输出。命令执行期间 TUI 每秒自动刷新输出尾部（最后 5 行），取消即清除、完成后折叠回最终结果；纯展示层，送模型与持久化的最终裁剪结果不变。