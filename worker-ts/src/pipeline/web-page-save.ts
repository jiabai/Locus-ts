// 网页任务的保存路径：宿主把浏览器抽取的文章交给 worker，落成一份可以重算的正式任务。
//
// 对齐 `worker/worker_core/web_page_storage.py`：校验请求 → 构造来源与保存用 Markdown →
// 新建任务目录 → 单事务提交 `article/article.txt`、`article/article.md` 与清单。
// 任何一步失败都收敛成 `WEB_PAGE_REQUEST_OR_STORAGE_INVALID`：宿主不关心是校验拒绝
// 还是存储异常，用户只需要「这次没存上」。
import {mkdir} from 'node:fs/promises';
import path from 'node:path';

import {commitTaskArtifacts} from '../artifacts/task-transaction.ts';
import {buildWorkerProgressEvent} from '../protocol/events.ts';
import type {WorkerProgressEvent} from '../protocol/events.ts';
import {CACHE_DIR_ENV, OUTPUT_DIR_ENV} from '../protocol/contract.ts';
import {serializeTaskManifest, TASK_MANIFEST_FILE_NAME} from '../tasks/manifest.ts';
import {createWebTaskContext, resultWithTask} from '../tasks/index.ts';
import type {TaskStore} from '../tasks/types.ts';
import type {ProcessResult} from '../tasks/types.ts';
import {failedResult, resultToPayload} from '../tasks/types.ts';
import {
  buildSavedMarkdown,
  MAX_ARTICLE_MARKDOWN_BYTES,
  parseWebPageRequest,
  validateArticlePayload,
  validateWebPageSource,
} from '../web/web-page-contract.ts';
import type {WebPageSource} from '../web/web-page-contract.ts';

const WEB_SAVE_FAILED_CODE = 'WEB_PAGE_REQUEST_OR_STORAGE_INVALID';
const WEB_SAVE_FAILED_MESSAGE = 'Web page saving failed.';
const WEB_SAVING_STAGE = 'web_saving' as const;

export interface SaveWebPageOptions {
  /** 固定抽取时间；测试用来逐字节比对清单与产物。 */
  readonly now?: Date;
  /** 宿主指定的任务 id；缺省按时间戳 + 随机尾生成。 */
  readonly taskId?: string;
}

/**
 * 保存一份网页抽取：所有输入先过契约校验，产物与清单一并进事务。
 *
 * 与 Python `save_web_page` 一致：目录创建失败（任务 id 已被占用）也在这里抛出，
 * 由上层 `runSaveWebPageOnce` 收敛成一个失败码。
 */
export async function saveWebPage(
  store: TaskStore,
  payload: unknown,
  options: SaveWebPageOptions = {},
): Promise<ProcessResult> {
  const article = validateArticlePayload(payload);
  const now = options.now ?? new Date();
  const iso = now.toISOString();
  const extractedAt = `${iso.slice(0, 19)}Z`;
  const source: WebPageSource = validateWebPageSource(article.sourceUrl, article.title, extractedAt);
  // 标题按 Markdown 标点转义，来源与时间只接受已验证的本机字段。
  const markdown = buildSavedMarkdown(source.title, source.url, source.extractedAt, article.markdown);
  if (Buffer.byteLength(markdown, 'utf8') > MAX_ARTICLE_MARKDOWN_BYTES) {
    throw new Error('Saved web page Markdown exceeds its limit.');
  }

  const {context, paths} = createWebTaskContext({
    store,
    source,
    now,
    ...(options.taskId === undefined ? {} : {taskId: options.taskId}),
  });
  // Python `mkdir(parents=True, exist_ok=False)`：父目录补建，任务目录必须不存在。
  await mkdir(path.join(store.outputRoot, 'tasks'), {recursive: true});
  await mkdir(paths.taskDir);

  const result: ProcessResult = {
    status: 'completed',
    taskId: context.taskId,
    taskDir: null,
    artifacts: {article_txt: 'article/article.txt', article_md: 'article/article.md'},
    text: article.text,
    summary: '',
    insights: [],
    transcript: null,
    dissection: null,
    error: null,
    draft: '',
    taskCreated: true,
    source,
    markdown,
  };
  const manifestBytes = serializeTaskManifest(context, result, {
    ...(options.now === undefined ? {} : {now: () => now}),
  });
  await commitTaskArtifacts(paths.taskDir, {
    'article/article.txt': Buffer.from(article.text, 'utf8'),
    'article/article.md': Buffer.from(markdown, 'utf8'),
    [TASK_MANIFEST_FILE_NAME]: manifestBytes,
  });
  return resultWithTask(paths, context, result);
}

export interface RunSaveWebPageOnceOptions {
  readonly environ?: Readonly<Record<string, string | undefined>>;
  readonly onProgress?: (event: WorkerProgressEvent) => void;
  readonly now?: Date;
}

/**
 * `--save-web-page-stdin` 的业务入口：请求校验、环境目录与存储失败共用一个错误码。
 *
 * 与 Python `save_web_page_once` 一致：请求按 `parse_web_page_request` 整体校验
 * （含任务 id 与操作 id），`APP_OUTPUT_DIR` / `APP_CACHE_DIR` 必须显式给出且为绝对
 * 路径——保存路径不允许悄悄写进工作区。
 */
export async function runSaveWebPageOnce(
  payload: unknown,
  options: RunSaveWebPageOnceOptions = {},
): Promise<Record<string, unknown>> {
  const environ = options.environ ?? process.env;
  try {
    // 请求已由 CLI 解析成对象；这里的解析失败同样按「保存失败」收敛。
    const request = parseWebPageRequest(payload);
    const outputRoot = environ[OUTPUT_DIR_ENV];
    const cacheRoot = environ[CACHE_DIR_ENV];
    if (typeof outputRoot !== 'string' || typeof cacheRoot !== 'string'
      || !path.isAbsolute(outputRoot) || !path.isAbsolute(cacheRoot)) {
      throw new Error('Web page storage is invalid.');
    }
    options.onProgress?.(buildWorkerProgressEvent('web.page.saving', {
      stage: WEB_SAVING_STAGE,
      progress: 90,
    }));
    const result = await saveWebPage({outputRoot, cacheRoot}, request.article, {
      taskId: request.taskId,
      ...(options.now === undefined ? {} : {now: options.now}),
    });
    return resultToPayload(result);
  } catch {
    return resultToPayload(failedResult({
      code: WEB_SAVE_FAILED_CODE,
      message: WEB_SAVE_FAILED_MESSAGE,
      stage: WEB_SAVING_STAGE,
    }));
  }
}
