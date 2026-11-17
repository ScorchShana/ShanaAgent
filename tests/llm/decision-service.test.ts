import { afterEach, expect, it, vi } from "vitest";
import { probeDecisionModel, requestDecision, type DecisionState } from "../../src/llm/decision-service.js";
const state: DecisionState = {
  user_task: "task",
  agent_intent: "full\nintent",
  tool: "bash",
  arguments: { command: "echo a | cat\necho b", timeout: 3 },
  project_root: "/project",
};
const config = { base_url: "http://localhost:8081/", model: "m", apiKey: "secret" };
const answer = (choice: string) => ({
  answers: { approval: { type: "choice", choice, extra: true } },
  extra: true,
});
afterEach(() => vi.useRealTimers());
it.each(["allow_once", "ask_user"] as const)("posts choice protocol and accepts %s", async (kind) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(answer(kind)));
  expect(
    await requestDecision({
      config,
      prompt: "instruction",
      state,
      timeoutMs: 1000,
      signal: new AbortController().signal,
      fetch: fetcher,
    }),
  ).toEqual({ kind });
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe("http://localhost:8081/v1/systemone");
  expect(init?.method).toBe("POST");
  expect(init?.headers).toMatchObject({ Authorization: "Bearer secret" });
  expect(JSON.parse(init?.body as string)).toEqual({
    model: "m",
    state,
    questions: {
      approval: {
        type: "choice",
        instructions: "instruction",
        criteria: { ask_user: null, allow_once: null },
      },
    },
  });
});
it("omits optional model and authentication", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(answer("ask_user")));
  await requestDecision({
    config: { base_url: "http://host" },
    prompt: "p",
    state,
    timeoutMs: 100,
    signal: new AbortController().signal,
    fetch: fetcher,
  });
  const init = fetcher.mock.calls[0]![1]!;
  expect(JSON.parse(init.body as string)).not.toHaveProperty("model");
  expect(init.headers).not.toHaveProperty("Authorization");
});
it.each([null, {}, { answers: { approval: { type: "text", choice: "allow_once" } } }, answer("unknown")])(
  "rejects malformed response %j",
  async (body) => {
    expect(
      await requestDecision({
        config,
        prompt: "p",
        state,
        timeoutMs: 100,
        signal: new AbortController().signal,
        fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json(body)),
      }),
    ).toEqual({ kind: "fallback", category: "response" });
  },
);
it.each(["http", "transport", "response"] as const)("classifies %s without retry", async (category) => {
  const fetcher = vi.fn<typeof fetch>();
  if (category === "transport") fetcher.mockRejectedValue(new Error("secret"));
  else fetcher.mockResolvedValue(new Response("not json", { status: category === "http" ? 500 : 200 }));
  expect(
    await requestDecision({
      config,
      prompt: "p",
      state,
      timeoutMs: 100,
      signal: new AbortController().signal,
      fetch: fetcher,
    }),
  ).toEqual({ kind: "fallback", category });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each([false, true])("times out stalled fetch or body (%s) and cleans up", async (body) => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () =>
      body ? new Response(new ReadableStream({ start() {} })) : await new Promise<Response>(() => {}),
    );
  const pending = requestDecision({
    config,
    prompt: "p",
    state,
    timeoutMs: 25,
    signal: controller.signal,
    fetch: fetcher,
  });
  await vi.advanceTimersByTimeAsync(25);
  expect(await pending).toEqual({ kind: "fallback", category: "timeout" });
  expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  expect(remove).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it.each([false, true])("cancellation wins and cleans up (%s)", async (preAborted) => {
  vi.useFakeTimers();
  const controller = new AbortController();
  if (preAborted) controller.abort();
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
    controller.abort();
    return Response.json(answer("allow_once"));
  });
  expect(
    await requestDecision({
      config,
      prompt: "p",
      state,
      timeoutMs: 100,
      signal: controller.signal,
      fetch: fetcher,
    }),
  ).toEqual({ kind: "cancelled" });
  expect(fetcher).toHaveBeenCalledTimes(preAborted ? 0 : 1);
  expect(vi.getTimerCount()).toBe(0);
});

it("wall clock changes do not expire the request", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(100000);
  try {
    expect(
      await requestDecision({
        config,
        prompt: "p",
        state,
        timeoutMs: 1000,
        signal: new AbortController().signal,
        fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json(answer("allow_once"))),
      }),
    ).toEqual({ kind: "allow_once" });
  } finally {
    now.mockRestore();
  }
});
it("cancels while response body is pending and removes the listener", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ start() {} })));
  const pending = requestDecision({
    config,
    prompt: "p",
    state,
    timeoutMs: 1000,
    signal: controller.signal,
    fetch: fetcher,
  });
  await Promise.resolve();
  controller.abort();
  expect(await pending).toEqual({ kind: "cancelled" });
  expect(remove).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

