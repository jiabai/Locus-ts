// 标题状态的读写：只改清单里的 `note_title` 与 `updated_at`。
//
// 对齐 `worker/worker_core/task_store.py` 的 `read_note_title_transcript` /
// `save_note_title`。清单可能带着前端或旧 worker 写入的额外字段，所以这里读回原始对象
// 就地改两个键，绝不重新生成整份清单（Python 的测试专门断言未知字段必须保留）。
//
// 写入前会重新打开任务、重新核对身份、重新读一遍权威文字稿：一旦任务在这期间被改名、
// 被链接替换或文字稿消失，宁可让标题失败，也不能把旧稿当成新稿发出去。
import {commitTaskArtifacts} from '../artifacts/task-transaction.ts';
import {TASK_MANIFEST_FILE_NAME, isoTimestamp} from './manifest.ts';
import {loadTaskManifest, taskContextFromLoadedManifest} from './load.ts';
import {parseNoteTitleMetadata} from './note-title-metadata.ts';
import type {NoteTitleMetadata} from './note-title-metadata.ts';
import {MAX_TRANSCRIPT_BYTES, readSourceFile} from './source-text.ts';
import type {TaskStore} from './index.ts';
import type {TaskPaths} from './paths.ts';
import type {TaskContext} from './types.ts';

/** 读不懂清单、身份变了、权威文字稿不在：统一当作「标题源不可用」。 */
export class TitleTranscriptUnavailableError extends Error {
  constructor() {
    super('The saved transcript is unavailable for title generation.');
    this.name = 'TitleTranscriptUnavailableError';
  }
}

function unavailable(): TitleTranscriptUnavailableError {
  return new TitleTranscriptUnavailableError();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 清单里已有的标题；清单本身已由 `loadTaskManifest` 严格校验过。 */
export function noteTitleFromManifest(manifest: Record<string, unknown>): NoteTitleMetadata | null {
  if (!('note_title' in manifest)) return null;
  try {
    return parseNoteTitleMetadata(manifest.note_title);
  } catch {
    return null;
  }
}

function sameContext(left: TaskContext, right: TaskContext): boolean {
  return left.taskId === right.taskId
    && left.createdAt === right.createdAt
    && left.model === right.model
    && JSON.stringify(left.source) === JSON.stringify(right.source);
}

/**
 * 读权威文字稿。
 *
 * 与 `readTaskSourceText` 的差别：多一层「任务身份没有变」的比对，且失败码归标题所有。
 * 底层 `readSourceFile` 负责链接、nlink、普通文件与读取期间 inode 不变的检查。
 */
export async function readNoteTitleTranscript(
  store: TaskStore,
  taskId: string,
  context: TaskContext,
  paths: TaskPaths,
): Promise<string> {
  let manifest: Record<string, unknown>;
  try {
    manifest = await loadTaskManifest(store, taskId);
  } catch {
    throw unavailable();
  }
  const current = taskContextFromLoadedManifest(store, taskId, manifest);
  if (!sameContext(current.context, context) || manifest.task_id !== taskId) throw unavailable();

  const artifacts = manifest.artifacts;
  if (!isPlainObject(artifacts) || artifacts.transcript_txt !== 'transcript/transcript.txt') {
    throw unavailable();
  }

  let bytes: Uint8Array;
  try {
    bytes = await readSourceFile(paths.transcriptTxtPath, MAX_TRANSCRIPT_BYTES, paths.taskDir);
  } catch {
    throw unavailable();
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    throw unavailable();
  }
  if (text.trim().length === 0) throw unavailable();
  return text;
}

/**
 * 原子写一份标题状态。
 *
 * 一次只提交 `task.json`，走与 Python 相同的事务：崩溃后由下一次 `recoverTaskArtifacts`
 * 还原旧清单，不会留下「标题已生成但清单还是 generating」的中间态。
 */
export async function saveNoteTitle(options: {
  readonly store: TaskStore;
  readonly taskId: string;
  readonly context: TaskContext;
  readonly paths: TaskPaths;
  readonly metadata: NoteTitleMetadata;
  readonly now?: () => Date;
}): Promise<void> {
  const {store, taskId, context, paths} = options;
  const manifest = await loadTaskManifest(store, taskId);
  await readNoteTitleTranscript(store, taskId, context, paths);
  const metadata = parseNoteTitleMetadata(options.metadata);
  const updated: Record<string, unknown> = {
    ...manifest,
    note_title: {...metadata},
    updated_at: isoTimestamp((options.now ?? (() => new Date()))()),
  };
  await commitTaskArtifacts(paths.taskDir, {
    [TASK_MANIFEST_FILE_NAME]: Buffer.from(`${JSON.stringify(updated, null, 2)}\n`, 'utf8'),
  });
}
