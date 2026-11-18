import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Model, OpenAICompletionsCompat } from "@earendil-works/pi-ai";

export const MODEL_CONFIG_FILE_NAME = "model.json";
export const SUPPORTED_API = "openai-completions";

export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "high";

const INPUT_MODALITIES = ["text", "image"] as const;
type InputModality = (typeof INPUT_MODALITIES)[number];

const SAMPLING_PARAM_KEYS = [
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "presence_penalty",
  "frequency_penalty",
  "repetition_penalty",
  "seed",
  "stop",
] as const;

export interface SamplingParamsConfig {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  repetition_penalty?: number;
  seed?: number;
  stop?: string | string[];
}

export interface CostConfig {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelEntryConfig {
  id: string;
  name?: string;
  reasoning?: boolean;
  thinking?: boolean;
  reasoningEffort?: ReasoningEffort;
  input?: InputModality[];
  contextWindow: number;
  maxTokens: number;
  samplingParams?: SamplingParamsConfig;
  compat?: Record<string, unknown>;
  cost?: CostConfig;
}

export interface ProviderConfig {
  name?: string;
  api: string;
  baseUrl: string;
  apiKey?: string;
  models: ModelEntryConfig[];
}

export interface ModelConfigFile {
  current?: { provider: string; model: string };
  providers: Record<string, ProviderConfig>;
}

export interface ResolvedModel {
  providerId: string;
  providerName: string;
  id: string;
  name: string;
  api: typeof SUPPORTED_API;
  baseUrl: string;
  apiKey?: string;
  reasoning: boolean;
  thinking: boolean;
  reasoningEffort: ReasoningEffort;
  input: InputModality[];
  contextWindow: number;
  maxTokens: number;
  samplingParams?: SamplingParamsConfig;
  compat?: Record<string, unknown>;
  cost: CostConfig;
  costUnknown: boolean;
}

export type LoadedModelConfig =
  | { status: "ok"; models: ResolvedModel[]; current: ResolvedModel; secrets: string[] }
  | { status: "empty"; reason: "missing-file" | "no-providers"; message: string; secrets: [] };

export class ModelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelConfigError";
  }
}

const NO_MODEL_MESSAGE = `无有效模型：请手动编辑 ${path.join(os.homedir(), ".shana", "model.json")} 配置 Provider 与模型`;

export function noModelMessage(): string {
  return NO_MODEL_MESSAGE;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(scope: string, message: string): never {
  throw new ModelConfigError(`model.json: ${scope}: ${message}`);
}

function expectNonEmptyString(value: unknown, scope: string, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(scope, `字段 "${field}" 必须是非空字符串`);
  }
  return value;
}

function checkNoUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], scope: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(scope, `未知字段 "${key}"`);
    }
  }
}

function parseSamplingParams(raw: unknown, scope: string): SamplingParamsConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) fail(scope, '"samplingParams" 必须是对象');
  checkNoUnknownKeys(raw, SAMPLING_PARAM_KEYS, scope);
  const out: SamplingParamsConfig = {};
  const numericKeys = [
    "temperature",
    "top_p",
    "top_k",
    "min_p",
    "presence_penalty",
    "frequency_penalty",
    "repetition_penalty",
    "seed",
  ] as const;
  for (const key of numericKeys) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      fail(scope, `"samplingParams.${key}" 必须是数字`);
    }
    (out as Record<string, unknown>)[key] = value;
  }
  const stop = raw.stop;
  if (stop !== undefined) {
    if (typeof stop === "string") {
      out.stop = stop;
    } else if (Array.isArray(stop) && stop.every((s) => typeof s === "string")) {
      out.stop = stop;
    } else {
      fail(scope, '"samplingParams.stop" 必须是字符串或字符串数组');
    }
  }
  return out;
}

