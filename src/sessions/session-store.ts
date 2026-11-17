import { toolCallsOfMessage, validateResultReference } from "./records.js";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  parseSessionMeta,
  parseSessionRecord,
  RecordValidationError,
  SESSION_FORMAT_VERSION,
  type AssistantMessageRecord,
  type NewSessionRecord,
  type SessionMeta,
  type SessionRecord,
  type ToolResultRecord,
} from "./records.js";

export interface SessionRef {
  workspaceId: string;
  sessionId: string;
}

export interface CreateSessionInput {
  workspaceId: string;
  sessionId?: string;
  initialRecords?: readonly NewSessionRecord[];
  autoDecisionEnabled?: boolean;
}

interface CreateSessionWithRecordsInput extends CreateSessionInput {
  records: readonly SessionRecord[];
}

export interface SessionLoadWarning {
  kind: "tail_truncated";
  line: number;
  byteOffset: number;
  message: string;
}

export interface SessionLoad {
  meta: SessionMeta;
  records: SessionRecord[];
  warnings: SessionLoadWarning[];
}

export interface SessionHistory extends SessionLoad {
  fromRecordSeq: number;
}

export interface AppendHookInfo {
  workspaceId: string;
  sessionId: string;
  path: string;
  recordSeq: number;
  type: SessionRecord["type"];
}

// 测试专用注入点：用于观测 fsync 边界与注入写盘失败，禁止真实破坏磁盘（计划 §3.7）。
export interface SessionStoreHooks {
  beforeMetaWrite?(ref: SessionRef): void | Promise<void>;
  beforeMetaSync?(ref: SessionRef): void | Promise<void>;
  beforeMetaReplace?(ref: SessionRef): void | Promise<void>;
  afterMetaReplace?(ref: SessionRef): void | Promise<void>;
  beforeLockWrite?(ref: SessionRef): void | Promise<void>;
  beforeLockSync?(ref: SessionRef): void | Promise<void>;
  beforeAppend?(info: AppendHookInfo): void | Promise<void>;
  afterWrite?(info: AppendHookInfo): void | Promise<void>;
  afterSync?(info: AppendHookInfo): void | Promise<void>;
}

export interface SessionStoreOptions {
  sessionsDir: string;
  now?: () => Date;
  hooks?: SessionStoreHooks;
  sessionIdFactory?: (date: Date) => string;
}

export type SessionStoreErrorCode =
  | "not_found"
  | "corrupt"
  | "unsupported_version"
  | "write_failed"
  | "already_exists"
  | "invalid_argument"
  | "occupied"
  | "not_owned";

export class SessionStoreError extends Error {
  readonly code: SessionStoreErrorCode;

  constructor(code: SessionStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionStoreError";
    this.code = code;
  }
}

export class SessionVersionError extends SessionStoreError {
  readonly foundVersion: unknown;

  constructor(message: string, foundVersion: unknown) {
    super("unsupported_version", message);
    this.name = "SessionVersionError";
    this.foundVersion = foundVersion;
  }
}

export class SessionCorruptionError extends SessionStoreError {
  readonly line: number | undefined;
  readonly byteOffset: number | undefined;

  constructor(message: string, location: { line?: number; byteOffset?: number } = {}) {
    super("corrupt", message);
    this.name = "SessionCorruptionError";
    this.line = location.line;
    this.byteOffset = location.byteOffset;
  }
}

export class SessionNotFoundError extends SessionStoreError {
  constructor(ref: SessionRef) {
    super("not_found", `Session 不存在: ${ref.workspaceId}/${ref.sessionId}；不会自动创建或修复`);
    this.name = "SessionNotFoundError";
  }
}

export class SessionWriteError extends SessionStoreError {
  constructor(message: string, options?: ErrorOptions, code: SessionStoreErrorCode = "write_failed") {
    super(code, message, options);
    this.name = "SessionWriteError";
  }
}

interface AssistantIndexEntry {
  runId: string;
  calls: Map<string, string>;
}

