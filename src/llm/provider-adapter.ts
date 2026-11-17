import { createModels, createProvider } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { toPiAiModel } from "./model-config-store.js";
import type { ResolvedModel } from "./model-config-store.js";

export function createConfiguredModels(resolvedModels: readonly ResolvedModel[]): MutableModels {
  const models = createModels();
  const byProvider = new Map<string, ResolvedModel[]>();
  for (const resolved of resolvedModels) {
    const list = byProvider.get(resolved.providerId) ?? [];
    list.push(resolved);
    byProvider.set(resolved.providerId, list);
  }
  for (const [providerId, entries] of byProvider) {
    const first = entries[0];
    if (!first) continue;
    const providerName = first.providerName;
    const apiKey = first.apiKey;
    models.setProvider(
      createProvider({
        id: providerId,
        name: providerName,
        baseUrl: first.baseUrl,
        auth: {
          apiKey: {
            name: providerName,
            resolve: async () => (apiKey ? { auth: { apiKey } } : undefined),
          },
        },
        // thinking:false 仅靠省略 reasoningEffort 表达；把 thinkingLevelMap.off 设为 null 会被
        // pi-ai 视为“不支持关闭”，从而省略 thinking:{type:'disabled'}。
        models: entries.map(toPiAiModel),
        api: openAICompletionsApi(),
      }),
    );
  }
  return models;
}