const probePayload = {
  model: "m",
  state: "ShanaAgent decision probe",
  questions: {
    approval: {
      type: "choice",
      instructions: "This is a ShanaAgent decision probe. Answer allow_once.",
      criteria: { ask_user: null, allow_once: null },
    },
  },
};
const probe = (fetcher: typeof fetch, timeoutMs = 1000, signal = new AbortController().signal) =>
  probeDecisionModel({ config, timeoutMs, signal, fetch: fetcher });

it("probe posts the fixed payload and passes on a canonical name match", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ ...answer("allow_once"), model: "m" }));
  expect(await probe(fetcher)).toEqual({ kind: "ok" });
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe("http://localhost:8081/v1/systemone");
  expect(init?.method).toBe("POST");
  expect(init?.headers).toMatchObject({ Authorization: "Bearer secret" });
  expect(JSON.parse(init?.body as string)).toEqual(probePayload);
});

it("probe reports a confirmed name mismatch with the served model", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ ...answer("allow_once"), model: "served" }));
  expect(await probe(fetcher)).toEqual({ kind: "model_mismatch", servedModel: "served" });
});

it.each([{}, { model: 42 }, { model: null }])(
  "probe passes when the response model is absent or non-string (%j)",
  async (extra) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ...answer("allow_once"), ...extra }));
    expect(await probe(fetcher)).toEqual({ kind: "ok" });
  },
);

it("probe omits model and authentication when unconfigured and passes regardless of served name", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ ...answer("allow_once"), model: "anything" }));
  expect(
    await probeDecisionModel({
      config: { base_url: "http://host" },
      timeoutMs: 100,
      signal: new AbortController().signal,
      fetch: fetcher,
    }),
  ).toEqual({ kind: "ok" });
  const init = fetcher.mock.calls[0]![1]!;
  const body = JSON.parse(init.body as string);
  expect(body).not.toHaveProperty("model");
  expect(body.state).toBe("ShanaAgent decision probe");
  expect(init.headers).not.toHaveProperty("Authorization");
});

it("probe detects a non-decision service via HTTP 501", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify(answer("allow_once")), { status: 501 }));
  expect(await probe(fetcher)).toEqual({ kind: "not_decision" });
});

it.each([400, 401, 404, 500])("probe keeps state on HTTP %i (inconclusive)", async (status) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("err", { status }));
  expect(await probe(fetcher, 100)).toEqual({ kind: "inconclusive", category: "http" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("probe keeps state on a transport error without retry", async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("secret"));
  expect(await probe(fetcher, 100)).toEqual({ kind: "inconclusive", category: "transport" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("probe keeps state on invalid JSON", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("not json"));
  expect(await probe(fetcher, 100)).toEqual({ kind: "inconclusive", category: "response" });
});

it.each([
  null,
  {},
  { answers: { approval: { type: "text", choice: "allow_once" } } },
  answer("unknown"),
  { answers: { approval: { type: "choice", choice: "bogus" } }, model: "served" },
])("probe keeps state on malformed response %j", async (body) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
  expect(await probe(fetcher, 100)).toEqual({ kind: "inconclusive", category: "response" });
});

it.each([false, true])("probe times out a stalled fetch or body (%s) and cleans up", async (body) => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () =>
      body ? new Response(new ReadableStream({ start() {} })) : await new Promise<Response>(() => {}),
    );
  const pending = probeDecisionModel({ config, timeoutMs: 25, signal: controller.signal, fetch: fetcher });
  await vi.advanceTimersByTimeAsync(25);
  expect(await pending).toEqual({ kind: "inconclusive", category: "timeout" });
  expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  expect(remove).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true])("probe cancellation wins and cleans up (%s)", async (preAborted) => {
  vi.useFakeTimers();
  const controller = new AbortController();
  if (preAborted) controller.abort();
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
    controller.abort();
    return Response.json({ ...answer("allow_once"), model: "m" });
  });
  expect(
    await probeDecisionModel({ config, timeoutMs: 100, signal: controller.signal, fetch: fetcher }),
  ).toEqual({ kind: "cancelled" });
  expect(fetcher).toHaveBeenCalledTimes(preAborted ? 0 : 1);
  expect(vi.getTimerCount()).toBe(0);
});
