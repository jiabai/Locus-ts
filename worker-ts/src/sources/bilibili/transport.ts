// B 站传输层：对齐 `worker/worker_core/bilibili/transport.py`。
//
// API 响应可能带 gzip/br/deflate，正文上限 4 MiB；媒体流上限 2 GiB，
// 默认 120 秒无进展即中断。Python 用 urllib + 手动解压，这里用 fetch：
// 请求头与 Python 一致地声明 Accept-Encoding，正文由 fetch 透明解压，
// 因此记录响应头时去掉 `Content-Encoding`；`decodeResponseBody` 的解压分支
// 留给直接传入压缩正文的调用方（测试夹具与自定义客户端）。
import {stat} from 'node:fs/promises';
import {gunzipSync, brotliDecompressSync, inflateRawSync, inflateSync} from 'node:zlib';

import {
  SafeDownloadError,
  dropContentEncoding,
  header,
  writeHttpResponseAtomically,
  writeHttpStreamAtomically,
} from '../../download-reliability.ts';
import type {HttpDownloadResponse} from '../../download-reliability.ts';
import {BilibiliFallbackError} from './types.ts';
import type {
  BilibiliRequestClient,
  DownloadToPathOptions,
  HttpResponse,
} from './types.ts';

export {header};

export const BILIBILI_DESKTOP_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
export const BILIBILI_REFERER = 'https://www.bilibili.com/';
export const BILIBILI_ORIGIN = 'https://www.bilibili.com';
export const BILIBILI_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const BILIBILI_MAX_STREAM_BYTES = 2 * 1024 * 1024 * 1024;
export const BILIBILI_DOWNLOAD_CHUNK_BYTES = 256 * 1024;
export const BILIBILI_NO_PROGRESS_TIMEOUT_SECONDS = 120;

export function pageHeaders(
  extra?: Readonly<Record<string, string>>,
): Record<string, string> {
  return {
    'User-Agent': BILIBILI_DESKTOP_USER_AGENT,
    Referer: BILIBILI_REFERER,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,'
      + 'image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    Connection: 'keep-alive',
    ...extra,
  };
}

export function apiHeaders(
  extra?: Readonly<Record<string, string>>,
): Record<string, string> {
  return {
    'User-Agent': BILIBILI_DESKTOP_USER_AGENT,
    Referer: BILIBILI_REFERER,
    Origin: BILIBILI_ORIGIN,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    ...extra,
  };
}

export function mediaHeaders(): Record<string, string> {
  return {
    'User-Agent': BILIBILI_DESKTOP_USER_AGENT,
    Referer: BILIBILI_REFERER,
    Origin: BILIBILI_ORIGIN,
    Accept: '*/*',
  };
}

/** 按 `Content-Encoding` 解压到文本；必须也能识别已解压的普通正文。 */
export function decodeResponseBody(
  response: HttpResponse,
  maxBytes: number = BILIBILI_MAX_RESPONSE_BYTES,
): string {
  let body: Buffer<ArrayBufferLike> = Buffer.from(response.body);
  requireBoundedBody(body, maxBytes);
  const encoding = (header(response.headers, 'Content-Encoding') ?? '')
    .split(',', 1)[0]
    .trim()
    .toLowerCase();
  try {
    if (encoding === 'gzip') {
      body = gunzipSync(body);
    } else if (encoding === 'br') {
      body = brotliDecompressSync(body);
    } else if (encoding === 'deflate') {
      try {
        body = inflateSync(body);
      } catch {
        body = inflateRawSync(body);
      }
    }
  } catch {
    throw new BilibiliFallbackError(
      'BILIBILI_VIDEO_INFO_UNAVAILABLE',
      'Bilibili response body could not be decoded.',
    );
  }
  requireBoundedBody(body, maxBytes);
  return body.toString('utf8');
}

/** 下载一条 DASH 分片；有 `downloadToPath` 就走流式，否则整块落盘。 */
export async function downloadUrlToPath(
  url: string,
  outputPath: string,
  httpClient: BilibiliRequestClient,
): Promise<number> {
  if (typeof httpClient.downloadToPath === 'function') {
    return httpClient.downloadToPath(url, outputPath, {
      headers: mediaHeaders(),
      timeoutSeconds: 30,
      maxBytes: BILIBILI_MAX_STREAM_BYTES,
      noProgressTimeoutSeconds: BILIBILI_NO_PROGRESS_TIMEOUT_SECONDS,
    });
  }
  const response = await httpClient.get(url, mediaHeaders(), 30);
  return writeHttpResponseAtomically(response, outputPath, {
    maxBytes: BILIBILI_MAX_STREAM_BYTES,
  });
}

