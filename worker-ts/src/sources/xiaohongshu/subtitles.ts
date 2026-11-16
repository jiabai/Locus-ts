// 小红书字幕轨选择：对齐 `worker/worker_core/xiaohongshu/subtitles.py`。
//
// 字幕信息藏在 `video.mediaV2` 这个 JSON 字符串里，按固定语言优先序挑第一条可用轨；
// 只接受小红书自家 CDN 的 https 地址，避免把笔记里的任意 URL 变成下载目标。
import {stripPythonSpace} from '../../protocol/process-request.ts';
import {asMapping} from './page.ts';
import type {XiaohongshuSubtitleTrack} from './types.ts';
import {splitUrl} from './url.ts';

export const PREFERRED_SUBTITLE_GROUPS: readonly string[] = [
  'source',
  'zh-Hans',
  'zh-CN',
  'zh-Hant',
  'zh',
  'en-US',
  'en',
  'ja',
  'ko',
];
export const SUBTITLE_HOST_SUFFIXES: readonly string[] = ['xhscdn.com', 'xiaohongshu.com'];

const LANGUAGE_TAG_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8}){0,3}$/u;
const SUPPORTED_SUFFIXES: readonly string[] = ['.srt', '.vtt'];

/** `zh_CN` → `zh-CN`、`EN-us` → `en-US`；不合规的标签一律当作没有。 */
export function normalizeSubtitleLanguage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const language = stripPythonSpace(value.replaceAll('_', '-'));
  if (!LANGUAGE_TAG_PATTERN.test(language)) return null;
  const parts = language.split('-');
  const normalized = [parts[0].toLowerCase()];
  for (const part of parts.slice(1)) {
    if (/^[A-Za-z]{4}$/u.test(part)) {
      normalized.push(part[0].toUpperCase() + part.slice(1).toLowerCase());
    } else if (part.length === 2 || part.length === 3) {
      normalized.push(part.toUpperCase());
    } else {
      normalized.push(part);
    }
  }
  return normalized.join('-');
}

export function isAllowedSubtitleUrl(url: string): boolean {
  const parsed = splitUrl(url);
  if (parsed.scheme !== 'https' || parsed.hostname === null) return false;
  if (parsed.username !== null || parsed.password !== null) return false;
  const host = parsed.hostname.replace(/\.+$/u, '').toLowerCase();
  return SUBTITLE_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

export function selectPreferredSubtitleTrack(
  noteObject: Readonly<Record<string, unknown>>,
): XiaohongshuSubtitleTrack | null {
  const video = asMapping(noteObject.video);
  const rawMediaV2 = video === null ? undefined : video.mediaV2;
  if (typeof rawMediaV2 !== 'string' || stripPythonSpace(rawMediaV2) === '') return null;

  let mediaV2: unknown;
  try {
    mediaV2 = JSON.parse(rawMediaV2);
  } catch {
    return null;
  }
  const mediaVideo = asMapping(asMapping(mediaV2)?.video);
  const groups = mediaVideo === null ? null : asMapping(mediaVideo.subtitles);
  if (groups === null) return null;

  for (const groupName of PREFERRED_SUBTITLE_GROUPS) {
    const rawTracks = groups[groupName];
    if (!Array.isArray(rawTracks)) continue;
    for (const rawTrack of rawTracks) {
      const track = parseTrack(rawTrack, groupName);
      if (track !== null) return track;
    }
  }
  return null;
}

function parseTrack(rawTrack: unknown, groupName: string): XiaohongshuSubtitleTrack | null {
  const track = asMapping(rawTrack);
  if (track === null) return null;
  const rawUrl = track.url;
  if (typeof rawUrl !== 'string' || stripPythonSpace(rawUrl) === '') return null;
  const url = stripPythonSpace(rawUrl);
  if (!isAllowedSubtitleUrl(url)) return null;

  let rawLanguage = track.language;
  if (rawLanguage === undefined || rawLanguage === null) {
    if (groupName === 'source') return null;
    rawLanguage = groupName;
  }
  const language = normalizeSubtitleLanguage(rawLanguage);
  if (language === null) return null;
  const suffix = suffixForTrack(track, url);
  if (suffix === null) return null;
  return {language, url, suffix};
}

function suffixForTrack(
  track: Readonly<Record<string, unknown>>,
  url: string,
): string | null {
  const explicitFormat = track.format;
  if (typeof explicitFormat === 'string') {
    const formatName = stripPythonSpace(explicitFormat).toLowerCase().replace(/^\.+/u, '');
    if (formatName !== 'srt' && formatName !== 'vtt') return null;
    return `.${formatName}`;
  }
  // Python 只在 `None` 与整数 `0` 时继续猜后缀；浮点 0.0 或其它类型一律拒绝。
  if (explicitFormat !== undefined && explicitFormat !== null) {
    if (typeof explicitFormat !== 'number' || !Number.isInteger(explicitFormat)
      || explicitFormat !== 0) {
      return null;
    }
  }

  const path = splitUrl(url).path.toLowerCase();
  for (const suffix of SUPPORTED_SUFFIXES) {
    if (path.endsWith(suffix)) return suffix;
  }
  const lastSegment = path.split('/').at(-1) ?? '';
  if (lastSegment.includes('.')) return null;
  return '.srt';
}
