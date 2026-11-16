// 三平台短链解析：复现 `bilibili/source.py`、`douyin/source.py`、
// `xiaohongshu/source.py` 的解析与短链展开路径，并装配
// `platform_source_resolvers.build_default_source_resolver()` 的适配器集合。
//
// 适配器契约与 Python 一致：只对自家平台的短链/视频 URL 负责，
// 解析失败（含网络失败）一律返回 null，由 SourceResolver 保留直连错误。
// 展开结果必须重过 `identifySource` 与平台校验，不能被当成可信来源。
import {type SourcePlatform} from './source-identity.ts';
import {type ShortLinkAdapter} from './source-resolution.ts';
import {decodeBody, defaultPageFetch, type PageFetch, PageFetchError, unescapeHtml} from './short-link-http.ts';

// —— 各平台的失败：对适配器而言等价于「这次解析失败」。 ——
class ShortLinkFailure extends Error {}

const SHORT_LINK_BODY_BYTES = 256 * 1024;
const MAX_REDIRECT_DEPTH = 5;

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) '
  + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1';

const BILIBILI_PAGE_HEADERS = {
  'User-Agent': DESKTOP_UA,
  Referer: 'https://www.bilibili.com/',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,'
    + 'image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};
const DOUYIN_PUBLIC_HEADERS = {
  'User-Agent': MOBILE_UA,
  Accept: '*/*',
  Referer: 'https://www.iesdouyin.com/',
};
const XHS_PAGE_HEADERS = {
  'User-Agent': DESKTOP_UA,
  Referer: 'https://www.xiaohongshu.com/',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,'
    + 'image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/giu;
// bilibili 与 xhs 的尾标点闭集一致；douyin 是自己的小闭集。
const SHARED_TRAILING = /[ \t\r\n"'<>[\]{}()，。！？；：、,.;:!?]+$/u;
const DOUYIN_TRAILING = /[，。,.、!！?？)]+$/u;

function fail(message: string): never {
  throw new ShortLinkFailure(message);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.+$/u, '');
  } catch {
    return '';
  }
}

interface PlatformEngine {
  readonly headers: typeof BILIBILI_PAGE_HEADERS;
  /** 平台视频/笔记 URL → 原样 URL（保留查询串）；非平台 URL 为 null；非法平台 URL 抛 ShortLinkFailure。 */
  readonly parsePlatformUrl: (rawUrl: string) => string | null;
  readonly isShortHost: (host: string) => boolean;
  readonly isPlatformHost: (host: string) => boolean;
  readonly maxBodyBytes: number;
  readonly unescape: boolean;
}

/** bilibili 与 xhs 共用的展开引擎：直连解析 → 短链 GET → Location / 最终 URL /
 * 正文内嵌 URL → 深度 ≤ 5 递归，http 先试再试 https。 */
async function resolveWithEngine(
  rawUrl: string,
  engine: PlatformEngine,
  depth: number,
  fetchImpl: PageFetch,
): Promise<string> {
  if (depth > MAX_REDIRECT_DEPTH) {
    fail('short link redirected too many times');
  }
  const direct = engine.parsePlatformUrl(rawUrl);
  if (direct !== null) return direct;
  if (!engine.isShortHost(hostOf(rawUrl))) fail('not a short link');

  let lastFailure: ShortLinkFailure | null = null;
  for (const attemptUrl of shortLinkAttempts(rawUrl)) {
    try {
      const response = await fetchImpl(attemptUrl, {
        headers: {...engine.headers},
        timeoutSeconds: 10,
      });
      const location = response.header('Location');
      if (response.status >= 300 && response.status < 400 && location) {
        return new URL(location.trim(), response.url || attemptUrl).href;
      }
      if (engine.parsePlatformUrl(response.url) !== null) return response.url;
      if (response.body.length > engine.maxBodyBytes) {
        fail('short link response exceeded the safety limit');
      }
      const body = decodeBody(response.body);
      for (const embedded of extractPlatformUrls(body, engine)) {
        if (engine.parsePlatformUrl(embedded) !== null) return embedded;
      }
      fail('short link response did not contain a platform URL');
    } catch (error) {
      if (!(error instanceof ShortLinkFailure) && !(error instanceof PageFetchError)) throw error;
      lastFailure = error;
      continue;
    }
  }
  throw lastFailure ?? new ShortLinkFailure('short link could not be resolved');
}

function shortLinkAttempts(shortUrl: string): readonly string[] {
  try {
    const parsed = new URL(shortUrl);
    if (parsed.protocol !== 'http:') return [shortUrl];
    parsed.protocol = 'https:';
    return parsed.href === shortUrl ? [shortUrl] : [shortUrl, parsed.href];
  } catch {
    return [shortUrl];
  }
}

