// URL 任务的完整管线：来源解析 → 建任务 → 下载/准备媒体 → 字幕或本地识别 → 清单。
//
// 对齐 `worker/worker_core/pipeline_runtime/orchestration.py` 的 `run_worker_pipeline`
// 与 `pipeline_runtime/transcript.py` 的字幕/ASR 两支：进度事件、失败阶段与错误码都按
// 同一套规则产出。三平台 fallback 默认只启用抖音；小红书与 B 站仍缺传输层，
// 未接通时不会注册空策略，也不会把 yt-dlp 的失败伪装成平台错误。
import path from 'node:path';

import {isASRError} from '../asr/errors.ts';
import {createTranscriber} from '../asr/index.ts';
import {ONNX_CACHE_DIR_NAME, SENSEVOICE_MODEL_ID} from '../asr/model-assets.ts';
import {validateModelCache} from '../asr/model-cache.ts';
import type {Transcriber} from '../asr/types.ts';
import {AtomicFileCommitError} from '../artifacts/atomic-file.ts';
import {
  TaskArtifactCommitError,
  TaskArtifactRecoveryError,
} from '../artifacts/task-transaction.ts';
import {writeTranscriptFiles} from '../artifacts/transcript-artifacts.ts';
import {MODEL_DIR_ENV} from '../protocol/contract.ts';
import {buildWorkerProgressEvent} from '../protocol/events.ts';
import type {WorkerProgressCode, WorkerProgressEvent} from '../protocol/events.ts';
import type {ProcessVideoRequest} from '../protocol/process-request.ts';
import {MediaPreparationError} from '../media/errors.ts';
import {prepareUrlMedia} from '../media/url-media.ts';
import type {CommandRunner} from '../media/command.ts';
import {runCommand} from '../media/command.ts';
import type {FallbackDownloadStrategy} from '../media/download.ts';
import {createPlatformFallbackStrategies} from '../media/platform-strategies.ts';
import {downloadXiaohongshuSubtitle} from '../sources/xiaohongshu/index.ts';
import {SourceIdentityError} from '../sources/source-identity.ts';
import {buildDefaultSourceResolver} from '../sources/platform-short-links.ts';
import {SourceResolver} from '../sources/source-resolution.ts';
import type {SourceRequest} from '../sources/source-resolution.ts';
import {createUrlTaskContext, ensureTaskDirs, finalizeTask} from '../tasks/index.ts';
import {resolveTaskStore} from '../tasks/paths.ts';
import type {TaskPaths} from '../tasks/paths.ts';
import {failedResult} from '../tasks/types.ts';
import type {ProcessResult, TaskContext} from '../tasks/types.ts';

const SOURCE_IDENTITY_UNAVAILABLE = 'SOURCE_IDENTITY_UNAVAILABLE';
const TASK_STORAGE_UNAVAILABLE = 'TASK_STORAGE_UNAVAILABLE';
const ARTIFACT_COMMIT_FAILED_MESSAGE = 'Task artifacts could not be stored safely.';
const ARTIFACT_RECOVERY_FAILED_MESSAGE = 'Task artifacts could not be recovered safely.';
const MODEL_NOT_DOWNLOADED_MESSAGE = 'SenseVoiceSmall-ONNX model is not downloaded yet.';
const MODEL_CACHE_UNAVAILABLE_MESSAGE = 'ASR model cache is unavailable.';

/** `worker_application/defaults.py` 的同位解析器：直连识别 + 三平台短链展开。 */
const DEFAULT_SOURCE_RESOLVER = new SourceResolver(buildDefaultSourceResolver());

export type UrlSourceResolver = (url: string) => Promise<SourceRequest>;

export interface UrlMediaPipelineOptions {
  readonly request: ProcessVideoRequest;
  readonly projectRoot: string;
  readonly environ?: Readonly<Record<string, string | undefined>>;
  /** 官方独立 yt-dlp 可执行文件及其前置参数；由业务入口解析后注入。 */
  readonly launcher: readonly string[];
  readonly runner?: CommandRunner;
  /** 三平台 fallback 策略；未接通时为空数组，绝不静默伪造成功。 */
  readonly strategies?: readonly FallbackDownloadStrategy[];
  readonly probeXiaohongshuSubtitle?: (url: string, outputDir: string) => Promise<void>;
  readonly sourceResolver?: UrlSourceResolver;
  readonly transcriberFactory?: (model: string, cacheDir: string) => Promise<Transcriber>;
  readonly modelCacheValidator?: (cacheDir: string) => Promise<{readonly valid: boolean}>;
  readonly onProgress?: (event: WorkerProgressEvent) => void;
  readonly now?: Date;
}

/** yt-dlp 成功后的平台字幕探测：内部已把网络与解析失败收敛成「没有字幕」。 */
async function downloadXiaohongshuSubtitleProbe(
  url: string,
  outputDir: string,
): Promise<void> {
  await downloadXiaohongshuSubtitle(url, outputDir);
}