function parseCost(raw: unknown, scope: string): CostConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) fail(scope, '"cost" 必须是对象');
  const keys: (keyof CostConfig)[] = ["input", "output", "cacheRead", "cacheWrite"];
  for (const key of keys) {
    if (raw[key] === undefined) fail(scope, `"cost" 填写后 "${key}" 必填`);
    if (typeof raw[key] !== "number" || !Number.isFinite(raw[key]) || (raw[key] as number) < 0) {
      fail(scope, `"cost.${key}" 必须是非负数字`);
    }
  }
  checkNoUnknownKeys(raw, keys, scope);
  return {
    input: raw.input as number,
    output: raw.output as number,
    cacheRead: raw.cacheRead as number,
    cacheWrite: raw.cacheWrite as number,
  };
}

function parseModelEntry(raw: unknown, scope: string): ModelEntryConfig {
  if (!isPlainObject(raw)) fail(scope, "模型条目必须是对象");
  checkNoUnknownKeys(
    raw,
    [
      "id",
      "name",
      "reasoning",
      "thinking",
      "reasoningEffort",
      "input",
      "contextWindow",
      "maxTokens",
      "samplingParams",
      "compat",
      "cost",
    ],
    scope,
  );
  const entry: ModelEntryConfig = {
    id: expectNonEmptyString(raw.id, scope, "id"),
    contextWindow: 0,
    maxTokens: 0,
  };
  for (const field of ["contextWindow", "maxTokens"] as const) {
    const value = raw[field];
    if (value === undefined) fail(scope, `缺少必填字段 "${field}"`);
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      fail(scope, `"${field}" 必须是正整数`);
    }
    entry[field] = value;
  }
  if (raw.name !== undefined) entry.name = expectNonEmptyString(raw.name, scope, "name");
  for (const field of ["reasoning", "thinking"] as const) {
    if (raw[field] !== undefined) {
      if (typeof raw[field] !== "boolean") fail(scope, `"${field}" 必须是布尔值`);
      entry[field] = raw[field] as boolean;
    }
  }
  if (raw.reasoningEffort !== undefined) {
    if (typeof raw.reasoningEffort !== "string" || !(REASONING_EFFORTS as readonly string[]).includes(raw.reasoningEffort)) {
      fail(scope, `"reasoningEffort" 必须是 ${REASONING_EFFORTS.join(" | ")} 之一`);
    }
    entry.reasoningEffort = raw.reasoningEffort as ReasoningEffort;
  }
  if (raw.input !== undefined) {
    if (
      !Array.isArray(raw.input) ||
      raw.input.length === 0 ||
      !raw.input.every((m) => typeof m === "string" && (INPUT_MODALITIES as readonly string[]).includes(m))
    ) {
      fail(scope, `"input" 必须是 ${INPUT_MODALITIES.join(" | ")} 的非空数组`);
    }
    entry.input = raw.input as InputModality[];
  }
  entry.samplingParams = parseSamplingParams(raw.samplingParams, scope);
  if (raw.compat !== undefined) {
    if (!isPlainObject(raw.compat)) fail(scope, '"compat" 必须是对象');
    entry.compat = raw.compat;
  }
  entry.cost = parseCost(raw.cost, scope);
  const reasoning = entry.reasoning ?? false;
  if (reasoning && entry.compat === undefined) {
    fail(scope, 'reasoning: true 的模型必须显式配置 "compat"，拒绝加载');
  }
  return entry;
}

function parseProvider(raw: unknown, providerId: string): ProviderConfig {
  const scope = `providers.${providerId}`;
  if (!isPlainObject(raw)) fail(scope, "Provider 必须是对象");
  checkNoUnknownKeys(raw, ["name", "api", "baseUrl", "apiKey", "apiKeyEnv", "models"], scope);
  if (raw.apiKeyEnv !== undefined) {
    fail(scope, '不支持 "apiKeyEnv"；凭据仅支持明文 "apiKey" 一种方式');
  }
  const api = expectNonEmptyString(raw.api, scope, "api");
  if (api !== SUPPORTED_API) {
    fail(scope, `未知的 "api" "${api}"；第一版仅支持 "${SUPPORTED_API}"`);
  }
  const provider: ProviderConfig = {
    api,
    baseUrl: expectNonEmptyString(raw.baseUrl, scope, "baseUrl"),
    models: [],
  };
  if (raw.name !== undefined) provider.name = expectNonEmptyString(raw.name, scope, "name");
  if (raw.apiKey !== undefined) {
    const apiKey = expectNonEmptyString(raw.apiKey, scope, "apiKey");
    if (apiKey.startsWith("$")) {
      fail(scope, '不支持 "$VAR" 环境变量引用；凭据仅支持明文 "apiKey"');
    }
    provider.apiKey = apiKey;
  }
  if (!Array.isArray(raw.models)) fail(scope, '缺少非空 "models" 数组');
  if (raw.models.length === 0) fail(scope, '"models" 不能为空');
  const seenIds = new Set<string>();
  provider.models = raw.models.map((m, index) => {
    const entry = parseModelEntry(m, `${scope}.models[${index}]`);
    if (seenIds.has(entry.id)) fail(scope, `模型 id "${entry.id}" 重复`);
    seenIds.add(entry.id);
    return entry;
  });
  return provider;
}

