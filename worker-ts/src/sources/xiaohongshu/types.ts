// 小红书传输层的共享类型：对齐 `worker/worker_core/xiaohongshu/types.py`。
//
// 错误码（`XHS_*`）是宿主与日志的约定；候选流、字幕轨与响应的字段名照抄
// Python，跨语言基准才能逐项比对。
import type {DownloadProgress} from '../../download-reliability.ts';

export class XiaohongshuFallbackError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'XiaohongshuFallbackError';
    this.code = code;
  }
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly url: string;
}

export interface XiaohongshuParseResult {
  readonly noteId: string;
  readonly fullUrl: string;
  readonly xsecToken: string;
}

export interface XiaohongshuStreamCandidate {
  readonly qualityKey: string;
  readonly url: string;
  readonly sizeBytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly backupUrls: readonly string[];
  readonly videoCodec: string;
  readonly videoBitrate: number;
  readonly streamType: number;
  readonly weight: number;
  readonly defaultStream: number;
  readonly headers: Readonly<Record<string, string>>;
}

export interface XiaohongshuSubtitleTrack {
  readonly language: string;
  readonly url: string;
  readonly suffix: string;
}

export interface DownloadToPathOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutSeconds?: number;
  readonly maxBytes?: number | null;
  readonly noProgressTimeoutSeconds?: number | null;
  readonly allowedContentTypes?: readonly string[] | null;
  readonly allowedHostSuffixes?: readonly string[] | null;
  readonly resumeFromBytes?: number;
  readonly totalBytes?: number | null;
  readonly onProgress?: DownloadProgress;
}

/** 传输层契约：页面读取与流下载分开注入，单测不需要真实网络。 */
export interface XiaohongshuHttpClient {
  get(
    url: string,
    headers?: Readonly<Record<string, string>>,
    timeoutSeconds?: number,
  ): Promise<HttpResponse>;
  downloadToPath(
    url: string,
    destination: string,
    options?: DownloadToPathOptions,
  ): Promise<number>;
}
