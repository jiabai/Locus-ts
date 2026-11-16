// 任务存储：建目录、拼路径、写清单。
//
// 对齐 `worker/worker_core/task_store.py` 的 `TaskStoreFacade`：任务 id 由时间戳 + 来源标识
// 组成，产物落在 `<output>/tasks/<id>`，源文件副本落在 `<cache>/tasks/<id>/download`。
// 清单最后写，且是唯一记录「哪些产物算数」的地方。
import {randomBytes} from 'node:crypto';
import {lstat, mkdir} from 'node:fs/promises';
import path from 'node:path';

import {atomicWriteBytes} from '../artifacts/atomic-file.ts';
import {
  ARTIFACT_KEY_BY_RELATIVE_PATH,
  commitTaskArtifacts,
  recoverTaskArtifacts,
  TaskArtifactCommitError,
} from '../artifacts/task-transaction.ts';
import {isValidLocalSourceFields} from './local-source.ts';
import {
  readPriorManifestKeys,
  serializeTaskManifest,
  TASK_MANIFEST_FILE_NAME,
} from './manifest.ts';
import type {SerializeManifestOptions} from './manifest.ts';
import {createTaskPaths, toPosixPath} from './paths.ts';
import type {TaskPaths} from './paths.ts';
import {readSourceFile, MAX_ARTICLE_BYTES, MAX_ARTICLE_MARKDOWN_BYTES} from './source-text.ts';
import {validateWebTaskId, WebPageContractError} from '../web/web-page-contract.ts';
import type {WebPageSource} from '../web/web-page-contract.ts';
import {canonicalUrlForPersistence} from '../sources/source-identity.ts';
import type {SourceIdentity} from '../sources/source-identity.ts';
import type {LocalFileTaskSource, ProcessResult, TaskContext, TaskSource, TaskStore} from './types.ts';

const LOCAL_TASK_RANDOM_ID_PATTERN = /^[a-z0-9]{6,32}$/;

export type {TaskStore};

export interface LocalTaskRequest {
  readonly safeDisplayName: string;
  readonly mediaKind: 'video' | 'audio';
  readonly sourceExtension: string;
  readonly asrModel: string;
}

/**
 * 本地任务来源：显示名必须是安全 basename，且扩展名要与媒体类型、
 * 名字后缀三处一致。任一处不符就是非法请求，不在这里「修正」用户输入。
 */
export function validateLocalSource(
  request: LocalTaskRequest,
): LocalFileTaskSource {
  const {safeDisplayName, mediaKind, sourceExtension} = request;
  if (!isValidLocalSourceFields(safeDisplayName, mediaKind, sourceExtension)) {
    throw new Error('Local task source is invalid.');
  }
  return {kind: 'local_file', displayName: safeDisplayName, mediaKind, extension: sourceExtension};
}

export function createLocalTaskContext(options: {
  readonly store: TaskStore;
  readonly request: LocalTaskRequest;
  readonly now?: Date;
  readonly randomId?: string;
}): {readonly context: TaskContext; readonly paths: TaskPaths} {
  const source = validateLocalSource(options.request);
  const created = options.now ?? new Date();
  const randomId = options.randomId ?? randomBytes(8).toString('hex');
  if (!LOCAL_TASK_RANDOM_ID_PATTERN.test(randomId)) {
    throw new Error('Local task random id is invalid.');
  }
  // 时间戳取 UTC，格式与 Python 的 `strftime("%Y%m%d-%H%M%S")` 一致。
  const iso = created.toISOString();
  const datePart = iso.slice(0, 10).replaceAll('-', '');
  const timePart = iso.slice(11, 19).replaceAll(':', '');
  const taskId = `${datePart}-${timePart}-local-${randomId}`;

  const paths = createTaskPaths({
    outputRoot: options.store.outputRoot,
    cacheRoot: options.store.cacheRoot,
    taskId,
  });
  return {
    context: {
      taskId,
      createdAt: `${iso.slice(0, 19)}Z`,
      model: options.request.asrModel,
      source,
    },
    paths,
  };
}

export async function ensureTaskDirs(paths: TaskPaths): Promise<void> {
  for (const directory of [paths.mediaDir, paths.transcriptDir, paths.aiDir, paths.downloadDir]) {
    await mkdir(directory, {recursive: true});
  }
}

/**
 * 新建 URL 任务上下文。
 *
 * 与 Python `create_task_context` 逐字符一致：先重新验算规范 URL（身份不可持久化就直接抛），
 * 再按 `时间戳-平台-稳定 ID[-p分P]` 拼任务 id。稳定 ID 最多保留 80 个字符，分 P 后缀
 * 先占位；当前四平台的 ID 上限是 24 位，截断分支只是守住目录名长度这一不变量。
 */
