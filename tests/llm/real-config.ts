import os from "node:os";
import path from "node:path";
import type { ResolvedModel } from "../../src/llm/model-config-store.js";
import { loadModelConfig } from "../../src/llm/model-config-store.js";

export const REAL_CONFIG_PATH = path.join(os.homedir(), ".shana", "model.json");

export type ProviderRole = "deepseek" | "qwen";

export function roleOf(model: ResolvedModel): ProviderRole | null {
  const modelLabel = `${model.id} ${model.name}`;
  if (/qwen|dashscope/i.test(modelLabel)) return "qwen";
  if (/deepseek/i.test(modelLabel)) return "deepseek";
  const providerLabel = `${model.providerId} ${model.providerName}`;
  if (/qwen|dashscope|aliyun|aliyuncs/i.test(providerLabel)) return "qwen";
  if (/deepseek/i.test(providerLabel)) return "deepseek";
  return null;
}

export interface RealProviderEntry {
  role: ProviderRole;
  model: ResolvedModel;
}

export function loadRealProviders(): { entries: RealProviderEntry[]; secrets: string[] } | null {
  const loaded = loadModelConfig(REAL_CONFIG_PATH);
  if (loaded.status === "empty") return null;
  const entries: RealProviderEntry[] = [];
  const seen = new Set<string>();
  for (const model of loaded.models) {
    if (seen.has(model.providerId)) continue;
    seen.add(model.providerId);
    const role = roleOf(model);
    if (role) entries.push({ role, model });
  }
  return { entries, secrets: loaded.secrets };
}
