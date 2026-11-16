// 小红书传输层：对齐 `worker/worker_core/xiaohongshu/transport.py`。
//
// 页面 GET 与媒体流走同一个客户端实例：页面会种 Cookie（未登录状态的 a1/websectiga 等），
// 媒体请求要带上；流下载带 Range 续传，服务端忽略续传时删掉部分文件重下一次。
// Python 用 `urllib` + `CookieJar`；这里用 `fetch`，Cookie 只按主机名存取。
import {rm, stat} from 'node:fs/promises';

import {
  SafeDownloadError,
  dropContentEncoding,
  header,
  writeHttpStreamAtomically,
} from '../../download-reliability.ts';
import type {HttpDownloadResponse} from '../../download-reliability.ts';
import {isAllowedSubtitleUrl} from './subtitles.ts';
import {XiaohongshuFallbackError} from './types.ts';
import type {
  DownloadToPathOptions,
  HttpResponse,
  XiaohongshuHttpClient,
} from './types.ts';
import {splitUrl} from './url.ts';

export const XHS_DESKTOP_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
export const XHS_REFERER = 'https://www.xiaohongshu.com/';
export const XHS_MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
export const XHS_DOWNLOAD_CHUNK_BYTES = 256 * 1024;
export const XHS_NO_PROGRESS_TIMEOUT_SECONDS = 120;
export const XHS_MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;
export const XHS_SUBTITLE_CONTENT_TYPES = [
  'application/x-subrip',
  'application/srt',
  'text/plain',
  'text/vtt',
  'application/octet-stream',
] as const;
export const XHS_SUBTITLE_HOST_SUFFIXES = ['xhscdn.com', 'xiaohongshu.com'] as const;

const PAGE_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,'
  + 'image/avif,image/webp,image/apng,*/*;q=0.8';

export function pageHeaders(
  extra?: Readonly<Record<string, string>>,
): Record<string, string> {
  return {
    'User-Agent': XHS_DESKTOP_USER_AGENT,
    Referer: XHS_REFERER,
    Accept: PAGE_ACCEPT,
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    Connection: 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Cache-Control': 'max-age=0',
    ...extra,
  };
}

export function mediaHeaders(): Record<string, string> {
  return {
    'User-Agent': XHS_DESKTOP_USER_AGENT,
    Referer: XHS_REFERER,
    Accept: '*/*',
  };
}

/** 视频流：2 GiB 上限、30 秒连接超时、120 秒无进展判停滞。 */
export async function downloadStreamToPath(
  streamUrl: string,
  outputPath: string,
  httpClient: XiaohongshuHttpClient,
): Promise<number> {
  return httpClient.downloadToPath(streamUrl, outputPath, {
    headers: mediaHeaders(),
    timeoutSeconds: 30,
    maxBytes: XHS_MAX_VIDEO_BYTES,
    noProgressTimeoutSeconds: XHS_NO_PROGRESS_TIMEOUT_SECONDS,
  });
}

/** 字幕：只允许小红书 CDN/主站，正文上限 2 MiB。 */
export async function downloadSubtitleToPath(
  subtitleUrl: string,
  outputPath: string,
  httpClient: XiaohongshuHttpClient,
): Promise<number> {
  if (!isAllowedSubtitleUrl(subtitleUrl)) {
    throw new SafeDownloadError('DOWNLOAD_URL_INVALID', 'Subtitle URL is not allowed.');
  }
  return httpClient.downloadToPath(subtitleUrl, outputPath, {
    headers: mediaHeaders(),
    timeoutSeconds: 20,
    maxBytes: XHS_MAX_SUBTITLE_BYTES,
    noProgressTimeoutSeconds: 30,
    allowedContentTypes: XHS_SUBTITLE_CONTENT_TYPES,
    allowedHostSuffixes: XHS_SUBTITLE_HOST_SUFFIXES,
  });
}

export function mapDownloadError(error: unknown): XiaohongshuFallbackError {
  if (error instanceof SafeDownloadError) {
    if (error.code === 'DOWNLOAD_SIZE_EXCEEDED') {
      return new XiaohongshuFallbackError(
        'XHS_VIDEO_TOO_LARGE',
        'Xiaohongshu video exceeded the configured size limit.',
      );
    }
    if (error.code === 'DOWNLOAD_STALLED') {
      return new XiaohongshuFallbackError(
        'XHS_DOWNLOAD_STALLED',
        'Xiaohongshu video download stalled.',
      );
    }
  }
  return new XiaohongshuFallbackError(
    'XHS_STREAM_DOWNLOAD_FAILED',
    'All Xiaohongshu fallback streams failed to download.',
  );
}

/** 单个候选失败可继续试下一个；参数错误之类的编程错误必须原样抛出。 */
export function isDownloadAttemptError(error: unknown): boolean {
  if (error instanceof SafeDownloadError) return true;
  if (error instanceof XiaohongshuFallbackError) return true;
  return isSystemError(error);
}

function isSystemError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const code = (error as {code?: unknown}).code;
  return typeof code === 'string' && /^E[A-Z0-9]+$/u.test(code);
}