function emit(
  options: UrlMediaPipelineOptions,
  messageCode: WorkerProgressCode,
  progress: number,
  messageArgs?: Readonly<Record<string, unknown>>,
): void {
  options.onProgress?.(buildWorkerProgressEvent(messageCode, {
    stage: 'video_transcribing',
    progress,
    ...(messageArgs === undefined ? {} : {messageArgs}),
  }));
}

/** 对齐 Python `progress_events.normalize_language_tag`，事件里不能带任意平台字符串。 */
export function normalizeLanguageTag(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const candidate = raw.trim().replaceAll('_', '-');
  if (candidate.length < 2 || candidate.length > 35
    || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(candidate)) return null;
  const parts = candidate.split('-');
  const primary = parts.shift() as string;
  if (primary.length < 2 || primary.length > 3 || !/^[A-Za-z]+$/u.test(primary)) return null;
  const normalized = [primary.toLowerCase()];
  const first = parts[0];
  if (first !== undefined && first.length === 4 && /^[A-Za-z]+$/u.test(first)) {
    const script = parts.shift() as string;
    normalized.push(`${script[0]?.toUpperCase()}${script.slice(1).toLowerCase()}`);
  }
  if (parts.length > 0) {
    const region = parts.shift() as string;
    if (region.length === 2 && /^[A-Za-z]+$/u.test(region)) {
      normalized.push(region.toUpperCase());
    } else if (region.length === 3 && /^\d+$/u.test(region)) {
      normalized.push(region);
    } else {
      return null;
    }
  }
  return parts.length > 0 ? null : normalized.join('-');
}

export async function runUrlMediaPipeline(
  options: UrlMediaPipelineOptions,
): Promise<ProcessResult> {
  const environ = options.environ ?? process.env;
  let source: SourceRequest;
  try {
    source = await (options.sourceResolver
      ?? ((url: string) => DEFAULT_SOURCE_RESOLVER.resolveRequest(url)))(options.request.url);
  } catch (error) {
    if (!(error instanceof SourceIdentityError)) throw error;
    return failedResult({
      code: SOURCE_IDENTITY_UNAVAILABLE,
      message: 'Could not identify a supported stable video source.',
      stage: 'video_extracting',
    });
  }

  let context: TaskContext;
  let paths: TaskPaths;
  try {
    const created = createUrlTaskContext({
      store: resolveTaskStore(options.projectRoot, environ),
      identity: source.identity,
      asrModel: options.request.asrModel,
      ...(options.now === undefined ? {} : {now: options.now}),
    });
    context = created.context;
    paths = created.paths;
    await ensureTaskDirs(paths);
  } catch {
    return failedResult({
      code: TASK_STORAGE_UNAVAILABLE,
      message: 'Task storage could not be prepared.',
      stage: 'video_extracting',
    });
  }

  try {
    return await runStages({options, context, paths, source, environ});
  } catch (error) {
    if (error instanceof TaskArtifactRecoveryError) {
      return failedResult({
        code: 'TASK_ARTIFACT_RECOVERY_FAILED',
        message: ARTIFACT_RECOVERY_FAILED_MESSAGE,
        stage: 'failed',
      });
    }
    if (error instanceof AtomicFileCommitError || error instanceof TaskArtifactCommitError) {
      return failedResult({
        code: 'TASK_ARTIFACT_COMMIT_FAILED',
        message: ARTIFACT_COMMIT_FAILED_MESSAGE,
        stage: 'failed',
      });
    }
    throw error;
  }
}

