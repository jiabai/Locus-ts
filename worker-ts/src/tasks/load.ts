// 重新打开一个已存在的任务。
//
// 对齐 `worker/worker_core/task_store.py` 的 `load_task_manifest` /
// `task_context_from_loaded_manifest`：清单是三方共读的状态，读的时候必须比写的时候更严——
// 写错只影响一次任务，读得松会让任意一份被改过的文件变成「可信任务」。
//
// 顺序也不能变：先恢复残留事务，再读清单。恢复要在读之前，否则读到的是「事务中途」的
// 半套产物；先恢复再判不可用，才能把「上一次写到一半」和「这份清单本来就不合规」分开。
import {lstat, realpath} from 'node:fs/promises';
import path from 'node:path';

import {recoverTaskArtifacts} from '../artifacts/task-transaction.ts';
import {isValidLocalSourceFields} from './local-source.ts';
import {SOURCE_PRIVACY_MIGRATION_VERSION, validateManifestArtifacts} from './manifest.ts';
import type {NoteTitleMetadata} from './manifest.ts';
import {parseNoteTitleMetadata as parseTitleMetadata} from './note-title-metadata.ts';
import {createTaskPaths} from './paths.ts';
import type {TaskPaths} from './paths.ts';
import {readSourceFile} from './source-file.ts';
import {validateWebPageSource} from '../web/web-page-contract.ts';
import {sourceIdentityFromManifest} from '../sources/source-identity.ts';
import type {TaskContext, TaskSource, TranscriptMetadata} from './types.ts';
import type {TaskStore} from './index.ts';

const MAX_MANIFEST_BYTES = 1024 * 1024;
const DEFAULT_MODEL = 'iic/SenseVoiceSmall';

/** 任务存储不可用、被链接，或清单不合规：对调用方等价于「这个任务读不出来」。 */
export class TaskManifestUnavailableError extends Error {
  readonly code = 'TASK_MANIFEST_NOT_FOUND';

  constructor() {
    super('A safe task manifest is required to regenerate insights.');
    this.name = 'TaskManifestUnavailableError';
  }
}

function unavailable(): TaskManifestUnavailableError {
  return new TaskManifestUnavailableError();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  const actual = Object.keys(value);
  if (actual.length !== keys.size) return false;
  return actual.every((key) => keys.has(key));
}

/**
 * 任务 id 必须是单层目录名：绝对路径、`..`、带分隔符的都会被当成「想把任务目录指到别处」。
 */