export function createUrlTaskContext(options: {
  readonly store: TaskStore;
  readonly identity: SourceIdentity;
  readonly asrModel: string;
  readonly now?: Date;
}): {readonly context: TaskContext; readonly paths: TaskPaths} {
  canonicalUrlForPersistence(options.identity);
  const created = options.now ?? new Date();
  const iso = created.toISOString();
  const datePart = iso.slice(0, 10).replaceAll('-', '');
  const timePart = iso.slice(11, 19).replaceAll(':', '');
  const part = options.identity.effectivePart;
  const partSuffix = part !== null && part > 1 ? `-p${part}` : '';
  const sourceSlug = `${options.identity.stableId.slice(0, 80 - partSuffix.length)}${partSuffix}`;
  const taskId = `${datePart}-${timePart}-${options.identity.platform}-${sourceSlug}`;
  if (taskId.includes('/') || taskId.includes('\\') || path.basename(taskId) !== taskId) {
    throw new Error('URL task identity is invalid.');
  }
  const paths = createTaskPaths({
    outputRoot: options.store.outputRoot,
    cacheRoot: options.store.cacheRoot,
    taskId,
  });
  return {
    context: {
      taskId,
      createdAt: `${iso.slice(0, 19)}Z`,
      model: options.asrModel,
      source: {kind: 'url', identity: options.identity},
    },
    paths,
  };
}

/** 新建网页任务上下文：任务目录必须不存在（Python `create_web` 的 `exist_ok=False`）。 */
export function createWebTaskContext(options: {
  readonly store: TaskStore;
  readonly source: WebPageSource;
  readonly now?: Date;
  readonly taskId?: string;
}): {readonly context: TaskContext; readonly paths: TaskPaths} {
  const created = options.now ?? new Date();
  const iso = created.toISOString();
  const datePart = iso.slice(0, 10).replaceAll('-', '');
  const timePart = iso.slice(11, 19).replaceAll(':', '');
  let taskId: string;
  try {
    taskId = validateWebTaskId(
      options.taskId ?? `${datePart}-${timePart}-web-${randomBytes(8).toString('hex')}`,
    );
  } catch (error) {
    if (error instanceof WebPageContractError) throw new Error('Web page task identity is invalid.');
    throw error;
  }
  const paths = createTaskPaths({
    outputRoot: options.store.outputRoot,
    cacheRoot: options.store.cacheRoot,
    taskId,
  });
  return {
    context: {
      taskId,
      createdAt: `${iso.slice(0, 19)}Z`,
      model: null,
      source: options.source,
    },
    paths,
  };
}

