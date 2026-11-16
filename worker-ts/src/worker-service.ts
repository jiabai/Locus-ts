// worker 模式的业务入口。CLI 只负责解析参数与渲染，具体动作在这里。
//
// 已迁移五条：`--download-asr-model`（安装后、首次转写前的必经路径，也是 CI 准备模型
// 资产的入口）、`--process-local-media-stdin`（本地音频/视频 → 文字稿 → 清单）、
// `--request-stdin`（URL → 下载 → 字幕或 ASR → 清单）、`--save-web-page-stdin`
// （浏览器抽取的文章 → 正式任务）、`--retry-insights-stdin`
// （已转写任务 → 重新生成导图与摘要 / 灵感 / 标题 / 整理稿 / 解剖报告 / 成稿）。
import {existsSync} from 'node:fs';
import path from 'node:path';

import {ASRModelArchiveInvalidError, isASRError} from './asr/errors.ts';
import {prepareModelCache} from './asr/model-download.ts';
import type {ModelFetch, ModelProgressEvent} from './asr/model-download.ts';
import {ONNX_CACHE_DIR_NAME, SENSEVOICE_MODEL_ID} from './asr/model-assets.ts';
import type {CommandRunner} from './media/command.ts';
import {runLocalMediaPipeline} from './pipeline/local-media.ts';
import {runUrlMediaPipeline} from './pipeline/url-media.ts';
import type {UrlSourceResolver} from './pipeline/url-media.ts';
import {MODEL_DIR_ENV, YTDLP_PATH_ENV} from './protocol/contract.ts';
import {
  INVALID_PROCESS_PAYLOAD_CODE,
  INVALID_PROCESS_PAYLOAD_MESSAGE,
  parseProcessVideoRequest,
} from './protocol/process-request.ts';
import {parseProcessLocalMediaRequest} from './protocol/requests.ts';
import type {WorkerProgressEvent} from './protocol/events.ts';
import type {FallbackDownloadStrategy} from './media/download.ts';
import {failedResult, resultToPayload} from './tasks/types.ts';
import type {Transcriber} from './asr/types.ts';
import {runInsightRetryPipeline} from './pipeline/insight-retry.ts';
import {runSaveWebPageOnce, saveWebPage} from './pipeline/web-page-save.ts';
export type {RunSaveWebPageOnceOptions, SaveWebPageOptions} from './pipeline/web-page-save.ts';
export {runSaveWebPageOnce};
import type {SummaryAgentRuntime} from './ai/summary-agent.ts';
import type {NoteTitleLlm, PolishLlmFactory} from './ai/index.ts';
import type {ChatFetch} from './ai/chat.ts';
import type {Transport} from './ai/config.ts';
import type {PolishRunner} from './pipeline/transcript-polish-step.ts';
import type {DraftRunner, McpSessionFactory} from './pipeline/draft-step.ts';
import type {DraftLlmFactory} from './ai/draft-agent.ts';
import type {TaskStore} from './tasks/index.ts';

/** 契约 `terminalResults.schemas.modelDownload` 的两条固定文案，不能改写。 */
const DOWNLOAD_FAILED_MESSAGE = 'ASR model download failed.';
const ARCHIVE_INVALID_MESSAGE = 'Downloaded ASR model archive was invalid.';

export type AsrModelDownloadResult =
  | {readonly status: 'completed'; readonly model: string}
  | {readonly status: 'failed'; readonly code: string; readonly message: string};

export interface AsrModelDownloadOptions {
  /** 必须显式传入：旧 worker 的默认值是 PyTorch 模型，这里没有等价物。 */
  readonly model: string;
  /** 等价于 `APP_MODEL_DIR`：模型根目录，缓存落在其下的 `onnx/`。 */
  readonly modelDir?: string;
  /** 未给 `modelDir` 时用 `<root>/models`，与 Python 的默认一致。 */
  readonly root?: string;
  readonly environ?: Readonly<Record<string, string | undefined>>;
  readonly onProgress?: (event: ModelProgressEvent) => void;
  readonly fetchImpl?: ModelFetch;
  readonly signal?: AbortSignal;
  /**
   * 替换固定哈希，与 `prepareModelCache` 同名参数一致：门禁与单测用假资产跑通完整
   * 下载路径时使用。生产路径不传。
   */
  readonly assetHashes?: Readonly<Record<string, string>>;
}

