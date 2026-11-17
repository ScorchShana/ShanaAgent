// T12 end-to-end acceptance driver (V1/V4/V5 Windows + WSL).
//
// Walks the formal product chain (bootstrap -> createAgentSession -> real
// ModelService -> real SessionStore -> real ToolExecutor) in an isolated temp
// home + workspace, never touching the user's real ~/.shana and never printing
// apiKey values (evidence passes through redactSecrets + path scrubbing).
//
// Scenarios beyond the T13 regression: cancel mid-run, resume original ID,
// idle model switch + run-reject + cross-model history continuity, and session
// title / runCount. Cross-process Session ownership is covered separately by
// tests/sessions/recovery.test.ts (two real PIDs), re-run on Windows and WSL.
//
// --mock runs a deterministic scripted agent through the SAME real tool chain
// with synthetic credentials and no network; it validates plumbing + assertion
// logic only, NOT acceptance (acceptance requires --real).
//
// Usage:
//   node tests/integration/t12-e2e.mjs --mock
//   node tests/integration/t12-e2e.mjs --real --provider deepseek
//   node tests/integration/t12-e2e.mjs --real --provider qwen
// Flags: --scenario all|e2e|cancel|resume|model-switch|title (default all),
//   --keep, --out DIR, --no-compat-override.

/* global process, setTimeout, structuredClone */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bootstrap } from "../../dist/bootstrap.js";
import { createAgentSession } from "../../dist/core/agent-loop.js";
import { ModelService } from "../../dist/llm/model-service.js";
import { createConfiguredModels } from "../../dist/llm/provider-adapter.js";
import { redactSecrets } from "../../dist/llm/model-config-store.js";
import { SessionStore } from "../../dist/sessions/session-store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..");

function flag(name) {
  return process.argv.includes(name);
}
function option(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  const value = process.argv[i + 1];
  assert.ok(value && !value.startsWith("--"), `Missing value for ${name}`);
  return value;
}

const MODE = flag("--mock") ? "mock-smoke" : "real";
const KEEP = flag("--keep");
const NO_COMPAT_OVERRIDE = flag("--no-compat-override");
const PROVIDER = option("--provider", "deepseek");
const SCENARIO = option("--scenario", "all");
const MODEL_CONFIG_PATH = option("--model-config", path.join(os.homedir(), ".shana", "model.json"));
const OUT = option("--out", path.join(REPO, "tasks", "T12-evidence"));
assert.ok(["deepseek", "qwen"].includes(PROVIDER), "bad --provider (deepseek|qwen)");
assert.ok(["all", "e2e", "cancel", "resume", "model-switch", "title"].includes(SCENARIO), "bad --scenario");

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// ---- isolated environment -------------------------------------------------

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "shana-t12-"));
const workspace = path.join(homeDir, "workspace");
const shanaDir = path.join(homeDir, ".shana");
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(shanaDir, { recursive: true });
fs.mkdirSync(path.join(workspace, "src"), { recursive: true });

fs.writeFileSync(path.join(workspace, "README.md"), "# calc-lib\n\nA tiny calculation library.\n");
fs.writeFileSync(
  path.join(workspace, "src", "calc.js"),
  "export function add(a, b) {\n  return a - b;\n}\n\nexport function mul(a, b) {\n  return a * b;\n}\n",
);
fs.writeFileSync(
  path.join(workspace, "src", "util.js"),
  'export function slug(s) {\n  return s.trim().replace(/\\s+/g, "-");\n}\n',
);
fs.writeFileSync(
  path.join(workspace, "check.mjs"),
  [
    'import { add, mul } from "./src/calc.js";',
    'import { slug } from "./src/util.js";',
    "let fail = 0;",
    'if (add(2, 3) !== 5) { console.log("FAIL add"); fail += 1; }',
    'if (mul(2, 3) !== 6) { console.log("FAIL mul"); fail += 1; }',
    'if (slug("  Hello World ") !== "hello-world") { console.log("FAIL slug"); fail += 1; }',
    'if (fail === 0) console.log("ALL PASS");',
    'else console.log(fail + " failures");',
    "process.exit(fail === 0 ? 0 : 1);",
    "",
  ].join("\n"),
);

// ---- isolated model config ------------------------------------------------

