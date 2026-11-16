// 来源身份识别：复现 `worker/worker_core/source_identity.py`。
//
// 平台闭集（douyin / xiaohongshu / bilibili / youtube）+ 稳定 ID 白名单，
// 任何查询串里的 token（xsec_token、spm_id_from、si……）都不进规范 URL，
// 也不进任何序列化输出——它们可能携带分享者的身份信息。
import {parseQsl} from '../web/web-page-contract.ts';

export type SourcePlatform = 'douyin' | 'xiaohongshu' | 'bilibili' | 'youtube';

export const SOURCE_IDENTITY_VERSION = 1;

export const SOURCE_PRIVACY_MIGRATION_VERSION = 2;

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/giu;
const URL_TRAILING_PUNCTUATION = /[ \t\r\n"'<>[\]{}()，。！？；：、.;:!?]+$/u;
const XHS_NOTE_ID_PATTERN = /^[0-9a-f]{24}$/iu;
const BILIBILI_BVID_PATTERN = /^BV[0-9A-Za-z]{10}$/iu;
const BILIBILI_AVID_PATTERN = /^av(\d{1,20})$/iu;
const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/u;
const DOUYIN_AWEME_ID_PATTERN = /^\d{15,24}$/u;
export const MAX_BILIBILI_PART_INDEX = 100_000;

const PLATFORMS: readonly SourcePlatform[] = ['douyin', 'xiaohongshu', 'bilibili', 'youtube'];

export class SourceIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceIdentityError';
  }
}

export interface SourceIdentity {
  readonly platform: SourcePlatform;
  readonly stableId: string;
  readonly canonicalUrl: string;
  readonly effectivePart: number | null;
}

export function sourceIdentity(
  platform: SourcePlatform,
  stableId: string,
  canonicalUrl: string,
  effectivePart: number | null = null,
): SourceIdentity {
  return {platform, stableId, canonicalUrl, effectivePart};
}

/** 与 Python `SourceIdentity.to_manifest_dict` 同键序。 */
export function sourceIdentityToManifestDict(identity: SourceIdentity): Record<string, unknown> {
  return {
    version: SOURCE_IDENTITY_VERSION,
    platform: identity.platform,
    stable_id: identity.stableId,
    effective_part: identity.effectivePart,
    canonical_url: identity.canonicalUrl,
  };
}

export function identifySource(rawSource: string, resolvedUrl?: string): SourceIdentity {
  const source = rawSource.trim();
  if (source.length === 0) {
    throw new SourceIdentityError('Source URL cannot be empty.');
  }
  if (resolvedUrl) {
    const resolved = identifyDirectSource(resolvedUrl);
    if (resolved !== null) return resolved;
  }
  const direct = identifyDirectSource(source);
  if (direct !== null) return direct;
  throw new SourceIdentityError('Source URL does not contain a supported stable video ID.');
}

/** 与 Python `source_identity_from_manifest` 同语义：结构、版本、平台闭集与重算一致性全要过。 */
export function sourceIdentityFromManifest(value: unknown): SourceIdentity | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const {version, platform, stableId, canonicalUrl, effectivePart} = {
    version: record['version'],
    platform: record['platform'],
    stableId: record['stable_id'],
    canonicalUrl: record['canonical_url'],
    effectivePart: record['effective_part'],
  };
  if (version !== SOURCE_IDENTITY_VERSION) return null;
  if (typeof platform !== 'string' || !PLATFORMS.includes(platform as SourcePlatform)) return null;
  if (typeof stableId !== 'string' || stableId.length === 0) return null;
  if (typeof canonicalUrl !== 'string' || canonicalUrl.length === 0) return null;
  if (effectivePart !== null && effectivePart !== undefined
    && (typeof effectivePart !== 'number' || !Number.isInteger(effectivePart))) return null;
  let expected: SourceIdentity;
  try {
    expected = identifySource(canonicalUrl);
  } catch (error) {
    if (error instanceof SourceIdentityError) return null;
    throw error;
  }
  const identity = sourceIdentity(
    platform as SourcePlatform,
    stableId,
    canonicalUrl,
    effectivePart === undefined ? null : effectivePart,
  );
  return identity.platform === expected.platform
    && identity.stableId === expected.stableId
    && identity.effectivePart === expected.effectivePart
    && identity.canonicalUrl === expected.canonicalUrl ? identity : null;
}

