// 可靠下载：复现 `worker/worker_core/download_reliability.py`。
//
// 所有平台传输共用的最后一道把关：状态码、Content-Range、Content-Type、
// 声明大小与实际写入量都要对得上；写盘先落 `.part` 再原子改名，中断时按错误码
// 决定是否保留部分文件供续传。判定顺序与文案逐条对齐 Python，宿主看到的是同一组
// `DOWNLOAD_*` 码。
import {open, mkdir, rename, rm, stat} from 'node:fs/promises';
import path from 'node:path';

const CONTENT_RANGE_PATTERN = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)\s*$/iu;
const CONTENT_RANGE_TOTAL_PATTERN = /\/(\d+)\s*$/u;

/** 允许的媒体类型；`video/` 按前缀匹配，其余按全等。 */
export const VIDEO_CONTENT_TYPES: readonly string[] = ['video/', 'application/octet-stream'];

/** 断流与提前结束都会留下有效的部分字节，供同一路径的续传重试复用。 */
export const RESUMABLE_DOWNLOAD_ERROR_CODES: ReadonlySet<string> = new Set([
  'DOWNLOAD_STALLED',
  'DOWNLOAD_INCOMPLETE',
]);

export class SafeDownloadError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SafeDownloadError';
    this.code = code;
  }
}

export interface HttpDownloadResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly url: string;
}

export type DownloadProgress = (downloadedBytes: number, totalBytes: number) => void;

export interface WriteResponseOptions {
  readonly maxBytes?: number | null;
  readonly allowedContentTypes?: readonly string[];
}

export interface WriteStreamOptions extends WriteResponseOptions {
  readonly noProgressTimeoutSeconds?: number | null;
  /** 注入单调时钟（秒），只用于测试停滞判定。 */
  readonly monotonic?: () => number;
  readonly resumeFromBytes?: number;
}

const defaultMonotonic = (): number => performance.now() / 1000;

/** 一次性响应体落盘；校验不过就不碰目标文件。 */
export async function writeHttpResponseAtomically(
  response: HttpDownloadResponse,
  destination: string,
  options: WriteResponseOptions = {},
): Promise<number> {
  validateResponse(response, options.maxBytes ?? null,
    options.allowedContentTypes ?? VIDEO_CONTENT_TYPES);

  await mkdir(path.dirname(destination), {recursive: true});
  const partPath = `${destination}.part`;
  try {
    await rm(partPath, {force: true});
    await writeAll(partPath, response.body);
    await rename(partPath, destination);
  } catch (error) {
    await rm(partPath, {force: true});
    throw error;
  }
  return response.body.length;
}

/** 流式响应体落盘；续传、停滞与声明大小都按 Python 的判定顺序处理。 */
export async function writeHttpStreamAtomically(
  response: HttpDownloadResponse,
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  destination: string,
  options: WriteStreamOptions = {},
): Promise<number> {
  const resumeFromBytes = options.resumeFromBytes ?? 0;
  const maxBytes = options.maxBytes ?? null;
  const noProgressTimeoutSeconds = options.noProgressTimeoutSeconds ?? null;
  const monotonic = options.monotonic ?? defaultMonotonic;

  validateResponseHeaders(response, {
    maxBytes,
    allowedContentTypes: options.allowedContentTypes ?? VIDEO_CONTENT_TYPES,
    resumeFromBytes,
  });

  await mkdir(path.dirname(destination), {recursive: true});
  const partPath = `${destination}.part`;
  let written = resumeFromBytes;
  let lastProgressAt = monotonic();
  const handle = await openForWrite(partPath, resumeFromBytes);
  try {
    for await (const chunk of chunks) {
      const now = monotonic();
      if (noProgressTimeoutSeconds !== null && noProgressTimeoutSeconds > 0
        && now - lastProgressAt > noProgressTimeoutSeconds) {
        throw new SafeDownloadError('DOWNLOAD_STALLED', 'Download made no progress before the timeout.');
      }
      if (chunk.length === 0) continue;
      written += chunk.length;
      if (maxBytes !== null && maxBytes > 0 && written > maxBytes) {
        throw new SafeDownloadError('DOWNLOAD_SIZE_EXCEEDED',
          'Download response exceeds the configured size limit.');
      }
      await handle.write(chunk);
      lastProgressAt = now;
    }
    await handle.close();
    if (written <= resumeFromBytes) {
      throw new SafeDownloadError('DOWNLOAD_EMPTY_BODY', 'Download response body is empty.');
    }
    const declaredSize = declaredSizeOf(response.headers);
    if (declaredSize !== null && written !== declaredSize) {
      throw new SafeDownloadError('DOWNLOAD_INCOMPLETE',
        'Download response ended before the declared size.');
    }
    await rename(partPath, destination);
  } catch (error) {
    // 已关闭的文件句柄再 close 一次是幂等的；未关闭时这里负责兜底。
    await handle.close().catch(() => undefined);
    if (!(error instanceof SafeDownloadError) || !RESUMABLE_DOWNLOAD_ERROR_CODES.has(error.code)) {
      await rm(partPath, {force: true});
    }
    throw error;
  }
  return written;
}