/**
 * 下载（或复用）当前 ONNX 模型缓存。
 *
 * 返回契约里的两种终态之一，不抛错：宿主只看 stdout 的 JSON 与退出码。
 * 失败原因只保留两个固定码——下载态失败与产物无效——其余细节进 stderr 进度与诊断通道，
 * 避免把端点、路径或第三方异常文本带进用户可见结果。
 */
export async function runAsrModelDownloadOnce(
  options: AsrModelDownloadOptions,
): Promise<AsrModelDownloadResult> {
  if (options.model !== SENSEVOICE_MODEL_ID) {
    // 闭集：PyTorch 标识与未知值都在此拒止，不悄悄换成 ONNX 去下载。
    return {status: 'failed', code: 'ASR_MODEL_UNSUPPORTED', message: DOWNLOAD_FAILED_MESSAGE};
  }

  const environ = options.environ ?? process.env;
  const modelDir = options.modelDir
    ?? environ[MODEL_DIR_ENV]
    ?? path.join(options.root ?? process.cwd(), 'models');
  const cacheDir = path.join(modelDir, ONNX_CACHE_DIR_NAME);

  try {
    await prepareModelCache({
      cacheDir,
      ...(options.onProgress === undefined ? {} : {onProgress: options.onProgress}),
      ...(options.fetchImpl === undefined ? {} : {fetchImpl: options.fetchImpl}),
      ...(options.signal === undefined ? {} : {signal: options.signal}),
      ...(options.assetHashes === undefined ? {} : {assetHashes: options.assetHashes}),
    });
  } catch (error) {
    if (error instanceof ASRModelArchiveInvalidError) {
      return {status: 'failed', code: error.code, message: ARCHIVE_INVALID_MESSAGE};
    }
    if (isASRError(error) && error.code === 'ASR_MODEL_DOWNLOAD_FAILED') {
      return {status: 'failed', code: error.code, message: DOWNLOAD_FAILED_MESSAGE};
    }
    // 取消也走这里：契约只有两条失败文案，宿主以进程树终止为准。
    return {status: 'failed', code: 'ASR_MODEL_DOWNLOAD_FAILED', message: DOWNLOAD_FAILED_MESSAGE};
  }

  return {status: 'completed', model: options.model};
}

export interface LocalMediaRunOptions {
  readonly projectRoot: string;
  readonly environ?: Readonly<Record<string, string | undefined>>;
  readonly runner?: CommandRunner;
  readonly transcriberFactory?: (model: string, cacheDir: string) => Promise<Transcriber>;
  /** 与管线同名参数：单测用它跳过真实模型哈希校验。 */
  readonly modelCacheValidator?: (cacheDir: string) => Promise<{readonly valid: boolean}>;
  readonly onProgress?: (event: WorkerProgressEvent) => void;
  readonly now?: Date;
  readonly randomId?: string;
}

/**
 * 跑一条本地媒体任务。
 *
 * 返回终态结果的 JSON 载荷（契约 `terminalResults.schemas.mediaTask`），不抛错：
 * 请求非法与执行失败都走结果行，宿主只看这一行。请求非法时没有任务目录，
 * 所以 `task_id`/`task_dir` 为 null、`artifacts` 为空。
 */
