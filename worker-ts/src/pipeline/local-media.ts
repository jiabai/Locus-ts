// 本地媒体任务的完整管线：建任务 → 准备媒体 → 识别 → 写文字稿 → 写清单。
//
// 对齐 `worker/worker_core/pipeline_runtime/orchestration.py` 的 `run_local_media_pipeline`
// 与 `pipeline_runtime/transcript.py` 的 `run_asr_transcript_stage`：进度事件的值与顺序、
// 失败阶段、错误码都按同一套规则产出，宿主不需要为两代 worker 写两套分支。
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
import {
  MediaPreparationError,
  prepareLocalMedia,
} from '../media/local-media.ts';
import type {CommandRunner} from '../media/command.ts';
import {MODEL_DIR_ENV} from '../protocol/contract.ts';
import {buildWorkerProgressEvent} from '../protocol/events.ts';
import type {WorkerProgressCode, WorkerProgressEvent} from '../protocol/events.ts';
import {createLocalTaskContext, ensureTaskDirs, finalizeTask} from '../tasks/index.ts';
import {resolveTaskStore} from '../tasks/paths.ts';
import type {TaskPaths} from '../tasks/paths.ts';
import {failedResult} from '../tasks/types.ts';
import type {ProcessResult, TaskContext} from '../tasks/types.ts';

export interface ProcessLocalMediaRequest {
  readonly sourcePath: string;
  readonly mediaKind: 'video' | 'audio';
  readonly safeDisplayName: string;
  readonly sourceExtension: string;
  readonly asrModel: string;
}

export interface LocalMediaPipelineOptions {
  readonly request: ProcessLocalMediaRequest;
  /** 与 Python 的 `project_root` 等价：相对路径的配置与默认目录都以它为基准。 */
  readonly projectRoot: string;
  readonly environ?: Readonly<Record<string, string | undefined>>;
  readonly runner?: CommandRunner;
  /** 测试注入：默认走真实的 ONNX 适配器。 */
  readonly transcriberFactory?: (model: string, cacheDir: string) => Promise<Transcriber>;
  /**
   * 测试注入的缓存就绪判定。默认走 `validateModelCache`（逐文件 SHA-256）；
   * 单测里换成假判定，才能在几百毫秒内跑通「模型已就绪」之后的分支。
   */
  readonly modelCacheValidator?: (cacheDir: string) => Promise<{readonly valid: boolean}>;
  readonly onProgress?: (event: WorkerProgressEvent) => void;
  readonly now?: Date;
  readonly randomId?: string;
}

const MODEL_NOT_DOWNLOADED_MESSAGE = 'SenseVoiceSmall-ONNX model is not downloaded yet.';
const MODEL_CACHE_UNAVAILABLE_MESSAGE = 'ASR model cache is unavailable.';
const TASK_STORAGE_UNAVAILABLE_MESSAGE = 'Task storage could not be prepared.';
const ARTIFACT_COMMIT_FAILED_MESSAGE = 'Task artifacts could not be stored safely.';
const ARTIFACT_RECOVERY_FAILED_MESSAGE = 'Task artifacts could not be recovered safely.';