/** `fetch` 实现：跟随重定向、保最终 URL、正文按上限截断读取。 */
export class FetchBilibiliHttpClient implements BilibiliRequestClient {
  async get(
    url: string,
    headers: Readonly<Record<string, string>> = {},
    timeoutSeconds = 10,
  ): Promise<HttpResponse> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutSeconds * 1000),
      });
    } catch {
      throw new BilibiliFallbackError(
        'BILIBILI_VIDEO_INFO_UNAVAILABLE',
        'Bilibili public API request failed.',
      );
    }
    return {
      status: response.status,
      headers: dropContentEncoding(recordHeaders(response.headers)),
      body: await readCapped(response, BILIBILI_MAX_RESPONSE_BYTES + 1),
      url: response.url,
    };
  }

  async downloadToPath(
    url: string,
    destination: string,
    options: DownloadToPathOptions = {},
  ): Promise<number> {
    const resumeFrom = await partialFileSize(destination);
    const first = await this.#attempt(url, destination, options, resumeFrom);
    if (first.ok) return first.written;
    // 服务端不接受续传时，删掉部分文件从头再来一次——与 Python 的重试条件一致。
    if (resumeFrom <= 0 || first.error.code !== 'DOWNLOAD_CONTENT_RANGE_INVALID') {
      throw first.error;
    }
    const second = await this.#attempt(url, destination, options, 0, true);
    if (second.ok) return second.written;
    throw second.error;
  }

  async #attempt(
    url: string,
    destination: string,
    options: DownloadToPathOptions,
    resumeFromBytes: number,
    bare = false,
  ): Promise<{ok: true; written: number} | {ok: false; error: SafeDownloadError}> {
    const headers: Record<string, string> = {...(options.headers ?? {})};
    if (resumeFromBytes > 0 && !bare) headers.Range = `bytes=${resumeFromBytes}-`;
    const noProgressSeconds = options.noProgressTimeoutSeconds === undefined
      || options.noProgressTimeoutSeconds === null
      ? BILIBILI_NO_PROGRESS_TIMEOUT_SECONDS
      : options.noProgressTimeoutSeconds;

    const controller = new AbortController();
    let aborted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (seconds: number): void => {
      if (timer !== undefined) clearTimeout(timer);
      if (seconds <= 0) return;
      timer = setTimeout(() => {
        aborted = true;
        controller.abort();
      }, seconds * 1000);
    };

    try {
      arm(options.timeoutSeconds ?? 30);
      const response = await fetch(url, {
        method: 'GET',
        headers,
        redirect: 'follow',
        signal: controller.signal,
      });
      const metadata: HttpDownloadResponse = {
        status: response.status,
        headers: recordHeaders(response.headers),
        body: new Uint8Array(0),
        url: response.url,
      };
      const chunks = this.#chunks(response, noProgressSeconds, arm, () => aborted);
      const written = await writeHttpStreamAtomically(metadata, chunks, destination, {
        maxBytes: options.maxBytes ?? BILIBILI_MAX_STREAM_BYTES,
        noProgressTimeoutSeconds: noProgressSeconds,
        ...(resumeFromBytes > 0 ? {resumeFromBytes} : {}),
      });
      return {ok: true, written};
    } catch (error) {
      if (error instanceof SafeDownloadError) return {ok: false, error};
      throw new BilibiliFallbackError(
        'BILIBILI_DASH_DOWNLOAD_FAILED',
        'Bilibili DASH media request failed.',
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async *#chunks(
    response: Response,
    noProgressSeconds: number,
    arm: (seconds: number) => void,
    wasAborted: () => boolean,
  ): AsyncGenerator<Uint8Array> {
    const reader = response.body?.getReader();
    if (reader === undefined) return;
    arm(noProgressSeconds);
    for (;;) {
      let chunk: {readonly done: boolean; readonly value?: Uint8Array};
      try {
        chunk = await reader.read();
      } catch (error) {
        if (wasAborted()) {
          throw new SafeDownloadError('DOWNLOAD_STALLED',
            'Download made no progress before the timeout.');
        }
        throw error;
      }
      if (chunk.done) return;
      if (chunk.value === undefined || chunk.value.length === 0) continue;
      arm(noProgressSeconds);
      yield chunk.value;
    }
  }
}

async function readCapped(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < limit) {
    const {done, value} = await reader.read();
    if (done || value === undefined) break;
    const remaining = limit - total;
    chunks.push(value.length <= remaining ? value : value.subarray(0, remaining));
    total += Math.min(value.length, remaining);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

async function partialFileSize(destination: string): Promise<number> {
  try {
    return (await stat(`${destination}.part`)).size;
  } catch {
    return 0;
  }
}

export function recordHeaders(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    const existing = header(record, key);
    record[key] = existing === null ? value : `${existing}, ${value}`;
  });
  return record;
}

function requireBoundedBody(body: Uint8Array, maxBytes: number): void {
  if (body.length > maxBytes) {
    throw new BilibiliFallbackError(
      'BILIBILI_VIDEO_INFO_UNAVAILABLE',
      'Bilibili response exceeded the safety limit.',
    );
  }
}