function pickRealProvider(real, kind) {
  if (kind === "qwen") {
    for (const [pid, p] of Object.entries(real.providers ?? {})) {
      const m = (p.models ?? []).find((mm) => mm.id === "qwen3.8-2.4t-a95b" || mm.name === "Qwen 3.8");
      if (m) return { providerId: pid, provider: p, model: m };
    }
    throw new Error("Qwen 3.8 model (qwen3.8-2.4t-a95b) not found in real model.json");
  }
  const entry = Object.entries(real.providers ?? {}).find(
    ([id, p]) => /deepseek/i.test(id) || (p.models ?? []).some((m) => /deepseek/i.test(m.id)),
  );
  if (!entry) throw new Error("No DeepSeek provider in real model.json");
  const [providerId, provider] = entry;
  const model = (provider.models ?? []).find((m) => /deepseek/i.test(m.id)) ?? provider.models[0];
  return { providerId, provider, model };
}

function buildIsolatedConfig() {
  if (MODE === "mock-smoke") {
    // Two mock models so the model-switch scenario has a target to switch to.
    return {
      current: { provider: "MockSeek", model: "mock-flash" },
      providers: {
        MockSeek: {
          api: "openai-completions",
          baseUrl: "https://mock.invalid/v1",
          apiKey: "synthetic-mock-key-not-a-secret",
          models: [
            { id: "mock-flash", contextWindow: 128000, maxTokens: 8192, reasoning: false, input: ["text"] },
            { id: "mock-flash-alt", contextWindow: 128000, maxTokens: 8192, reasoning: false, input: ["text"] },
          ],
        },
      },
      _secondary: { provider: "MockSeek", model: "mock-flash-alt" },
    };
  }
  const realPath = MODEL_CONFIG_PATH;
  assert.ok(fs.existsSync(realPath), `Real model.json not found at ${realPath}`);
  const real = JSON.parse(fs.readFileSync(realPath, "utf8"));
  const primary = pickRealProvider(real, PROVIDER);
  assert.ok(primary.provider.apiKey, `${PROVIDER} provider has no apiKey`);
  const providers = {};
  const prep = (sel) => {
    let m = sel.model;
    if (sel === primary && PROVIDER === "qwen" && !NO_COMPAT_OVERRIDE) {
      m = { ...m, compat: { ...(m.compat ?? {}), supportsDeveloperRole: false } };
    }
    providers[sel.providerId] = { ...sel.provider, models: [m] };
    return m;
  };
  const primaryModel = prep(primary);
  // Cross-model continuity needs a second real model. Prefer the other Flash
  // family; fall back to a second model under the same provider if present.
  let secondary = null;
  const otherKind = PROVIDER === "qwen" ? "deepseek" : "qwen";
  try {
    secondary = pickRealProvider(real, otherKind);
    if (!secondary.provider.apiKey) secondary = null;
  } catch {
    secondary = null;
  }
  let secondaryModel = null;
  if (secondary) {
    if (secondary.providerId === primary.providerId) {
      const alt = (secondary.provider.models ?? []).find((m) => m.id !== primaryModel.id);
      if (alt) {
        providers[primary.providerId].models.push(alt);
        secondaryModel = alt;
        secondary = { ...secondary, model: alt };
      } else secondary = null;
    } else {
      secondaryModel = prep(secondary);
    }
  }
  return {
    current: { provider: primary.providerId, model: primaryModel.id },
    providers,
    _secondary: secondary ? { provider: secondary.providerId, model: secondaryModel.id } : null,
  };
}

const isolatedConfig = buildIsolatedConfig();
const SECONDARY = isolatedConfig._secondary ?? null;
delete isolatedConfig._secondary;
fs.writeFileSync(path.join(shanaDir, "model.json"), JSON.stringify(isolatedConfig, null, 2));
fs.writeFileSync(path.join(shanaDir, "settings.json"), JSON.stringify({ maxTurns: 40, maxRetries: 4 }, null, 2));

const result = bootstrap({ homeDir, cwd: workspace });
assert.equal(result.modelConfig.status, "ok", `isolated config invalid: ${result.modelConfig.message ?? ""}`);
const secrets = new Set(result.modelConfig.secrets);
const PATH_PLACEHOLDER = "<isolated-temp-path>";
function scrubPaths(text) {
  let out = String(text);
  for (const p of [workspace, homeDir, os.homedir()]) {
    if (!p) continue;
    out = out.split(p).join(PATH_PLACEHOLDER);
    out = out.split(p.replaceAll("\\", "/")).join(PATH_PLACEHOLDER);
  }
  return out;
}
const redact = (text) => scrubPaths(redactSecrets(String(text), [...secrets]));

