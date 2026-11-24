import { loadPrompts, type PromptBundle } from "./tools/prompts.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDiagnostics, type Diagnostics } from "./diagnostics.js";
import { loadModelConfig, redactSecrets, type LoadedModelConfig } from "./llm/model-config-store.js";
import { loadSettings, SETTINGS_FILE_NAME, type Settings } from "./llm/settings-store.js";
import { deriveWorkspaceIdentity, type WorkspaceIdentity } from "./workspace.js";

export interface BootstrapOptions {
  homeDir?: string;
  cwd?: string;
}

export interface BootstrapResult {
  shanaDir: string;
  logsDir: string;
  sessionsDir: string;
  settings: Settings;
  modelConfig: LoadedModelConfig;
  workspace: WorkspaceIdentity;
  diagnostics: Diagnostics;
  prompts: PromptBundle;
}

function ensureDir(dir: string): void {
  if (fs.existsSync(dir)) return;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // 权限尽力而为
    }
  }
}

export function bootstrap(options: BootstrapOptions = {}): BootstrapResult {
  const prompts = loadPrompts();
  const shanaDir = path.join(options.homeDir ?? os.homedir(), ".shana");
  const logsDir = path.join(shanaDir, "logs");
  const sessionsDir = path.join(shanaDir, "sessions");
  ensureDir(shanaDir);
  ensureDir(logsDir);
  ensureDir(sessionsDir);

  const settings = loadSettings(path.join(shanaDir, SETTINGS_FILE_NAME));
  const modelConfig = loadModelConfig(path.join(shanaDir, "model.json"));
  const secrets = modelConfig.status === "ok" ? modelConfig.secrets : [];
  const redact = (text: string) => redactSecrets(text, secrets);
  const diagnostics = createDiagnostics({ logsDir, minLevel: settings.logLevel, redact });
  const workspace = deriveWorkspaceIdentity(options.cwd ?? process.cwd());

  return {
    shanaDir,
    logsDir,
    sessionsDir,
    settings,
    modelConfig,
    workspace,
    diagnostics,
    prompts,
  };
}
