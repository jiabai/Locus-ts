// B 站传输层的共享类型：对齐 `worker/worker_core/bilibili/types.py`。
//
// 错误码（`BILIBILI_*`）与字段名都是跨语言约定；DASH 选择结果把主地址与备用地址
// 分开保留，下载时按顺序尝试，失败才换下一条。
import type {DownloadProgress} from '../../download-reliability.ts';

export class BilibiliFallbackError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'BilibiliFallbackError';
    this.code = code;
  }
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly url: string;
}

export interface CommandResult {
  readonly command: readonly string[];
  readonly returncode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner = (command: readonly string[]) => Promise<CommandResult>;

export interface BilibiliParseResult {
  readonly videoId: string;
  readonly idKind: 'bvid' | 'aid';
  readonly partIndex: number;
  readonly fullUrl: string;
}

export interface BilibiliPage {
  readonly cid: number;
  readonly page: number;
  readonly part: string;
  readonly durationSeconds: number;
}

export interface BilibiliVideoInfo {
  readonly bvid: string;
  readonly aid: number;
  readonly title: string;
  readonly pages: readonly BilibiliPage[];
}

export interface BilibiliDashSelection {
  readonly videoUrl: string;
  readonly audioUrl: string;
  readonly videoBackupUrls: readonly string[];
  readonly audioBackupUrls: readonly string[];
  readonly videoCodecId: number;
  readonly quality: number;
  readonly qualityName: string;
}

export interface DownloadToPathOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutSeconds?: number;
  readonly maxBytes?: number | null;
  readonly noProgressTimeoutSeconds?: number | null;
  readonly onProgress?: DownloadProgress;
}

/** 传输层契约：页面/API 读取与媒体流下载分开，单测注入假实现。 */
export interface BilibiliRequestClient {
  get(
    url: string,
    headers?: Readonly<Record<string, string>>,
    timeoutSeconds?: number,
  ): Promise<HttpResponse>;
  downloadToPath?(
    url: string,
    destination: string,
    options?: DownloadToPathOptions,
  ): Promise<number>;
}