/** 只有普通文件算产物：链接（含 Windows 目录联接）一律排除。 */
async function isCommittedRegularFile(target: string): Promise<boolean> {
  try {
    const info = await lstat(target);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * 按磁盘现状生成 `artifacts` 映射。
 *
 * 与 Python 的差异只在「视频键取哪个路径」这一处的推导方式，取值完全一致：
 * 本地视频任务用来源扩展名，音频任务用默认扩展名（此时文件不存在，键自然不会出现）。
 * 网页任务排除媒体键、补上 article 两个键（`task_artifacts_for_existing_files` 的 web 分支）。
 */
export async function taskArtifactsForExistingFiles(
  paths: TaskPaths,
  source: TaskSource,
): Promise<Record<string, string>> {
  const webPage = source.kind === 'web_page';
  const videoPath = source.kind === 'local_file' && source.mediaKind === 'video'
    ? paths.videoPathForExtension(source.extension)
    : paths.videoPathForExtension('mp4');
  const candidates: ReadonlyArray<readonly [string, string]> = webPage ? [
    ['article_txt', paths.articleTxtPath],
    ['article_md', paths.articleMdPath],
    ['summary', paths.summaryPath],
    ['mindmap', paths.mindmapPath],
    ['insights', paths.insightsPath],
    ['insights_md', paths.insightsMdPath],
    ['preference_snapshot', paths.preferenceSnapshotPath],
    ['dissection', paths.dissectionJsonPath],
    ['dissection_md', paths.dissectionMarkdownPath],
    ['draft', paths.draftPath],
  ] : [
    ['video', videoPath],
    ['audio', paths.audioPath],
    ['transcript_txt', paths.transcriptTxtPath],
    ['transcript_md', paths.transcriptMdPath],
    ['segments', paths.segmentsPath],
    ['summary', paths.summaryPath],
    ['mindmap', paths.mindmapPath],
    ['insights', paths.insightsPath],
    ['insights_md', paths.insightsMdPath],
    ['preference_snapshot', paths.preferenceSnapshotPath],
    ['dissection', paths.dissectionJsonPath],
    ['dissection_md', paths.dissectionMarkdownPath],
    ['draft', paths.draftPath],
  ];

  const artifacts: Record<string, string> = {};
  for (const [key, target] of candidates) {
    if (await isCommittedRegularFile(target)) {
      artifacts[key] = toPosixPath(path.relative(paths.taskDir, target));
    }
  }
  return artifacts;
}

/**
 * 把任务标识与磁盘上的产物映射挂到结果上，但不写清单。
 *
 * 标题生成就是这种路径：清单里的 `note_title` 已由两次独立事务写好，再跑一次
 * `finalize` 会把未知字段和 `status` 覆盖掉（Python 的 title 分支同样只调
 * `result_with_task`）。调用方仍需先恢复残留事务，才能读磁盘现状。
 * 网页任务与 Python `result_with_task` 一致：`text` 与 `markdown` 从权威文件读回，
 * 调用方传进来的值只对媒体任务生效。
 */
export async function resultWithTask(
  paths: TaskPaths,
  context: TaskContext,
  result: ProcessResult,
  artifacts?: Readonly<Record<string, string>>,
): Promise<ProcessResult> {
  const webPage = context.source.kind === 'web_page';
  const text = webPage
    ? new TextDecoder('utf-8', {fatal: true}).decode(
      await readSourceFile(paths.articleTxtPath, MAX_ARTICLE_BYTES, paths.taskDir),
    )
    : result.text;
  const markdown = webPage
    ? new TextDecoder('utf-8', {fatal: true}).decode(
      await readSourceFile(paths.articleMdPath, MAX_ARTICLE_MARKDOWN_BYTES, paths.taskDir),
    )
    : (result.markdown ?? '');
  return {
    ...result,
    taskId: context.taskId,
    taskDir: toPosixPath(paths.taskDir),
    artifacts: artifacts ?? await taskArtifactsForExistingFiles(paths, context.source),
    text,
    markdown,
    ...(webPage ? {source: context.source} : {}),
  };
}

/**
 * 提交任务结果：先恢复残留事务，再按磁盘现状重建产物映射，最后原子写清单。
 *
 * 顺序不能反：清单写着某个文件算数，就必须真的存在；而恢复要先于读取，
 * 否则读到的是「事务中途」的半套产物。
 */
export async function finalizeTask(
  paths: TaskPaths,
  context: TaskContext,
  result: ProcessResult,
  options: Omit<SerializeManifestOptions, 'prior'> = {},
): Promise<ProcessResult> {
  await recoverTaskArtifacts(paths.taskDir);
  const taskResult = await resultWithTask(paths, context, result);
  const prior = await readPriorManifestKeys(paths.manifestPath);
  const bytes = serializeTaskManifest(context, taskResult, {...options, prior});
  await atomicWriteBytes(paths.manifestPath, bytes);
  return taskResult;
}

/**
 * 一次提交「产物 + 清单」。
 *
 * 用于「重新生成某个产物」这类动作：新摘要、新导图与写着「哪些产物算数」的清单必须
 * 同生共死——只写文件不写清单，界面看不到新内容；只写清单不写文件，清单会指向旧版本。
 * 因此这里不走逐个原子写，而是把它们放进同一个事务（对齐 Python 的
 * `finalize(artifact_payloads=...)`）。
 */
export async function finalizeTaskWithPayloads(
  paths: TaskPaths,
  context: TaskContext,
  result: ProcessResult,
  payloads: Readonly<Record<string, Uint8Array | null>>,
  options: Omit<SerializeManifestOptions, 'prior'> = {},
): Promise<ProcessResult> {
  await recoverTaskArtifacts(paths.taskDir);
  const artifacts = await taskArtifactsForExistingFiles(paths, context.source);
  for (const [relative, content] of Object.entries(payloads)) {
    // 值为 null 表示在同一个事务里删除旧文件（草稿分支删 `ai/original/draft.md`）；
    // 它不在闭集表里，不能写进清单的 artifacts。
    if (content === null) continue;
    const key = ARTIFACT_KEY_BY_RELATIVE_PATH[relative];
    // 不在闭集里的路径不能进清单：写进去就代表「这个键对应这个文件」。
    if (key === undefined) throw new TaskArtifactCommitError();
    artifacts[key] = relative;
  }
  const taskResult = await resultWithTask(paths, context, result, artifacts);
  const prior = await readPriorManifestKeys(paths.manifestPath);
  const manifestBytes = serializeTaskManifest(context, taskResult, {...options, prior});
  await commitTaskArtifacts(paths.taskDir, {
    ...payloads,
    [TASK_MANIFEST_FILE_NAME]: manifestBytes,
  });
  return taskResult;
}

export type {SerializeManifestOptions};
