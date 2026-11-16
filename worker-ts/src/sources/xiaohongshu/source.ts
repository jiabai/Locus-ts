// 小红书输入解析：对齐 `worker/worker_core/xiaohongshu/source.py`。
//
// 先认 24 位十六进制笔记 ID，再从文本里挑小红书链接；`xhslink.com` 短链最多
// 展开 5 层，http 失败会换 https 再试。域名不接受非小红书主机——短链跳到
// 外站时按 `XHS_URL_INVALID` 明确拒绝，而不是把外站地址当成笔记。
import {decodeHTML} from 'entities';

import {header} from '../../download-reliability.ts';
import {stripPythonSpace} from '../../protocol/process-request.ts';
import {decodeResponseBody} from './page.ts';
import {isDownloadAttemptError, pageHeaders} from './transport.ts';
import {XiaohongshuFallbackError} from './types.ts';
import type {XiaohongshuHttpClient, XiaohongshuParseResult} from './types.ts';
import {
  pythonQuote,
  queryFirstValue,
  rebuildUrl,
  splitUrl,
} from './url.ts';

export const XHS_BASE_URL = 'https://www.xiaohongshu.com';
export const XHS_SHORT_HOSTS: ReadonlySet<string> = new Set([
  'xhslink.com',
  'www.xhslink.com',
  'xhslink.cn',
  'www.xhslink.cn',
]);
export const XHS_SHORT_LINK_BODY_BYTES = 256 * 1024;
export const XHS_MAX_REDIRECT_DEPTH = 5;
export const XHS_TRAILING_URL_PUNCTUATION = ' \t\r\n"\'<>[]{}()，。！？；：、,.;:!?';