export async function runProcessLocalMediaOnce(
  payload: unknown,
  options: LocalMediaRunOptions,
): Promise<Record<string, unknown>> {
  let request;
  try {
    request = parseProcessLocalMediaRequest(payload);
  } catch {
    return resultToPayload(failedResult({
      code: 'LOCAL_MEDIA_VALIDATION_FAILED',
      message: 'Local media request payload was invalid.',
      stage: 'waiting_input',
    }));
  }

  const result = await runLocalMediaPipeline({
    request,
    projectRoot: options.projectRoot,
    ...(options.environ === undefined ? {} : {environ: options.environ}),
    ...(options.runner === undefined ? {} : {runner: options.runner}),
    ...(options.transcriberFactory === undefined
      ? {}
      : {transcriberFactory: options.transcriberFactory}),
    ...(options.modelCacheValidator === undefined
      ? {}
      : {modelCacheValidator: options.modelCacheValidator}),
    ...(options.onProgress === undefined ? {} : {onProgress: options.onProgress}),
    ...(options.now === undefined ? {} : {now: options.now}),
    ...(options.randomId === undefined ? {} : {randomId: options.randomId}),
  });
  return resultToPayload(result);
}

/**
 * 解析官方独立 yt-dlp 可执行文件的位置。
 *
 * 宿主接线后应显式注入 `APP_YTDLP_PATH`；未注入时按当前平台在 `<root>/bin/` 下找随包资产。
 * 找不到就由调用方返回固定的下载失败结果，不把路径或 ENOENT 细节写进用户可见的结果行。
 */
export function resolveYtdlpLauncher(
  environ: Readonly<Record<string, string | undefined>>,
  projectRoot: string,
): readonly string[] | null {
  const configured = environ[YTDLP_PATH_ENV]?.trim();
  if (configured) return [configured];
  const assetName = process.platform === 'win32'
    ? 'yt-dlp.exe'
    : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp';
  const bundled = path.join(projectRoot, 'bin', assetName);
  return existsSync(bundled) ? [bundled] : null;
}

export interface ProcessVideoRunOptions {
  readonly projectRoot: string;
  readonly environ?: Readonly<Record<string, string | undefined>>;
  /** 测试注入：直接给出下载器可执行文件，跳过磁盘探测。 */
  readonly launcher?: readonly string[];
  readonly runner?: CommandRunner;
  readonly strategies?: readonly FallbackDownloadStrategy[];
  readonly probeXiaohongshuSubtitle?: (url: string, outputDir: string) => Promise<void>;
  readonly sourceResolver?: UrlSourceResolver;
  readonly transcriberFactory?: (model: string, cacheDir: string) => Promise<Transcriber>;
  readonly modelCacheValidator?: (cacheDir: string) => Promise<{readonly valid: boolean}>;
  readonly onProgress?: (event: WorkerProgressEvent) => void;
  readonly now?: Date;
}

/** 跑一条 URL 任务：请求校验、来源解析、下载、字幕或本地识别，最后写清单。 */
export async function runProcessVideoOnce(
  payload: unknown,
  options: ProcessVideoRunOptions,
): Promise<Record<string, unknown>> {
  let request;
  try {
    request = parseProcessVideoRequest(payload);
  } catch {
    return resultToPayload(failedResult({
      code: INVALID_PROCESS_PAYLOAD_CODE,
      message: INVALID_PROCESS_PAYLOAD_MESSAGE,
      stage: 'waiting_input',
    }));
  }

  const environ = options.environ ?? process.env;
  const launcher = options.launcher
    ?? resolveYtdlpLauncher(environ, options.projectRoot);
  if (launcher === null) {
    return resultToPayload(failedResult({
      code: 'VIDEO_DOWNLOAD_FAILED',
      message: 'Video downloader is unavailable.',
      stage: 'video_extracting',
    }));
  }

  const result = await runUrlMediaPipeline({
    request,
    projectRoot: options.projectRoot,
    launcher,
    ...(options.environ === undefined ? {} : {environ: options.environ}),
    ...(options.runner === undefined ? {} : {runner: options.runner}),
    ...(options.strategies === undefined ? {} : {strategies: options.strategies}),
    ...(options.probeXiaohongshuSubtitle === undefined
      ? {}
      : {probeXiaohongshuSubtitle: options.probeXiaohongshuSubtitle}),
    ...(options.sourceResolver === undefined ? {} : {sourceResolver: options.sourceResolver}),
    ...(options.transcriberFactory === undefined
      ? {}
      : {transcriberFactory: options.transcriberFactory}),
    ...(options.modelCacheValidator === undefined
      ? {}
      : {modelCacheValidator: options.modelCacheValidator}),
    ...(options.onProgress === undefined ? {} : {onProgress: options.onProgress}),
    ...(options.now === undefined ? {} : {now: options.now}),
  });
  return resultToPayload(result);
}