function isValidTaskId(taskId: string): boolean {
  if (taskId.length === 0 || taskId === '.' || taskId === '..') return false;
  if (path.isAbsolute(taskId)) return false;
  if (path.basename(taskId) !== taskId) return false;
  return !taskId.includes('/') && !taskId.includes('\\');
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * 标题元数据的严格解析：清单里写了 `note_title` 就必须自洽。
 *
 * 规则只在 `tasks/note-title-metadata.ts` 里写一份（生成、落盘、读清单共用）；
 * 这里只负责把「规则不合规」收敛成「整份任务不可用」，与 Python 的
 * `load_task_manifest` 把 ValueError 包成「历史格式不可用」一致。
 *
 * 与 `manifest.ts` 的 `readPriorManifestKeys` 不同——那里读不出来就当成「没有可保留字段」，
 * 因为写入时会重新生成；这里读不懂说明这份清单不可信，整个任务都要拒止。
 */
export function parseNoteTitleMetadata(value: unknown): NoteTitleMetadata {
  try {
    return parseTitleMetadata(value);
  } catch {
    throw unavailable();
  }
}

/**
 * 从清单还原任务来源：URL、本地文件或网页。
 *
 * URL 清单**没有 `source_kind`**（历史清单里显式写 `"url"` 也认）；`source_identity` 必须
 * 经平台识别重新验算，`source_url` 必须等于身份里的规范 URL，`local_source`/`web_source`
 * 都不能出现。网页任务的约束全按 Python 的 `_task_source_from_manifest`：schema 4、
 * `model`/`transcript` 必须显式为 null、不许有 `local_source` 与 `note_title`。
 */
function readTaskSource(manifest: Record<string, unknown>): TaskSource {
  if (manifest.source_kind === 'web_page') {
    const metadata = manifest.web_source;
    if (manifest.schema_version !== 4 || manifest.platform !== 'web') throw unavailable();
    if (!('source_identity' in manifest) || manifest.source_identity !== null) throw unavailable();
    if (!('model' in manifest) || manifest.model !== null) throw unavailable();
    if (!('transcript' in manifest) || manifest.transcript !== null) throw unavailable();
    if ('local_source' in manifest || 'note_title' in manifest) throw unavailable();
    if (!isPlainObject(metadata) || !hasExactKeys(metadata, new Set(['title', 'extracted_at']))) {
      throw unavailable();
    }
    if (Object.values(metadata).some((value) => typeof value !== 'string')) throw unavailable();
    if (typeof manifest.source_url !== 'string') throw unavailable();
    // WebPageSource 的构造校验：URL 必须是已规范化的，标题与时间各自自洽。
    try {
      return validateWebPageSource(manifest.source_url, metadata.title, metadata.extracted_at);
    } catch {
      throw unavailable();
    }
  }
  if (manifest.schema_version !== 3 || 'web_source' in manifest) throw unavailable();
  const kind = manifest.source_kind;
  if (kind === undefined || kind === null || kind === 'url') {
    if ('local_source' in manifest) throw unavailable();
    const identity = sourceIdentityFromManifest(manifest.source_identity);
    if (identity === null || manifest.source_url !== identity.canonicalUrl) throw unavailable();
    return {kind: 'url', identity};
  }
  if (kind !== 'local_file') throw unavailable();
  if (!('source_url' in manifest) || manifest.source_url !== '') throw unavailable();
  if (!('source_identity' in manifest) || manifest.source_identity !== null) throw unavailable();
  if (manifest.platform !== 'local') throw unavailable();

  const raw = manifest.local_source;
  if (!isPlainObject(raw) || !hasExactKeys(raw, new Set(['display_name', 'media_kind', 'extension']))) {
    throw unavailable();
  }
  const {display_name: displayName, media_kind: mediaKind, extension} = raw;
  if (!isValidLocalSourceFields(displayName, mediaKind, extension)) throw unavailable();
  return {
    kind: 'local_file',
    displayName: displayName as string,
    mediaKind: mediaKind as 'video' | 'audio',
    extension: extension as string,
  };
}

function validateManifestIdentity(manifest: Record<string, unknown>, taskId: string): void {
  if (manifest.task_id !== taskId) throw unavailable();
  const schema = manifest.schema_version;
  if (typeof schema !== 'number' || !Number.isInteger(schema) || (schema !== 3 && schema !== 4)) {
    throw unavailable();
  }
  if (manifest.source_privacy_migration_version !== SOURCE_PRIVACY_MIGRATION_VERSION) throw unavailable();
  if (manifest.source_privacy_quarantined === true) throw unavailable();
}

/** 解析并校验一份清单对象；所有失败都收敛成同一个「不可用」。 */
export function validateTaskManifest(
  raw: unknown,
  taskId: string,
): Record<string, unknown> {
  if (!isPlainObject(raw)) throw unavailable();
  validateManifestIdentity(raw, taskId);
  // 顺序与 Python 一致：来源、标题、产物依次校验，第一个不合格就整体拒止。
  const source = readTaskSource(raw);
  if (source.kind !== 'web_page' && 'note_title' in raw) parseNoteTitleMetadata(raw.note_title);
  validateManifestArtifacts(raw, source.kind === 'web_page');
  return raw;
}

/**
 * 读取任务清单。
 *
 * 目录与文件本身也校验：任务目录被换成链接、清单是多硬链接文件时，读到的是别人给的内容
 * ——那不是这个任务的清单，再严的字段校验也没有意义。
 */
export async function loadTaskManifest(
  store: TaskStore,
  taskId: string,
): Promise<Record<string, unknown>> {
  if (!isValidTaskId(taskId)) throw unavailable();

  const tasksRoot = path.join(store.outputRoot, 'tasks');
  const taskDir = path.join(tasksRoot, taskId);
  const manifestPath = path.join(taskDir, 'task.json');

  let taskDirInfo;
  let manifestInfo;
  try {
    taskDirInfo = await lstat(taskDir);
    manifestInfo = await lstat(manifestPath);
  } catch {
    throw unavailable();
  }
  if (!taskDirInfo.isDirectory() || taskDirInfo.isSymbolicLink()) throw unavailable();
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.nlink !== 1) {
    throw unavailable();
  }
  try {
    const resolvedRoot = await realpath(tasksRoot);
    const resolvedTask = await realpath(taskDir);
    if (!isInside(resolvedRoot, resolvedTask)) throw unavailable();
  } catch (error) {
    if (error instanceof TaskManifestUnavailableError) throw error;
    throw unavailable();
  }

  // 恢复残留事务可能抛出 `TaskArtifactRecoveryError`：那是另一类失败，
  // 调用方要按「产物无法安全恢复」报告，不能混进「清单读不出来」。
  await recoverTaskArtifacts(taskDir);

  let bytes: Uint8Array;
  try {
    bytes = await readSourceFile(manifestPath, MAX_MANIFEST_BYTES, taskDir);
  } catch {
    throw unavailable();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  } catch {
    throw unavailable();
  }
  return validateTaskManifest(parsed, taskId);
}

/** 从清单还原任务上下文；来源与模型取清单里的值，缺省与 Python 一致。 */
export function taskContextFromLoadedManifest(
  store: TaskStore,
  taskId: string,
  manifest: Record<string, unknown>,
): {readonly context: TaskContext; readonly paths: TaskPaths} {
  const source = readTaskSource(manifest);
  const model = source.kind === 'web_page'
    ? null
    : (typeof manifest.model === 'string' && manifest.model.length > 0
      ? manifest.model
      : DEFAULT_MODEL);
  const createdAt = typeof manifest.created_at === 'string' && manifest.created_at.length > 0
    ? manifest.created_at
    : `${new Date().toISOString().slice(0, 19)}Z`;

  return {
    context: {taskId, createdAt, model, source},
    paths: createTaskPaths({
      outputRoot: store.outputRoot,
      cacheRoot: store.cacheRoot,
      taskId,
    }),
  };
}

/** 清单里的识别元数据；形状不对就当没有，不让一条可选信息拖垮整个任务。 */
export function transcriptMetadataFromManifest(
  manifest: Record<string, unknown>,
): TranscriptMetadata | null {
  const raw = manifest.transcript;
  if (!isPlainObject(raw)) return null;
  const source = raw.source;
  if (source !== 'asr' && source !== 'subtitle') return null;
  return {
    source,
    language: typeof raw.language === 'string' ? raw.language : null,
    engine: typeof raw.engine === 'string' ? raw.engine : null,
  };
}
