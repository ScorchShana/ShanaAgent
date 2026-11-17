import fs from "node:fs";

export interface DecisionModelConfig {
  base_url: string;
  model?: string;
  apiKey?: string;
}

export type LoadedDecisionModelConfig =
  | { status: "missing" }
  | { status: "invalid"; message: string }
  | { status: "ok"; config: DecisionModelConfig; secrets: string[] };

export function loadDecisionModelConfig(configPath: string): LoadedDecisionModelConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(configPath)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return { status: "invalid", message: "decision-model.json: 读取或 JSON 解析失败" };
  }
  const invalid = (): LoadedDecisionModelConfig => ({
    status: "invalid",
    message: "decision-model.json: 配置字段无效",
  });
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return invalid();
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["base_url", "model", "apiKey"].includes(key))) return invalid();
  for (const key of ["base_url", "model", "apiKey"] as const) {
    if (key !== "base_url" && !(key in value)) continue;
    if (typeof value[key] !== "string" || !value[key].trim()) return invalid();
  }
  const baseUrl = value.base_url as string;
  if (!/^https?:\/\//i.test(baseUrl) || /[\s\\]/.test(baseUrl)) return invalid();
  try {
    const url = new URL(baseUrl);
    if (
      !/^https?:$/.test(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname.replace(/\/+$/, "") ||
      /[?#]/.test(baseUrl)
    )
      return invalid();
  } catch {
    return invalid();
  }
  const config: DecisionModelConfig = { base_url: baseUrl.replace(/\/+$/, "") };
  if (typeof value.model === "string") config.model = value.model;
  if (typeof value.apiKey === "string") config.apiKey = value.apiKey;
  return { status: "ok", config, secrets: config.apiKey ? [config.apiKey] : [] };
}
