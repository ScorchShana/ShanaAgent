import type { BusEvent, FormalEvent, StreamingEvent } from "./events.js";

export type EventListener = (event: BusEvent) => void;

interface BufferedDelta {
  type: StreamingEvent["type"];
  runId: string;
  delta: string;
}

function deltaKey(event: StreamingEvent): string {
  return `${event.runId}:${event.type}`;
}

export class EventBus {
  private readonly listeners = new Set<EventListener>();
  private readonly deltaBuffer = new Map<string, BufferedDelta>();
  private readonly onListenerError?: (error: unknown) => void;

  constructor(options: { onListenerError?: (error: unknown) => void } = {}) {
    this.onListenerError = options.onListenerError;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: FormalEvent): void {
    this.flushDeltas();
    this.broadcast(event);
  }

  // 全量尾快照自带替换语义，不能进按 runId:type 拼接的 deltaBuffer。
  publishStreaming(event: StreamingEvent): void {
    this.flushDeltas();
    this.broadcast(event);
  }

  offerDelta(event: StreamingEvent): void {
    const key = deltaKey(event);
    const buffered = this.deltaBuffer.get(key);
    if (buffered) {
      buffered.delta += event.delta;
    } else {
      this.deltaBuffer.set(key, { type: event.type, runId: event.runId, delta: event.delta });
    }
  }

  flushDeltas(): void {
    if (this.deltaBuffer.size === 0) return;
    const pending = [...this.deltaBuffer.values()];
    this.deltaBuffer.clear();
    for (const buffered of pending) {
      this.broadcast({ type: buffered.type, runId: buffered.runId, delta: buffered.delta } as StreamingEvent);
    }
  }

  get pendingDeltaCount(): number {
    return this.deltaBuffer.size;
  }

  private broadcast(event: BusEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.onListenerError?.(error);
      }
    }
  }
}
