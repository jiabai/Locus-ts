// 抖音输入解析：对齐 `worker/worker_core/douyin/source.py`。
//
// 分享文案里可能混着中文、话题与短链；先把 AWEME ID 从原文或任意抖音链接里取出来，
// 取不到才发短链请求。`iesdouyin.com/share/video/<id>/` 是公开分享页，
// 不需要登录态。
import {DouyinFallbackError} from './types.ts';
import type {DouyinHttpClient, HttpResponse} from './types.ts';
import {publicHeaders} from './transport.ts';

const AWEME_ID_PATTERNS: readonly RegExp[] = [
  /[?&](?:modal_id|aweme_id)=(\d+)(?:[&#]|$)/u,
  /(?:^|\/)(?:video|note)\/(\d+)(?:[/?#]|$)/u,
  /(?:^|\/)share\/slides\/(\d+)(?:[/?#]|$)/u,
  /[?&]aweme_id=(\d+)(?:[&#]|$)/u,
];
const DOUYIN_URL_PATTERN = /https?:\/\/[^\s"'<>]+/gu;
const DOUYIN_SHORT_HOSTS: ReadonlySet<string> = new Set(['v.douyin.com']);
const TRAILING_PUNCTUATION: ReadonlySet<string> = new Set([
  '，', '。', ',', '.', '、', '!', '！', '?', '？', ')',
]);

export function extractAwemeId(url: string): string | null {
  for (const pattern of AWEME_ID_PATTERNS) {
    const match = pattern.exec(url);
    if (match !== null) return match[1];
  }
  return null;
}

export async function resolveAwemeIdFromInput(
  rawInput: string,
  httpClient: DouyinHttpClient,
): Promise<string | null> {
  const directId = extractAwemeId(rawInput);
  if (directId !== null) return directId;

  for (const candidateUrl of extractDouyinUrls(rawInput)) {
    const candidateId = extractAwemeId(candidateUrl);
    if (candidateId !== null) return candidateId;
    if (!isDouyinShortLink(candidateUrl)) continue;
    let response: HttpResponse;
    try {
      response = await httpClient.get(candidateUrl, publicHeaders(), 10);
    } catch (error) {
      // 短链失败只意味着这个候选没戏，后面可能还有别的链接。
      if (error instanceof DouyinFallbackError) continue;
      throw error;
    }
    const resolvedId = extractAwemeId(response.url);
    if (resolvedId !== null) return resolvedId;
    const body = new TextDecoder('utf-8').decode(response.body);
    for (const embeddedUrl of extractDouyinUrls(body)) {
      const embeddedId = extractAwemeId(embeddedUrl);
      if (embeddedId !== null) return embeddedId;
    }
  }
  return null;
}

export function buildSharePageUrl(awemeId: string): string {
  return `https://www.iesdouyin.com/share/video/${awemeId}/?app=aweme`;
}

function extractDouyinUrls(rawInput: string): string[] {
  const urls: string[] = [];
  DOUYIN_URL_PATTERN.lastIndex = 0;
  for (const match of rawInput.matchAll(DOUYIN_URL_PATTERN)) {
    const candidate = stripTrailingPunctuation(match[0]);
    if (isDouyinHost(hostnameOf(candidate) ?? '')) urls.push(candidate);
  }
  return urls;
}

function stripTrailingPunctuation(value: string): string {
  const points = [...value];
  while (points.length > 0 && TRAILING_PUNCTUATION.has(points[points.length - 1])) points.pop();
  return points.join('');
}

function isDouyinShortLink(url: string): boolean {
  return DOUYIN_SHORT_HOSTS.has((hostnameOf(url) ?? '').toLowerCase());
}

function isDouyinHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.+$/u, '');
  return normalized === 'douyin.com'
    || normalized.endsWith('.douyin.com')
    || normalized === 'iesdouyin.com'
    || normalized.endsWith('.iesdouyin.com');
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