// ---- tracking -------------------------------------------------------------

const requests = [];
const approvals = [];
const runs = [];
const runFinished = [];
const warnings = [];
const scenarioResults = {};
let currentRunId = null;
let deniedBash = false;
let mockRunIndex = -1;
let mockStepCursor = 0;
let capturedRef = null;
let mockDelayMs = 0;

// ---- mock scripted agent --------------------------------------------------

function tc(id, name, args) {
  return { type: "toolCall", id, name, rawArguments: JSON.stringify(args), parse: { status: "parsed", arguments: args } };
}
function mockMessage(content, stopReason) {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "MockSeek",
    model: "mock-flash",
    usage: structuredClone(ZERO_USAGE),
    stopReason,
    timestamp: Date.now(),
  };
}
function mockResult(content, stopReason, text) {
  return {
    attempts: 1,
    message: mockMessage(content, stopReason),
    stopReason,
    usage: structuredClone(ZERO_USAGE),
    text,
    thinking: "",
    toolCalls: content.filter((b) => b.type === "toolCall"),
    truncated: false,
  };
}

const MOCK_SCRIPTS = [
  [
    { calls: [["read", { path: "src/calc.js" }], ["read", { path: "src/util.js" }], ["read", { path: "missing.txt" }]] },
    { text: "calc.add subtracts; util.slug does not lowercase." },
  ],
  [
    { calls: [["bash", { command: "node check.mjs" }]] },
    { calls: [["edit", { path: "src/calc.js", old_string: "return a - b;", new_string: "return a + b;" }]] },
    { calls: [["edit", { path: "src/util.js", old_string: 'return s.trim().replace(/\\s+/g, "-");', new_string: 'return s.trim().toLowerCase().replace(/\\s+/g, "-");' }]] },
    { calls: [["bash", { command: "node check.mjs" }]] },
    { text: "Fixes applied; ALL PASS." },
  ],
];

function mockStreamTurn() {
  const script = MOCK_SCRIPTS[mockRunIndex] ?? [];
  const step = script[mockStepCursor];
  mockStepCursor += 1;
  const delay = mockDelayMs;
  const produce = () => {
    if (!step) return mockResult([{ type: "text", text: "Done." }], "stop", "Done.");
    if (step.calls) {
      const content = step.calls.map(([name, args], i) => tc(`mock_${mockRunIndex}_${mockStepCursor}_${i}`, name, args));
      return mockResult(content, "toolUse", "");
    }
    return mockResult([{ type: "text", text: step.text }], "stop", step.text);
  };
  if (delay > 0) return new Promise((resolve) => setTimeout(() => resolve(produce()), delay));
  return Promise.resolve(produce());
}

function realStreamTurn(options) {
  if (options.model.apiKey) secrets.add(options.model.apiKey);
  const start = Date.now();
  const service = new ModelService(createConfiguredModels([options.model]), [...secrets]);
  return service.streamTurn(options).then(
    (r) => {
      requests.push({
        at: new Date().toISOString(),
        runId: currentRunId,
        model: options.model.id,
        stopReason: r.stopReason,
        textChars: r.text.length,
        toolCalls: r.toolCalls.length,
        usage: { input: r.usage.input, output: r.usage.output, totalTokens: r.usage.totalTokens },
        ms: Date.now() - start,
      });
      return r;
    },
    (error) => {
      requests.push({
        at: new Date().toISOString(),
        runId: currentRunId,
        model: options.model.id,
        error: redact(error instanceof Error ? error.message : String(error)),
        errorKind: error?.kind,
        ms: Date.now() - start,
      });
      throw error;
    },
  );
}

const modelService = { streamTurn: MODE === "mock-smoke" ? mockStreamTurn : realStreamTurn };

// ---- session wiring -------------------------------------------------------

const store = new SessionStore({ sessionsDir: result.sessionsDir });
const environment = `Workspace: ${workspace}\nPlatform: ${
  process.platform === "win32" ? "Windows (Git Bash)" : "Linux (bash)"
}`;