export function parseModelConfig(raw: unknown): ModelConfigFile {
  if (!isPlainObject(raw)) fail("顶层", "必须是对象");
  checkNoUnknownKeys(raw, ["current", "providers"], "顶层");
  const config: ModelConfigFile = { providers: {} };
  if (raw.current !== undefined) {
    if (!isPlainObject(raw.current)) fail("current", "必须是对象");
    checkNoUnknownKeys(raw.current, ["provider", "model"], "current");
    config.current = {
      provider: expectNonEmptyString(raw.current.provider, "current", "provider"),
      model: expectNonEmptyString(raw.current.model, "current", "model"),
    };
  }
  if (raw.providers !== undefined) {
    if (!isPlainObject(raw.providers)) fail("providers", "必须是以 Provider ID 为键的对象映射");
    for (const [providerId, providerRaw] of Object.entries(raw.providers)) {
      config.providers[providerId] = parseProvider(providerRaw, providerId);
    }
  }
  if (config.current) {
    const provider = config.providers[config.current.provider];
    if (!provider) {
      fail("current", `Provider "${config.current.provider}" 不存在`);
    }
    if (!provider.models.some((m) => m.id === config.current?.model)) {
      fail("current", `Provider "${config.current.provider}" 中不存在模型 "${config.current.model}"`);
    }
  }
  return config;
}

function resolveModels(config: ModelConfigFile): { models: ResolvedModel[]; secrets: string[] } {
  const models: ResolvedModel[] = [];
  const secrets: string[] = [];
  for (const [providerId, provider] of Object.entries(config.providers)) {
    if (provider.apiKey) secrets.push(provider.apiKey);
    for (const entry of provider.models) {
      models.push({
        providerId,
        providerName: provider.name ?? providerId,
        id: entry.id,
        name: entry.name ?? entry.id,
        api: SUPPORTED_API,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        reasoning: entry.reasoning ?? false,
        thinking: entry.thinking ?? true,
        reasoningEffort: entry.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
        input: entry.input ?? ["text"],
        contextWindow: entry.contextWindow,
        maxTokens: entry.maxTokens,
        samplingParams: entry.samplingParams,
        compat: entry.compat,
        cost: entry.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        costUnknown: entry.cost === undefined,
      });
    }
  }
  return { models, secrets };
}

export function loadModelConfig(configPath: string): LoadedModelConfig {
  if (!fs.existsSync(configPath)) {
    return { status: "empty", reason: "missing-file", message: NO_MODEL_MESSAGE, secrets: [] };
  }
  let rawText: string;
  try {
    rawText = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    throw new ModelConfigError(`model.json: 读取失败 (${(error as Error).message})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new ModelConfigError("model.json: JSON 解析失败，文件已损坏；请手动修复，程序不会覆盖它");
  }
  const config = parseModelConfig(parsed);
  const providerIds = Object.keys(config.providers);
  if (providerIds.length === 0) {
    return { status: "empty", reason: "no-providers", message: NO_MODEL_MESSAGE, secrets: [] };
  }
  const { models, secrets } = resolveModels(config);
  const currentRef = config.current ?? {
    provider: providerIds[0] as string,
    model: config.providers[providerIds[0] as string]?.models[0]?.id as string,
  };
  const current = models.find((m) => m.providerId === currentRef.provider && m.id === currentRef.model);
  if (!current) {
    throw new ModelConfigError(`model.json: current 指向的模型 "${currentRef.provider}/${currentRef.model}" 无法解析`);
  }
  return { status: "ok", models, current, secrets };
}

function readRawConfigFile(configPath: string): Record<string, unknown> {
  let rawText: string;
  try {
    rawText = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    throw new ModelConfigError(`model.json: 读取失败 (${(error as Error).message})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new ModelConfigError("model.json: JSON 解析失败，文件已损坏；拒绝写回");
  }
  if (!isPlainObject(parsed)) fail("顶层", "必须是对象");
  return parsed;
}

function atomicWriteJson(configPath: string, value: unknown): void {
  const dir = path.dirname(configPath);
  const tmpPath = path.join(dir, `.${path.basename(configPath)}.${process.pid}.tmp`);
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmpPath, "w");
    fs.writeFileSync(fd, serialized);
    fs.fsyncSync(fd);
    fs.renameSync(tmpPath, configPath);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true });
  }
}

