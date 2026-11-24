import path from "node:path";
import type { BootstrapResult } from "./bootstrap.js";
import { createAgentSession, type AgentSessionOptions } from "./core/agent-loop.js";
import type { SessionController } from "./core/session-controller.js";
import { redactSecrets } from "./llm/model-config-store.js";
import { ModelService } from "./llm/model-service.js";
import { createConfiguredModels } from "./llm/provider-adapter.js";
import { collectSettingsWarnings } from "./llm/settings-store.js";
import { SessionStore } from "./sessions/session-store.js";

// Core 告警原始联合类型，不复制定义；展示文案归各入口（TUI 在 main.ts 映射）。
export type AgentWarning = Parameters<NonNullable<AgentSessionOptions["onWarning"]>>[0];

// settings 告警本身是字符串，包一层进入同一有序通道。
export type RuntimeWarning = AgentWarning | { kind: "settings_warning"; message: string };

export interface AgentRuntime {
  readonly controller: SessionController;
  // 闭包（不依赖 this）：调用方以未绑定引用传递。
  acknowledgeUnknownSideEffects(): void;
  // 闭包：调用时读活 secrets 集合，不得预计算。
  redact(text: string): string;
  // 接管前缓冲区的浅拷贝；接管后缓冲区冻结，内容恒定。
  readonly startupWarnings: readonly RuntimeWarning[];
  // 只切换转发目标、绝不自动回放；回放是调用方责任。恰好一次接管。
  setWarningHandler(handler: (warning: RuntimeWarning) => void): void;
}

// 公共运行时组装：不创建终端、不注册信号
// （工具定义由 agent-loop 按模型 input 能力自建）。
export async function createAgentRuntime(result: BootstrapResult): Promise<AgentRuntime> {
  const sessions = new SessionStore({ sessionsDir: result.sessionsDir });
  // 可变集合：streamTurn 追加后续 Run 的 Key，redact 共享同一实例。
  const secrets = new Set(result.modelConfig.secrets);
  const buffered: RuntimeWarning[] = [];
  let handler: ((warning: RuntimeWarning) => void) | undefined;
  const reportWarning = (warning: RuntimeWarning): void => {
    if (handler) handler(warning);
    else buffered.push(warning);
  };
  // settings 告警先于 createAgentSession 收集，天然在缓冲区前部。
  for (const message of collectSettingsWarnings(result.settings)) {
    reportWarning({ kind: "settings_warning", message });
  }
  const session = await createAgentSession({
    store: sessions,
    workspaceId: result.workspace.id,
    workspaceRoot: result.workspace.path,
    // 随注入 home 传导（与 model.json 同源 shanaDir）；缺省会落回真实 home，测试注入失效。
    skillsRoot: path.join(result.shanaDir, "skills"),
    // getModel 与 modelConfigPath 都必须传：Core 优先自加载配置（切换模型/
    // Reasoning Effort 依赖内部重载），getModel 仅作无 path 回退与 error 态列表。
    modelConfigPath: path.join(result.shanaDir, "model.json"),
    getModel: () => {
      if (result.modelConfig.status !== "ok") throw new Error(result.modelConfig.message);
      return result.modelConfig.current;
    },
    getSettings: () => result.settings,
    modelService: {
      // 每次调用新建 ModelService（携带当时 secrets），不得改为启动时单例。
      streamTurn: (options) => {
        if (options.model.apiKey) secrets.add(options.model.apiKey);
        return new ModelService(createConfiguredModels([options.model]), [...secrets]).streamTurn(options);
      },
    },
    diagnostics: result.diagnostics,
    systemPrompt: result.prompts.system,
    environment: `Workspace: ${result.workspace.path}\nPlatform: ${process.platform === "win32" ? "Windows (Git Bash)" : "Linux (bash)"}`,
    onWarning: reportWarning,
  });
  return {
    controller: session.controller,
    acknowledgeUnknownSideEffects: session.acknowledgeUnknownSideEffects,
    redact: (text) => redactSecrets(text, [...secrets]),
    get startupWarnings() {
      return [...buffered];
    },
    setWarningHandler(next) {
      if (handler) throw new Error("Warning handler already set");
      handler = next;
    },
  };
}
