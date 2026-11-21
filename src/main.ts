#!/usr/bin/env node
import { theme } from "./tui/theme.js";
import { ProcessTerminal, TuiAltScreen, getKeybindings, getNativeClipboard, setImageTranscoder, type Terminal } from "./tui/framework/index.js";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { bootstrap, type BootstrapResult } from "./bootstrap.js";
import { createAgentSession } from "./core/agent-loop.js";
import { ModelService } from "./llm/model-service.js";
import { createConfiguredModels } from "./llm/provider-adapter.js";
import { redactSecrets } from "./llm/model-config-store.js";
import { collectSettingsWarnings } from "./llm/settings-store.js";
import { SessionStore } from "./sessions/session-store.js";
import { TuiStore } from "./tui/store.js";
import { TuiApp } from "./tui/app.js";
import { onTranscodeReady, transcodeToPng } from "./tui/image-transcoder.js";

export const App = TuiApp;

export function renderTui(store: TuiStore, options: { terminal?: Terminal } = {}) {
  const keybindings = getKeybindings();
  keybindings.setUserBindings({
    ...keybindings.getUserBindings(),
    "tui.altScreen.lineUp": "ctrl+up",
    "tui.altScreen.lineDown": "ctrl+down",
  });
  let resolveExit!: () => void;
  let rejectExit!: (error: unknown) => void;
  const exited = new Promise<void>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  let closing: Promise<void> | undefined;
  let app: TuiApp | undefined;
  const tui = new TuiAltScreen(
    options.terminal ?? new ProcessTerminal({ escapeTimeoutMs: store.settings.escapeTimeoutMs }),
    false,
    undefined,
    {
      refreshIntervalMs: store.settings.streamRefreshMs,
      wheelScrollLines: store.settings.mouseScrollLines,
      scrollToEndIndicator: () => theme.blue("[ Move to bottom ]"),
      copySelection: async (text) => {
        const clipboard = getNativeClipboard();
        if (clipboard?.setText) {
          try {
            await clipboard.setText(text);
            return true;
          } catch (error) {
            return `Copy failed: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
        tui.terminal.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
        return "OSC 52 sent; system clipboard unverified";
      },
      onRenderError: (error) => {
        void close(error);
      },
    },
  );
  // kitty 只接受 PNG：jpeg/webp 由 sharp 后台异步转码，就绪后全树失效重渲染（与 resize 路径同构）。
  setImageTranscoder(transcodeToPng);
  const offTranscodeReady = onTranscodeReady(() => {
    tui.invalidate();
    tui.requestRender();
  });
  function close(error?: unknown): Promise<void> {
    return (closing ??= (async () => {
      // 先退订：转码完成回调不得触碰正在销毁的 tui。
      offTranscodeReady();
      const failures: unknown[] = [];
      if (error !== undefined) failures.push(error);
      try { await store.dispose(); } catch (failure) { failures.push(failure); }
      try { app?.dispose(); } catch (failure) { failures.push(failure); }
      try { tui.stop({ preserveScreen: true }); } catch (failure) { failures.push(failure); }
      if (failures.length === 1) rejectExit(failures[0]);
      else if (failures.length > 1) rejectExit(new AggregateError(failures, "Application shutdown failed"));
      else resolveExit();
    })());
  }
  store.setExitHandler((error) => {
    void close(error);
  });
  try {
    app = new TuiApp(store, tui);
    tui.start();
  } catch (error) {
    void close(error);
  }
  return { tui, unmount: () => close(), waitUntilExit: () => exited };
}

export function bindExitSignals(
  store: TuiStore,
  onClosed: (signal: NodeJS.Signals, error?: unknown) => void,
  host: {
    on(event: NodeJS.Signals, listener: () => void): unknown;
    off(event: NodeJS.Signals, listener: () => void): unknown;
  } = process,
): () => void {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  if (process.platform === "win32") signals.push("SIGBREAK");
  let shutdown: Promise<void> | null = null;
  const bindings = signals.map((signal) => {
    const listener = () => {
      shutdown ??= store.dispose().then(
        () => onClosed(signal),
        (error) => onClosed(signal, error),
      );
    };
    host.on(signal, listener);
    return { signal, listener };
  });
  return () => {
    for (const { signal, listener } of bindings) host.off(signal, listener);
  };
}

export async function createApplication(result: BootstrapResult): Promise<TuiStore> {
  const sessions = new SessionStore({ sessionsDir: result.sessionsDir });
  const secrets = new Set(result.modelConfig.secrets);
  const startupWarnings: string[] = [];
  startupWarnings.push(...collectSettingsWarnings(result.settings));
  let reportWarning = (message: string): void => {
    startupWarnings.push(message);
  };
  const session = await createAgentSession({
    store: sessions,
    workspaceId: result.workspace.id,
    workspaceRoot: result.workspace.path,
    modelConfigPath: path.join(result.shanaDir, "model.json"),
    getModel: () => {
      if (result.modelConfig.status !== "ok") throw new Error(result.modelConfig.message);
      return result.modelConfig.current;
    },
    getSettings: () => result.settings,
    modelService: {
      streamTurn: (options) => {
        if (options.model.apiKey) secrets.add(options.model.apiKey);
        return new ModelService(createConfiguredModels([options.model]), [...secrets]).streamTurn(options);
      },
    },
    diagnostics: result.diagnostics,
    systemPrompt: result.prompts.system,
    environment: `Workspace: ${result.workspace.path}\nPlatform: ${process.platform === "win32" ? "Windows (Git Bash)" : "Linux (bash)"}`,
    onWarning: (warning) => {
      const text =
        warning.kind === "temporary_file_cleanup_failed"
          ? `未能清理临时文件：${warning.path}`
          : warning.kind === "shell_cleanup_unconfirmed"
            ? "Shell 终止无法确认，可能仍有子进程运行。"
            : warning.kind === "tail_truncated"
              ? `Session 尾部记录不完整，已读取完整前缀：${warning.message}`
              : warning.kind === "compaction_failed"
                ? `自动压缩失败，本次继续使用原上下文：${warning.message}`
                : warning.kind === "agents_md_read_failed"
                  ? `AGENTS.md 读取失败，本会话省略项目规则：${warning.path}`
                  : "未识别的警告。";
      reportWarning(text);
    },
  });
  const store = new TuiStore(session.controller, result.settings, {
    workspace: result.workspace.path,
    redact: (text) => redactSecrets(text, [...secrets]),
    diagnostics: result.diagnostics,
  });
  store.setUnknownAcknowledgement(session.acknowledgeUnknownSideEffects);
  reportWarning = (message) => store.notice(message);
  for (const warning of startupWarnings) store.notice(warning);
  return store;
}

const entry = process.argv[1] ? realpathSync(process.argv[1]) : undefined;
if (entry && import.meta.url === pathToFileURL(entry).href) {
  let store: TuiStore | undefined;
  let result: BootstrapResult | undefined;
  try {
    result = bootstrap();
    store = await createApplication(result);
    let view: ReturnType<typeof renderTui> | undefined;
    const unbind = bindExitSignals(store, (signal, error) => {
      process.exitCode = error ? 1 : 128 + os.constants.signals[signal];
      view?.unmount();
    });
    try {
      view = renderTui(store);
      await view.waitUntilExit();
    } finally {
      unbind();
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    console.error(store ? store.redact(text) : redactSecrets(text, result?.modelConfig.secrets ?? []));
    process.exitCode = 1;
  } finally {
    try {
      await store?.dispose();
    } catch {
      console.error("Session 清理失败，可能仍有子进程运行。");
      process.exitCode = 1;
    }
    for (const warning of store?.getExitNotices() ?? []) console.error(warning);
  }
}
