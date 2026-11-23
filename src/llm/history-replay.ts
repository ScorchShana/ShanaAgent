import type { Context, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import type { StoredAssistantMessage } from "../sessions/records.js";

export type StoredContext = Omit<Context, "messages"> & {
  messages: (Exclude<Message, { role: "assistant" }> | StoredAssistantMessage)[];
};

export function prepareReplay(input: StoredContext): {
  context: Context;
  onPayload: (payload: unknown) => void;
} {
  const raw = new Map<string, { name: string; arguments: string }>();
  const pending = new Map<string, string>();
  const completed = new Set<string>();
  const messages: Message[] = input.messages.map((message, index) => {
    if (message.role === "assistant") {
      if (pending.size) throw new Error("Unpaired tool calls in context");
      const content = message.content.map((block, blockIndex) => {
        if (block.type !== "toolCall") return block;
        if (!block.id || !block.name || pending.has(block.id))
          throw new Error("Invalid tool identity in context");
        const alias = `shana_${index}_${blockIndex}`;
        pending.set(block.id, alias);
        raw.set(alias, { name: block.name, arguments: block.rawArguments });
        return {
          type: "toolCall" as const,
          id: alias,
          name: block.name,
          arguments: block.parse.status === "parsed" ? block.parse.arguments : {},
        };
      });
      return { ...message, content };
    }
    if (message.role === "toolResult") {
      const alias = pending.get(message.toolCallId);
      if (!alias || raw.get(alias)?.name !== message.toolName)
        throw new Error("Unpaired tool result in context");
      pending.delete(message.toolCallId);
      completed.add(alias);
      return { ...message, toolCallId: alias } as ToolResultMessage;
    }
    if (pending.size) throw new Error("Unpaired tool calls in context");
    return message;
  });
  if (pending.size) throw new Error("Unpaired tool calls in context");
  // pi-ai transformMessages 整条丢弃 aborted/error 的 assistant 消息，却保留其 toolResult（成孤儿），
  // 下方 onPayload 的计数自检因此必然命中。stopReason 不进请求体，改写发送侧副本即可让 SDK 保留该轮；
  // Context 与记录恒存原文。
  for (const [index, message] of messages.entries()) {
    if (message.role !== "assistant" || message.stopReason !== "aborted") continue;
    messages[index] = { ...message, stopReason: "toolUse" };
  }
  return {
    context: { ...input, messages },
    onPayload(payload) {
      const data = payload as {
        messages?: {
          role: string;
          tool_calls?: { id: string; function: { name: string; arguments: string } }[];
          tool_call_id?: string;
        }[];
      };
      if (!Array.isArray(data.messages)) throw new Error("Invalid SDK request payload");
      const calls = new Set<string>();
      const results = new Set<string>();
      for (const message of data.messages) {
        for (const call of message.tool_calls ?? []) {
          const source = raw.get(call.id);
          if (!source || source.name !== call.function.name || calls.has(call.id))
            throw new Error("SDK tool identity mapping failed");
          call.function.arguments = source.arguments;
          calls.add(call.id);
        }
        if (message.role === "tool") {
          const id = message.tool_call_id ?? "";
          if (!completed.has(id) || results.has(id)) throw new Error("SDK tool result mapping failed");
          results.add(id);
        }
      }
      if (calls.size !== raw.size || results.size !== raw.size)
        throw new Error("SDK dropped or synthesized tool history");
    },
  };
}
