// ASR 包的公共入口。worker 的模型解析处只用这里创建适配器，任务流程只依赖
// `Transcriber` / `Transcript` / `ASRError`，不接触具体模型或运行时。
export {
  SUPPORTED_ASR_MODELS,
  LEGACY_ASR_MODELS,
  DEFAULT_ASR_LANGUAGE,
  assertSupportedModel,
} from './types.ts';
export type {
  SupportedAsrModel,
  Transcript,
  TranscriptSegment,
  Transcriber,
} from './types.ts';

export {
  ASRError,
  ASR_ERROR_CODES,
  ASRDependencyError,
  ASREmptyTranscriptError,
  ASRModelArchiveInvalidError,
  ASRModelCacheUnavailableError,
  ASRModelDownloadFailedError,
  ASRModelNotDownloadedError,
  ASRRuntimeError,
  ASRUnsupportedModelError,
  ModelDownloadCancelledError,
  isASRError,
  isModelDownloadCancelled,
} from './errors.ts';
export type {ASRErrorCode, ASRErrorPayload} from './errors.ts';

export {
  resolveModelCacheDir,
  validateModelCache,
  assertModelCacheReady,
} from './model-cache.ts';
export type {CacheValidation, AssetProblem} from './model-cache.ts';

export {prepareModelCache, MODEL_PROGRESS_SPECS, buildDownloadUrl} from './model-download.ts';
export type {
  ModelFetch,
  ModelFetchInit,
  ModelFetchResponse,
  ModelProgressCode,
  ModelProgressEvent,
  ModelProgressListener,
  ModelProgressStatus,
  PrepareModelCacheOptions,
  PrepareModelCacheResult,
} from './model-download.ts';

export {SenseVoiceOnnxTranscriber, senseVoiceLanguage, MAX_BLOCK_SECONDS} from './sensevoice.ts';
export type {SenseVoiceOptions} from './sensevoice.ts';

import {resolveModelCacheDir} from './model-cache.ts';
import {SenseVoiceOnnxTranscriber} from './sensevoice.ts';
import {assertSupportedModel, type SupportedAsrModel, type Transcriber} from './types.ts';

export interface CreateTranscriberOptions {
  /** 用户数据根；缓存目录按 `<root>/models/onnx` 解析，与 Rust 侧一致。 */
  dataRoot: string;
  /** 直接指定缓存目录，优先于 `dataRoot`（门禁与诊断使用）。 */
  cacheDir?: string;
  model: string;
  language?: string;
  dither?: number;
  threads?: number;
}

/**
 * worker 的模型解析处调用这一个入口。模型列表是闭集：旧标识或未知值直接拒绝，
 * 不会悄悄落到当前模型上。
 */
export async function createTranscriber(options: CreateTranscriberOptions): Promise<Transcriber> {
  const model: SupportedAsrModel = assertSupportedModel(options.model);
  const cacheDir = options.cacheDir ?? resolveModelCacheDir(options.dataRoot);
  return SenseVoiceOnnxTranscriber.create({
    cacheDir,
    language: options.language,
    dither: options.dither,
    threads: options.threads,
  });
}
