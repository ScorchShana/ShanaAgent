import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Models,
  ModelsSimpleStreamOptions,
  StopReason,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai";
import { parseArguments } from "./argument-parser.js";
import { prepareReplay, type StoredContext } from "./history-replay.js";
import type { StoredAssistantMessage, StoredToolCall } from "../sessions/records.js";
import { redactSecrets } from "./model-config-store.js";
import type { ReasoningEffort, ResolvedModel } from "./model-config-store.js";
import { DEFAULT_MAX_RETRIES } from "./settings-store.js";

export const RETRY_BACKOFF_INITIAL_MS = 1000;
export const RETRY_BACKOFF_FACTOR = 2;
export const RETRY_BACKOFF_MAX_MS = 16000;

export function retryBackoffDelayMs(failedAttempts: number): number {
  return Math.min(
    RETRY_BACKOFF_INITIAL_MS * RETRY_BACKOFF_FACTOR ** (failedAttempts - 1),
    RETRY_BACKOFF_MAX_MS,
  );
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  return new Error("Turn aborted");
}

export interface ModelSnapshot {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  reasoning: boolean;
  thinking: boolean;
  reasoningEffort: ReasoningEffort;
  input: readonly string[];
  contextWindow: number;
  maxTokens: number;
}

export function createModelSnapshot(resolved: ResolvedModel): ModelSnapshot {
  return {
    providerId: resolved.providerId,
    providerName: resolved.providerName,
    modelId: resolved.id,
    modelName: resolved.name,
    reasoning: resolved.reasoning,
    thinking: resolved.thinking,
    reasoningEffort: resolved.reasoningEffort,
    input: [...resolved.input],
    contextWindow: resolved.contextWindow,
    maxTokens: resolved.maxTokens,
  };
}

export type TurnEvent =
  | { type: "text_delta"; attempt: number; delta: string }
  | { type: "text_end"; attempt: number; text: string }
  | { type: "thinking_delta"; attempt: number; delta: string }
  | { type: "thinking_end"; attempt: number; text: string }
  | { type: "tool_call_start"; attempt: number; contentIndex: number; name?: string }
  | { type: "tool_call_delta"; attempt: number; contentIndex: number; delta: string }
  | { type: "tool_call_end"; attempt: number; toolCall: ToolCall }
  | { type: "attempt_failed"; attempt: number; errorMessage: string; nextDelayMs: number | null };

export interface TurnResult {
  attempts: number;
  message: StoredAssistantMessage;
  stopReason: StopReason;
  rawStopReason?: string;
  usage: Usage;
  text: string;
  thinking: string;
  toolCalls: StoredToolCall[];
  truncated: boolean;
}

export type TurnErrorKind =
  "cancelled" | "context_overflow" | "non_retryable" | "retryable_exhausted" | "stream_error";

export class TurnError extends Error {
  readonly kind: TurnErrorKind;
  readonly attempts: number;

  constructor(kind: TurnErrorKind, attempts: number, message: string) {
    super(message);
    this.name = "TurnError";
    this.kind = kind;
    this.attempts = attempts;
  }
}

export interface TurnStream {
  [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent>;
  result(): Promise<AssistantMessage>;
}

export interface TurnRequester {
  stream(
    providerId: string,
    modelId: string,
    context: Context,
    options: ModelsSimpleStreamOptions,
  ): TurnStream;
}

function defaultRequester(models: Models): TurnRequester {
  return {
    stream(providerId, modelId, context, options) {
      const model = models.getModel(providerId, modelId);
      if (!model) {
        throw new TurnError("stream_error", 0, `Error: model not registered: ${providerId}/${modelId}`);
      }
      return models.streamSimple(model, context, options);
    },
  };
}

export interface StreamTurnOptions {
  model: ResolvedModel;
  context: StoredContext;
  signal?: AbortSignal;
  onEvent?: (event: TurnEvent) => void;
  maxRetries?: number;
  maxTokens?: number;
  fetch?: ModelsSimpleStreamOptions["fetch"];
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

interface AttemptBuffer {
  text: string;
  thinking: string;
  toolCalls: ToolCall[];
}

export class ModelService {
  private readonly requester: TurnRequester;
  private readonly secrets: readonly string[];

  constructor(models: Models, secrets: readonly string[], requester?: TurnRequester) {
    this.requester = requester ?? defaultRequester(models);
    this.secrets = secrets;
  }

  redact(text: string): string {
    return redactSecrets(text, this.secrets);
  }