export interface RetryInsightsOptions {
  readonly projectRoot: string;
  readonly environ?: Readonly<Record<string, string | undefined>>;
  /** 测试注入：替换输出/缓存根目录。 */
  readonly store?: TaskStore;
  /** 测试注入：替换真实 LLM 工厂，单测不需要凭证也能跑完整条链。 */
  readonly llmFactory?: (environ: Readonly<Record<string, string | undefined>>) => Promise<SummaryAgentRuntime>;
  /** 测试注入：标题分支的单次文本补全。 */
  readonly titleLlmFactory?: (environ: Readonly<Record<string, string | undefined>>) => Promise<NoteTitleLlm>;
  /** 测试注入：整理稿分支整段替换，或只替换模型层。 */
  readonly polishRunner?: PolishRunner;
  readonly polishLlmFactory?: PolishLlmFactory;
  /** 测试注入：成稿分支整段替换，或只替换模型层 / 检索会话 / 技能目录。 */
  readonly draftRunner?: DraftRunner;
  readonly draftLlmFactory?: DraftLlmFactory;
  readonly mcpSessionFactory?: McpSessionFactory;
  readonly skillsRoot?: string;
  /** 测试注入：模型请求 / 托管 checkout 的传输层。 */
  readonly fetchImpl?: ChatFetch;
  readonly transport?: Transport;
  /** stderr 进度事件（标题、整理稿与解剖报告）。 */
  readonly onProgress?: (event: WorkerProgressEvent) => void;
  readonly signal?: AbortSignal;
}

/**
 * 重新生成某个已转写任务的产物（契约里六个 target 全部可用）。
 *
 * 返回契约 `workerResultKeys` 那套终态结果，不抛错：请求非法、任务读不出来、生成失败
 * 都写在结果行里。与 Python 的 `retry_insights_once` 一样，退出码不因这些失败改变。
 */
export async function runRetryInsightsOnce(
  payload: unknown,
  options: RetryInsightsOptions,
): Promise<Record<string, unknown>> {
  const result = await runInsightRetryPipeline(payload, {
    projectRoot: options.projectRoot,
    ...(options.environ === undefined ? {} : {environ: options.environ}),
    ...(options.store === undefined ? {} : {store: options.store}),
    ...(options.llmFactory === undefined ? {} : {llmFactory: options.llmFactory}),
    ...(options.titleLlmFactory === undefined ? {} : {titleLlmFactory: options.titleLlmFactory}),
    ...(options.polishRunner === undefined ? {} : {polishRunner: options.polishRunner}),
    ...(options.polishLlmFactory === undefined ? {} : {polishLlmFactory: options.polishLlmFactory}),
    ...(options.draftRunner === undefined ? {} : {draftRunner: options.draftRunner}),
    ...(options.draftLlmFactory === undefined ? {} : {draftLlmFactory: options.draftLlmFactory}),
    ...(options.mcpSessionFactory === undefined ? {} : {mcpSessionFactory: options.mcpSessionFactory}),
    ...(options.skillsRoot === undefined ? {} : {skillsRoot: options.skillsRoot}),
    ...(options.fetchImpl === undefined ? {} : {fetchImpl: options.fetchImpl}),
    ...(options.transport === undefined ? {} : {transport: options.transport}),
    ...(options.onProgress === undefined ? {} : {onProgress: options.onProgress}),
    ...(options.signal === undefined ? {} : {signal: options.signal}),
  });
  return resultToPayload(result);
}