const XHS_URL_PATTERN = /https?:\/\/[^\s"'<>]+/giu;
const XHS_NOTE_ID_EXACT_PATTERN = /^[0-9a-f]{24}$/iu;
const XHS_NOTE_ID_PATTERN = /^[0-9a-f]{24}$/iu;
const TRAILING_PUNCTUATION: ReadonlySet<string> = new Set([...XHS_TRAILING_URL_PUNCTUATION]);
const WRAPPING_CHARS: ReadonlySet<string> = new Set([
  '"', "'", '<', '>', '[', ']', '{', '}', '(', ')',
]);

export async function parseXiaohongshuSource(
  rawInput: string,
  httpClient: XiaohongshuHttpClient,
): Promise<XiaohongshuParseResult> {
  const normalized = stripPythonSpace(rawInput);
  if (XHS_NOTE_ID_EXACT_PATTERN.test(normalized)) {
    return {noteId: normalized.toLowerCase(), fullUrl: '', xsecToken: ''};
  }

  let lastError: XiaohongshuFallbackError | null = null;
  for (const candidateUrl of extractXhsUrls(normalized)) {
    try {
      return await parseXhsUrlCandidate(candidateUrl, httpClient, 0);
    } catch (error) {
      if (!(error instanceof XiaohongshuFallbackError)) throw error;
      lastError = error;
    }
  }
  if (lastError !== null) throw lastError;
  throw new XiaohongshuFallbackError(
    'XHS_ID_PARSE_FAILED',
    'Could not extract Xiaohongshu note ID from input.',
  );
}

export function buildExploreUrl(
  noteId: string,
  xsecToken = '',
  baseUrl: string = XHS_BASE_URL,
): string {
  const base = baseUrl.replace(/\/+$/u, '');
  let noteUrl = `${base}/explore/${pythonQuote(noteId)}`;
  const token = stripPythonSpace(xsecToken);
  if (token !== '') noteUrl = `${noteUrl}?xsec_token=${pythonQuote(token)}`;
  return noteUrl;
}

async function parseXhsUrlCandidate(
  rawUrl: string,
  httpClient: XiaohongshuHttpClient,
  depth: number,
): Promise<XiaohongshuParseResult> {
  if (depth > XHS_MAX_REDIRECT_DEPTH) {
    throw new XiaohongshuFallbackError(
      'XHS_SHORT_LINK_RESOLUTION_FAILED',
      'Xiaohongshu short link redirected too many times.',
    );
  }

  const parsed = parseXhsNoteUrl(rawUrl);
  if (parsed !== null) return parsed;
  if (!isXhsShortLink(rawUrl)) {
    throw new XiaohongshuFallbackError(
      'XHS_ID_PARSE_FAILED',
      'Could not extract Xiaohongshu note ID from URL.',
    );
  }

  const resolvedUrl = await resolveShortLink(rawUrl, httpClient);
  return parseXhsUrlCandidate(resolvedUrl, httpClient, depth + 1);
}

async function resolveShortLink(
  shortUrl: string,
  httpClient: XiaohongshuHttpClient,
): Promise<string> {
  let lastError: unknown = null;
  for (const attemptUrl of shortLinkAttempts(shortUrl)) {
    try {
      return await resolveShortLinkOnce(attemptUrl, httpClient);
    } catch (error) {
      if (!isDownloadAttemptError(error)) throw error;
      lastError = error;
    }
  }
  throw new XiaohongshuFallbackError(
    'XHS_SHORT_LINK_RESOLUTION_FAILED',
    'Xiaohongshu short link could not be resolved.',
  );
}

async function resolveShortLinkOnce(
  shortUrl: string,
  httpClient: XiaohongshuHttpClient,
): Promise<string> {
  const response = await httpClient.get(shortUrl, pageHeaders(), 10);
  const location = header(response.headers, 'Location');
  if (response.status >= 300 && response.status < 400 && location !== null
    && location !== '') {
    return resolveLocation(response.url === '' ? shortUrl : response.url, location);
  }

  const resolved = parseXhsNoteUrl(response.url);
  if (resolved !== null) return response.url;

  const body = decodeResponseBody(response, XHS_SHORT_LINK_BODY_BYTES);
  for (const embeddedUrl of extractXhsUrls(body)) {
    if (parseXhsNoteUrl(embeddedUrl) !== null) return embeddedUrl;
  }

  throw new XiaohongshuFallbackError(
    'XHS_SHORT_LINK_RESOLUTION_FAILED',
    'Xiaohongshu short link response did not contain a note URL.',
  );
}

function resolveLocation(base: string, location: string): string {
  const trimmed = stripPythonSpace(location);
  const parsed = splitUrl(trimmed);
  if (parsed.scheme !== '') return trimmed;
  if (trimmed.startsWith('//')) return `${splitUrl(base).scheme}:${trimmed}`;
  const baseUrl = splitUrl(base);
  if (trimmed.startsWith('/')) {
    return `${baseUrl.scheme}://${baseUrl.netloc}${trimmed}`;
  }
  const directory = baseUrl.path.slice(0, baseUrl.path.lastIndexOf('/') + 1);
  return `${baseUrl.scheme}://${baseUrl.netloc}${directory}${trimmed}`;
}

function shortLinkAttempts(shortUrl: string): string[] {
  const attempts = [shortUrl];
  const parsed = splitUrl(shortUrl);
  if (parsed.scheme === 'http') {
    const secureUrl = rebuildUrl({...parsed, scheme: 'https'});
    if (!attempts.includes(secureUrl)) attempts.push(secureUrl);
  }
  return attempts;
}

export function extractXhsUrls(rawInput: string): string[] {
  const urls: string[] = [];
  for (const match of rawInput.matchAll(new RegExp(XHS_URL_PATTERN))) {
    const candidate = stripTrailingPunctuation(match[0]);
    const parsed = splitUrl(candidate);
    if (isAcceptableXhsHost(parsed.hostname ?? '')) urls.push(candidate);
  }
  return urls;
}

function parseXhsNoteUrl(rawUrl: string): XiaohongshuParseResult | null {
  const stripped = stripWrappingChars(stripPythonSpace(rawUrl));
  const parsed = splitUrl(decodeHTML(stripped));
  if (parsed.scheme !== 'http' && parsed.scheme !== 'https') {
    throw new XiaohongshuFallbackError(
      'XHS_URL_INVALID',
      'Xiaohongshu URL must use http or https.',
    );
  }

  const host = (parsed.hostname ?? '').replace(/\.+$/u, '');
  if (isXhsShortHost(host)) return null;
  if (!isAcceptableXhsHost(host)) {
    throw new XiaohongshuFallbackError(
      'XHS_URL_INVALID',
      'Unsupported Xiaohongshu host.',
    );
  }

  const noteId = noteIdFromPath(parsed.path);
  if (noteId === null) {
    throw new XiaohongshuFallbackError(
      'XHS_ID_PARSE_FAILED',
      'Could not extract Xiaohongshu note ID from URL.',
    );
  }

  return {
    noteId: noteId.toLowerCase(),
    fullUrl: rebuildUrl(parsed),
    xsecToken: queryFirstValue(parsed.query, 'xsec_token'),
  };
}

function noteIdFromPath(path: string): string | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  let candidate = '';
  if (segments.length === 2 && segments[0].toLowerCase() === 'explore') {
    candidate = segments[1];
  } else if (
    segments.length === 3
    && segments[0].toLowerCase() === 'discovery'
    && segments[1].toLowerCase() === 'item'
  ) {
    candidate = segments[2];
  }
  return XHS_NOTE_ID_PATTERN.test(candidate) ? candidate.toLowerCase() : null;
}

function isXhsShortLink(url: string): boolean {
  return isXhsShortHost(splitUrl(url).hostname ?? '');
}

function isXhsShortHost(host: string): boolean {
  return XHS_SHORT_HOSTS.has(host.toLowerCase().replace(/\.+$/u, ''));
}

function isAcceptableXhsHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.+$/u, '');
  return normalized === 'xiaohongshu.com'
    || normalized.endsWith('.xiaohongshu.com')
    || isXhsShortHost(normalized);
}

function stripTrailingPunctuation(value: string): string {
  const points = [...value];
  while (points.length > 0 && TRAILING_PUNCTUATION.has(points[points.length - 1])) points.pop();
  return points.join('');
}

function stripWrappingChars(value: string): string {
  const points = [...value];
  while (points.length > 0 && WRAPPING_CHARS.has(points[0])) points.shift();
  while (points.length > 0 && WRAPPING_CHARS.has(points[points.length - 1])) points.pop();
  return points.join('');
}