async function runStages(args: {
  readonly options: UrlMediaPipelineOptions;
  readonly context: TaskContext;
  readonly paths: TaskPaths;
  readonly source: SourceRequest;
  readonly environ: Readonly<Record<string, string | undefined>>;
}): Promise<ProcessResult> {
  const {options, context, paths, source, environ} = args;

  let prepared;
  try {
    prepared = await prepareUrlMedia({
      source,
      paths: {
        downloadDir: paths.downloadDir,
        mediaDir: paths.mediaDir,
        audioPath: paths.audioPath,
        videoPath: paths.videoPathForExtension('mp4'),
      },
      launcher: options.launcher,
      runner: options.runner ?? runCommand,
      strategies: options.strategies ?? createPlatformFallbackStrategies(),
      probeXiaohongshuSubtitle: options.probeXiaohongshuSubtitle
        ?? downloadXiaohongshuSubtitleProbe,
      ...(options.onProgress === undefined ? {} : {onProgress: options.onProgress}),
    });
  } catch (error) {
    if (!(error instanceof MediaPreparationError)) throw error;
    return finalizeTask(paths, context, failedResult({
      code: error.code,
      message: error.message,
      stage: 'video_extracting',
    }));
  }

  const canonicalSourceUrl = source.identity.canonicalUrl;
  const subtitle = prepared.subtitleCandidate;
  if (subtitle !== null) {
    let written = true;
    try {
      await writeTranscriptFiles({
        text: subtitle.text,
        outputDir: paths.transcriptDir,
        outputStem: '',
        metadata: {
          source: 'subtitle',
          language: subtitle.language,
          engine: null,
          canonicalSourceUrl,
        },
        segments: subtitle.segments.map((segment) => ({
          id: segment.id,
          start_ms: segment.startMs,
          end_ms: segment.endMs,
          text: segment.text,
        })),
      });
    } catch (error) {
      // Python 的 `run_prepared_subtitle_transcript_step` 把 ASR 错误当成「没字幕」，
      // 落回本地识别；产物提交失败则是终态错误。
      if (error instanceof AtomicFileCommitError) {
        return finalizeTask(paths, context, failedResult({
          code: 'TASK_ARTIFACT_COMMIT_FAILED',
          message: ARTIFACT_COMMIT_FAILED_MESSAGE,
          stage: 'video_transcribing',
        }));
      }
      if (!isASRError(error)) throw error;
      written = false;
    }
    if (written) {
      emit(options, 'subtitle.detect.found', 68, {
        language: normalizeLanguageTag(subtitle.language) ?? 'und',
      });
      return finalizeTask(paths, context, completedResult(
        subtitle.text,
        {source: 'subtitle', language: subtitle.language, engine: null},
      ));
    }
  }

  emit(options, 'asr.transcribe.starting', 58);
  if (options.request.asrModel !== SENSEVOICE_MODEL_ID) {
    return finalizeTask(paths, context, failedResult({
      code: 'ASR_MODEL_UNSUPPORTED',
      message: 'This worker supports only the ONNX SenseVoice model.',
      stage: 'video_transcribing',
    }));
  }

  emit(options, 'asr.cache.preparing', 58, {model: options.request.asrModel});
  const modelDir = environ[MODEL_DIR_ENV]?.trim() || path.join(options.projectRoot, 'models');
  const cacheDir = path.join(modelDir, ONNX_CACHE_DIR_NAME);
  const validation = await (options.modelCacheValidator ?? validateModelCache)(cacheDir);
  if (!validation.valid) {
    return finalizeTask(paths, context, failedResult({
      code: 'ASR_MODEL_NOT_DOWNLOADED',
      message: MODEL_NOT_DOWNLOADED_MESSAGE,
      stage: 'video_transcribing',
    }));
  }

  let transcriber: Transcriber;
  try {
    transcriber = await (options.transcriberFactory ?? defaultTranscriberFactory)(
      options.request.asrModel,
      cacheDir,
    );
  } catch (error) {
    if (isASRError(error)) {
      return finalizeTask(paths, context, failedResult({
        code: error.code,
        message: MODEL_CACHE_UNAVAILABLE_MESSAGE,
        stage: 'video_transcribing',
      }));
    }
    throw error;
  }

  let transcript: Awaited<ReturnType<Transcriber['transcribe']>>;
  try {
    emit(options, 'asr.transcribe.running', 68);
    transcript = await transcriber.transcribe(prepared.audioPath);
  } catch (error) {
    if (!isASRError(error)) throw error;
    return finalizeTask(paths, context, failedResult({
      code: error.code,
      message: error.message,
      stage: 'video_transcribing',
    }));
  } finally {
    try {
      transcriber.dispose();
    } catch {
      // 释放失败不改写已经决定的结果或错误。
    }
  }

  try {
    await writeTranscriptFiles({
      text: transcript.text,
      outputDir: paths.transcriptDir,
      outputStem: '',
      metadata: {
        source: 'asr',
        language: null,
        engine: options.request.asrModel,
        canonicalSourceUrl,
      },
      segments: transcript.segments,
    });
  } catch (error) {
    if (error instanceof AtomicFileCommitError) {
      return finalizeTask(paths, context, failedResult({
        code: 'TASK_ARTIFACT_COMMIT_FAILED',
        message: ARTIFACT_COMMIT_FAILED_MESSAGE,
        stage: 'video_transcribing',
      }));
    }
    if (!isASRError(error)) throw error;
    return finalizeTask(paths, context, failedResult({
      code: error.code,
      message: error.message,
      stage: 'video_transcribing',
    }));
  }

  return finalizeTask(paths, context, completedResult(
    transcript.text,
    {source: 'asr', language: null, engine: options.request.asrModel},
  ));
}

function completedResult(
  text: string,
  transcript: NonNullable<ProcessResult['transcript']>,
): ProcessResult {
  return {
    status: 'completed',
    taskId: null,
    taskDir: null,
    artifacts: {},
    text,
    summary: '',
    insights: [],
    transcript,
    dissection: null,
    error: null,
    draft: '',
  };
}

function defaultTranscriberFactory(model: string, cacheDir: string): Promise<Transcriber> {
  return createTranscriber({dataRoot: path.dirname(path.dirname(cacheDir)), model, cacheDir});
}