  async streamTurn(options: StreamTurnOptions): Promise<TurnResult> {
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const sleep = options.sleep ?? abortableSleep;
    const signal = options.signal;
    const onEvent = options.onEvent;
    const snapshot = createModelSnapshot(options.model);
    // 每次请求 maxRetries: 0 关闭 SDK 客户端自带重试，Agent 级重试在此循环内计数。
    const replay = prepareReplay(options.context);
    const requestOptions: ModelsSimpleStreamOptions = {
      onPayload: replay.onPayload,
      signal,
      maxRetries: 0,
      reasoning: options.model.thinking ? options.model.reasoningEffort : undefined,
      maxTokens: options.maxTokens,
      fetch: options.fetch,
    };

    let attempts = 0;
    for (;;) {
      if (signal?.aborted) {
        throw new TurnError("cancelled", attempts, "Turn aborted");
      }
      attempts += 1;
      let buffer: AttemptBuffer;
      let message: AssistantMessage;
      const raw = new Map<number, string>();
      try {
        const stream = this.requester.stream(
          snapshot.providerId,
          snapshot.modelId,
          replay.context,
          requestOptions,
        );
        buffer = { text: "", thinking: "", toolCalls: [] };
        for await (const event of stream) {
          switch (event.type) {
            case "text_delta":
              buffer.text += event.delta;
              onEvent?.({ type: "text_delta", attempt: attempts, delta: event.delta });
              break;
            case "text_end":
              onEvent?.({ type: "text_end", attempt: attempts, text: event.content });
              break;
            case "thinking_delta":
              buffer.thinking += event.delta;
              onEvent?.({ type: "thinking_delta", attempt: attempts, delta: event.delta });
              break;
            case "thinking_end":
              onEvent?.({ type: "thinking_end", attempt: attempts, text: event.content });
              break;
            case "toolcall_start": {
              raw.set(event.contentIndex, "");
              const partial = event.partial.content[event.contentIndex];
              onEvent?.({
                type: "tool_call_start",
                attempt: attempts,
                contentIndex: event.contentIndex,
                name: partial?.type === "toolCall" ? partial.name : undefined,
              });
              break;
            }
            case "toolcall_delta":
              raw.set(event.contentIndex, (raw.get(event.contentIndex) ?? "") + event.delta);
              onEvent?.({
                type: "tool_call_delta",
                attempt: attempts,
                contentIndex: event.contentIndex,
                delta: event.delta,
              });
              break;
            case "toolcall_end":
              buffer.toolCalls.push(event.toolCall);
              onEvent?.({ type: "tool_call_end", attempt: attempts, toolCall: event.toolCall });
              break;
            default:
              break;
          }
        }
        message = await stream.result();
        if (signal?.aborted) throw new TurnError("cancelled", attempts, "Turn aborted");
      } catch (error) {
        if (error instanceof TurnError) {
          throw error;
        }
        if (signal?.aborted || isAbortError(error)) {
          throw new TurnError("cancelled", attempts, "Turn aborted");
        }
        throw new TurnError(
          "stream_error",
          attempts,
          this.redact(`Error: unexpected stream failure: ${(error as Error).message ?? String(error)}`),
        );
      }

      if (!message.errorMessage && message.stopReason !== "error" && message.stopReason !== "aborted") {
        const stored: StoredAssistantMessage = {
          ...message,
          content: message.content.map((block, index) => {
            if (block.type !== "toolCall") return block;
            const rawArguments = raw.get(index);
            if (rawArguments === undefined)
              throw new TurnError(
                "stream_error",
                attempts,
                "Error: Missing raw tool arguments. Not executed.",
              );
            return {
              type: "toolCall",
              id: block.id,
              name: block.name,
              rawArguments,
              parse: parseArguments(
                rawArguments,
                message.stopReason === "toolUse" || message.stopReason === "stop",
              ),
            };
          }),
        };
        const toolCalls = stored.content.filter(
          (block): block is StoredToolCall => block.type === "toolCall",
        );
        return {
          attempts,
          message: stored,
          stopReason: message.stopReason,
          rawStopReason: message.rawStopReason,
          usage: message.usage,
          text: buffer.text,
          thinking: buffer.thinking,
          toolCalls,
          truncated: message.stopReason === "length",
        };
      }

      if (signal?.aborted || message.stopReason === "aborted") {
        throw new TurnError("cancelled", attempts, "Turn aborted");
      }
      const errorMessage = this.redact(message.errorMessage ?? "unknown provider error");
      // 分类依赖 pi-ai 字符串启发式，Provider 文案变化会导致误判
      if (isContextOverflow(message, snapshot.contextWindow)) {
        throw new TurnError("context_overflow", attempts, errorMessage);
      }
      if (!isRetryableAssistantError(message)) {
        throw new TurnError("non_retryable", attempts, errorMessage);
      }
      if (attempts > maxRetries) {
        throw new TurnError("retryable_exhausted", attempts, errorMessage);
      }
      const delayMs = retryBackoffDelayMs(attempts);
      onEvent?.({
        type: "attempt_failed",
        attempt: attempts,
        errorMessage,
        nextDelayMs: delayMs,
      });
      try {
        await sleep(delayMs, signal ?? neverAbortedSignal());
      } catch {
        throw new TurnError("cancelled", attempts, "Turn aborted");
      }
    }
  }
}

function neverAbortedSignal(): AbortSignal {
  return new AbortController().signal;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.message === "Turn aborted";
}