async function openForWrite(partPath: string, resumeFromBytes: number): Promise<FileHandleLike> {
  if (resumeFromBytes > 0) {
    let existing: number;
    try {
      existing = (await stat(partPath)).size;
    } catch {
      throw new SafeDownloadError('DOWNLOAD_RESUME_INVALID',
        'Partial download file does not match the expected resume offset.');
    }
    if (existing !== resumeFromBytes) {
      throw new SafeDownloadError('DOWNLOAD_RESUME_INVALID',
        'Partial download file does not match the expected resume offset.');
    }
    return open(partPath, 'a');
  }
  await rm(partPath, {force: true});
  return open(partPath, 'w');
}

interface FileHandleLike {
  write(chunk: Uint8Array): Promise<unknown>;
  close(): Promise<void>;
}

async function writeAll(target: string, body: Uint8Array): Promise<void> {
  const handle = await open(target, 'w');
  try {
    await handle.write(body);
  } finally {
    await handle.close();
  }
}

function validateResponse(
  response: HttpDownloadResponse,
  maxBytes: number | null,
  allowedContentTypes: readonly string[],
): void {
  validateResponseHeaders(response, {maxBytes, allowedContentTypes, resumeFromBytes: 0});
  if (response.body.length === 0) {
    throw new SafeDownloadError('DOWNLOAD_EMPTY_BODY', 'Download response body is empty.');
  }
  const totalSize = declaredSizeOf(response.headers) ?? response.body.length;
  if (totalSize <= 0) {
    throw new SafeDownloadError('DOWNLOAD_SIZE_INVALID', 'Download response size is invalid.');
  }
  if (maxBytes !== null && maxBytes > 0
    && (totalSize > maxBytes || response.body.length > maxBytes)) {
    throw new SafeDownloadError('DOWNLOAD_SIZE_EXCEEDED',
      'Download response exceeds the configured size limit.');
  }
}

function validateResponseHeaders(
  response: HttpDownloadResponse,
  options: {
    readonly maxBytes: number | null;
    readonly allowedContentTypes: readonly string[];
    readonly resumeFromBytes: number;
  },
): void {
  const {maxBytes, allowedContentTypes, resumeFromBytes} = options;
  if (response.status !== 200 && response.status !== 206) {
    throw new SafeDownloadError('DOWNLOAD_HTTP_STATUS_INVALID',
      `Unexpected HTTP status: ${response.status}`);
  }
  if (response.status === 206 && contentRangeTotal(response.headers) === null) {
    throw new SafeDownloadError('DOWNLOAD_CONTENT_RANGE_INVALID',
      'Partial download response must include a valid Content-Range total.');
  }
  if (resumeFromBytes > 0
    && (response.status !== 206 || contentRangeStart(response.headers) !== resumeFromBytes)) {
    throw new SafeDownloadError('DOWNLOAD_CONTENT_RANGE_INVALID',
      'Resume response must start at the existing partial file size.');
  }
  const contentType = header(response.headers, 'Content-Type');
  if (contentType !== null && !isAllowedContentType(contentType, allowedContentTypes)) {
    throw new SafeDownloadError('DOWNLOAD_CONTENT_TYPE_INVALID',
      'Download response returned a non-media content type.');
  }
  const declaredSize = declaredSizeOf(response.headers);
  if (declaredSize !== null && maxBytes !== null && maxBytes > 0 && declaredSize > maxBytes) {
    throw new SafeDownloadError('DOWNLOAD_SIZE_EXCEEDED',
      'Download response exceeds the configured size limit.');
  }
}

function declaredSizeOf(headers: Readonly<Record<string, string>>): number | null {
  return contentRangeTotal(headers) ?? parsePositiveInt(header(headers, 'Content-Length'));
}

function contentRangeTotal(headers: Readonly<Record<string, string>>): number | null {
  const contentRange = header(headers, 'Content-Range');
  if (contentRange === null) return null;
  const match = CONTENT_RANGE_TOTAL_PATTERN.exec(contentRange);
  if (match === null) return null;
  return parsePositiveInt(match[1]);
}

function contentRangeStart(headers: Readonly<Record<string, string>>): number | null {
  const contentRange = header(headers, 'Content-Range');
  if (contentRange === null) return null;
  const match = CONTENT_RANGE_PATTERN.exec(contentRange.trim());
  if (match === null) return null;
  return parsePositiveInt(match[1]);
}

function isAllowedContentType(
  contentType: string,
  allowedContentTypes: readonly string[],
): boolean {
  const normalized = contentType.split(';', 1)[0].trim().toLowerCase();
  return allowedContentTypes.some((allowed) =>
    allowed.endsWith('/')
      ? normalized.startsWith(allowed.slice(0, -1))
      : normalized === allowed);
}

/** 头名大小写不敏感；同名多值时取第一个命中，与 Python 的 `_header` 一致。 */
export function header(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | null {
  const lowered = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowered) return value;
  }
  return null;
}

/**
 * `fetch` 读取正文时已经按 `Content-Encoding` 解压，响应头却保留压缩方式。
 * 记录响应头时删掉这一项，避免上层对已解压的正文再解一次。
 * 依据：Node 22.22.2 的 undici 与 Deno 2.9.1 都表现为「正文已解压、头保持原样」。
 */
export function dropContentEncoding(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'content-encoding') result[key] = value;
  }
  return result;
}

function parsePositiveInt(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  // 只认十进制正整数（允许前导 `+`）；`Content-Length: 5.0` 这类值按无法解析处理。
  if (!/^\+?\d+$/u.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed.replace(/^\+/u, ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