export function canonicalUrlForPersistence(identity: SourceIdentity | null): string | null {
  if (identity === null) return null;
  const validated = sourceIdentityFromManifest(sourceIdentityToManifestDict(identity));
  if (validated === null
    || validated.platform !== identity.platform
    || validated.stableId !== identity.stableId
    || validated.effectivePart !== identity.effectivePart
    || validated.canonicalUrl !== identity.canonicalUrl) {
    throw new SourceIdentityError('Source identity is not safe for persistence.');
  }
  return validated.canonicalUrl;
}

function identifyDirectSource(rawSource: string): SourceIdentity | null {
  const normalized = rawSource.trim();
  if (XHS_NOTE_ID_PATTERN.test(normalized)) {
    return xiaohongshuIdentity(normalized.toLowerCase());
  }
  const bilibiliDirect = normalizeBilibiliId(normalized);
  if (bilibiliDirect !== null) {
    return bilibiliIdentity(bilibiliDirect, 1);
  }
  for (const candidate of extractUrlCandidates(normalized)) {
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      // Python `urlparse` 对非法 URL 抛 ValueError 后跳过该候选。
      continue;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    const host = parsed.hostname.toLowerCase().replace(/\.+$/u, '');
    if (hostMatches(host, 'xiaohongshu.com')) {
      const noteId = findXhsNoteId(parsed);
      if (noteId) return xiaohongshuIdentity(noteId);
    }
    if (hostMatches(host, 'douyin.com') || hostMatches(host, 'iesdouyin.com')) {
      const awemeId = findDouyinAwemeId(parsed);
      if (awemeId) return douyinIdentity(awemeId);
    }
    if (hostMatches(host, 'bilibili.com')) {
      const bilibili = findBilibiliVideo(parsed);
      if (bilibili !== null) return bilibiliIdentity(bilibili.videoId, bilibili.partIndex);
    }
    if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be'].includes(host)) {
      const videoId = findYoutubeVideoId(parsed, host);
      if (videoId) return youtubeIdentity(videoId);
    }
  }
  return null;
}

export function extractUrlCandidates(rawSource: string): string[] {
  const candidates: string[] = [];
  for (const match of rawSource.matchAll(URL_PATTERN)) {
    candidates.push(match[0].replace(URL_TRAILING_PUNCTUATION, ''));
  }
  return candidates;
}