export function writeCurrentModel(configPath: string, providerId: string, modelId: string): void {
  const raw = readRawConfigFile(configPath);
  const config = parseModelConfig(raw);
  const provider = config.providers[providerId];
  if (!provider) throw new ModelConfigError(`model.json: Provider "${providerId}" 不存在`);
  if (!provider.models.some((m) => m.id === modelId)) {
    throw new ModelConfigError(`model.json: Provider "${providerId}" 中不存在模型 "${modelId}"`);
  }
  raw.current = { provider: providerId, model: modelId };
  atomicWriteJson(configPath, raw);
}

export function writeReasoningEffort(
  configPath: string,
  providerId: string,
  modelId: string,
  effort: ReasoningEffort,
): void {
  if (!(REASONING_EFFORTS as readonly string[]).includes(effort)) {
    throw new ModelConfigError(
      `model.json: "reasoningEffort" 必须是 ${REASONING_EFFORTS.join(" | ")} 之一`,
    );
  }
  const raw = readRawConfigFile(configPath);
  const config = parseModelConfig(raw);
  const provider = config.providers[providerId];
  const modelIndex = provider?.models.findIndex((m) => m.id === modelId) ?? -1;
  if (!provider || modelIndex < 0) {
    throw new ModelConfigError(`model.json: 模型 "${providerId}/${modelId}" 不存在`);
  }
  const rawModels = (raw.providers as Record<string, unknown>)[providerId];
  const rawModelList = (rawModels as Record<string, unknown>).models as unknown[];
  (rawModelList[modelIndex] as Record<string, unknown>).reasoningEffort = effort;
  atomicWriteJson(configPath, raw);
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let output = text;
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length === 0) continue;
    output = output.split(secret).join("[REDACTED]");
    const longestTail = Math.min(secret.length, 12);
    for (let length = longestTail; length >= 4; length--) {
      const tail = secret.slice(-length);
      output = output.split(tail).join("[REDACTED]");
    }
  }
  return output;
}

export function toPiAiModel(resolved: ResolvedModel): Model<typeof SUPPORTED_API> {
  const model: Model<typeof SUPPORTED_API> = {
    id: resolved.id,
    name: resolved.name,
    api: SUPPORTED_API,
    provider: resolved.providerId,
    baseUrl: resolved.baseUrl,
    input: resolved.input,
    reasoning: resolved.reasoning,
    contextWindow: resolved.contextWindow,
    maxTokens: resolved.maxTokens,
    cost: resolved.cost,
  };
  if (resolved.samplingParams !== undefined) {
    model.samplingParams = resolved.samplingParams as Model<typeof SUPPORTED_API>["samplingParams"];
  }
  // pi-ai 对未识别端点默认 true 会以 developer 角色发 system，兼容端点普遍拒绝；默认 false，显式配置优先。
  // pi-ai 1.5.1 起无工具请求会省略 tools 字段；压缩摘要依赖 tools:[] 维持请求前缀，默认恢复旧行为。
  model.compat = {
    supportsDeveloperRole: false,
    requiresToolsWithToolHistory: true,
    ...resolved.compat,
  } as OpenAICompletionsCompat;
  return model;
}
