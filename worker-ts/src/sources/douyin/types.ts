// 抖音传输层的共享类型：对齐 `worker/worker_core/douyin/types.py`。
//
// 错误码是宿主与日志的约定（`DOUYIN_*`），新增或改名都算契约变更；
// 候选流与响应的字段名也照抄 Python，便于跨语言基准逐项比对。
import type {DownloadProgress} from '../../download-reliability.ts';

export class DouyinFallbackError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DouyinFallbackError';
    this.code = code;
  }
}

export interface DouyinStreamCandidate {
  readonly quality: string;
  readonly url: string;
  readonly sizeBytes: number;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly headers: Readonly<Record<string, string>>;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly url: string;
}

export interface DownloadToPathOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutSeconds?: number;
  readonly noProgressTimeoutSeconds?: number;
  readonly resumeFromBytes?: number;
  readonly totalBytes?: number | null;
  readonly onProgress?: DownloadProgress;
}

/** 传输层契约：页面读取与流下载分开注入，单测不需要真实网络。 */
export interface DouyinHttpClient {
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