function hostMatches(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/** 首个查询值：与 Python `parse_qs(...).get(key, [default])[0]` 同语义。 */
function firstQueryValue(parsed: URL, key: string, fallback: string): string {
  let items: Array<{readonly key: string; readonly value: string}>;
  try {
    items = parseQsl(parsed.search.startsWith('?') ? parsed.search.slice(1) : parsed.search, 512);
  } catch {
    return fallback;
  }
  // Python `parse_qs` 默认丢弃空值项。
  for (const item of items) {
    if (item.key === key && item.value !== '') return item.value;
  }
  return fallback;
}

function findXhsNoteId(parsed: URL): string | null {
  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
  let candidate = '';
  if (segments.length === 2 && segments[0].toLowerCase() === 'explore') {
    candidate = segments[1];
  } else if (segments.length === 3
    && segments[0].toLowerCase() === 'discovery'
    && segments[1].toLowerCase() === 'item') {
    candidate = segments[2];
  }
  return XHS_NOTE_ID_PATTERN.test(candidate) ? candidate.toLowerCase() : null;
}

function findDouyinAwemeId(parsed: URL): string | null {
  for (const key of ['modal_id', 'aweme_id']) {
    const value = firstQueryValue(parsed, key, '');
    if (DOUYIN_AWEME_ID_PATTERN.test(value)) return value;
  }
  // 与 Python 同形：`/(?:video|note|share/slides)/(\d+)(?:/|$)`，前导 `/` 是模式的一部分。
  const pathMatch = /\/(?:video|note|share\/slides)\/(\d+)(?:\/|$)/u.exec(parsed.pathname);
  if (pathMatch && DOUYIN_AWEME_ID_PATTERN.test(pathMatch[1])) return pathMatch[1];
  return null;
}

function findBilibiliVideo(parsed: URL): {readonly videoId: string; readonly partIndex: number} | null {
  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
  if (segments.length < 2 || segments[0].toLowerCase() !== 'video') return null;
  const videoId = normalizeBilibiliId(segments[1]);
  if (videoId === null) return null;
  const rawPart = firstQueryValue(parsed, 'p', '1');
  const partIndex = /^\d+$/.test(rawPart) ? Number(rawPart) : NaN;
  if (!Number.isInteger(partIndex) || partIndex < 1 || partIndex > MAX_BILIBILI_PART_INDEX) {
    return null;
  }
  return {videoId, partIndex};
}

function findYoutubeVideoId(parsed: URL, host: string): string | null {
  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
  let candidate = '';
  if (host === 'youtu.be' || host === 'www.youtu.be') {
    candidate = segments.length === 1 ? segments[0] : '';
  } else if (parsed.pathname.replace(/\/+$/u, '') === '/watch') {
    candidate = firstQueryValue(parsed, 'v', '');
  } else if (segments.length === 2 && segments[0].toLowerCase() === 'shorts') {
    candidate = segments[1];
  }
  return YOUTUBE_VIDEO_ID_PATTERN.test(candidate) ? candidate : null;
}

export function normalizeBilibiliId(value: string): string | null {
  if (BILIBILI_BVID_PATTERN.test(value)) return `BV${value.slice(2)}`;
  const avid = BILIBILI_AVID_PATTERN.exec(value);
  return avid ? `av${avid[1]}` : null;
}

function xiaohongshuIdentity(noteId: string): SourceIdentity {
  const normalized = noteId.toLowerCase();
  if (!XHS_NOTE_ID_PATTERN.test(normalized)) {
    throw new SourceIdentityError('Invalid Xiaohongshu note ID.');
  }
  return sourceIdentity('xiaohongshu', normalized, `https://www.xiaohongshu.com/explore/${normalized}`);
}

function douyinIdentity(awemeId: string): SourceIdentity {
  if (!DOUYIN_AWEME_ID_PATTERN.test(awemeId)) {
    throw new SourceIdentityError('Invalid Douyin work ID.');
  }
  return sourceIdentity('douyin', awemeId, `https://www.douyin.com/video/${awemeId}`);
}

function bilibiliIdentity(videoId: string, partIndex: number): SourceIdentity {
  const normalizedVideoId = normalizeBilibiliId(videoId);
  if (normalizedVideoId === null) {
    throw new SourceIdentityError('Invalid Bilibili video ID.');
  }
  if (!Number.isInteger(partIndex) || partIndex < 1 || partIndex > MAX_BILIBILI_PART_INDEX) {
    throw new SourceIdentityError('Invalid Bilibili part index.');
  }
  const suffix = partIndex > 1 ? `?p=${partIndex}` : '';
  return sourceIdentity(
    'bilibili', normalizedVideoId, `https://www.bilibili.com/video/${normalizedVideoId}${suffix}`, partIndex,
  );
}

function youtubeIdentity(videoId: string): SourceIdentity {
  if (!YOUTUBE_VIDEO_ID_PATTERN.test(videoId)) {
    throw new SourceIdentityError('Invalid YouTube video ID.');
  }
  return sourceIdentity('youtube', videoId, `https://www.youtube.com/watch?v=${videoId}`);
}
