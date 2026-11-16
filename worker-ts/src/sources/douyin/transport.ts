// 抖音传输层：对齐 `worker/worker_core/douyin/transport.py`。
//
// 两条路径共用同一个客户端实例：分享页与播放地址的 GET 走 Cookie 记忆，
// 媒体流走带续传的流式落盘。Python 用 `urllib` + `CookieJar`；这里用 `fetch`，
// Cookie 只按主机名存取（不区分 path/过期），差异仅影响跨路径同名的罕见情形，
// 不改变解析与失败语义。
import {mkdir, rm, stat} from 'node:fs/promises';
import path from 'node:path';

import {
  RESUMABLE_DOWNLOAD_ERROR_CODES,
  SafeDownloadError,
  header,
  writeHttpStreamAtomically,
} from '../../download-reliability.ts';
import type {HttpDownloadResponse} from '../../download-reliability.ts';
import {
  DouyinFallbackError,
} from './types.ts';
import type {
  DouyinHttpClient,
  DouyinStreamCandidate,
  DownloadToPathOptions,
  HttpResponse,
} from './types.ts';

export const DOUYIN_MOBILE_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) '
  + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1';
export const DOUYIN_DOWNLOAD_CHUNK_BYTES = 256 * 1024;
export const DOUYIN_NO_PROGRESS_TIMEOUT_SECONDS = 60;
export const DOUYIN_STREAM_SOCKET_TIMEOUT_SECONDS = 15;

export type CandidateFailed = (failedIndex: number, total: number) => void;

/** 页面与流请求共用的公开头；与 Python `public_headers` 逐字段一致。 */
export function publicHeaders(
  extra?: Readonly<Record<string, string>>,
): Record<string, string> {
  return {
    'User-Agent': DOUYIN_MOBILE_USER_AGENT,
    Accept: '*/*',
    Referer: 'https://www.iesdouyin.com/',
    ...extra,
  };
}

/** 已声明的总大小内才续传；越界或读不到的部分文件直接丢弃。 */
export async function resumablePartSize(
  partPath: string,
  declaredTotal: number,
): Promise<number> {
  let size: number;
  try {
    size = (await stat(partPath)).size;
  } catch {
    return 0;
  }
  if (size <= 0 || size >= declaredTotal) {
    if (size > 0) await rm(partPath, {force: true});
    return 0;
  }
  return size;
}

/**
 * 按顺序尝试候选流：每个候选最多两次（原始下载 + 用部分文件续传一次）。
 * 只有「还有别的候选」且这次确实失败时才报重试事件。
 */
export async function downloadOrderedCandidates(
  awemeId: string,
  candidates: readonly DouyinStreamCandidate[],
  outputDir: string,
  httpClient: DouyinHttpClient,
  timeoutSeconds: number = DOUYIN_STREAM_SOCKET_TIMEOUT_SECONDS,
  onCandidateFailed?: CandidateFailed,
  onProgress?: (downloadedBytes: number, totalBytes: number) => void,
): Promise<string> {
  await mkdir(outputDir, {recursive: true});
  const outputPath = path.join(outputDir, `${awemeId}.mp4`);
  const partPath = `${outputPath}.part`;
  let lastError: unknown = null;
  const total = candidates.length;

  for (const [index, candidate] of candidates.entries()) {
    let failed = false;
    for (const attempt of [1, 2]) {
      try {
        await httpClient.downloadToPath(candidate.url, outputPath, {
          headers: candidate.headers,
          timeoutSeconds,
          noProgressTimeoutSeconds: DOUYIN_NO_PROGRESS_TIMEOUT_SECONDS,
          resumeFromBytes: await resumablePartSize(partPath, candidate.sizeBytes),
          totalBytes: candidate.sizeBytes,
          ...(onProgress === undefined ? {} : {onProgress}),
        });
        return outputPath;
      } catch (error) {
        lastError = error;
        if (attempt === 1 && error instanceof SafeDownloadError
          && RESUMABLE_DOWNLOAD_ERROR_CODES.has(error.code)) {
          continue;
        }
        await rm(partPath, {force: true});
        failed = true;
        break;
      }
    }
    if (failed && onCandidateFailed !== undefined && index < total - 1) {
      onCandidateFailed(index, total);
    }
  }

  throw new DouyinFallbackError(
    'DOUYIN_STREAM_DOWNLOAD_FAILED',
    'All Douyin fallback streams failed to download.',
  );
}

/** `fetch` 实现：跟随重定向，保留最终 URL，按主机记忆 Cookie。 */
export class FetchDouyinHttpClient implements DouyinHttpClient {
  readonly #cookies = new Map<string, Map<string, string>>();

