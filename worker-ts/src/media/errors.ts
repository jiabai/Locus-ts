// 媒体准备阶段的失败：本地文件与 URL 下载共用同一个类，管线只需捕获一次。
//
// 对齐 `worker/worker_core/media_preparation.py` 的 `MediaPreparationError`：
// `code` 是契约里的闭集项，`stage` 恒为视频提取期；前端按错误码给文案，
// 因此 message 只用于日志，不能拿来分流。
export type UrlMediaErrorCode =
  | 'VIDEO_DOWNLOAD_FAILED'
  | 'VIDEO_DOWNLOAD_OUTPUT_MISSING'
  | 'MEDIA_VALIDATION_FAILED'
  | 'AUDIO_EXTRACTION_FAILED';

export class MediaPreparationError extends Error {
  readonly code: string;
  readonly stage = 'video_extracting' as const;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MediaPreparationError';
    this.code = code;
  }
}
