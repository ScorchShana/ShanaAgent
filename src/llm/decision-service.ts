import type { DecisionModelConfig } from "./decision-model-config-store.js";

interface DecisionStateBase {
  user_task: string;
  agent_intent: string;
  project_root: string;
}

export type DecisionState = DecisionStateBase &
  (
    | {
        tool: "bash";
        arguments: { command: string; timeout?: number };
        resolved_paths?: never;
        touches_outside_workspace?: never;
      }
    | {
        tool: "read" | "glob" | "grep";
        arguments: Record<string, unknown>;
        resolved_paths: string[];
        touches_outside_workspace: boolean;
      }
    | {
        tool: "write" | "edit";
        arguments: { path: string };
        resolved_paths: string[];
        touches_outside_workspace: boolean;
      }
  );

export type DecisionOutcome =
  | { kind: "allow_once" | "ask_user" | "cancelled" }
  | { kind: "fallback"; category: "http" | "transport" | "response" | "timeout" };

export interface DecisionRequest {
  config: DecisionModelConfig;
  prompt: string;
  state: DecisionState;
  timeoutMs: number;
  signal: AbortSignal;
  fetch?: typeof globalThis.fetch;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function withRequestDeadline<T>(
  timeoutMs: number,
  signal: AbortSignal,
  perform: (requestSignal: AbortSignal) => Promise<T>,
  outcomes: { cancelled: T; timeout: T },
): Promise<T> {
  if (signal.aborted) return outcomes.cancelled;
  const controller = new AbortController();
  let timedOut = false;
  let settleStop: (outcome: T) => void;
  const stopped = new Promise<T>((resolve) => {
    settleStop = resolve;
  });
  const cancel = () => {
    settleStop(outcomes.cancelled);
    controller.abort();
  };
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    settleStop(outcomes.timeout);
    controller.abort();
  }, timeoutMs);
  const deadline = performance.now() + timeoutMs;
  try {
    const outcome = await Promise.race([perform(controller.signal), stopped]);
    if (signal.aborted) return outcomes.cancelled;
    if (timedOut || performance.now() >= deadline) {
      controller.abort();
      return outcomes.timeout;
    }
    return outcome;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    controller.abort();
  }
}

export async function requestDecision(options: DecisionRequest): Promise<DecisionOutcome> {
  const { config, prompt, state, timeoutMs, signal } = options;
  return withRequestDeadline<DecisionOutcome>(
    timeoutMs,
    signal,
    async (requestSignal) => {
      let response: Response;
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (config.apiKey !== undefined) headers.Authorization = `Bearer ${config.apiKey}`;
        response = await (options.fetch ?? globalThis.fetch)(
          `${config.base_url.replace(/\/+$/, "")}/v1/systemone`,
          {
            method: "POST",
            headers,
            signal: requestSignal,
            body: JSON.stringify({
              ...(config.model !== undefined ? { model: config.model } : {}),
              state,
              questions: {
                approval: {
                  type: "choice",
                  instructions: prompt,
                  criteria: { ask_user: null, allow_once: null },
                },
              },
            }),
          },
        );
      } catch {
        return { kind: "fallback", category: "transport" };
      }
      if (!response.ok) return { kind: "fallback", category: "http" };
      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        return { kind: "fallback", category: "response" };
      }
      if (!object(raw) || !object(raw.answers) || !object(raw.answers.approval))
        return { kind: "fallback", category: "response" };
      const approval = raw.answers.approval;
      if (approval.type !== "choice" || (approval.choice !== "ask_user" && approval.choice !== "allow_once"))
        return { kind: "fallback", category: "response" };
      return { kind: approval.choice };
    },
    { cancelled: { kind: "cancelled" }, timeout: { kind: "fallback", category: "timeout" } },
  );
}

export type DecisionProbeOutcome =
  | { kind: "ok" }
  | { kind: "model_mismatch"; servedModel: string }
  | { kind: "not_decision" }
  | { kind: "inconclusive"; category: "http" | "transport" | "response" | "timeout" }
  | { kind: "cancelled" };

export interface DecisionProbeRequest {
  config: DecisionModelConfig;
  timeoutMs: number;
  signal: AbortSignal;
  fetch?: typeof globalThis.fetch;
}

const PROBE_STATE = "ShanaAgent decision probe";
const PROBE_INSTRUCTIONS = "This is a ShanaAgent decision probe. Answer allow_once.";

export async function probeDecisionModel(options: DecisionProbeRequest): Promise<DecisionProbeOutcome> {
  const { config, timeoutMs, signal } = options;
  return withRequestDeadline<DecisionProbeOutcome>(
    timeoutMs,
    signal,
    async (requestSignal) => {
      let response: Response;
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (config.apiKey !== undefined) headers.Authorization = `Bearer ${config.apiKey}`;
        response = await (options.fetch ?? globalThis.fetch)(
          `${config.base_url.replace(/\/+$/, "")}/v1/systemone`,
          {
            method: "POST",
            headers,
            signal: requestSignal,
            body: JSON.stringify({
              ...(config.model !== undefined ? { model: config.model } : {}),
              state: PROBE_STATE,
              questions: {
                approval: {
                  type: "choice",
                  instructions: PROBE_INSTRUCTIONS,
                  criteria: { ask_user: null, allow_once: null },
                },
              },
            }),
          },
        );
      } catch {
        return { kind: "inconclusive", category: "transport" };
      }
      if (response.status === 501) return { kind: "not_decision" };
      if (!response.ok) return { kind: "inconclusive", category: "http" };
      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        return { kind: "inconclusive", category: "response" };
      }
      if (!object(raw) || !object(raw.answers) || !object(raw.answers.approval))
        return { kind: "inconclusive", category: "response" };
      const approval = raw.answers.approval;
      if (approval.type !== "choice" || (approval.choice !== "ask_user" && approval.choice !== "allow_once"))
        return { kind: "inconclusive", category: "response" };
      if (config.model !== undefined && typeof raw.model === "string" && raw.model !== config.model)
        return { kind: "model_mismatch", servedModel: raw.model };
      return { kind: "ok" };
    },
    { cancelled: { kind: "cancelled" }, timeout: { kind: "inconclusive", category: "timeout" } },
  );
}
