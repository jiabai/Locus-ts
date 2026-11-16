// B 站输入解析：对齐 `worker/worker_core/bilibili/source.py`。
//
// 先认纯 BV/av 号，再从文本里挑 B 站链接；`b23.tv` 短链最多展开 5 层，
// http 失败还会换 https 再试一次。番剧、影视与课程入口明确拒绝——
// 那些内容需要登录或付费，不在本工具的公开视频范围内。
import {decodeResponseBody, header, pageHeaders} from './transport.ts';
import {BilibiliFallbackError} from './types.ts';
import type {BilibiliParseResult, BilibiliRequestClient} from './types.ts';

const BILIBILI_URL_PATTERN = /https?:\/\/[^\s"'<>]+/giu;
const BILIBILI_BVID_PATTERN = /^BV[0-9A-Za-z]{10,}$/iu;
const BILIBILI_AVID_PATTERN = /^av(\d+)$/iu;
const BILIBILI_SHORT_HOSTS: ReadonlySet<string> = new Set(['b23.tv', 'www.b23.tv']);
export const BILIBILI_MAX_REDIRECT_DEPTH = 5;
const TRAILING_PUNCTUATION: ReadonlySet<string> = new Set([
  ' ', '\t', '\r', '\n', '"', "'", '<', '>', '[', ']', '{', '}', '(',
  ')', '，', '。', '！', '？', '；', '：', '、', ',', '.', ';', ':', '!', '?',
]);

export async function parseBilibiliInput(
  rawInput: string,
  httpClient: BilibiliRequestClient,
): Promise<BilibiliParseResult> {
  const normalized = rawInput.trim();
  const direct = parseDirectId(normalized);
  if (direct !== null) return direct;

  let lastError: BilibiliFallbackError | null = null;
  for (const candidateUrl of extractBilibiliUrls(normalized)) {
    try {
      return await parseBilibiliUrlCandidate(candidateUrl, httpClient, 0);
    } catch (error) {
      if (!(error instanceof BilibiliFallbackError)) throw error;
      lastError = error;
    }
  }
  if (lastError !== null) throw lastError;
  throw new BilibiliFallbackError(
    'BILIBILI_ID_PARSE_FAILED',
    'Could not extract Bilibili BV or av ID from input.',
  );
}

export function parseDirectId(value: string): BilibiliParseResult | null {
  if (BILIBILI_BVID_PATTERN.test(value)) {
    return {videoId: value, idKind: 'bvid', partIndex: 0, fullUrl: ''};
  }
  const avid = BILIBILI_AVID_PATTERN.exec(value);
  if (avid !== null) {
    return {videoId: avid[1], idKind: 'aid', partIndex: 0, fullUrl: ''};
  }
  return null;
}

async function parseBilibiliUrlCandidate(
  rawUrl: string,
  httpClient: BilibiliRequestClient,
  depth: number,
): Promise<BilibiliParseResult> {
  if (depth > BILIBILI_MAX_REDIRECT_DEPTH) {
    throw new BilibiliFallbackError(
      'BILIBILI_SHORT_LINK_RESOLVE_FAILED',
      'Bilibili short link redirected too many times.',
    );
  }

  const parsed = parseBilibiliVideoUrl(rawUrl);
  if (parsed !== null) return parsed;
  if (!isBilibiliShortLink(rawUrl)) {
    throw new BilibiliFallbackError(
      'BILIBILI_ID_PARSE_FAILED',
      'Could not extract Bilibili BV or av ID from URL.',
    );
  }

  const resolvedUrl = await resolveShortLink(rawUrl, httpClient);
  return parseBilibiliUrlCandidate(resolvedUrl, httpClient, depth + 1);
}

/** 返回 null 表示这是短链，需要先展开；不是短链也不是普通视频时抛错。 */
export function parseBilibiliVideoUrl(rawUrl: string): BilibiliParseResult | null {
  const trimmed = stripWrappingChars(rawUrl.trim());
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/u.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    throw new BilibiliFallbackError(
      'BILIBILI_ID_PARSE_FAILED',
      'Bilibili URL must use http or https.',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new BilibiliFallbackError('BILIBILI_ID_PARSE_FAILED', 'Unsupported Bilibili host.');
  }
  const host = parsed.hostname.toLowerCase().replace(/\.+$/u, '');
  if (isBilibiliShortHost(host)) return null;
  if (!isBilibiliHost(host)) {
    throw new BilibiliFallbackError('BILIBILI_ID_PARSE_FAILED', 'Unsupported Bilibili host.');
  }

  const loweredPath = parsed.pathname.toLowerCase();
  for (const prefix of ['/bangumi/', '/movie/', '/cheese/', '/festival/']) {
    if (loweredPath.startsWith(prefix)) {
      throw new BilibiliFallbackError(
        'BILIBILI_UNSUPPORTED_CONTENT',
        'Only ordinary public Bilibili videos are supported.',
      );
    }
  }

  const segments = parsed.pathname.split('/').filter((segment) => segment !== '');
  if (segments.length < 2 || segments[0].toLowerCase() !== 'video') {
    throw new BilibiliFallbackError(
      'BILIBILI_ID_PARSE_FAILED',
      'Could not extract Bilibili BV or av ID from URL.',
    );
  }
  const direct = parseDirectId(segments[1]);
  if (direct === null) {
    throw new BilibiliFallbackError(
      'BILIBILI_ID_PARSE_FAILED',
      'Could not extract Bilibili BV or av ID from URL.',
    );
  }

  const partValue = parsed.searchParams.getAll('p')[0];
  const partIndex = parsePartIndex(partValue === undefined || partValue === '' ? '1' : partValue);
  return {
    videoId: direct.videoId,
    idKind: direct.idKind,
    partIndex,
    fullUrl: parsed.href,
  };
}

export function parsePartIndex(value: unknown): number {
  const page = parsePythonInt(value) ?? 1;
  return Math.max(0, page - 1);
}

async function resolveShortLink(
  shortUrl: string,
  httpClient: BilibiliRequestClient,
): Promise<string> {
  let lastError: unknown = null;
  for (const attemptUrl of shortLinkAttempts(shortUrl)) {
    try {
      return await resolveShortLinkOnce(attemptUrl, httpClient);
    } catch (error) {
      lastError = error;
    }
  }
  throw new BilibiliFallbackError(
    'BILIBILI_SHORT_LINK_RESOLVE_FAILED',
    'Bilibili short link could not be resolved.',
  );
}

async function resolveShortLinkOnce(
  shortUrl: string,
  httpClient: BilibiliRequestClient,
): Promise<string> {
  const response = await httpClient.get(shortUrl, pageHeaders(), 10);
  const location = header(response.headers, 'Location');
  if (response.status >= 300 && response.status < 400 && location !== null) {
    return new URL(location.trim(), response.url === '' ? shortUrl : response.url).href;
  }

  try {
    if (parseBilibiliVideoUrl(response.url) !== null) return response.url;
  } catch {
    // 最终 URL 不是普通视频时继续看正文里的链接。
  }

  const body = decodeResponseBody(response, 256 * 1024);
  for (const embeddedUrl of extractBilibiliUrls(body)) {
    try {
      if (parseBilibiliVideoUrl(embeddedUrl) !== null) return embeddedUrl;
    } catch {
      continue;
    }
  }
  throw new BilibiliFallbackError(
    'BILIBILI_SHORT_LINK_RESOLVE_FAILED',
    'Bilibili short link response did not contain an ordinary video URL.',
  );
}

export function extractBilibiliUrls(rawInput: string): string[] {
  const urls: string[] = [];
  for (const match of rawInput.matchAll(new RegExp(BILIBILI_URL_PATTERN))) {
    const candidate = stripTrailingPunctuation(match[0]);
    const host = hostnameOf(candidate);
    if (host !== null && isAcceptableBilibiliHost(host)) urls.push(candidate);
  }
  return urls;
}

function shortLinkAttempts(shortUrl: string): string[] {
  const attempts = [shortUrl];
  try {
    const parsed = new URL(shortUrl);
    if (parsed.protocol.toLowerCase() === 'http:') {
      const secure = new URL(shortUrl);
      secure.protocol = 'https:';
      if (!attempts.includes(secure.href)) attempts.push(secure.href);
    }
  } catch {
    // 解析不了就只试原样一次，失败由调用方映射成短链错误。
  }
  return attempts;
}

function isBilibiliShortLink(url: string): boolean {
  const host = hostnameOf(url);
  return host !== null && isBilibiliShortHost(host);
}

function isBilibiliShortHost(host: string): boolean {
  return BILIBILI_SHORT_HOSTS.has(host.toLowerCase().replace(/\.+$/u, ''));
}

function isAcceptableBilibiliHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.+$/u, '');
  return isBilibiliHost(normalized) || isBilibiliShortHost(normalized);
}

function isBilibiliHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.+$/u, '');
  return normalized === 'bilibili.com' || normalized.endsWith('.bilibili.com');
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function stripWrappingChars(value: string): string {
  const points = [...value];
  const wrappers: ReadonlySet<string> = new Set(['"', "'", '<', '>', '[', ']', '{', '}', '(', ')']);
  while (points.length > 0 && wrappers.has(points[0])) points.shift();
  while (points.length > 0 && wrappers.has(points[points.length - 1])) points.pop();
  return points.join('');
}

function stripTrailingPunctuation(value: string): string {
  const points = [...value];
  while (points.length > 0 && TRAILING_PUNCTUATION.has(points[points.length - 1])) points.pop();
  return points.join('');
}

function parsePythonInt(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^[+-]?\d+$/u.test(trimmed)) return null;
    return Number.parseInt(trimmed, 10);
  }
  return null;
}
