// 稳定错误语义。错误码沿用现有 Python 侧与 worker 契约，不新造码，
// 否则前端与 Rust 的错误分支会分叉。
export const ASR_ERROR_CODES = {
  base: 'ASR_ERROR',
  dependencyMissing: 'ASR_DEPENDENCY_MISSING',
  runtimeError: 'ASR_RUNTIME_ERROR',
  emptyTranscript: 'ASR_EMPTY_TRANSCRIPT',
  modelUnsupported: 'ASR_MODEL_UNSUPPORTED',
  modelNotDownloaded: 'ASR_MODEL_NOT_DOWNLOADED',
  modelCacheUnavailable: 'ASR_MODEL_CACHE_UNAVAILABLE',
  modelDownloadFailed: 'ASR_MODEL_DOWNLOAD_FAILED',
  modelArchiveInvalid: 'ASR_MODEL_ARCHIVE_INVALID',
} as const;

export type ASRErrorCode = (typeof ASR_ERROR_CODES)[keyof typeof ASR_ERROR_CODES];

export interface ASRErrorPayload {
  readonly code: ASRErrorCode;
  readonly message: string;
  /** 诊断用的附加信息，不进入面向用户的文案。 */
  readonly detail?: string;
}

export class ASRError extends Error {
  readonly code: ASRErrorCode;
  readonly detail: string | undefined;

  constructor(code: ASRErrorCode, message: string, detail?: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.detail = detail;
  }

  toJSON(): ASRErrorPayload {
    return this.detail === undefined
      ? {code: this.code, message: this.message}
      : {code: this.code, message: this.message, detail: this.detail};
  }
}

/** onnxruntime 缺失或原生模块无法加载。 */
export class ASRDependencyError extends ASRError {
  constructor(message: string, detail?: string) {
    super(ASR_ERROR_CODES.dependencyMissing, message, detail);
  }
}

export class ASRRuntimeError extends ASRError {
  constructor(message: string, detail?: string) {
    super(ASR_ERROR_CODES.runtimeError, message, detail);
  }
}

/** 没有检测到语音，或识别结果为空。 */
export class ASREmptyTranscriptError extends ASRError {
  constructor(message = 'ONNX VAD detected no speech.', detail?: string) {
    super(ASR_ERROR_CODES.emptyTranscript, message, detail);
  }
}

export class ASRUnsupportedModelError extends ASRError {
  constructor(message: string, detail?: string) {
    super(ASR_ERROR_CODES.modelUnsupported, message, detail);
  }
}

/**
 * 模型缓存未通过完整性校验：文件缺失、哈希不符或就绪标记不匹配。
 * 与 Python 侧一致，损坏的缓存按「尚未下载」处理，不能当成可用缓存。
 */
export class ASRModelNotDownloadedError extends ASRError {
  constructor(message: string, detail?: string) {
    super(ASR_ERROR_CODES.modelNotDownloaded, message, detail);
  }
}

export class ASRModelCacheUnavailableError extends ASRError {
  constructor(message: string, detail?: string) {
    super(ASR_ERROR_CODES.modelCacheUnavailable, message, detail);
  }
}

/** 下载态失败：网络、HTTP 状态、磁盘空间。缓存未就绪，不能当成功处理。 */
export class ASRModelDownloadFailedError extends ASRError {
  constructor(message: string, detail?: string) {
    super(ASR_ERROR_CODES.modelDownloadFailed, message, detail);
  }
}

/** 下载到的内容不对：哈希不符、文件缺失、体积超限。 */
export class ASRModelArchiveInvalidError extends ASRError {
  constructor(message: string, detail?: string) {
    super(ASR_ERROR_CODES.modelArchiveInvalid, message, detail);
  }
}

/**
 * 取消不是失败码：宿主以终止完整进程树为准，模块内用 `name === 'AbortError'`
 * 的错误离开，调用方据此发出 `model.download.cancelled` 之外的收尾动作。
 */
export class ModelDownloadCancelledError extends Error {
  constructor(message = 'ASR model download was cancelled.') {
    super(message);
    this.name = 'AbortError';
  }
}

export function isModelDownloadCancelled(error: unknown): boolean {
  return error instanceof ModelDownloadCancelledError
    || (error instanceof Error && error.name === 'AbortError');
}

export function isASRError(error: unknown): error is ASRError {
  return error instanceof ASRError;
}