export async function runLocalMediaPipeline(
  options: LocalMediaPipelineOptions,
): Promise<ProcessResult> {
  const environ = options.environ ?? process.env;
  const emit = (messageCode: WorkerProgressCode, stage: 'video_extracting' | 'video_transcribing', progress: number, messageArgs?: Readonly<Record<string, string>>) => {
    options.onProgress?.(buildWorkerProgressEvent(messageCode, {
      stage,
      progress,
      ...(messageArgs === undefined ? {} : {messageArgs}),
    }));
  };

  let context: TaskContext;
  let paths: TaskPaths;
  try {
    const created = createLocalTaskContext({
      store: resolveTaskStore(options.projectRoot, environ),
      request: {
        safeDisplayName: options.request.safeDisplayName,
        mediaKind: options.request.mediaKind,
        sourceExtension: options.request.sourceExtension,
        asrModel: options.request.asrModel,
      },
      ...(options.now === undefined ? {} : {now: options.now}),
      ...(options.randomId === undefined ? {} : {randomId: options.randomId}),
    });
    context = created.context;
    paths = created.paths;
    await ensureTaskDirs(paths);
  } catch {
    // 建目录失败（权限、磁盘、非法来源）都在这里终结：连任务目录都没有，
    // 没有地方可以记录失败清单，只能返回不带任务标识的失败结果。
    return failedResult({
      code: 'TASK_STORAGE_UNAVAILABLE',
      message: TASK_STORAGE_UNAVAILABLE_MESSAGE,
      stage: 'video_extracting',
    });
  }

  try {
    return await runStages({
      options,
      context,
      paths,
      emit,
      environ,
    });
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
  readonly options: LocalMediaPipelineOptions;
  readonly context: TaskContext;
  readonly paths: TaskPaths;
  readonly environ: Readonly<Record<string, string | undefined>>;
  readonly emit: (
    code: WorkerProgressCode,
    stage: 'video_extracting' | 'video_transcribing',
    progress: number,
    messageArgs?: Readonly<Record<string, string>>,
  ) => void;
}): Promise<ProcessResult> {
  const {options, context, paths, environ, emit} = args;

  let prepared;
  try {
    prepared = await prepareLocalMedia({
      sourcePath: options.request.sourcePath,
      mediaKind: options.request.mediaKind,
      sourceExtension: options.request.sourceExtension,
      paths: {
        downloadDir: paths.downloadDir,
        mediaDir: paths.mediaDir,
        audioPath: paths.audioPath,
        videoPathForExtension: (extension: string) => paths.videoPathForExtension(extension),
      },
      ...(options.runner === undefined ? {} : {runner: options.runner}),
      onProgress: (messageCode, progress) => emit(messageCode, 'video_extracting', progress),
    });
  } catch (error) {
    if (!(error instanceof MediaPreparationError)) throw error;
    return finalizeTask(paths, context, failedResult({
      code: error.code,
      message: error.message,
      stage: 'video_extracting',
    }));
  }

  emit('asr.transcribe.starting', 'video_transcribing', 58);
  if (options.request.asrModel !== SENSEVOICE_MODEL_ID) {
    // 闭集只剩 ONNX 一条路：PyTorch 标识在这里明确失败，不去假装能加载它。
    return finalizeTask(paths, context, failedResult({
      code: 'ASR_MODEL_UNSUPPORTED',
      message: 'This worker supports only the ONNX SenseVoice model.',
      stage: 'video_transcribing',
    }));
  }

  emit('asr.cache.preparing', 'video_transcribing', 58, {model: options.request.asrModel});
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
    transcriber = await (options.transcriberFactory ?? defaultTranscriberFactory)(options.request.asrModel, cacheDir);
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

  let text: string;
  try {
    emit('asr.transcribe.running', 'video_transcribing', 68);
    const transcript = await transcriber.transcribe(prepared.audioPath);
    text = transcript.text;
  } catch (error) {
    if (!isASRError(error)) throw error;
    return finalizeTask(paths, context, failedResult({
      code: error.code,
      message: error.message,
      stage: 'video_transcribing',
    }));
  } finally {
    // 推理会话占着原生内存，任务结束就还回去；失败路径同样要释放。
    try {
      transcriber.dispose();
    } catch {
      // 释放失败不影响已经得到的结论：结果或错误已经决定了，不让清理动作改写它。
    }
  }

  await writeTranscriptFiles({
    text,
    outputDir: paths.transcriptDir,
    outputStem: '',
    metadata: {source: 'asr', language: null, engine: options.request.asrModel},
  });

  return finalizeTask(paths, context, {
    status: 'completed',
    taskId: null,
    taskDir: null,
    artifacts: {},
    text,
    summary: '',
    insights: [],
    transcript: {source: 'asr', language: null, engine: options.request.asrModel},
    dissection: null,
    error: null,
    draft: '',
  });
}

function defaultTranscriberFactory(model: string, cacheDir: string): Promise<Transcriber> {
  return createTranscriber({dataRoot: path.dirname(path.dirname(cacheDir)), model, cacheDir});
}