/** Python `_extract_*_urls`：按 host 过滤候选（不做完整解析，解析留给调用点）。 */
function extractPlatformUrls(rawInput: string, engine: PlatformEngine): string[] {
  const source = engine.unescape ? unescapeHtml(rawInput) : rawInput;
  const urls: string[] = [];
  for (const match of source.matchAll(URL_PATTERN)) {
    const candidate = match[0].replace(SHARED_TRAILING, '');
    const host = hostOf(candidate);
    if (host.length > 0 && (engine.isShortHost(host) || engine.isPlatformHost(host))) {
      urls.push(candidate);
    }
  }
  return urls;
}

// —— bilibili ——
const BILIBILI_BVID_PATTERN = /^BV[0-9A-Za-z]{10,}$/iu;
const BILIBILI_AVID_PATTERN = /^av(\d+)$/iu;
const BILIBILI_SHORT_HOSTS = new Set(['b23.tv', 'www.b23.tv']);
const BILIBILI_UNSUPPORTED_PREFIXES = ['/bangumi/', '/movie/', '/cheese/', '/festival/'];

function parseBilibiliVideoUrl(rawUrl: string): string | null {
  const url = rawUrl.trim().replace(/^["'<>[\]{}()]+/u, '').replace(/["'<>[\]{}()]+$/u, '');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    fail('Bilibili URL must use http or https.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fail('Bilibili URL must use http or https.');
  }
  const host = parsed.hostname.toLowerCase().replace(/\.+$/u, '');
  if (BILIBILI_SHORT_HOSTS.has(host)) return null;
  if (host !== 'bilibili.com' && !host.endsWith('.bilibili.com')) {
    fail('Unsupported Bilibili host.');
  }
  const loweredPath = parsed.pathname.toLowerCase();
  if (BILIBILI_UNSUPPORTED_PREFIXES.some((prefix) => loweredPath.startsWith(prefix))) {
    fail('Only ordinary public Bilibili videos are supported.');
  }
  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
  if (segments.length < 2 || segments[0].toLowerCase() !== 'video') {
    fail('Could not extract Bilibili BV or av ID from URL.');
  }
  const videoSegment = segments[1];
  if (!BILIBILI_BVID_PATTERN.test(videoSegment) && !BILIBILI_AVID_PATTERN.test(videoSegment)) {
    fail('Could not extract Bilibili BV or av ID from URL.');
  }
  return parsed.href;
}

const BILIBILI_ENGINE: PlatformEngine = {
  headers: BILIBILI_PAGE_HEADERS,
  parsePlatformUrl: parseBilibiliVideoUrl,
  isShortHost: (host) => BILIBILI_SHORT_HOSTS.has(host),
  isPlatformHost: (host) => host === 'bilibili.com' || host.endsWith('.bilibili.com'),
  maxBodyBytes: SHORT_LINK_BODY_BYTES,
  unescape: false,
};

// —— xiaohongshu ——
const XHS_NOTE_ID_PATTERN = /^[0-9a-f]{24}$/iu;
const XHS_SHORT_HOSTS = new Set(['xhslink.com', 'www.xhslink.com', 'xhslink.cn', 'www.xhslink.cn']);

function parseXhsNoteUrl(rawUrl: string): string | null {
  const url = unescapeHtml(rawUrl.trim().replace(/^["'<>[\]{}()]+/u, '').replace(/["'<>[\]{}()]+$/u, ''));
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    fail('Xiaohongshu URL must use http or https.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fail('Xiaohongshu URL must use http or https.');
  }
  const host = parsed.hostname.toLowerCase().replace(/\.+$/u, '');
  if (XHS_SHORT_HOSTS.has(host)) return null;
  if (host !== 'xiaohongshu.com' && !host.endsWith('.xiaohongshu.com')) {
    fail('Unsupported Xiaohongshu host.');
  }
  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
  let candidate = '';
  if (segments.length === 2 && segments[0].toLowerCase() === 'explore') {
    candidate = segments[1];
  } else if (segments.length === 3
    && segments[0].toLowerCase() === 'discovery'
    && segments[1].toLowerCase() === 'item') {
    candidate = segments[2];
  }
  if (!XHS_NOTE_ID_PATTERN.test(candidate)) {
    fail('Could not extract Xiaohongshu note ID from URL.');
  }
  return parsed.href;
}

const XHS_ENGINE: PlatformEngine = {
  headers: XHS_PAGE_HEADERS,
  parsePlatformUrl: parseXhsNoteUrl,
  isShortHost: (host) => XHS_SHORT_HOSTS.has(host),
  isPlatformHost: (host) => host === 'xiaohongshu.com' || host.endsWith('.xiaohongshu.com'),
  maxBodyBytes: SHORT_LINK_BODY_BYTES,
  unescape: true,
};

// —— douyin：Python 里它不走共用引擎（提取正则与重试语义都不同），保持独立实现。 ——
const AWEME_ID_PATTERNS = [
  /[?&](?:modal_id|aweme_id)=(\d+)(?:[&#]|$)/u,
  /(?:^|\/)(?:video|note)\/(\d+)(?:[/?#]|$)/u,
  /(?:^|\/)share\/slides\/(\d+)(?:[/?#]|$)/u,
  /[?&]aweme_id=(\d+)(?:[&#]|$)/u,
];
const DOUYIN_SHORT_HOSTS = new Set(['v.douyin.com']);

function isDouyinHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.+$/u, '');
  return normalized === 'douyin.com' || normalized.endsWith('.douyin.com')
    || normalized === 'iesdouyin.com' || normalized.endsWith('.iesdouyin.com');
}

function extractAwemeId(url: string): string | null {
  for (const pattern of AWEME_ID_PATTERNS) {
    const match = pattern.exec(url);
    if (match) return match[1];
  }
  return null;
}

function douyinUrlsFrom(rawInput: string): string[] {
  const urls: string[] = [];
  for (const match of rawInput.matchAll(URL_PATTERN)) {
    const candidate = match[0].replace(DOUYIN_TRAILING, '');
    if (isDouyinHost(hostOf(candidate))) urls.push(candidate);
  }
  return urls;
}

async function resolveDouyinInput(rawInput: string, fetchImpl: PageFetch): Promise<string> {
  const directId = extractAwemeId(rawInput);
  if (directId) return `https://www.douyin.com/video/${directId}`;
  for (const candidateUrl of douyinUrlsFrom(rawInput)) {
    const candidateId = extractAwemeId(candidateUrl);
    if (candidateId) return `https://www.douyin.com/video/${candidateId}`;
    if (!DOUYIN_SHORT_HOSTS.has(hostOf(candidateUrl))) continue;
    let response;
    try {
      response = await fetchImpl(candidateUrl, {
        headers: {...DOUYIN_PUBLIC_HEADERS},
        timeoutSeconds: 10,
      });
    } catch (error) {
      if (error instanceof PageFetchError) continue;
      throw error;
    }
    const resolvedId = extractAwemeId(response.url);
    if (resolvedId) return `https://www.douyin.com/video/${resolvedId}`;
    const body = decodeBody(response.body);
    for (const embedded of douyinUrlsFrom(body)) {
      const embeddedId = extractAwemeId(embedded);
      if (embeddedId) return `https://www.douyin.com/video/${embeddedId}`;
    }
  }
  fail('no aweme id found');
}

function platformAdapter(
  platform: SourcePlatform,
  hosts: ReadonlySet<string>,
  resolveWith: (candidate: string, fetchImpl: PageFetch) => Promise<string>,
  fetchImpl: PageFetch,
): ShortLinkAdapter {
  return {
    platform,
    hosts,
    resolve: async (shortUrl) => {
      try {
        return await resolveWith(shortUrl, fetchImpl);
      } catch (error) {
        if (error instanceof ShortLinkFailure || error instanceof PageFetchError) return null;
        throw error;
      }
    },
  };
}

export const XIAOHONGSHU_SHORT_HOSTS = XHS_SHORT_HOSTS;
export const BILIBILI_SHORT_HOST_SET = BILIBILI_SHORT_HOSTS;
export const DOUYIN_SHORT_HOST_SET = DOUYIN_SHORT_HOSTS;

/** 与 Python `platform_source_resolvers.build_default_source_resolver` 同序：
 * xiaohongshu → bilibili → douyin。测试可注入 fetch。 */
export function buildDefaultSourceResolver(fetchImpl: PageFetch = defaultPageFetch): ShortLinkAdapter[] {
  return [
    platformAdapter('xiaohongshu', XHS_SHORT_HOSTS, (candidate, fetch) =>
      resolveWithEngine(candidate, XHS_ENGINE, 0, fetch), fetchImpl),
    platformAdapter('bilibili', BILIBILI_SHORT_HOSTS, (candidate, fetch) =>
      resolveWithEngine(candidate, BILIBILI_ENGINE, 0, fetch), fetchImpl),
    platformAdapter('douyin', DOUYIN_SHORT_HOSTS, (candidate, fetch) =>
      resolveDouyinInput(candidate, fetch), fetchImpl),
  ];
}