function wireBus(controller) {
  return controller.eventBus.subscribe((event) => {
    if (event.type === "permission.requested") {
      if (event.toolName === "bash" && !deniedBash) {
        deniedBash = true;
        approvals.push({ toolName: event.toolName, toolCallId: event.toolCallId, decision: "deny" });
        controller.resolveApproval(event.approvalId, "deny");
      } else {
        approvals.push({ toolName: event.toolName, toolCallId: event.toolCallId, decision: "session" });
        controller.resolveApproval(event.approvalId, "session");
      }
    } else if (event.type === "run.started") {
      currentRunId = event.runId;
      mockRunIndex += 1;
      mockStepCursor = 0;
    } else if (event.type === "run.finished") {
      runFinished.push({
        runId: event.runId,
        outcome: event.outcome,
        persisted: event.persisted,
        ...(event.error ? { error: redact(event.error) } : {}),
      });
      currentRunId = null;
    }
  });
}

function sessionOptions(ref) {
  return {
    store,
    workspaceId: result.workspace.id,
    workspaceRoot: result.workspace.path,
    modelConfigPath: path.join(shanaDir, "model.json"),
    getModel: () => result.modelConfig.current,
    getSettings: () => result.settings,
    modelService,
    diagnostics: result.diagnostics,
    systemPrompt: result.prompts.system,
    environment,
    ...(ref ? { ref } : {}),
    onWarning: (w) => warnings.push(redact(JSON.stringify(w))),
  };
}

let session = await createAgentSession(sessionOptions(null));
let unsubscribe = wireBus(session.controller);

async function runPrompt(label, prompt) {
  const started = Date.now();
  process.stderr.write(`\n[${label}] submitting (${MODE})...\n`);
  let outcome;
  try {
    outcome = await session.controller.submitPrompt(prompt);
  } catch (error) {
    outcome = `threw: ${redact(error instanceof Error ? error.message : String(error))}`;
  }
  const snap = session.controller.getSnapshot();
  if (snap.session.ref) capturedRef = snap.session.ref;
  runs.push({ label, promptChars: prompt.length, outcome, elapsedMs: Date.now() - started });
  process.stderr.write(`[${label}] outcome=${outcome} elapsed=${runs.at(-1).elapsedMs}ms\n`);
  return outcome;
}

