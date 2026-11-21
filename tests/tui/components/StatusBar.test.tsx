import { stripVTControlCharacters as stripAnsi } from "node:util";
import { visibleWidth } from "../../../src/tui/framework/index.js";
import { afterEach, expect, it } from "vitest";
import type { ControllerStatus, RunPhase } from "../../../src/core/state.js";
import { SessionController } from "../../../src/core/session-controller.js";
import { parseSettings } from "../../../src/llm/settings-store.js";
import type {
  CheckpointUsage,
  RunModelSnapshot,
  SessionRecord,
  SessionRunOutcome,
  StoredAssistantMessage,
} from "../../../src/sessions/records.js";
import { StatusBar, sessionContextMetrics, contextSegment } from "../../../src/tui/components/StatusBar.js";
import { TuiStore, type TuiState } from "../../../src/tui/store.js";
import { makeAssistantMessage, makeModelSnapshot } from "../../sessions/helpers.js";
const stores: TuiStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose();
});
function started(seq: number, runId: string, contextWindow = 128000): SessionRecord {
  return {
    recordSeq: seq,
    ts: "now",
    type: "run_started",
    runId,
    model: { ...makeModelSnapshot(), contextWindow },
    settings: {},
    agentsMd: { path: "AGENTS.md", present: false },
  };
}
function assistant(
  seq: number,
  runId: string,
  input: number,
  cacheRead: number,
  totalTokens = input + cacheRead,
): SessionRecord {
  const message = makeAssistantMessage();
  message.usage = { ...message.usage, input, cacheRead, totalTokens };
  return { recordSeq: seq, ts: "now", type: "assistant_message", runId, message };
}
function assistantWithUsage(seq: number, runId: string, usage: unknown): SessionRecord {
  const message = makeAssistantMessage();
  return {
    recordSeq: seq,
    ts: "now",
    type: "assistant_message",
    runId,
    message: { ...message, usage } as unknown as StoredAssistantMessage,
  };
}
function timedAssistant(seq: number, runId: string, output: unknown, durationMs: unknown): SessionRecord {
  const message = makeAssistantMessage();
  return {
    recordSeq: seq,
    ts: "now",
    type: "assistant_message",
    runId,
    message: {
      ...message,
      usage: { ...message.usage, input: 100, cacheRead: 0, totalTokens: 1000, output },
      durationMs,
    } as unknown as StoredAssistantMessage,
  };
}
function finished(seq: number, runId: string, outcome: SessionRunOutcome = "completed"): SessionRecord {
  return { recordSeq: seq, ts: "now", type: "run_finished", runId, outcome, persisted: true };
}
function checkpoint(seq: number, coveredUpTo: number, usage?: CheckpointUsage): SessionRecord {
  return {
    type: "checkpoint",
    recordSeq: seq,
    ts: "now",
    summary: "summary",
    coveredUpTo,
    model: { providerId: "p", modelId: "m" },
    ...(usage === undefined ? {} : { usage }),
  };
}
function running(runId: string, phase: RunPhase = "streaming"): ControllerStatus {
  return { kind: "running", runId, phase };
}
function wideStatus(state: TuiState, width = 240) {
  return { state, width };
}
function render(value: { state: TuiState; width: number }) {
  const component = new StatusBar(value.state);
  let width = value.width;
  return {
    lastFrame: () => component.render(width).map(stripAnsi).join("\n"),
    rerender: (next: { state: TuiState; width: number }) => {
      component.update(next.state);
      width = next.width;
    },
    unmount: () => {},
  };
}
// Context 三字段由 Core 经快照直供；测试以 options 模拟 Core 的维护结果。
function stateWith(
  records: SessionRecord[],
  options: {
    sessionId?: string;
    model?: RunModelSnapshot | null;
    contextTokens?: number | null;
    contextEstimated?: boolean;
    status?: ControllerStatus;
  } = {},
): TuiState {
  const sessionId = options.sessionId ?? "s";
  const store = new TuiStore(
    new SessionController({
      driver: { execute: async () => ({ outcome: "completed" }) },
      hooks: {
        getSessionView: () => ({
          approvalMode: "auto",
          ref: { workspaceId: "ws", sessionId },
          title: null,
          model: options.model === undefined ? makeModelSnapshot() : options.model,
          models: [],
          runModel: null,
          contextTokens: options.contextTokens ?? null,
          contextEstimated: options.contextEstimated ?? false,
        }),
      },
    }),
    parseSettings({}),
  );
  stores.push(store);
  const snapshot = store.getSnapshot();
  return {
    ...snapshot,
    core: options.status === undefined ? snapshot.core : { ...snapshot.core, status: options.status },
    history: {
      meta: { version: 6, workspaceId: "ws", sessionId, createdAt: "now" },
      records,
      warnings: [],
      fromRecordSeq: 1,
    },
  };
}
function contextMetrics(
  contextTokens: number | null,
  contextWindow: number | null,
  contextEstimated = false,
) {
  return { contextTokens, contextWindow, contextEstimated, cacheHitRate: null, speedTokPerSec: null };
}
it("returns no usage metrics for an empty history or for runs that have not finished", () => {
  expect(sessionContextMetrics([])).toEqual({ cacheHitRate: null, speedTokPerSec: null });
  expect(sessionContextMetrics([started(1, "r1"), assistant(2, "r1", 100, 50)])).toEqual({
    cacheHitRate: null,
    speedTokPerSec: null,
  });
  const view = render(wideStatus(stateWith([], { model: null })));
  expect(view.lastFrame()).toContain("Context: — / — · Speed: — · Cache: 0.0%");
  expect((view.lastFrame() ?? "").split("\n")).toHaveLength(2);
  view.unmount();
});
it("displays the Core context value and estimate flag from the snapshot", () => {
  const view = render(wideStatus(stateWith([], { contextTokens: 3941, contextEstimated: true })));
  expect(view.lastFrame()).toContain("Context: ~3.9k / 128k · Speed: — · Cache: 0.0%");
  view.rerender(
    wideStatus(
      stateWith([], {
        contextTokens: 3941,
        contextEstimated: true,
        model: { ...makeModelSnapshot(), contextWindow: 256000 },
      }),
    ),
  );
  expect(view.lastFrame()).toContain("Context: ~3.9k / 256k · Speed: — · Cache: 0.0%");
  view.rerender(wideStatus(stateWith([], { contextTokens: null })));
  expect(view.lastFrame()).toContain("Context: — / 128k · Speed: — · Cache: 0.0%");
  view.unmount();
});
it("follows the Core value transition from estimate to measured across a run", () => {
  const active = [started(1, "r1", 256000)];
  const view = render(
    wideStatus(stateWith(active, { contextTokens: 3941, contextEstimated: true, status: running("r1") })),
  );
  expect(view.lastFrame()).toContain("Context: ~3.9k / 128k · Speed: — · Cache: 0.0%");
  view.rerender(
    wideStatus(
      stateWith([...active, assistant(2, "r1", 300, 0, 2000), finished(3, "r1")], {
        contextTokens: 2000,
        model: { ...makeModelSnapshot(), contextWindow: 256000 },
      }),
    ),
  );
  expect(view.lastFrame()).toContain("Context: 2.0k / 256k · Speed: — · Cache: 0.0%");
  view.unmount();
});
it("cumulates cache across assistants of a finished run", () => {
  const metrics = sessionContextMetrics([
    started(1, "r1", 128000),
    assistant(2, "r1", 100, 40, 1000),
    assistant(3, "r1", 200, 60, 2000),
    finished(4, "r1"),
  ]);
  expect(metrics.cacheHitRate).toBeCloseTo(100 / 400);
});
it("keeps Cache and Speed cumulative at a checkpoint without usage", () => {
  const records = [started(1, "r1", 128000), assistant(2, "r1", 100, 50, 1000), finished(3, "r1")];
  const metrics = sessionContextMetrics([...records, checkpoint(4, 2)]);
  // 压缩不重置 Cache：checkpoint 自己没带 usage 时，累计只来自 assistant。
  expect(metrics.cacheHitRate).toBeCloseTo(50 / 150);
  expect(metrics.speedTokPerSec).toBeNull();
});
it("spans the hit rate across every finished run of the conversation", () => {
  const metrics = sessionContextMetrics([
    started(1, "r1", 128000),
    assistant(2, "r1", 100, 50, 1000),
    finished(3, "r1"),
    started(4, "r2", 256000),
    assistant(5, "r2", 300, 30, 2000),
    finished(6, "r2"),
  ]);
  expect(metrics.cacheHitRate).toBeCloseTo(80 / 480);
});
it("counts cancelled, failed and turn-limited runs alike", () => {
  const metrics = sessionContextMetrics([
    started(1, "r1", 128000),
    assistant(2, "r1", 10, 5, 100),
    finished(3, "r1", "cancelled"),
    started(4, "r2", 200000),
    assistant(5, "r2", 10, 5, 200),
    finished(6, "r2", "failed"),
    started(7, "r3", 300000),
    assistant(8, "r3", 10, 0, 300),
    finished(9, "r3", "turn_limit"),
  ]);
  expect(metrics.cacheHitRate).toBeCloseTo(10 / 40);
});
it("includes the active run only when its id is given", () => {
  const records = [
    started(1, "r1", 128000),
    assistant(2, "r1", 100, 50, 1000),
    finished(3, "r1"),
    started(4, "r2", 512000),
    assistant(5, "r2", 9999, 9999, 99999),
  ];
  expect(sessionContextMetrics(records).cacheHitRate).toBeCloseTo(1 / 3);
  expect(sessionContextMetrics(records, "r2").cacheHitRate).toBeCloseTo(10049 / 20148);
});
it("counts assistants of earlier runs when the latest finished run has none", () => {
  const metrics = sessionContextMetrics([
    started(1, "r1", 128000),
    assistant(2, "r1", 100, 50, 1000),
    finished(3, "r1"),
    started(4, "r2", 256000),
    finished(5, "r2"),
  ]);
  expect(metrics.cacheHitRate).toBeCloseTo(50 / 150);
});
it("keeps the hit rate at or below 100 percent when cacheRead exceeds input", () => {
  const metrics = sessionContextMetrics([
    started(1, "r1"),
    assistant(2, "r1", 10, 990, 1500),
    finished(3, "r1"),
  ]);
  expect(metrics.cacheHitRate).toBeCloseTo(0.99);
  const view = render(
    wideStatus(stateWith([started(1, "r1"), assistant(2, "r1", 10, 990, 1500), finished(3, "r1")])),
  );
  expect(view.lastFrame()).toContain("Cache: 99.0%");
  expect(view.lastFrame()).not.toContain("990.0%");
  view.unmount();
  const zero = sessionContextMetrics([started(1, "r1"), assistant(2, "r1", 0, 0, 0), finished(3, "r1")]);
  expect(zero.cacheHitRate).toBeNull();
  const zeroView = render(
    wideStatus(stateWith([started(1, "r1"), assistant(2, "r1", 0, 0, 0), finished(3, "r1")])),
  );
  expect(zeroView.lastFrame()).toContain("Cache: 0.0%");
  zeroView.unmount();
});
it("formats k units, decimals, small values and unknown", () => {
  const cases: Array<{
    total: number | null;
    window: number | null;
    estimated?: boolean;
    expected: string;
  }> = [
    { total: 12345, window: 128000, expected: "Context: 12.3k / 128k" },
    { total: 128000, window: 65536, expected: "Context: 128.0k / 65.5k" },
    { total: 500, window: 999, expected: "Context: 500 / 999" },
    { total: 0, window: 0, expected: "Context: 0 / 0" },
    { total: null, window: 128000, expected: "Context: — / 128k" },
    { total: null, window: null, expected: "Context: — / —" },
    { total: 52000, window: 128000, estimated: true, expected: "Context: ~52.0k / 128k" },
  ];
  for (const { total, window, estimated, expected } of cases) {
    expect(contextSegment(contextMetrics(total, window, estimated))).toBe(expected);
  }
});
it("ignores unusable usage fields in Cache and shows — for unknown context", () => {
  const missingUsage = sessionContextMetrics([
    started(1, "r1"),
    assistantWithUsage(2, "r1", undefined),
    finished(3, "r1"),
  ]);
  expect(missingUsage.cacheHitRate).toBeNull();
  const invalidUsage = sessionContextMetrics([
    started(1, "r1"),
    assistant(2, "r1", 100, 50, 1000),
    assistantWithUsage(3, "r1", { input: Number.NaN, cacheRead: 10, totalTokens: 100 }),
    finished(4, "r1"),
  ]);
  expect(invalidUsage.cacheHitRate).toBeNull();
  const missingTotal = sessionContextMetrics([
    started(1, "r1"),
    assistantWithUsage(2, "r1", { input: 100, cacheRead: 50 }),
    finished(3, "r1"),
  ]);
  expect(missingTotal.cacheHitRate).toBeCloseTo(50 / 150);
  const view = render(
    wideStatus(stateWith([started(1, "r1"), assistantWithUsage(2, "r1", undefined), finished(3, "r1")])),
  );
  expect(view.lastFrame()).toContain("Context: — / 128k · Speed: — · Cache: 0.0%");
  view.unmount();
});
it("keeps the five status variants, drops the two hints and renders one line", () => {
  const base = stateWith([]);
  const view = render(wideStatus(base));
  const frame = () => view.lastFrame() ?? "";
  expect(frame()).not.toContain("Ctrl+C");
  expect(frame()).not.toContain("/effort 强度");
  expect(frame()).not.toContain("PgUp/PgDn 历史");
  expect(frame()).toContain("Context: — / 128k · Speed: — · Cache: 0.0%");
  expect(frame().split("\n")).toHaveLength(2);
  view.rerender(
    wideStatus({ ...base, core: { ...base.core, session: { ...base.core.session, model: null } } }),
  );
  expect(frame()).not.toContain("请手动编辑 model.json 配置模型");
  view.rerender(wideStatus({ ...base, retryPrompt: "继续完成之前的任务" }));
  expect(frame()).not.toContain("失败重试：输入区空白时按 Enter 恢复建议，再次 Enter 发送");
  view.rerender(wideStatus({ ...base, modal: { kind: "confirm", selection: 0, purpose: "exit" } }));
  expect(frame()).not.toContain("↑↓ 选择 · Enter 确认 · Esc 取消");
  view.rerender(wideStatus({ ...base, modal: { kind: "approval", selection: 0 } }));
  expect(frame()).not.toContain("↑↓ 选择 · Enter 确认 · Esc 取消");
  view.rerender(wideStatus({ ...base, core: { ...base.core, status: { kind: "compacting" } } }));
  expect(frame()).toContain("Draft · ");
  expect(frame()).not.toContain("草稿（运行中不提交）");
  view.unmount();
});
it("refreshes the context value after every committed turn during an active run", () => {
  const records: SessionRecord[] = [
    started(1, "r1", 128000),
    assistant(2, "r1", 100, 40, 1500),
    finished(3, "r1"),
  ];
  const view = render(wideStatus(stateWith(records, { contextTokens: 1500 })));
  expect(view.lastFrame()).toContain("Context: 1.5k / 128k · Speed: — · Cache: 28.6%");
  const active = [...records, started(4, "r2", 512000)];
  view.rerender(wideStatus(stateWith(active, { contextTokens: 1500, status: running("r2") })));
  expect(view.lastFrame()).toContain("Context: 1.5k / 128k · Speed: — · Cache: 28.6%");
  const firstTurn = [...active, assistant(5, "r2", 300, 30, 2000)];
  view.rerender(
    wideStatus(
      stateWith(firstTurn, {
        contextTokens: 2000,
        model: { ...makeModelSnapshot(), contextWindow: 512000 },
        status: running("r2"),
      }),
    ),
  );
  expect(view.lastFrame()).toContain("Context: 2.0k / 512k · Speed: — · Cache: 14.9%");
  view.rerender(
    wideStatus(
      stateWith([...firstTurn, finished(6, "r2")], {
        contextTokens: 2000,
        model: { ...makeModelSnapshot(), contextWindow: 512000 },
      }),
    ),
  );
  expect(view.lastFrame()).toContain("Context: 2.0k / 512k · Speed: — · Cache: 14.9%");
  view.unmount();
});
it("never shows zero after a cancelled run with no assistant", () => {
  // 回归：首个 Run 发出即取消，无 assistant 落盘。Core 收尾刷新给出含系统提示词的估算，
  // 状态栏直显 ~ 估算，绝不因"选不出实测"渲染 0。
  const finishedRun = [started(1, "r1", 128000), assistant(2, "r1", 100, 40, 1500), finished(3, "r1")];
  const view = render(
    wideStatus(
      stateWith([...finishedRun, started(4, "r2", 512000)], {
        contextTokens: 1500,
        status: running("r2"),
      }),
    ),
  );
  expect(view.lastFrame()).toContain("Context: 1.5k / 128k · Speed: — · Cache: 28.6%");
  view.rerender(
    wideStatus(
      stateWith([...finishedRun, started(4, "r2", 512000), finished(5, "r2", "cancelled")], {
        contextTokens: 4200,
        contextEstimated: true,
      }),
    ),
  );
  expect(view.lastFrame()).toContain("Context: ~4.2k / 128k · Speed: — · Cache: 28.6%");
  expect(view.lastFrame()).not.toContain("Context: 0");
  view.unmount();
});
it("shows the estimate, not zero, when a cancelled run persists a zero-usage partial", () => {
  // 回归：流式中途取消落盘的 aborted partial 携带零占位 usage（pi-ai 初始 partial /
  // 时机 B 合成）。Core 拒零后回退估算，状态栏不再把 0 当实测。
  const zeroUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const records = [
    started(1, "r1", 128000),
    assistantWithUsage(2, "r1", zeroUsage),
    finished(3, "r1", "cancelled"),
  ];
  const view = render(wideStatus(stateWith(records, { contextTokens: 5200, contextEstimated: true })));
  expect(view.lastFrame()).toContain("Context: ~5.2k / 128k");
  expect(view.lastFrame()).not.toContain("Context: 0");
  view.unmount();
});
it("keeps a committed turn of a tool-batch cancel once the run finishes", () => {
  const active = [started(1, "r1", 128000), assistant(2, "r1", 300, 30, 2000)];
  const view = render(wideStatus(stateWith(active, { contextTokens: 2000, status: running("r1") })));
  expect(view.lastFrame()).toContain("Context: 2.0k / 128k · Speed: — · Cache: 9.1%");
  view.rerender(wideStatus(stateWith([...active, finished(3, "r1", "cancelled")], { contextTokens: 2000 })));
  expect(view.lastFrame()).toContain("Context: 2.0k / 128k · Speed: — · Cache: 9.1%");
  view.unmount();
});
it("keeps Cache for the active run when a checkpoint covers its measured assistant", () => {
  const active: SessionRecord[] = [started(1, "r1", 128000), assistant(2, "r1", 100, 50, 1000)];
  const metrics = sessionContextMetrics([...active, checkpoint(3, 2)], "r1");
  expect(metrics.cacheHitRate).toBeCloseTo(50 / 150);
});
it("renders the post-compaction estimate from the snapshot with a ~ prefix", () => {
  // 手动 /compact 的真实几何：恒保留最新 Turn，coveredUpTo 严格小于最后一条 assistant。
  // Context 取值已归 Core，checkpoint 几何不再影响状态栏选值。
  const records: SessionRecord[] = [
    started(1, "r1", 128000),
    assistant(2, "r1", 100, 50, 200000),
    assistant(3, "r1", 100, 50, 230000),
    finished(4, "r1"),
    checkpoint(5, 2),
  ];
  const view = render(wideStatus(stateWith(records, { contextTokens: 52000, contextEstimated: true })));
  expect(view.lastFrame()).toContain("Context: ~52.0k / 128k");
  // 压后首个 Run 进行中同样直显估算。
  view.rerender(
    wideStatus(
      stateWith([...records, started(6, "r2", 128000)], {
        contextTokens: 52000,
        contextEstimated: true,
        status: running("r2"),
      }),
    ),
  );
  expect(view.lastFrame()).toContain("Context: ~52.0k / 128k");
  view.unmount();
});
it("switches back to measured display once Core re-anchors after compaction", () => {
  const records: SessionRecord[] = [
    started(1, "r1", 128000),
    assistant(2, "r1", 100, 50, 230000),
    finished(3, "r1"),
    checkpoint(4, 2),
    started(5, "r2", 128000),
    assistant(6, "r2", 40000, 10000, 55000),
    finished(7, "r2"),
  ];
  const view = render(wideStatus(stateWith(records, { contextTokens: 52000, contextEstimated: true })));
  expect(view.lastFrame()).toContain("Context: ~52.0k / 128k");
  view.rerender(wideStatus(stateWith(records, { contextTokens: 55000 })));
  expect(view.lastFrame()).toContain("Context: 55.0k / 128k");
  // Cache 是整段对话累计：压缩前的 assistant(2) 与压后 assistant(6) 都计入。
  expect(view.lastFrame()).toContain("Cache: 20.0%");
  view.unmount();
});
it("recomputes metrics when a checkpoint with usage is appended", () => {
  const records = [
    started(1, "r1", 128000),
    timedAssistant(2, "r1", 80, 1275),
    finished(3, "r1"),
  ];
  const view = render(wideStatus(stateWith(records)));
  expect(view.lastFrame()).toContain("Speed: 63 tok/s");
  // 追加 checkpoint 不改既有 assistant / run_finished 的 seq，必须靠 refreshKey 的 checkpoint 维度重算。
  view.rerender(
    wideStatus(
      stateWith([...records, checkpoint(4, 2, { input: 900, cacheRead: 100, output: 40, durationMs: 1275 })]),
    ),
  );
  expect(view.lastFrame()).toContain("Speed: 47 tok/s");
  expect(view.lastFrame()).toContain("Cache: 9.1%");
  view.unmount();
});
it("ignores invalid checkpoint records without crashing", () => {
  const records: SessionRecord[] = [
    started(1, "r1", 128000),
    assistant(2, "r1", 100, 50, 230000),
    finished(3, "r1"),
    checkpoint(4, 3),
  ];
  const view = render(wideStatus(stateWith(records, { contextTokens: 230000 })));
  expect(view.lastFrame()).toContain("Context: 230.0k / 128k");
  // Cache/Speed 不依赖 checkpoint 边界；坏记录只被忽略。
  expect(view.lastFrame()).toContain("Cache: 33.3%");
  view.unmount();
});
it("counts checkpoint usage on top of every assistant in Cache and Speed", () => {
  const records: SessionRecord[] = [
    started(1, "r1", 128000),
    assistant(2, "r1", 100, 50, 1000),
    finished(3, "r1"),
    checkpoint(4, 2, { input: 600, cacheRead: 400, output: 200, durationMs: 2000 }),
    started(5, "r2", 128000),
    timedAssistant(6, "r2", 80, 1275),
    assistant(7, "r2", 300, 30, 2000),
    finished(8, "r2"),
  ];
  const metrics = sessionContextMetrics(records);
  // Cache：(50 + 0 + 30 + 400) / (100 + 100 + 300 + 50 + 0 + 30 + 600 + 400)。
  expect(metrics.cacheHitRate).toBeCloseTo(480 / 1580);
  // Speed：(80 + 200) / (1275 + 2000)。
  expect(metrics.speedTokPerSec).toBeCloseTo(280 / 3.275);
});
it("accumulates every checkpoint of the conversation", () => {
  const metrics = sessionContextMetrics([
    started(1, "r1", 128000),
    assistant(2, "r1", 100, 50, 1000),
    finished(3, "r1"),
    checkpoint(4, 2, { input: 500, cacheRead: 500, output: 100, durationMs: 1000 }),
    checkpoint(5, 2, { input: 300, cacheRead: 100, output: 300, durationMs: 2000 }),
  ]);
  // Cache：assistant(2) + checkpoint(4) + checkpoint(5)。
  expect(metrics.cacheHitRate).toBeCloseTo((50 + 500 + 100) / (100 + 50 + 500 + 500 + 300 + 100));
  // Speed：(100 + 300) / (1000 + 2000)。
  expect(metrics.speedTokPerSec).toBeCloseTo(400 / 3);
});
it("counts a checkpoint without duration in Cache but not in Speed", () => {
  const metrics = sessionContextMetrics([
    started(1, "r1", 128000),
    assistant(2, "r1", 100, 50, 1000),
    finished(3, "r1"),
    checkpoint(4, 2, { input: 500, cacheRead: 100, output: 900 }),
  ]);
  // Cache：(50 + 100) / (100 + 50 + 500 + 100)。
  expect(metrics.cacheHitRate).toBeCloseTo(150 / 750);
  // 缺 durationMs 的摘要请求只计 token，不补零冒充测量，因此 Speed 仍无数据。
  expect(metrics.speedTokPerSec).toBeNull();
});
it("ignores malformed checkpoint usage instead of throwing", () => {
  for (const usage of [
    null,
    { input: "500", cacheRead: 100, output: 10 },
    { input: 500, cacheRead: Number.NaN, output: 10, durationMs: 1000 },
    { input: 500, cacheRead: 100, output: 10, durationMs: -1 },
    { input: 500, cacheRead: 100 },
  ]) {
    const metrics = sessionContextMetrics([
      started(1, "r1", 128000),
      assistant(2, "r1", 100, 50, 1000),
      finished(3, "r1"),
      { ...checkpoint(4, 2), usage } as unknown as SessionRecord,
    ]);
    expect(metrics.cacheHitRate).toBeCloseTo(50 / 150);
    expect(metrics.speedTokPerSec).toBeNull();
  }
});
it("renders non-zero Cache and Speed after a compaction", () => {
  const records: SessionRecord[] = [
    started(1, "r1", 128000),
    timedAssistant(2, "r1", 80, 1275),
    assistant(3, "r1", 100, 50, 1000),
    finished(4, "r1"),
    checkpoint(5, 3, { input: 800, cacheRead: 200, output: 40, durationMs: 1275 }),
  ];
  const view = render(wideStatus(stateWith(records)));
  // Cache：(0 + 50 + 200) / (100 + 0 + 100 + 50 + 800 + 200) = 20.0%。
  expect(view.lastFrame()).toContain("Cache: 20.0%");
  expect(view.lastFrame()).toContain("Speed: 47 tok/s");
  view.unmount();
});
it("counts the active run without any finished run", () => {
  const metrics = sessionContextMetrics([started(1, "r1", 256000), assistant(2, "r1", 100, 50, 1500)], "r1");
  expect(metrics.cacheHitRate).toBeCloseTo(1 / 3);
});
it("counts valid usage fields of the active run even without totalTokens", () => {
  const metrics = sessionContextMetrics(
    [
      started(1, "r1", 128000),
      assistant(2, "r1", 100, 50, 1000),
      finished(3, "r1"),
      started(4, "r2", 512000),
      assistantWithUsage(5, "r2", { input: 10, cacheRead: 5 }),
    ],
    "r2",
  );
  expect(metrics.cacheHitRate).toBeCloseTo(55 / 165);
});
it("truncates the single line in a narrow frame without adding rows", () => {
  const state = stateWith([started(1, "r1", 128000), assistant(2, "r1", 100, 50, 12345), finished(3, "r1")]);
  const view = render(wideStatus(state, 24));
  const lines = (view.lastFrame() ?? "").split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain("Mode:");
  expect(lines[1]).not.toContain("Cache:");
  view.unmount();
});
it("derives speed from output and request duration", () => {
  const metrics = sessionContextMetrics([
    started(1, "r1", 128000),
    timedAssistant(2, "r1", 80, 1275),
    finished(3, "r1"),
  ]);
  expect(metrics.speedTokPerSec).toBeCloseTo(80 / 1.275);
});
it("sums speed across the run", () => {
  const metrics = sessionContextMetrics([
    started(1, "r1", 128000),
    timedAssistant(2, "r1", 80, 1275),
    assistant(3, "r1", 100, 40, 2000),
    finished(4, "r1"),
  ]);
  expect(metrics.speedTokPerSec).toBeCloseTo(80 / 1.275);
});
it("weights the run average by duration instead of averaging turn speeds", () => {
  const records = [
    started(1, "r1", 128000),
    timedAssistant(2, "r1", 80, 1275),
    timedAssistant(3, "r1", 100, 1075),
    finished(4, "r1"),
  ];
  const metrics = sessionContextMetrics(records);
  expect(metrics.speedTokPerSec).toBeCloseTo(180 / 2.35);
  expect(metrics.speedTokPerSec).not.toBeCloseTo(100 / 1.075);
  expect(metrics.speedTokPerSec).not.toBeCloseTo((80 / 1.275 + 100 / 1.075) / 2);
  const view = render(wideStatus(stateWith(records)));
  expect(view.lastFrame()).toContain("Speed: 77 tok/s");
  view.unmount();
});
it("drops a turn entirely when either output or duration is unusable", () => {
  const lateInvalid = sessionContextMetrics([
    started(1, "r1"),
    timedAssistant(2, "r1", 80, 1275),
    timedAssistant(3, "r1", 100, undefined),
    finished(4, "r1"),
  ]);
  expect(lateInvalid.speedTokPerSec).toBeCloseTo(80 / 1.275);
  expect(lateInvalid.speedTokPerSec).not.toBeCloseTo(180 / 1.275);
  const earlyInvalid = sessionContextMetrics([
    started(1, "r1"),
    timedAssistant(2, "r1", undefined, 1275),
    timedAssistant(3, "r1", 100, 1075),
    finished(4, "r1"),
  ]);
  expect(earlyInvalid.speedTokPerSec).toBeCloseTo(100 / 1.075);
});
it("returns null when no turn of the run has a usable pair", () => {
  const metrics = sessionContextMetrics([
    started(1, "r1"),
    timedAssistant(2, "r1", 80, undefined),
    timedAssistant(3, "r1", undefined, 1275),
    finished(4, "r1"),
  ]);
  expect(metrics.speedTokPerSec).toBeNull();
});
it("weights every run of the conversation into the average", () => {
  const metrics = sessionContextMetrics(
    [
      started(1, "r1", 128000),
      timedAssistant(2, "r1", 80, 1275),
      timedAssistant(3, "r1", 100, 1075),
      finished(4, "r1"),
      started(5, "r2", 512000),
      timedAssistant(6, "r2", 50, 1000),
      timedAssistant(7, "r2", 30, 1000),
    ],
    "r2",
  );
  expect(metrics.speedTokPerSec).toBeCloseTo(260 / 4.35);
  expect(metrics.speedTokPerSec).not.toBeCloseTo(80 / 2);
});
it("counts committed turns of cancelled and failed runs in the average", () => {
  for (const outcome of ["cancelled", "failed"] as const) {
    const metrics = sessionContextMetrics([
      started(1, "r1", 128000),
      timedAssistant(2, "r1", 80, 1275),
      timedAssistant(3, "r1", 100, 1075),
      finished(4, "r1", outcome),
    ]);
    expect(metrics.speedTokPerSec).toBeCloseTo(180 / 2.35);
  }
});
it("dilutes the conversation average with a new turn of the active run", () => {
  const records = [
    started(1, "r1", 128000),
    timedAssistant(2, "r1", 80, 1275),
    timedAssistant(3, "r1", 100, 1075),
    finished(4, "r1"),
  ];
  const before = sessionContextMetrics([...records, started(5, "r2", 512000)], "r2");
  expect(before.speedTokPerSec).toBeCloseTo(180 / 2.35);
  const after = sessionContextMetrics(
    [...records, started(5, "r2", 512000), timedAssistant(6, "r2", 100, 1075)],
    "r2",
  );
  expect(after.speedTokPerSec).toBeCloseTo(280 / 3.425);
  expect(after.speedTokPerSec).not.toBeCloseTo(100 / 1.075);
});
it("falls back to null when output or duration is unusable", () => {
  const cases: Array<[unknown, unknown]> = [
    [80, undefined],
    [80, 0],
    [80, -1],
    [80, Number.NaN],
    [80, "1275"],
    [undefined, 1275],
    [Number.NaN, 1275],
    [-1, 1275],
    ["80", 1275],
  ];
  for (const [output, durationMs] of cases) {
    const metrics = sessionContextMetrics([
      started(1, "r1"),
      timedAssistant(2, "r1", output, durationMs),
      finished(3, "r1"),
    ]);
    expect(metrics.speedTokPerSec).toBeNull();
  }
});
it("renders the speed as an integer between context and cache", () => {
  const view = render(
    wideStatus(
      stateWith([started(1, "r1", 128000), timedAssistant(2, "r1", 80, 1275), finished(3, "r1")], {
        contextTokens: 1000,
      }),
    ),
  );
  expect(view.lastFrame()).toContain("Context: 1.0k / 128k · Speed: 63 tok/s · Cache: 0.0%");
  view.unmount();
  const rounded = render(
    wideStatus(stateWith([started(1, "r1", 128000), timedAssistant(2, "r1", 100, 1075), finished(3, "r1")])),
  );
  expect(rounded.lastFrame()).toContain("Speed: 93 tok/s");
  rounded.unmount();
});
it("always renders the speed segment even without usable data", () => {
  const view = render(
    wideStatus(stateWith([started(1, "r1"), assistant(2, "r1", 100, 50, 1000), finished(3, "r1")])),
  );
  expect(view.lastFrame()).toContain("Speed: —");
  expect(view.lastFrame()).not.toContain("Decision:");
  view.unmount();
});
it("hides the whole speed segment when the line would exceed the width", () => {
  const state = stateWith([started(1, "r1", 128000), timedAssistant(2, "r1", 80, 1275), finished(3, "r1")]);
  const width = visibleWidth(new StatusBar(state).render(1000)[1]!);
  const fit = render(wideStatus(state, width));
  expect(fit.lastFrame()).toContain("Speed: 63 tok/s");
  expect(fit.lastFrame()).toContain("Cache: 0.0%");
  fit.unmount();
  const tight = render(wideStatus(state, width - 1));
  expect(tight.lastFrame()).not.toContain("Speed");
  expect(tight.lastFrame()).toContain("Cache: 0.0%");
  expect((tight.lastFrame() ?? "").split("\n")).toHaveLength(2);
  tight.unmount();
});