/** `fetch` 实现：跟随重定向，保留最终 URL，按主机记忆 Cookie。 */
export class FetchXiaohongshuHttpClient implements XiaohongshuHttpClient {
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
      throw new XiaohongshuFallbackError(
        'XHS_PAGE_UNAVAILABLE',
        'Xiaohongshu public page request failed.',
      );
    }
    this.#rememberCookies(response);
    const body = new Uint8Array(await response.arrayBuffer());
    return {
      status: response.status,
      headers: dropContentEncoding(recordHeaders(response.headers)),
      body,
      url: response.url,
    };
  }

  async downloadToPath(
    url: string,
    destination: string,
    options: DownloadToPathOptions = {},
  ): Promise<number> {
    const resumeFrom = await partialFileSize(destination);
    const headers: Record<string, string> = {...options.headers};
    if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`;
    try {
      return await this.#attempt(url, destination, options, headers, resumeFrom);
    } catch (error) {
      if (!(error instanceof SafeDownloadError) || resumeFrom <= 0
        || error.code !== 'DOWNLOAD_CONTENT_RANGE_INVALID') {
        throw error;
      }
      // 服务端不认续传：丢掉部分文件，从头再来一次（与 Python 完全一致）。
      await rm(`${destination}.part`, {force: true});
      return this.#attempt(url, destination, options, {...options.headers}, 0);
    }
  }

  async #attempt(
    url: string,
    destination: string,
    options: DownloadToPathOptions,
    headers: Readonly<Record<string, string>>,
    resumeFrom: number,
  ): Promise<number> {
    const suffixes = options.allowedHostSuffixes ?? null;
    if (suffixes !== null && !isAllowedHttpsHost(url, suffixes)) {
      throw new SafeDownloadError('DOWNLOAD_URL_INVALID', 'Download URL host is not allowed.');
    }

    const timeoutSeconds = options.timeoutSeconds ?? 30;
    const noProgressSeconds = options.noProgressTimeoutSeconds ?? XHS_NO_PROGRESS_TIMEOUT_SECONDS;
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
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'GET',
          headers: this.#requestHeaders(url, headers),
          redirect: 'follow',
          signal: controller.signal,
        });
      } catch {
        throw new XiaohongshuFallbackError(
          'XHS_STREAM_DOWNLOAD_FAILED',
          'Xiaohongshu media stream request failed.',
        );
      }
      this.#rememberCookies(response);
      if (suffixes !== null && !isAllowedHttpsHost(response.url, suffixes)) {
        throw new SafeDownloadError(
          'DOWNLOAD_URL_INVALID',
          'Download response host is not allowed.',
        );
      }

      const metadata: HttpDownloadResponse = {
        status: response.status,
        headers: recordHeaders(response.headers),
        body: new Uint8Array(0),
        url: response.url,
      };
      return await writeHttpStreamAtomically(
        metadata,
        this.#streamChunks(response, noProgressSeconds, arm, () => aborted, options),
        destination,
        {
          noProgressTimeoutSeconds: noProgressSeconds,
          ...(options.maxBytes === undefined || options.maxBytes === null
            ? {}
            : {maxBytes: options.maxBytes}),
          ...(options.allowedContentTypes === undefined
            || options.allowedContentTypes === null
            ? {}
            : {allowedContentTypes: options.allowedContentTypes}),
          ...(resumeFrom > 0 ? {resumeFromBytes: resumeFrom} : {}),
        },
      );
    } catch (error) {
      if (error instanceof SafeDownloadError || error instanceof XiaohongshuFallbackError) {
        throw error;
      }
      throw new XiaohongshuFallbackError(
        'XHS_STREAM_DOWNLOAD_FAILED',
        'Xiaohongshu media stream request failed.',
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async *#streamChunks(
    response: Response,
    noProgressSeconds: number,
    arm: (seconds: number) => void,
    wasAborted: () => boolean,
    options: DownloadToPathOptions,
  ): AsyncGenerator<Uint8Array> {
    let emitted = options.resumeFromBytes ?? 0;
    const reader = response.body?.getReader();
    if (reader === undefined) return;
    arm(noProgressSeconds);
    for (;;) {
      let chunk: {readonly done: boolean; readonly value?: Uint8Array};
      try {
        chunk = await reader.read();
      } catch (error) {
        // 看门狗掐断按可续传的停滞处理，部分文件留给下一次续传。
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
      options.onProgress?.(emitted, options.totalBytes ?? emitted);
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
      result.Cookie = [...cookies.entries()]
        .map(([name, value]) => `${name}=${value}`)
        .join('; ');
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

/** 响应头转普通对象；同名多值用 `, ` 合并，取头时仍大小写不敏感。 */
export function recordHeaders(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    const existing = header(record, key);
    record[key] = existing === null ? value : `${existing}, ${value}`;
  });
  return record;
}

function readSetCookies(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & {getSetCookie?: () => string[]};
  if (typeof withGetSetCookie.getSetCookie === 'function') {
    return withGetSetCookie.getSetCookie();
  }
  const single = headers.get('set-cookie');
  return single === null ? [] : [single];
}

function hostnameOf(url: string): string {
  return (splitUrl(url).hostname ?? '').toLowerCase();
}

async function partialFileSize(destination: string): Promise<number> {
  try {
    return (await stat(`${destination}.part`)).size;
  } catch {
    return 0;
  }
}

function isAllowedHttpsHost(url: string, suffixes: readonly string[]): boolean {
  const parsed = splitUrl(url);
  if (parsed.scheme !== 'https' || parsed.hostname === null) return false;
  if (parsed.username !== null || parsed.password !== null) return false;
  const host = parsed.hostname.replace(/\.+$/u, '').toLowerCase();
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}