  async get(
    url: string,
    headers: Readonly<Record<string, string>> = {},
    timeoutSeconds = 10,
  ): Promise<HttpResponse> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: this.#requestHeaders(url, headers),
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutSeconds * 1000),
      });
    } catch {
      throw new DouyinFallbackError(
        'DOUYIN_SHARE_PAGE_UNAVAILABLE',
        'Douyin public share page request failed.',
      );
    }
    this.#rememberCookies(response);
    const body = new Uint8Array(await response.arrayBuffer());
    return {
      status: response.status,
      headers: recordHeaders(response.headers),
      body,
      url: response.url,
    };
  }

  async downloadToPath(
    url: string,
    destination: string,
    options: DownloadToPathOptions = {},
  ): Promise<number> {
    const timeoutSeconds = options.timeoutSeconds ?? DOUYIN_STREAM_SOCKET_TIMEOUT_SECONDS;
    const noProgressSeconds = options.noProgressTimeoutSeconds ?? DOUYIN_NO_PROGRESS_TIMEOUT_SECONDS;
    const resumeFromBytes = options.resumeFromBytes ?? 0;
    const totalBytes = options.totalBytes ?? null;
    const requestHeaders: Record<string, string> = {
      ...this.#requestHeaders(url, options.headers ?? {}),
    };
    if (resumeFromBytes > 0) requestHeaders.Range = `bytes=${resumeFromBytes}-`;

    const controller = new AbortController();
    let aborted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (seconds: number): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        aborted = true;
        controller.abort();
      }, seconds * 1000);
    };

    try {
      arm(timeoutSeconds);
      const response = await fetch(url, {
        method: 'GET',
        headers: requestHeaders,
        redirect: 'follow',
        signal: controller.signal,
      });
      this.#rememberCookies(response);
      const metadata: HttpDownloadResponse = {
        status: response.status,
        headers: recordHeaders(response.headers),
        body: new Uint8Array(0),
        url: response.url,
      };
      const chunks = this.#streamChunks(
        response,
        resumeFromBytes,
        totalBytes,
        noProgressSeconds,
        arm,
        () => aborted,
        options.onProgress,
      );
      return await writeHttpStreamAtomically(metadata, chunks, destination, {
        noProgressTimeoutSeconds: noProgressSeconds,
        ...(resumeFromBytes > 0 ? {resumeFromBytes} : {}),
      });
    } catch (error) {
      if (error instanceof SafeDownloadError) throw error;
      throw new DouyinFallbackError(
        'DOUYIN_STREAM_DOWNLOAD_FAILED',
        'Douyin media stream request failed.',
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async *#streamChunks(
    response: Response,
    resumeFromBytes: number,
    totalBytes: number | null,
    noProgressSeconds: number,
    arm: (seconds: number) => void,
    wasAborted: () => boolean,
    onProgress?: (downloadedBytes: number, totalBytes: number) => void,
  ): AsyncGenerator<Uint8Array> {
    let emitted = resumeFromBytes;
    const reader = response.body?.getReader();
    if (reader === undefined) return;
    arm(noProgressSeconds);
    for (;;) {
      let chunk: {readonly done: boolean; readonly value?: Uint8Array};
      try {
        chunk = await reader.read();
      } catch (error) {
        // 看门狗掐断时按可续传的停滞处理，保住已写入的部分文件。
        if (wasAborted()) {
          throw new SafeDownloadError('DOWNLOAD_STALLED',
            'Download made no progress before the timeout.');
        }
        throw error;
      }
      if (chunk.done) return;
      const value = chunk.value;
      if (value === undefined || value.length === 0) continue;
      arm(noProgressSeconds);
      emitted += value.length;
      onProgress?.(emitted, totalBytes ?? emitted);
      yield value;
    }
  }

  #requestHeaders(
    url: string,
    headers: Readonly<Record<string, string>>,
  ): Record<string, string> {
    const result = {...headers};
    const cookies = this.#cookies.get(hostnameOf(url));
    if (cookies !== undefined && cookies.size > 0) {
      result.Cookie = [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
    }
    return result;
  }

  #rememberCookies(response: Response): void {
    const setCookies = readSetCookies(response.headers);
    if (setCookies.length === 0) return;
    const host = hostnameOf(response.url);
    if (host === '') return;
    let jar = this.#cookies.get(host);
    if (jar === undefined) {
      jar = new Map();
      this.#cookies.set(host, jar);
    }
    for (const value of setCookies) {
      const pair = value.split(';', 1)[0];
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      jar.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    }
  }
}

function readSetCookies(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & {getSetCookie?: () => string[]};
  if (typeof withGetSetCookie.getSetCookie === 'function') {
    return withGetSetCookie.getSetCookie();
  }
  const single = headers.get('set-cookie');
  return single === null ? [] : [single];
}

/** 响应头转普通对象；同名多值用 `, ` 合并，取头时仍大小写不敏感。 */
export function recordHeaders(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    const existing = header(record, key);
    record[key] = existing === null ? value : `${existing}, ${value}`;
  });
  return record;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}