function loadRecords(ref = capturedRef) {
  if (!ref) return [];
  const file = path.join(result.sessionsDir, ref.workspaceId, ref.sessionId, "messages.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
function toolCallsOf(record) {
  return (record.message?.content ?? []).filter((b) => b.type === "toolCall");
}

// ---- scenarios ------------------------------------------------------------

const E2E_PROMPTS = [
  "You are working in a small JS calculation library in this workspace. In your NEXT SINGLE reply, issue THREE tool calls together in one turn: read `src/calc.js`, read `src/util.js`, and read a file named `missing.txt` (it does not exist). After you see the results, describe in plain text what `add` and `slug` do and what is wrong. Do NOT modify any file this turn.",
  "Now fix the bugs: make `add(a, b)` in `src/calc.js` return the sum, and make `slug(s)` in `src/util.js` lowercase the result. Verify with the bash command `node check.mjs`, re-running until it prints ALL PASS. Report the final check output.",
];

async function scenarioE2e() {
  await runPrompt("e2e-0", E2E_PROMPTS[0]);
  await runPrompt("e2e-1", E2E_PROMPTS[1]);
  const records = loadRecords();
  const assistant = records.filter((r) => r.type === "assistant_message");
  const results = records.filter((r) => r.type === "tool_result");
  const perTurn = assistant.map((r) => toolCallsOf(r).length);
  const calls = assistant.flatMap((r) => toolCallsOf(r));
  const callIds = calls.map((c) => c.id);
  const resultIds = results.map((r) => r.toolCallId);
  const pairingOk =
    callIds.length === resultIds.length &&
    callIds.every((id) => resultIds.filter((rid) => rid === id).length === 1) &&
    new Set(callIds).size === callIds.length;
  const denial = results.find((r) => r.content === "Error: User denied.");
  const missingErr = results.find((r) => r.status === "error" && /not found|no such file|does not exist/i.test(r.content ?? ""));
  const rawOk = calls.every((c) => {
    try { return typeof c.rawArguments === "string" && typeof JSON.parse(c.rawArguments) === "object"; }
    catch { return false; }
  });
  const gates = {
    multiTurn: perTurn.filter((n) => n >= 1).length >= 3,
    multiToolTurn: perTurn.some((n) => n >= 2),
    denialObserved: Boolean(denial),
    errorPathObserved: Boolean(missingErr),
    pairingOk,
    rawArgumentsPersisted: rawOk,
  };
  scenarioResults.e2e = {
    pass: Object.values(gates).every(Boolean),
    gates,
    perTurnToolCallCounts: perTurn,
    toolNamesCalled: calls.map((c) => c.name),
    callCount: callIds.length,
    resultCount: resultIds.length,
  };
}

async function scenarioTitle() {
  const entries = await session.controller.listSessions();
  const mine = entries.find((e) => e.sessionId === capturedRef?.sessionId);
  scenarioResults.title = {
    pass: Boolean(mine) && typeof mine.title === "string" && mine.title.length > 0 && mine.runCount >= 1,
    title: mine?.title ?? null,
    runCount: mine?.runCount ?? null,
    occupied: mine?.occupied ?? null,
    entryCount: entries.length,
    note: "runCount counts Runs (run_started/user_prompt dedup), not message rows",
  };
}

async function scenarioModelSwitch() {
  const out = { pass: false, idleSwitch: false, runReject: false, crossModelContinuity: false, secondary: SECONDARY };
  if (!SECONDARY) {
    out.note = "no second real model available; idle switch + run-reject only";
  }
  const before = session.controller.getSnapshot().session.model;
  // Idle switch.
  try {
    const target = SECONDARY ?? { provider: "MockSeek", model: "mock-flash-alt" };
    await session.controller.switchModel(target.provider, target.model);
    const after = session.controller.getSnapshot().session.model;
    out.idleSwitch = Boolean(after) && (after.modelId !== before?.modelId || after.providerId !== before?.providerId);
    out.modelAfterSwitch = after;
  } catch (error) {
    out.idleSwitchError = redact(error instanceof Error ? error.message : String(error));
  }
  // Run-reject: start a run, attempt a normal command mid-run, expect BusyError.
  if (MODE === "mock-smoke") mockDelayMs = 400;
  const runPromise = session.controller.submitPrompt(
    MODE === "mock-smoke" ? "describe the library" : "In one sentence, what does src/calc.js export? Do not call any tool.",
  ).catch((e) => `threw: ${redact(String(e))}`);
  // Wait until the run is actually running before issuing the command.
  await waitFor(() => session.controller.getSnapshot().status?.kind === "running", 5000);
  try {
    await session.controller.switchModel(SECONDARY?.provider ?? "MockSeek", SECONDARY?.model ?? "mock-flash");
    out.runReject = false;
    out.runRejectNote = "switchModel unexpectedly succeeded during run";
  } catch (error) {
    out.runReject = /活动 Run|Busy|in progress|运行/i.test(error instanceof Error ? error.message : String(error));
    out.runRejectError = redact(error instanceof Error ? error.message : String(error));
  }
  await runPromise;
  mockDelayMs = 0;
  // Cross-model continuity: continue under the switched model, visible history preserved.
  if (SECONDARY) {
    const recordsBefore = loadRecords().length;
    await runPrompt("cross-model", "Continue: now list the files under src/ using the glob tool, then summarize in one sentence.");
    const recordsAfter = loadRecords();
    out.crossModelContinuity = recordsAfter.length > recordsBefore && Boolean(capturedRef);
    out.recordsBefore = recordsBefore;
    out.recordsAfter = recordsAfter.length;
  }
  out.pass = out.idleSwitch && out.runReject && (SECONDARY ? out.crossModelContinuity : true);
  scenarioResults["model-switch"] = out;
}

async function scenarioResume() {
  const out = { pass: false };
  const ref = capturedRef;
  if (!ref) { out.note = "no captured ref"; scenarioResults.resume = out; return; }
  const before = loadRecords(ref);
  await session.controller.newSession();
  const afterNew = session.controller.getSnapshot().session.ref;
  out.newClearsRef = afterNew === null;
  await session.controller.resumeSession(ref);
  const snap = session.controller.getSnapshot().session;
  out.sameId = snap.ref?.sessionId === ref.sessionId;
  const restored = loadRecords(ref);
  out.prefixPreserved = restored.length >= before.length && before.every((r, i) => JSON.stringify(restored[i]) === JSON.stringify(r));
  await runPrompt("resume-append", "Append a short note: use the read tool to read README.md, then say done.");
  const appended = loadRecords(ref);
  out.appendedFromTail = appended.length > restored.length;
  out.recordSeqMonotonic = appended.every((r, i) => i === 0 || (r.recordSeq ?? i) >= (appended[i - 1].recordSeq ?? i - 1));
  out.pass = out.newClearsRef && out.sameId && out.prefixPreserved && out.appendedFromTail;
  scenarioResults.resume = out;
}

async function scenarioCancel() {
  const out = { pass: false };
  const finishedBefore = runFinished.length;
  if (MODE === "mock-smoke") {
    mockDelayMs = 600;
    const p = session.controller.submitPrompt("describe the library in detail").catch((e) => `threw: ${redact(String(e))}`);
    await waitFor(() => session.controller.getSnapshot().status?.kind === "running", 5000);
    const cancelReturn = session.controller.cancel();
    out.cancelReturn = cancelReturn ?? "void";
    out.outcome = await p;
    mockDelayMs = 0;
  } else {
    // Real cancel: trigger a long bash, approve it, then cancel during execution.
    const p = session.controller.submitPrompt(
      "Run the bash command `sleep 30` (a single tool call), then report its exit code. Do nothing else.",
    ).catch((e) => `threw: ${redact(String(e))}`);
    await waitFor(() => approvals.some((a) => a.toolName === "bash" && a.decision === "session"), 30000);
    await waitFor(() => session.controller.getSnapshot().status?.kind === "running", 5000);
    const cancelReturn = session.controller.cancel();
    out.cancelReturn = cancelReturn ?? "void";
    out.outcome = await p;
  }
  const newFinished = runFinished.slice(finishedBefore);
  out.singleFinished = newFinished.length === 1;
  out.cancelled = out.outcome === "cancelled" || newFinished.some((f) => f.outcome === "cancelled");
  out.pass = out.singleFinished && out.cancelled;
  scenarioResults.cancel = out;
}

function waitFor(pred, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timeout"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

// ---- report ---------------------------------------------------------------

function providerLabel() {
  return MODE === "mock-smoke" ? "mock-smoke" : `${PROVIDER}:${isolatedConfig.current.model}`;
}
function buildReport(status) {
  return {
    task: "T12",
    scenario: SCENARIO,
    mode: MODE,
    provider: providerLabel(),
    platform: process.platform,
    node: process.version,
    at: new Date().toISOString(),
    status,
    scenarioResults,
    runs,
    runFinished,
    approvals,
    requests,
    warnings,
  };
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const reportFile = path.join(OUT, `t12-${SCENARIO}-${MODE === "mock-smoke" ? "mock" : "real"}-${PROVIDER}-${stamp}.json`);
fs.mkdirSync(OUT, { recursive: true });

const order = SCENARIO === "all" ? ["e2e", "title", "model-switch", "resume", "cancel"] : [SCENARIO];
const runners = { e2e: scenarioE2e, title: scenarioTitle, "model-switch": scenarioModelSwitch, resume: scenarioResume, cancel: scenarioCancel };

try {
  for (const name of order) {
    process.stderr.write(`\n=== scenario: ${name} ===\n`);
    await runners[name]();
  }
  await session.controller.exit();
  unsubscribe?.();
  const allPass = Object.values(scenarioResults).every((r) => r.pass);
  const status = allPass ? "pass" : "fail";
  fs.writeFileSync(reportFile, JSON.stringify(buildReport(status), null, 2));
  process.stderr.write(`\n=== T12 RESULT: ${status} ===\n`);
  for (const [name, r] of Object.entries(scenarioResults)) process.stderr.write(`  ${name}: ${r.pass ? "pass" : "FAIL"}\n`);
  process.stderr.write(`report: ${reportFile}\n`);
  if (!allPass) process.exitCode = 2;
} catch (error) {
  fs.writeFileSync(reportFile, JSON.stringify({ ...buildReport("driver-error"), driverError: redact(error instanceof Error ? error.stack ?? error.message : String(error)) }, null, 2));
  process.stderr.write(`\nDRIVER ERROR: ${redact(error instanceof Error ? error.message : String(error))}\nreport: ${reportFile}\n`);
  process.exitCode = 1;
} finally {
  try { await session?.controller.exit(); } catch { /* exit may already have been called above */ }
  unsubscribe?.();
  if (KEEP) {
    process.stderr.write(`temp home kept: ${homeDir}\n`);
  } else {
    try { fs.rmSync(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch { process.stderr.write(`temp home retained (cleanup failed): ${homeDir}\n`); }
  }
}