interface WriterState {
  nextSeq: number;
  assistants: Map<number, AssistantIndexEntry>;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value) || value === "." || value === "..") {
    throw new SessionStoreError("invalid_argument", `${label} 非法: ${JSON.stringify(value)}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultSessionIdFactory(date: Date): string {
  const stamp = date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

async function chmodBestEffort(target: string, mode: number): Promise<void> {
  if (process.platform === "win32") return;
  try {
    await fs.promises.chmod(target, mode);
  } catch {
    // 权限尽力而为
  }
}

// Windows 不支持对目录 fsync；POSIX 下仅尽力保证目录项落盘。
async function syncDirectoryBestEffort(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle: FileHandle | undefined;
  try {
    handle = await fs.promises.open(dir, "r");
    await handle.sync();
  } catch {
    // 尽力而为，不宣称任何故障下绝对不丢数据
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeAll(handle: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null);
    offset += bytesWritten;
  }
}

export class SessionStore {
  readonly sessionsDir: string;
  private readonly now: () => Date;
  private readonly hooks: SessionStoreHooks;
  private readonly sessionIdFactory: (date: Date) => string;
  private readonly ownership = new Map<string, { ownerToken: string; releasing: boolean }>();
  private readonly writers = new Map<string, WriterState>();
  private readonly appendChains = new Map<string, Promise<void>>();

  constructor(options: SessionStoreOptions) {
    this.sessionsDir = path.resolve(options.sessionsDir);
    this.now = options.now ?? (() => new Date());
    this.hooks = options.hooks ?? {};
    this.sessionIdFactory = options.sessionIdFactory ?? defaultSessionIdFactory;
  }

  async createSession(input: CreateSessionInput): Promise<SessionMeta> {
    if (input.initialRecords) {
      const records = input.initialRecords.map((record, index) => ({
        ...record,
        recordSeq: index + 1,
        ts: this.now().toISOString(),
        ...(index === 0 ? { version: SESSION_FORMAT_VERSION } : {}),
      })) as SessionRecord[];
      return this.createSessionWithRecords({ ...input, records });
    }
    assertSafeId(input.workspaceId, "workspaceId");
    const createdAt = this.now();
    const sessionId = input.sessionId ?? this.sessionIdFactory(createdAt);
    assertSafeId(sessionId, "sessionId");
    const ref: SessionRef = { workspaceId: input.workspaceId, sessionId };
    const dir = this.sessionDir(ref);
    await this.assertSessionAbsent(ref);

    let created = false;
    try {
      await fs.promises.mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
      await fs.promises.mkdir(dir, { mode: 0o700 });
      created = true;
      await this.acquireSession(ref);
      await chmodBestEffort(path.join(this.sessionsDir, input.workspaceId), 0o700);
      await chmodBestEffort(dir, 0o700);

      const messagesPath = path.join(dir, "messages.jsonl");
      const messagesHandle = await fs.promises.open(messagesPath, "wx", 0o600);
      try {
        await messagesHandle.sync();
      } finally {
        await messagesHandle.close();
      }
      await chmodBestEffort(messagesPath, 0o600);

      const meta: SessionMeta = {
        version: SESSION_FORMAT_VERSION,
        sessionId,
        workspaceId: input.workspaceId,
        createdAt: createdAt.toISOString(),
        autoDecisionEnabled: input.autoDecisionEnabled ?? true,
      };
      await this.writeMetaAtomic(dir, meta);
      this.writers.set(this.sessionKey(ref), { nextSeq: 1, assistants: new Map() });
      return meta;
    } catch (error) {
      if (created) {
        this.ownership.delete(this.sessionKey(ref));
        this.writers.delete(this.sessionKey(ref));
        await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
      if (error instanceof SessionStoreError) throw error;
      throw new SessionWriteError(
        `创建 Session 失败: ${ref.workspaceId}/${ref.sessionId} (${errorMessage(error)})`,
        { cause: error },
      );
    }
  }

  private async createSessionWithRecords(input: CreateSessionWithRecordsInput): Promise<SessionMeta> {
    assertSafeId(input.workspaceId, "workspaceId");
    const records = this.validateInitialRecords(input.records);
    const createdAt = this.now();
    const sessionId = input.sessionId ?? this.sessionIdFactory(createdAt);
    assertSafeId(sessionId, "sessionId");
    const ref: SessionRef = { workspaceId: input.workspaceId, sessionId };
    const dir = this.sessionDir(ref);
    await this.assertSessionAbsent(ref);

    let created = false;
    try {
      await fs.promises.mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
      await fs.promises.mkdir(dir, { mode: 0o700 });
      created = true;
      await this.acquireSession(ref);
      await chmodBestEffort(path.join(this.sessionsDir, input.workspaceId), 0o700);
      await chmodBestEffort(dir, 0o700);

      const messagesPath = path.join(dir, "messages.jsonl");
      const infos: AppendHookInfo[] = [];
      const handle = await fs.promises.open(messagesPath, "wx", 0o600);
      try {
        for (const record of records) {
          const info: AppendHookInfo = {
            workspaceId: ref.workspaceId,
            sessionId: ref.sessionId,
            path: messagesPath,
            recordSeq: record.recordSeq,
            type: record.type,
          };
          await this.hooks.beforeAppend?.(info);
          await writeAll(handle, Buffer.from(`${JSON.stringify(record)}\n`, "utf8"));
          await this.hooks.afterWrite?.(info);
          infos.push(info);
        }
        // 初始化批量提交不被取消打断；meta.json 发布前初始记录必须已刷盘。
        await handle.sync();
        for (const info of infos) {
          await this.hooks.afterSync?.(info);
        }
      } finally {
        await handle.close();
      }
      await chmodBestEffort(messagesPath, 0o600);

      const meta: SessionMeta = {
        version: SESSION_FORMAT_VERSION,
        sessionId,
        workspaceId: input.workspaceId,
        createdAt: createdAt.toISOString(),
        autoDecisionEnabled: input.autoDecisionEnabled ?? true,
      };
      await this.writeMetaAtomic(dir, meta);
      this.writers.set(this.sessionKey(ref), {
        nextSeq: records.length + 1,
        assistants: this.buildAssistantIndex(records),
      });
      return meta;
    } catch (error) {
      if (created) {
        this.ownership.delete(this.sessionKey(ref));
        this.writers.delete(this.sessionKey(ref));
        await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
      if (error instanceof SessionStoreError) throw error;
      throw new SessionWriteError(
        `初始化 Session 失败: ${ref.workspaceId}/${ref.sessionId} (${errorMessage(error)})`,
        { cause: error },
      );
    }
  }

  async readSessionMeta(ref: SessionRef): Promise<SessionMeta> {
    this.assertRef(ref);
    const key = this.sessionKey(ref);
    const owner = this.ownership.get(key);
    if (!owner || owner.releasing) throw this.notOwned(ref);
    return this.serialize(key, async () => {
      await this.verifyOwnership(ref, owner.ownerToken);
      return this.readMeta(ref);
    });
  }

  async setAutoDecisionEnabled(ref: SessionRef, enabled: boolean): Promise<SessionMeta> {
    this.assertRef(ref);
    const key = this.sessionKey(ref);
    const owner = this.ownership.get(key);
    if (!owner || owner.releasing) throw this.notOwned(ref);
    if (typeof enabled !== "boolean") {
      throw new SessionStoreError("invalid_argument", "autoDecisionEnabled must be a boolean");
    }
    return this.serialize(key, async () => {
      await this.verifyOwnership(ref, owner.ownerToken);
      const meta = { ...(await this.readMeta(ref)), autoDecisionEnabled: enabled };
      try {
        await this.writeMetaAtomic(this.sessionDir(ref), meta);
      } catch (error) {
        throw new SessionWriteError(
          `Failed to save Session metadata: ${ref.workspaceId}/${ref.sessionId} (${errorMessage(error)})`,
          { cause: error },
        );
      }
      return meta;
    });
  }

  async appendRecord(ref: SessionRef, input: NewSessionRecord): Promise<SessionRecord> {
    this.assertRef(ref);
    const key = this.sessionKey(ref);
    const owner = this.ownership.get(key);
    if (!owner || owner.releasing) throw this.notOwned(ref);
    return this.serialize(key, async () => {
      await this.verifyOwnership(ref, owner.ownerToken);
      const state = await this.ensureWriter(ref, key);
      const recordSeq = state.nextSeq;
      const ts = this.now().toISOString();
      const base = recordSeq === 1 ? { recordSeq, ts, version: SESSION_FORMAT_VERSION } : { recordSeq, ts };
      const record = { ...input, ...base } as SessionRecord;
      const validated = parseSessionRecord(record, { expectVersion: recordSeq === 1 });
      if (validated.type === "checkpoint" && validated.coveredUpTo >= recordSeq) {
        throw new RecordValidationError(`checkpoint: "coveredUpTo" 必须小于本记录序号 ${recordSeq}`);
      }

      if (validated.type === "tool_result") {
        if (!this.matchesAssistantCall(state.assistants, validated)) {
          const prior = await this.loadSession(ref);
          state.assistants = this.buildAssistantIndex(prior.records);
          if (!this.matchesAssistantCall(state.assistants, validated))
            throw new RecordValidationError("tool_result: 无效的 Assistant 调用引用");
        }
      }
      const recordsPath = path.join(this.sessionDir(ref), "messages.jsonl");
      const info: AppendHookInfo = {
        workspaceId: ref.workspaceId,
        sessionId: ref.sessionId,
        path: recordsPath,
        recordSeq,
        type: validated.type,
      };
      try {
        await this.hooks.beforeAppend?.(info);
        const handle = await fs.promises.open(recordsPath, "a", 0o600);
        try {
          await writeAll(handle, Buffer.from(`${JSON.stringify(validated)}\n`, "utf8"));
          await this.hooks.afterWrite?.(info);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await this.hooks.afterSync?.(info);
      } catch (error) {
        // 提交结果不确定时丢弃缓存，下次从磁盘重建序号，避免重复序号
        this.writers.delete(key);
        throw new SessionWriteError(
          `追加记录失败: ${ref.workspaceId}/${ref.sessionId} ${validated.type} #${recordSeq} (${errorMessage(error)})`,
          { cause: error },
        );
      }

      state.nextSeq = recordSeq + 1;
      if (validated.type === "assistant_message")
        state.assistants.set(recordSeq, this.indexAssistant(validated));
      return validated;
    });
  }

  async openSession(ref: SessionRef): Promise<SessionLoad> {
    this.assertRef(ref);
    await this.readMeta(ref);
    const key = this.sessionKey(ref);
    const loadWriter = async (): Promise<SessionLoad> => {
      const loaded = await this.loadSession(ref);
      if (loaded.warnings.length > 0) {
        throw new SessionWriteError(`Session 末尾记录不完整，拒绝续写: ${ref.workspaceId}/${ref.sessionId}`);
      }
      this.writers.set(key, {
        nextSeq: (loaded.records.at(-1)?.recordSeq ?? 0) + 1,
        assistants: this.buildAssistantIndex(loaded.records),
      });
      return loaded;
    };
    const existing = this.ownership.get(key);
    if (existing) {
      if (existing.releasing) throw this.notOwned(ref);
      return this.serialize(key, async () => {
        await this.verifyOwnership(ref, existing.ownerToken);
        return loadWriter();
      });
    }
    await this.acquireSession(ref);
    try {
      return await this.serialize(key, loadWriter);
    } catch (error) {
      await this.releaseSession(ref);
      throw error;
    }
  }

  async releaseSession(ref: SessionRef): Promise<void> {
    this.assertRef(ref);
    const key = this.sessionKey(ref);
    const owner = this.ownership.get(key);
    if (!owner) throw this.notOwned(ref);
    owner.releasing = true;
    return this.serialize(key, async () => {
      try {
        await this.verifyOwnership(ref, owner.ownerToken);
        await fs.promises.unlink(this.lockPath(ref));
        await syncDirectoryBestEffort(this.sessionDir(ref));
        this.ownership.delete(key);
      } finally {
        this.writers.delete(key);
      }
    });
  }

  private notOwned(ref: SessionRef): SessionStoreError {
    return new SessionWriteError(
      `Session 未持有有效占用，拒绝写入: ${ref.workspaceId}/${ref.sessionId}`,
      undefined,
      "not_owned",
    );
  }

  private lockPath(ref: SessionRef): string {
    return path.join(this.sessionDir(ref), `${ref.sessionId}.session.lock`);
  }

  private async verifyOwnership(ref: SessionRef, ownerToken: string): Promise<void> {
    let lock: unknown;
    try {
      lock = JSON.parse(await fs.promises.readFile(this.lockPath(ref), "utf8"));
    } catch (error) {
      throw new SessionStoreError("not_owned", `Session 占用校验失败: ${this.lockPath(ref)}`, {
        cause: error,
      });
    }
    if (
      !isPlainObject(lock) ||
      lock.ownerToken !== ownerToken ||
      lock.workspaceId !== ref.workspaceId ||
      lock.sessionId !== ref.sessionId
    ) {
      throw this.notOwned(ref);
    }
  }

  private async acquireSession(ref: SessionRef): Promise<void> {
    const lockPath = this.lockPath(ref);
    const ownerToken = randomBytes(24).toString("hex");
    let handle: FileHandle;
    try {
      handle = await fs.promises.open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        let diagnostic = "持有者信息不可读取，占用状态不确定";
        try {
          const lock: unknown = JSON.parse(await fs.promises.readFile(lockPath, "utf8"));
          if (isPlainObject(lock)) {
            const pid = Number.isSafeInteger(lock.pid) && Number(lock.pid) > 0 ? lock.pid : "未知";
            const token =
              typeof lock.ownerToken === "string" && /^[a-f0-9]{48}$/.test(lock.ownerToken)
                ? lock.ownerToken
                : "未知";
            const at =
              typeof lock.acquiredAt === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(lock.acquiredAt)
                ? lock.acquiredAt
                : "未知";
            diagnostic = `pid=${pid}, ownerToken=${token}, acquiredAt=${at}`;
          }
        } catch {
          // A partial or unreadable lock still blocks acquisition.
        }
        throw new SessionStoreError(
          "occupied",
          `Session 已占用或占用状态不确定: ${lockPath}（${diagnostic}）；确认旧实例退出并停止本会话其他占用操作后，人工核对处理残锁`,
          { cause: error },
        );
      }
      if (isNotFound(error)) throw new SessionNotFoundError(ref);
      throw new SessionWriteError(`Session 占用创建失败: ${lockPath}`, { cause: error });
    }
    let identity: fs.BigIntStats | undefined;
    const failures: unknown[] = [];
    try {
      identity = await handle.stat({ bigint: true });
      await this.hooks.beforeLockWrite?.(ref);
      await writeAll(
        handle,
        Buffer.from(
          JSON.stringify({ ...ref, ownerToken, pid: process.pid, acquiredAt: this.now().toISOString() }) +
            "\n",
          "utf8",
        ),
      );
      await this.hooks.beforeLockSync?.(ref);
      await handle.sync();
    } catch (error) {
      failures.push(error);
    }
    try {
      await handle.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) {
      try {
        if (!identity) throw new Error("Cannot verify created lock identity");
        const current = await fs.promises.lstat(lockPath, { bigint: true });
        if (current.dev !== identity.dev || current.ino !== identity.ino)
          throw new Error("Lock identity changed");
        await fs.promises.unlink(lockPath);
      } catch (error) {
        failures.push(error);
      }
      throw new SessionWriteError(
        `Session 占用初始化失败: ${lockPath}${failures.length > 1 ? "；可能残留占用文件，请人工核对" : ""}`,
        { cause: new AggregateError(failures) },
      );
    }
    this.ownership.set(this.sessionKey(ref), { ownerToken, releasing: false });
  }

  async loadSession(ref: SessionRef): Promise<SessionLoad> {
    this.assertRef(ref);
    const meta = await this.readMeta(ref);
    const recordsPath = path.join(this.sessionDir(ref), "messages.jsonl");
    let buffer: Buffer;
    try {
      buffer = await fs.promises.readFile(recordsPath);
    } catch (error) {
      if (isNotFound(error)) {
        throw new SessionCorruptionError(
          `messages.jsonl 缺失: ${ref.workspaceId}/${ref.sessionId}；拒绝加载`,
        );
      }
      throw new SessionStoreError(
        "corrupt",
        `messages.jsonl 读取失败: ${ref.workspaceId}/${ref.sessionId} (${errorMessage(error)})`,
        { cause: error },
      );
    }
    const { records, warnings } = this.parseMessages(buffer, recordsPath);
    return { meta, records, warnings };
  }

  async readHistory(ref: SessionRef, options: { fromRecordSeq?: number } = {}): Promise<SessionHistory> {
    const fromRecordSeq = options.fromRecordSeq ?? 1;
    if (!Number.isInteger(fromRecordSeq) || fromRecordSeq < 1) {
      throw new SessionStoreError(
        "invalid_argument",
        `fromRecordSeq 必须是 ≥1 的整数: ${String(fromRecordSeq)}`,
      );
    }
    const loaded = await this.loadSession(ref);
    return {
      meta: loaded.meta,
      records: loaded.records.filter((record) => record.recordSeq >= fromRecordSeq),
      warnings: loaded.warnings,
      fromRecordSeq,
    };
  }

  async isSessionOccupied(ref: SessionRef): Promise<boolean> {
    this.assertRef(ref);
    try {
      await fs.promises.lstat(this.lockPath(ref));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw new SessionStoreError("corrupt", `Session 占用状态读取失败: ${this.lockPath(ref)}`, {
        cause: error,
      });
    }
  }

  async listSessions(workspaceId: string): Promise<SessionMeta[]> {
    assertSafeId(workspaceId, "workspaceId");
    const workspaceDir = path.join(this.sessionsDir, workspaceId);
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(workspaceDir, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return [];
      throw new SessionStoreError(
        "corrupt",
        `Session 目录读取失败: ${workspaceId} (${errorMessage(error)})`,
        { cause: error },
      );
    }

    const metas: SessionMeta[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
      try {
        metas.push(await this.readMeta({ workspaceId, sessionId: entry.name }));
      } catch (error) {
        if (error instanceof SessionNotFoundError) continue;
        throw error;
      }
    }
    return metas.sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || a.sessionId.localeCompare(b.sessionId),
    );
  }

  private async assertSessionAbsent(ref: SessionRef): Promise<void> {
    try {
      await fs.promises.lstat(this.sessionDir(ref));
      throw new SessionStoreError(
        "already_exists",
        `Session 目录已存在: ${ref.workspaceId}/${ref.sessionId}；拒绝覆盖`,
      );
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  private validateInitialRecords(records: readonly SessionRecord[]): SessionRecord[] {
    return records.map((record, index) => {
      const expectedSeq = index + 1;
      if (record.recordSeq !== expectedSeq) {
        throw new SessionStoreError(
          "invalid_argument",
          `初始记录要求 recordSeq 从 1 连续: 第 ${expectedSeq} 条为 ${record.recordSeq}`,
        );
      }
      let validated: SessionRecord;
      try {
        validated = parseSessionRecord(record, { expectVersion: expectedSeq === 1 });
        if (validated.type === "tool_result") validateResultReference(validated, records.slice(0, index));
      } catch (error) {
        if (error instanceof RecordValidationError) {
          throw new SessionStoreError("invalid_argument", `初始记录 #${expectedSeq} 非法: ${error.message}`);
        }
        throw error;
      }
      if (validated.type === "checkpoint" && validated.coveredUpTo >= validated.recordSeq) {
        throw new SessionStoreError(
          "invalid_argument",
          `checkpoint: "coveredUpTo" 必须小于记录序号 ${validated.recordSeq}`,
        );
      }
      return validated;
    });
  }

  private buildAssistantIndex(records: readonly SessionRecord[]): Map<number, AssistantIndexEntry> {
    const index = new Map<number, AssistantIndexEntry>();
    for (const record of records) {
      if (record.type !== "assistant_message") continue;
      index.set(record.recordSeq, this.indexAssistant(record));
    }
    return index;
  }

  private indexAssistant(record: AssistantMessageRecord): AssistantIndexEntry {
    const calls = new Map<string, string>();
    for (const call of toolCallsOfMessage(record.message)) calls.set(call.id, call.name);
    return { runId: record.runId, calls };
  }

  private matchesAssistantCall(
    assistants: Map<number, AssistantIndexEntry>,
    result: ToolResultRecord,
  ): boolean {
    const owner = assistants.get(result.assistantRecordSeq);
    return (
      owner !== undefined &&
      owner.runId === result.runId &&
      owner.calls.get(result.toolCallId) === result.toolName
    );
  }

  private async writeMetaAtomic(dir: string, meta: SessionMeta): Promise<void> {
    const ref: SessionRef = { workspaceId: meta.workspaceId, sessionId: meta.sessionId };
    const target = path.join(dir, "meta.json");
    const temp = path.join(dir, `.meta.json.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    try {
      const handle = await fs.promises.open(temp, "wx", 0o600);
      try {
        await this.hooks.beforeMetaWrite?.(ref);
        await writeAll(handle, Buffer.from(`${JSON.stringify(meta)}\n`, "utf8"));
        await this.hooks.beforeMetaSync?.(ref);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.hooks.beforeMetaReplace?.(ref);
      await fs.promises.rename(temp, target);
      await this.hooks.afterMetaReplace?.(ref);
    } catch (error) {
      await fs.promises.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
    await chmodBestEffort(target, 0o600);
    await syncDirectoryBestEffort(dir);
  }

  private async readMeta(ref: SessionRef): Promise<SessionMeta> {
    const metaPath = path.join(this.sessionDir(ref), "meta.json");
    let text: string;
    try {
      text = await fs.promises.readFile(metaPath, "utf8");
    } catch (error) {
      if (isNotFound(error)) throw new SessionNotFoundError(ref);
      throw new SessionStoreError(
        "corrupt",
        `meta.json 读取失败: ${ref.workspaceId}/${ref.sessionId} (${errorMessage(error)})`,
        { cause: error },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new SessionCorruptionError(
        `meta.json JSON 解析失败: ${ref.workspaceId}/${ref.sessionId}；拒绝加载，未修改文件`,
      );
    }
    const rawVersion = isPlainObject(parsed) ? parsed.version : undefined;
    if (rawVersion !== SESSION_FORMAT_VERSION) {
      throw new SessionVersionError(
        `meta.json 版本 ${String(rawVersion)} 不受支持（当前支持 ${SESSION_FORMAT_VERSION}）: ${ref.workspaceId}/${ref.sessionId}；拒绝加载，未修改文件`,
        rawVersion,
      );
    }

    let meta: SessionMeta;
    try {
      meta = parseSessionMeta(parsed);
    } catch (error) {
      throw new SessionCorruptionError(
        `${errorMessage(error)}: ${ref.workspaceId}/${ref.sessionId}；拒绝加载，未修改文件`,
      );
    }
    if (meta.sessionId !== ref.sessionId || meta.workspaceId !== ref.workspaceId) {
      throw new SessionCorruptionError(
        `meta.json 的 sessionId/workspaceId 与目录不一致: ${ref.workspaceId}/${ref.sessionId}`,
      );
    }
    return meta;
  }

  private parseMessages(
    buffer: Buffer,
    recordsPath: string,
  ): { records: SessionRecord[]; warnings: SessionLoadWarning[] } {
    const records: SessionRecord[] = [];
    const warnings: SessionLoadWarning[] = [];
    let lineStart = 0;
    let lineNumber = 0;

    for (let index = 0; index < buffer.length; index += 1) {
      if (buffer[index] !== 0x0a) continue;
      const start = lineStart;
      const lineBuffer = buffer.subarray(lineStart, index);
      lineStart = index + 1;
      lineNumber += 1;
      const record = this.parseLine(lineBuffer, lineNumber, start, recordsPath);
      if (record.recordSeq !== lineNumber) {
        throw new SessionCorruptionError(
          `recordSeq 不连续（期望 ${lineNumber}，实际 ${record.recordSeq}）: 第 ${lineNumber} 行`,
          { line: lineNumber, byteOffset: start },
        );
      }
      if (record.type === "tool_result") {
        try {
          validateResultReference(record, records);
        } catch {
          throw new SessionCorruptionError(`无效调用引用: 第 ${lineNumber} 行`, {
            line: lineNumber,
            byteOffset: start,
          });
        }
      }
      records.push(record);
    }

    if (lineStart < buffer.length) {
      warnings.push({
        kind: "tail_truncated",
        line: lineNumber + 1,
        byteOffset: lineStart,
        message: `末尾记录不完整（无换行终止符），已按前 ${lineNumber} 条完整记录恢复；原始文件未修改: ${recordsPath}`,
      });
    }
    return { records, warnings };
  }

  private parseLine(
    lineBuffer: Buffer,
    lineNumber: number,
    byteOffset: number,
    recordsPath: string,
  ): SessionRecord {
    const where = `${recordsPath} 第 ${lineNumber} 行（字节 ${byteOffset}）`;
    let text = lineBuffer.toString("utf8");
    if (text.endsWith("\r")) text = text.slice(0, -1);
    if (text.length === 0) {
      throw new SessionCorruptionError(`空行: ${where}`, { line: lineNumber, byteOffset });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new SessionCorruptionError(`JSON 解析失败: ${where}`, {
        line: lineNumber,
        byteOffset,
      });
    }

    if (lineNumber === 1) {
      const rawVersion = isPlainObject(parsed) ? parsed.version : undefined;
      if (rawVersion !== SESSION_FORMAT_VERSION) {
        throw new SessionVersionError(
          `messages.jsonl 首条记录版本 ${String(rawVersion)} 不受支持（当前支持 ${SESSION_FORMAT_VERSION}）: ${where}；拒绝加载，未修改文件`,
          rawVersion,
        );
      }
    }

    try {
      return parseSessionRecord(parsed, { expectVersion: lineNumber === 1 });
    } catch (error) {
      if (error instanceof RecordValidationError) {
        throw new SessionCorruptionError(`${error.message}: ${where}`, {
          line: lineNumber,
          byteOffset,
        });
      }
      throw error;
    }
  }

  private async ensureWriter(ref: SessionRef, key: string): Promise<WriterState> {
    const cached = this.writers.get(key);
    if (cached) return cached;

    const loaded = await this.loadSession(ref);
    if (loaded.warnings.length > 0) {
      throw new SessionWriteError(
        `Session 末尾记录不完整，拒绝追加（避免制造中间损坏）: ${ref.workspaceId}/${ref.sessionId}`,
      );
    }
    const last = loaded.records[loaded.records.length - 1];
    const state: WriterState = {
      nextSeq: (last?.recordSeq ?? 0) + 1,
      assistants: this.buildAssistantIndex(loaded.records),
    };
    this.writers.set(key, state);
    return state;
  }

  private serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.appendChains.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.appendChains.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private sessionKey(ref: SessionRef): string {
    return `${ref.workspaceId}/${ref.sessionId}`;
  }

  private sessionDir(ref: SessionRef): string {
    return path.join(this.sessionsDir, ref.workspaceId, ref.sessionId);
  }

  private assertRef(ref: SessionRef): void {
    assertSafeId(ref.workspaceId, "workspaceId");
    assertSafeId(ref.sessionId, "sessionId");
  }
}
