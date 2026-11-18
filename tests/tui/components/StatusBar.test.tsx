import { stripVTControlCharacters as stripAnsi } from "node:util";
import { visibleWidth } from "../../../src/tui/framework/index.js";
import { afterEach, expect, it } from "vitest";
import type { ControllerStatus, RunPhase } from "../../../src/core/state.js";
import { SessionController } from "../../../src/core/session-controller.js";
import { parseSettings } from "../../../src/llm/settings-store.js";
import type {
  RunModelSnapshot,
  SessionRecord,
  SessionRunOutcome,
  StoredAssistantMessage,
} from "../../../src/sessions/records.js";
import { StatusBar, sessionContextMetrics, contextSegment, formatWorkspacePath } from "../../../src/tui/components/StatusBar.js";
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
function checkpoint(seq: number, coveredUpTo: number): SessionRecord {
  return {
    type: "checkpoint",
    recordSeq: seq,
    ts: "now",
    summary: "summary",
    coveredUpTo,
    model: { providerId: "p", modelId: "m" },
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
function stateWith(
  records: SessionRecord[],
  options: {
    sessionId?: string;
    model?: RunModelSnapshot | null;
    baseline?: number | null;
    status?: ControllerStatus;
  } = {},
): TuiState {
  const sessionId = options.sessionId ?? "s";
  const store = new TuiStore(
    new SessionController({
      driver: { execute: async () => ({ outcome: "completed" }) },
      hooks: {
        getSessionView: () => ({
          autoDecision: { enabled: true, availability: "missing" },
          ref: { workspaceId: "ws", sessionId },
          title: null,
          model: options.model === undefined ? makeModelSnapshot() : options.model,
          models: [],
          runModel: null,
          contextBaselineTokens: options.baseline ?? null,
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
      meta: { version: 3, workspaceId: "ws", sessionId, createdAt: "now" },
      records,
      warnings: [],
      fromRecordSeq: 1,
    },
  };
}
it("returns no metrics for an empty history or for runs that have not finished", () => {
  expect(sessionContextMetrics([])).toEqual({
    contextTokens: null,
    contextWindow: null,
    cacheHitRate: null,
    speedTokPerSec: null,
    contextEstimated: false,
  });
  expect(sessionContextMetrics([started(1, "r1"), assistant(2, "r1", 100, 50)])).toEqual({
    contextTokens: null,
    contextWindow: null,
    cacheHitRate: null,
    speedTokPerSec: null,
    contextEstimated: false,
  });
  const view = render(wideStatus(stateWith([], { model: null })));
  expect(view.lastFrame()).toContain("Context: 0 / 0 · Speed: — · Cache: 0.0%");
  expect((view.lastFrame() ?? "").split("\n")).toHaveLength(2);
  view.unmount();
});
it("shows the fixed-overhead estimate against the current model window before the first finished run", () => {
  const view = render(wideStatus(stateWith([], { baseline: 3941 })));
  expect(view.lastFrame()).toContain("Context: 3.9k / 128k · Speed: — · Cache: 0.0%");
  view.rerender(
    wideStatus(
      stateWith([], {
        baseline: 3941,
        model: { ...makeModelSnapshot(), contextWindow: 256000 },
      }),
    ),
  );
  expect(view.lastFrame()).toContain("Context: 3.9k / 256k · Speed: — · Cache: 0.0%");
  view.rerender(wideStatus(stateWith([], { baseline: null })));
  expect(view.lastFrame()).toContain("Context: 0 / 128k · Speed: — · Cache: 0.0%");
  view.unmount();
});
it("uses the estimate for an active first run and real usage after it finishes", () => {
  const active = [started(1, "r1", 256000), assistant(2, "r1", 300, 0, 2000)];
  const view = render(wideStatus(stateWith(active, { baseline: 3941 })));
  expect(view.lastFrame()).toContain("Context: 3.9k / 128k · Speed: — · Cache: 0.0%");
  view.rerender(wideStatus(stateWith([...active, finished(3, "r1")], { baseline: 3941 })));
  expect(view.lastFrame()).toContain("Context: 2.0k / 256k · Speed: — · Cache: 0.0%");
  view.unmount();
});
it("keeps real metrics when the estimate or current model window changes after a finished run", () => {
  const records = [started(1, "r1", 128000), assistant(2, "r1", 100, 40, 1500), finished(3, "r1")];
  const view = render(wideStatus(stateWith(records, { baseline: 3941 })));
  expect(view.lastFrame()).toContain("Context: 1.5k / 128k · Speed: — · Cache: 28.6%");
  view.rerender(
    wideStatus(
      stateWith(records, {
        baseline: 9000,
        model: { ...makeModelSnapshot(), contextWindow: 512000 },
      }),
    ),
  );
  expect(view.lastFrame()).toContain("Context: 1.5k / 128k · Speed: — · Cache: 28.6%");
  view.unmount();
});
it("takes the latest request totalTokens within the most recently finished run", () => {
  const metrics = sessionContextMetrics([
    started(1, "r1", 128000),
    assistant(2, "r1", 100, 40, 1000),
    assistant(3, "r1", 200, 60, 2000),
    finished(4, "r1"),
  ]);
  expect(metrics.contextTokens).toBe(2000);
  expect(metrics.contextWindow).toBe(128000);
  expect(metrics.cacheHitRate).toBeCloseTo(100 / 400);
});
it("resets Cache and Speed at the latest checkpoint while keeping the measured Context", () => {
  const records = [started(1, "r1", 128000), assistant(2, "r1", 100, 50, 1000), finished(3, "r1")];
  const metrics = sessionContextMetrics([...records, checkpoint(4, 2)]);
  expect(metrics.contextTokens).toBe(1000);
  expect(metrics.contextWindow).toBe(128000);
  expect(metrics.cacheHitRate).toBeNull();
  expect(metrics.speedTokPerSec).toBeNull();
  expect(metrics.contextEstimated).toBe(false);
});
it("keeps earlier runs out of the context value while the hit rate still spans runs of the same era", () => {
  const metrics = sessionContextMetrics([
    started(1, "r1", 128000),
    assistant(2, "r1", 100, 50, 1000),
    finished(3, "r1"),
    started(4, "r2", 256000),
    assistant(5, "r2", 300, 30, 2000),
    finished(6, "r2"),
  ]);
  expect(metrics.contextTokens).toBe(2000);
  expect(metrics.contextWindow).toBe(256000);
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
  expect(metrics.contextTokens).toBe(300);
  expect(metrics.contextWindow).toBe(300000);
  expect(metrics.cacheHitRate).toBeCloseTo(10 / 40);
});
it("measures the active run when given its id and ignores it otherwise", () => {
  const records = [
    started(1, "r1", 128000),
    assistant(2, "r1", 100, 50, 1000),
    finished(3, "r1"),
    started(4, "r2", 512000),
    assistant(5, "r2", 9999, 9999, 99999),
  ];
  const idle = sessionContextMetrics(records);
  expect(idle.contextTokens).toBe(1000);
  expect(idle.contextWindow).toBe(128000);
  expect(idle.cacheHitRate).toBeCloseTo(1 / 3);
  const active = sessionContextMetrics(records, undefined, "r2");
  expect(active.contextTokens).toBe(99999);
  expect(active.contextWindow).toBe(512000);
  expect(active.cacheHitRate).toBeCloseTo(10049 / 20148);
});
it("falls back only the context value when the latest finished run has no assistant message", () => {
  const metrics = sessionContextMetrics([
    started(1, "r1", 128000),
    assistant(2, "r1", 100, 50, 1000),
    finished(3, "r1"),
    started(4, "r2", 256000),
    finished(5, "r2"),
  ]);
  expect(metrics.contextTokens).toBeNull();
  expect(metrics.contextWindow).toBe(256000);
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
it("formats k units, decimals and small token values", () => {
  const cases: Array<{
    total: number;
    window: number;
    expected: string;
  }> = [
    { total: 12345, window: 128000, expected: "Context: 12.3k / 128k" },
    { total: 128000, window: 65536, expected: "Context: 128.0k / 65.5k" },
    { total: 500, window: 999, expected: "Context: 500 / 999" },
    { total: 0, window: 0, expected: "Context: 0 / 0" },
  ];
  for (const { total, window, expected } of cases) {
    const records = [started(1, "r1", window), assistant(2, "r1", 100, 0, total), finished(3, "r1")];
    const view = render(wideStatus(stateWith(records)));
    expect(view.lastFrame()).toContain(expected);
    view.unmount();
  }
});
it("falls back to zero when snapshots, usage or numbers are missing", () => {
  const missingWindow = sessionContextMetrics([assistant(1, "r1", 100, 50, 1000), finished(2, "r1")]);
  expect(missingWindow.contextWindow).toBeNull();
  expect(missingWindow.contextTokens).toBe(1000);
  const invalidWindow = sessionContextMetrics([
    started(1, "r1", Number.NaN),
    assistant(2, "r1", 100, 50, 1000),
    finished(3, "r1"),
  ]);
  expect(invalidWindow.contextWindow).toBeNull();
  const missingUsage = sessionContextMetrics([
    started(1, "r1"),
    assistantWithUsage(2, "r1", undefined),
    finished(3, "r1"),
  ]);
  expect(missingUsage.contextTokens).toBeNull();
  expect(missingUsage.cacheHitRate).toBeNull();
  const invalidUsage = sessionContextMetrics([
    started(1, "r1"),
    assistant(2, "r1", 100, 50, 1000),
    assistantWithUsage(3, "r1", { input: Number.NaN, cacheRead: 10, totalTokens: 100 }),
    finished(4, "r1"),
  ]);
  expect(invalidUsage.contextTokens).toBe(100);
  expect(invalidUsage.cacheHitRate).toBeNull();
  const missingTotal = sessionContextMetrics([
    started(1, "r1"),
    assistantWithUsage(2, "r1", { input: 100, cacheRead: 50 }),
    finished(3, "r1"),
  ]);
  expect(missingTotal.contextTokens).toBeNull();
  expect(missingTotal.cacheHitRate).toBeCloseTo(50 / 150);
  const view = render(
    wideStatus(stateWith([started(1, "r1"), assistantWithUsage(2, "r1", undefined), finished(3, "r1")])),
  );
  expect(view.lastFrame()).toContain("Context: 0 / 128k · Speed: — · Cache: 0.0%");
  view.unmount();
});
it("keeps the five status variants, drops the two hints and renders one line", () => {
  const base = stateWith([]);
  const view = render(wideStatus(base));
  const frame = () => view.lastFrame() ?? "";
  expect(frame()).not.toContain("Ctrl+C");
  expect(frame()).not.toContain("/effort 强度");
  expect(frame()).not.toContain("PgUp/PgDn 历史");
  expect(frame()).toContain("Context: 0 / 128k · Speed: — · Cache: 0.0%");
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
it("refreshes metrics after every committed turn during an active run", () => {
  const records: SessionRecord[] = [
    started(1, "r1", 128000),
    assistant(2, "r1", 100, 40, 1500),
    finished(3, "r1"),
  ];
  const view = render(wideStatus(stateWith(records)));
  expect(view.lastFrame()).toContain("Context: 1.5k / 128k · Speed: — · Cache: 28.6%");
  const active = [...records, started(4, "r2", 512000)];
  view.rerender(wideStatus(stateWith(active, { status: running("r2") })));
  expect(view.lastFrame()).toContain("Context: 1.5k / 128k · Speed: — · Cache: 28.6%");
  const firstTurn = [...active, assistant(5, "r2", 300, 30, 2000)];
  view.rerender(wideStatus(stateWith(firstTurn, { status: running("r2") })));
  expect(view.lastFrame()).toContain("Context: 2.0k / 512k · Speed: — · Cache: 14.9%");
  view.rerender(wideStatus(stateWith([...firstTurn, finished(6, "r2")])));
  expect(view.lastFrame()).toContain("Context: 2.0k / 512k · Speed: — · Cache: 14.9%");
  view.unmount();
});
it("keeps the previous metrics on a mid-stream cancel and falls back after the cancelled run finishes", () => {
  const finishedRun = [started(1, "r1", 128000), assistant(2, "r1", 100, 40, 1500), finished(3, "r1")];
  const view = render(
    wideStatus(stateWith([...finishedRun, started(4, "r2", 512000)], { status: running("r2") })),
  );
  expect(view.lastFrame()).toContain("Context: 1.5k / 128k · Speed: — · Cache: 28.6%");
  view.rerender(
    wideStatus(stateWith([...finishedRun, started(4, "r2", 512000), finished(5, "r2", "cancelled")])),
  );
  expect(view.lastFrame()).toContain("Context: 0 / 512k · Speed: — · Cache: 28.6%");
  view.unmount();
});
it("keeps a committed turn of a tool-batch cancel once the run finishes", () => {
  const active = [started(1, "r1", 128000), assistant(2, "r1", 300, 30, 2000)];
  const view = render(wideStatus(stateWith(active, { status: running("r1") })));
  expect(view.lastFrame()).toContain("Context: 2.0k / 128k · Speed: — · Cache: 9.1%");
  view.rerender(wideStatus(stateWith([...active, finished(3, "r1", "cancelled")])));
  expect(view.lastFrame()).toContain("Context: 2.0k / 128k · Speed: — · Cache: 9.1%");
  view.unmount();
});
it("resets Cache at a checkpoint covering the active run's measured assistant", () => {
  const active: SessionRecord[] = [started(1, "r1", 128000), assistant(2, "r1", 100, 50, 1000)];
  const metrics = sessionContextMetrics([...active, checkpoint(3, 2)], undefined, "r1");
  expect(metrics.contextTokens).toBe(1000);
  expect(metrics.cacheHitRate).toBeNull();
});
it("shows the post-compaction estimate when the checkpoint covers the measured assistant", () => {
  const records: SessionRecord[] = [
    started(1, "r1", 128000),
    assistant(2, "r1", 100, 50, 230000),
    finished(3, "r1"),
    checkpoint(4, 2),
  ];
  const metrics = sessionContextMetrics(records, undefined, null, 52000);
  expect(metrics.contextTokens).toBe(52000);
  expect(metrics.contextEstimated).toBe(true);
  expect(contextSegment(metrics)).toBe("Context: ~52.0k / 128k");
  // 无估算值时保持实测（旧行为不回退）。
  const withoutEstimate = sessionContextMetrics(records);
  expect(withoutEstimate.contextTokens).toBe(230000);
  expect(withoutEstimate.contextEstimated).toBe(false);
});
it("switches back to real usage once a post-compaction assistant is committed", () => {
  const records: SessionRecord[] = [
    started(1, "r1", 128000),
    assistant(2, "r1", 100, 50, 230000),
    finished(3, "r1"),
    checkpoint(4, 2),
    started(5, "r2", 128000),
    assistant(6, "r2", 40000, 10000, 55000),
    finished(7, "r2"),
  ];
  const metrics = sessionContextMetrics(records, undefined, null, 52000);
  expect(metrics.contextTokens).toBe(55000);
  expect(metrics.contextEstimated).toBe(false);
  // Cache 只含压后 assistant(6)，与 Context 同一触发点恢复。
  expect(metrics.cacheHitRate).toBeCloseTo(10000 / 50000);
});
it("recomputes metrics when a checkpoint is appended", () => {
  const records = [
    started(1, "r1", 128000),
    timedAssistant(2, "r1", 80, 1275),
    finished(3, "r1"),
  ];
  const view = render(wideStatus(stateWith(records)));
  expect(view.lastFrame()).toContain("Speed: 63 tok/s");
  view.rerender(wideStatus(stateWith([...records, checkpoint(4, 2)])));
  expect(view.lastFrame()).toContain("Speed: —");
  expect(view.lastFrame()).toContain("Cache: 0.0%");
  view.unmount();
});
it("shows the estimate during the first post-compaction request of an active run", () => {
  const records: SessionRecord[] = [
    started(1, "r1", 128000),
    assistant(2, "r1", 100, 50, 230000),
    finished(3, "r1"),
    checkpoint(4, 2),
    started(5, "r2", 128000),
  ];
  const metrics = sessionContextMetrics(records, undefined, "r2", 52000);
  expect(metrics.contextTokens).toBe(52000);
  expect(metrics.contextEstimated).toBe(true);
});
it("renders the estimate from the controller snapshot with a ~ prefix", () => {
  const records: SessionRecord[] = [
    started(1, "r1", 128000),
    assistant(2, "r1", 100, 50, 230000),
    finished(3, "r1"),
    checkpoint(4, 2),
  ];
  const base = stateWith(records);
  const view = render(
    wideStatus({
      ...base,
      core: {
        ...base.core,
        session: { ...base.core.session, contextEstimateTokens: 52000 },
      },
    }),
  );
  expect(view.lastFrame()).toContain("Context: ~52.0k / 128k");
  view.unmount();
});
it("keeps real usage without crashing when the checkpoint is invalid", () => {
  const records: SessionRecord[] = [
    started(1, "r1", 128000),
    assistant(2, "r1", 100, 50, 230000),
    finished(3, "r1"),
    checkpoint(4, 3),
  ];
  const metrics = sessionContextMetrics(records, undefined, null, 52000);
  expect(metrics.contextTokens).toBe(230000);
  expect(metrics.contextEstimated).toBe(false);
  // 边界无法判定时 Cache/Speed 也保持全量聚合，状态栏不因坏记录崩溃。
  expect(metrics.cacheHitRate).toBeCloseTo(50 / 150);
});
it("counts only assistants after the latest checkpoint in Cache and Speed", () => {
  const records: SessionRecord[] = [
    started(1, "r1", 128000),
    assistant(2, "r1", 100, 50, 1000),
    finished(3, "r1"),
    checkpoint(4, 2),
    started(5, "r2", 128000),
    timedAssistant(6, "r2", 80, 1275),
    assistant(7, "r2", 300, 30, 2000),
    finished(8, "r2"),
  ];
  const metrics = sessionContextMetrics(records);
  expect(metrics.contextTokens).toBe(2000);
  // 只含 checkpoint 之后的 assistant(6)(7)：input 100+300、cacheRead 0+30。
  expect(metrics.cacheHitRate).toBeCloseTo(30 / 430);
  expect(metrics.speedTokPerSec).toBeCloseTo(80 / 1.275);
});
it("uses real usage and cache for an active run without any finished run", () => {
  const metrics = sessionContextMetrics(
    [started(1, "r1", 256000), assistant(2, "r1", 100, 50, 1500)],
    { contextTokens: 3941, contextWindow: 128000 },
    "r1",
  );
  expect(metrics.contextTokens).toBe(1500);
  expect(metrics.contextWindow).toBe(256000);
  expect(metrics.cacheHitRate).toBeCloseTo(1 / 3);
});
it("shows zero instead of carrying an earlier run when the active run's usage is invalid", () => {
  const metrics = sessionContextMetrics(
    [
      started(1, "r1", 128000),
      assistant(2, "r1", 100, 50, 1000),
      finished(3, "r1"),
      started(4, "r2", 512000),
      assistantWithUsage(5, "r2", { input: 10, cacheRead: 5 }),
    ],
    undefined,
    "r2",
  );
  expect(metrics.contextTokens).toBeNull();
  expect(metrics.contextWindow).toBe(512000);
  expect(metrics.cacheHitRate).toBeCloseTo(55 / 165);
});
it("truncates the single line in a narrow frame without adding rows", () => {
  const state = stateWith([started(1, "r1", 128000), assistant(2, "r1", 100, 50, 12345), finished(3, "r1")]);
  const view = render(wideStatus(state, 24));
  const lines = (view.lastFrame() ?? "").split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain("Decision:");
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
it("sums speed across the run while context still takes the latest record", () => {
  const metrics = sessionContextMetrics([
    started(1, "r1", 128000),
    timedAssistant(2, "r1", 80, 1275),
    assistant(3, "r1", 100, 40, 2000),
    finished(4, "r1"),
  ]);
  expect(metrics.contextTokens).toBe(2000);
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
it("keeps earlier runs out of the weighted average", () => {
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
    undefined,
    "r2",
  );
  expect(metrics.speedTokPerSec).toBeCloseTo(80 / 2);
  expect(metrics.speedTokPerSec).not.toBeCloseTo(260 / 4.35);
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
it("carries the previous run average until the active run commits a turn", () => {
  const records = [
    started(1, "r1", 128000),
    timedAssistant(2, "r1", 80, 1275),
    timedAssistant(3, "r1", 100, 1075),
    finished(4, "r1"),
  ];
  const before = sessionContextMetrics([...records, started(5, "r2", 512000)], undefined, "r2");
  expect(before.speedTokPerSec).toBeCloseTo(180 / 2.35);
  const after = sessionContextMetrics(
    [...records, started(5, "r2", 512000), timedAssistant(6, "r2", 100, 1075)],
    undefined,
    "r2",
  );
  expect(after.speedTokPerSec).toBeCloseTo(100 / 1.075);
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
    wideStatus(stateWith([started(1, "r1", 128000), timedAssistant(2, "r1", 80, 1275), finished(3, "r1")])),
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
  expect(view.lastFrame()).not.toContain("Auto Decision");
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
it("hides the speed segment at the running-prefix boundary", () => {
  const state = stateWith([started(1, "r1", 128000), timedAssistant(2, "r1", 80, 1275)], {
    status: running("r1"),
  });
  const width = visibleWidth(new StatusBar(state).render(1000)[1]!);
  const fit = render(wideStatus(state, width));
  expect(fit.lastFrame()).toContain("Speed: 63 tok/s");
  fit.unmount();
  const tight = render(wideStatus(state, width - 1));
  expect(tight.lastFrame()).not.toContain("Speed");
  expect(tight.lastFrame()).toContain("Cache: 0.0%");
  tight.unmount();
});
it("hides the dash segment at the running-prefix boundary too", () => {
  const state = stateWith([], { baseline: 3941, status: running("r1") });
  const width = visibleWidth(new StatusBar(state).render(1000)[1]!);
  const fit = render(wideStatus(state, width));
  expect(fit.lastFrame()).toContain("Speed: —");
  fit.unmount();
  const tight = render(wideStatus(state, width - 1));
  expect(tight.lastFrame()).not.toContain("Speed");
  expect(tight.lastFrame()).toContain("Cache: 0.0%");
  tight.unmount();
});
it("hides the dash segment too when the width is short", () => {
  const state = stateWith([], { baseline: 3941 });
  const width = visibleWidth(new StatusBar(state).render(1000)[1]!);
  const fit = render(wideStatus(state, width));
  expect(fit.lastFrame()).toContain("Speed: —");
  fit.unmount();
  const tight = render(wideStatus(state, width - 1));
  expect(tight.lastFrame()).not.toContain("Speed");
  expect(tight.lastFrame()).toContain("Cache: 0.0%");
  tight.unmount();
});

it("renders a workspace line and decision line without a permanent interrupt hint", () => {
  const bar = new StatusBar(stateWith([]));
  const rows = bar.render(120);
  expect(rows).toHaveLength(2);
  expect(stripAnsi(rows[1]!)).toContain("Decision: manual");
  expect(rows.join("\n")).not.toContain("Ctrl+C");
});

it.each([
  [false, "invalid", "manual"], [true, "invalid", "manual (config error)"],
  [true, "missing", "manual (not configured)"], [true, "unavailable", "manual (unavailable)"],
  [true, "ready", "auto"],
] as const)("renders decision enabled=%s availability=%s", (enabled, availability, expected) => {
  const state = stateWith([]);
  state.core.session.autoDecision = { enabled, availability };
  const rows = new StatusBar(state, { workspacePath: "D:\\project", homeDirectory: "C:\\Users\\me" }).render(120);
  expect(stripAnsi(rows[1]!)).toContain(`Decision: ${expected}`);
  expect(stripAnsi(rows[0]!)).toBe("D:\\project");
});
it("shortens workspace paths at directory boundaries and respects display widths", () => {
  expect(formatWorkspacePath("C:\\Users\\me\\project", "C:\\Users\\me", 80)).toBe("~\\project");
  expect(formatWorkspacePath("/home/me2/project", "/home/me", 80)).toBe("/home/me2/project");
  expect(formatWorkspacePath("/home/me", "/home/me", 80)).toBe("~");
  for (const value of ["D:\\very-long-parent\\project", "/long/parent/项目😀", "\\\\server\\share\\long\\project"]) {
    for (const width of [0, 1, 5, 16, 80]) expect(visibleWidth(formatWorkspacePath(value, "", width))).toBeLessThanOrEqual(width);
  }
  expect(formatWorkspacePath("/secret/project", "", 80, text => text.replace("secret", "[redacted]"))).toBe("/[redacted]/project");
});

it("keeps path output single line and accepts dot-prefixed home children", () => {
  expect(formatWorkspacePath("/home/me/..project", "/home/me", 80)).toBe("~/..project");
  expect(formatWorkspacePath("/tmp/line\nbreak", "", 80)).toBe("/tmp/line break");
});
