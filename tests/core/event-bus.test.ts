import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../../src/core/event-bus.js";
import type { BusEvent, FormalEvent } from "../../src/core/events.js";

function formal(type: FormalEvent["type"]): FormalEvent {
  return { type, runId: "r1" } as FormalEvent;
}

describe("EventBus", () => {
  it("有序广播：监听器按注册顺序收到同一事件", () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.subscribe(() => order.push("a"));
    bus.subscribe(() => order.push("b"));
    bus.publish(formal("run.started"));
    expect(order).toEqual(["a", "b"]);
  });

  it("监听异常隔离：抛错不影响其他监听者与主流程", () => {
    const bus = new EventBus();
    const onListenerError = vi.fn();
    const busWithSink = new EventBus({ onListenerError });
    const received: string[] = [];
    bus.subscribe(() => {
      throw new Error("listener boom");
    });
    bus.subscribe((event) => received.push(event.type));
    expect(() => bus.publish(formal("run.started"))).not.toThrow();
    expect(received).toEqual(["run.started"]);

    busWithSink.subscribe(() => {
      throw new Error("boom");
    });
    busWithSink.subscribe(() => {});
    busWithSink.publish(formal("run.started"));
    expect(onListenerError).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe 后不再收到事件", () => {
    const bus = new EventBus();
    const received: string[] = [];
    const unsubscribe = bus.subscribe((event) => received.push(event.type));
    unsubscribe();
    bus.publish(formal("run.started"));
    expect(received).toEqual([]);
  });

  it("流式 delta 可合并：多次 offer 一次 flush 合成单事件", () => {
    const bus = new EventBus();
    const received: BusEvent[] = [];
    bus.subscribe((event) => received.push(event));
    bus.offerDelta({ type: "llm.text.delta", runId: "r1", delta: "Hel" });
    bus.offerDelta({ type: "llm.text.delta", runId: "r1", delta: "lo" });
    bus.offerDelta({ type: "llm.thinking.delta", runId: "r1", delta: "think" });
    expect(received).toEqual([]);
    bus.flushDeltas();
    expect(received).toEqual([
      { type: "llm.text.delta", runId: "r1", delta: "Hello" },
      { type: "llm.thinking.delta", runId: "r1", delta: "think" },
    ]);
  });

  it("正式事件发布前先 flush 缓冲 delta，保证顺序", () => {
    const bus = new EventBus();
    const received: BusEvent[] = [];
    bus.subscribe((event) => received.push(event));
    bus.offerDelta({ type: "llm.text.delta", runId: "r1", delta: "partial" });
    bus.publish(formal("run.state_changed"));
    expect(received.map((e) => e.type)).toEqual(["llm.text.delta", "run.state_changed"]);
    expect((received[0] as { delta: string }).delta).toBe("partial");
  });

  it("publishStreaming 立即广播，全量快照不合并", () => {
    const bus = new EventBus();
    const received: BusEvent[] = [];
    bus.subscribe((event) => received.push(event));
    bus.publishStreaming({ type: "tool.output.delta", runId: "r1", toolCallId: "c1", delta: "a" });
    bus.publishStreaming({ type: "tool.output.delta", runId: "r1", toolCallId: "c1", delta: "ab" });
    expect(received).toEqual([
      { type: "tool.output.delta", runId: "r1", toolCallId: "c1", delta: "a" },
      { type: "tool.output.delta", runId: "r1", toolCallId: "c1", delta: "ab" },
    ]);
    expect(bus.pendingDeltaCount).toBe(0);
  });

  it("publishStreaming 前先 flush 缓冲 delta，保证顺序", () => {
    const bus = new EventBus();
    const received: BusEvent[] = [];
    bus.subscribe((event) => received.push(event));
    bus.offerDelta({ type: "llm.text.delta", runId: "r1", delta: "partial" });
    bus.publishStreaming({ type: "tool.output.delta", runId: "r1", toolCallId: "c1", delta: "out" });
    expect(received.map((e) => e.type)).toEqual(["llm.text.delta", "tool.output.delta"]);
    expect((received[0] as { delta: string }).delta).toBe("partial");
  });
});
