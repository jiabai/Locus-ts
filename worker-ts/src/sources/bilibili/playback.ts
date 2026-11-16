// B 站 API 解析：对齐 `worker/worker_core/bilibili/playback.py`。
//
// `view` 给分 P 与 cid，`playurl` 给 DASH 音视频轨。选择顺序是
// 编码偏好（AV1 > HEVC > AVC）→ 带宽 → 像素数 → 画质 id → 备用地址数，
// 逐项比较；DRM 轨道在任何情况下都拒绝，不尝试绕过。
import {decodeResponseBody} from './transport.ts';
import {BilibiliFallbackError} from './types.ts';
import type {
  BilibiliDashSelection,
  BilibiliPage,
  BilibiliVideoInfo,
  HttpResponse,
} from './types.ts';

export const BILIBILI_API_BASE_URL = 'https://api.bilibili.com';
const CODEC_RANK = new Map([[13, 300], [12, 200], [7, 100]]);

export function buildVideoInfoUrl(idKind: string, videoId: string): string {
  const queryKey = idKind === 'aid' ? 'aid' : 'bvid';
  return `${BILIBILI_API_BASE_URL}/x/web-interface/view?${queryKey}=${pythonQuote(String(videoId))}`;
}

export function buildPlayurlUrl(bvid: string, cid: number): string {
  return `${BILIBILI_API_BASE_URL}/x/player/playurl?`
    + `bvid=${pythonQuote(bvid)}&cid=${cid}&fnval=4048&fnver=0&fourk=1`;
}

export function selectDashStreamPair(
  data: Readonly<Record<string, unknown>>,
  durationSeconds: number,
): BilibiliDashSelection {
  raiseIfDrm(data);
  const dash = asMapping(data['dash']);
  if (dash === null || Object.keys(dash).length === 0) {
    throw new BilibiliFallbackError(
      'BILIBILI_NO_PLAYABLE_STREAM',
      'Bilibili playurl response did not include DASH streams.',
    );
  }

  const videos = dash['video'];
  const audios = dash['audio'];
  if (!Array.isArray(videos) || !Array.isArray(audios)) {
    throw new BilibiliFallbackError(
      'BILIBILI_NO_PLAYABLE_STREAM',
      'Bilibili DASH response did not include video and audio streams.',
    );
  }

  const videoStreams = videos.filter((item): item is Record<string, unknown> =>
    isPlainObject(item) && collectDashUrls(item).length > 0);
  const audioStreams = audios.filter((item): item is Record<string, unknown> =>
    isPlainObject(item) && collectDashUrls(item).length > 0);
  for (const item of [...videoStreams, ...audioStreams]) raiseIfDrm(item);

  if (videoStreams.length === 0 || audioStreams.length === 0) {
    throw new BilibiliFallbackError(
      'BILIBILI_NO_PLAYABLE_STREAM',
      'Bilibili DASH response returned no playable video/audio pair.',
    );
  }

  const bestVideo = maxBy(videoStreams, videoStreamScore);
  const bestAudio = maxBy(audioStreams, audioStreamScore);
  const videoUrls = collectDashUrls(bestVideo);
  const audioUrls = collectDashUrls(bestAudio);
  const quality = getInt(bestVideo, 'id');
  return {
    videoUrl: videoUrls[0],
    audioUrl: audioUrls[0],
    videoBackupUrls: videoUrls.slice(1),
    audioBackupUrls: audioUrls.slice(1),
    videoCodecId: getInt(bestVideo, 'codecid'),
    quality,
    qualityName: qualityName(data, quality),
  };
}

export function parseViewResponse(response: HttpResponse): BilibiliVideoInfo {
  const payload = jsonResponse(response, 'BILIBILI_VIDEO_INFO_UNAVAILABLE');
  const data = apiData(payload, 'BILIBILI_VIDEO_INFO_UNAVAILABLE');
  if (!isPlainObject(data)) {
    throw new BilibiliFallbackError(
      'BILIBILI_VIDEO_INFO_UNAVAILABLE',
      'Bilibili video information response was malformed.',
    );
  }

  const bvid = getStr(data, 'bvid');
  const aid = getInt(data, 'aid');
  const pagesObj = data['pages'];
  const pages: BilibiliPage[] = [];
  if (Array.isArray(pagesObj)) {
    for (const rawPage of pagesObj) {
      if (!isPlainObject(rawPage)) continue;
      const cid = getInt(rawPage, 'cid');
      if (cid <= 0) continue;
      pages.push({
        cid,
        page: getInt(rawPage, 'page') || pages.length + 1,
        part: getStr(rawPage, 'part'),
        durationSeconds: getInt(rawPage, 'duration'),
      });
    }
  }
  if (bvid === '' || aid <= 0 || pages.length === 0) {
    throw new BilibiliFallbackError(
      'BILIBILI_VIDEO_INFO_UNAVAILABLE',
      'Bilibili video information was incomplete.',
    );
  }
  return {bvid, aid, title: getStr(data, 'title'), pages};
}

export function parsePlayurlResponse(
  response: HttpResponse,
): Record<string, unknown> {
  const payload = jsonResponse(response, 'BILIBILI_NO_PLAYABLE_STREAM');
  const data = apiData(payload, 'BILIBILI_NO_PLAYABLE_STREAM');
  if (!isPlainObject(data)) {
    throw new BilibiliFallbackError(
      'BILIBILI_NO_PLAYABLE_STREAM',
      'Bilibili playurl response was malformed.',
    );
  }
  return data;
}

function jsonResponse(
  response: HttpResponse,
  unavailableCode: 'BILIBILI_VIDEO_INFO_UNAVAILABLE' | 'BILIBILI_NO_PLAYABLE_STREAM',
): Record<string, unknown> {
  if (response.status === 401 || response.status === 403) {
    throw new BilibiliFallbackError(
      'BILIBILI_LOGIN_REQUIRED',
      'Bilibili video requires login or account authorization.',
    );
  }
  if (response.status < 200 || response.status >= 300 || response.body.length === 0) {
    throw new BilibiliFallbackError(unavailableCode, 'Bilibili API response was unavailable.');
  }

  const body = decodeResponseBody(response);
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new BilibiliFallbackError(unavailableCode, 'Bilibili API response was not JSON.');
  }
  if (!isPlainObject(payload)) {
    throw new BilibiliFallbackError(unavailableCode, 'Bilibili API response was malformed.');
  }
  return payload;
}

function apiData(
  payload: Readonly<Record<string, unknown>>,
  unavailableCode: 'BILIBILI_VIDEO_INFO_UNAVAILABLE' | 'BILIBILI_NO_PLAYABLE_STREAM',
): unknown {
  const code = getInt(payload, 'code');
  if (code !== 0) {
    const message = getStr(payload, 'message') || getStr(payload, 'msg');
    const lowered = message.toLowerCase();
    const loginCodes = new Set([-101, -102, -104, -404, -403]);
    const markers = ['login', '登录', '权限', '会员', 'vip'];
    if (loginCodes.has(code) || markers.some((marker) => lowered.includes(marker))) {
      throw new BilibiliFallbackError(
        'BILIBILI_LOGIN_REQUIRED',
        'Bilibili video requires login or account authorization.',
      );
    }
    throw new BilibiliFallbackError(unavailableCode, 'Bilibili API returned an error.');
  }
  return payload['data'];
}

type Score = readonly number[];

function videoStreamScore(item: Readonly<Record<string, unknown>>): Score {
  const codecid = getInt(item, 'codecid');
  return [
    CODEC_RANK.get(codecid) ?? 0,
    getInt(item, 'bandwidth'),
    getInt(item, 'width') * getInt(item, 'height'),
    getInt(item, 'id'),
    collectDashUrls(item).length,
  ];
}

function audioStreamScore(item: Readonly<Record<string, unknown>>): Score {
  return [
    getInt(item, 'bandwidth'),
    getInt(item, 'id'),
    collectDashUrls(item).length,
  ];
}

/** 字典序比较；相等时保留先出现的那个，与 Python `max` 一致。 */
function maxBy<T>(items: readonly T[], score: (item: T) => Score): T {
  let best = items[0];
  let bestScore = score(best);
  for (const item of items.slice(1)) {
    const candidate = score(item);
    if (compareScores(candidate, bestScore) > 0) {
      best = item;
      bestScore = candidate;
    }
  }
  return best;
}

function compareScores(left: Score, right: Score): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function collectDashUrls(item: Readonly<Record<string, unknown>>): string[] {
  const primary = getStr(item, 'baseUrl') || getStr(item, 'base_url');
  const backups = [...getStrs(item['backupUrl']), ...getStrs(item['backup_url'])];
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const rawUrl of [primary, ...backups]) {
    const url = rawUrl.trim();
    if (url === '' || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

function raiseIfDrm(item: Readonly<Record<string, unknown>>): void {
  if (getInt(item, 'drm_tech_type') > 0 || getStr(item, 'bilidrm_uri') !== '') {
    throw new BilibiliFallbackError(
      'BILIBILI_DRM_PROTECTED',
      'Selected Bilibili DASH stream is DRM protected.',
    );
  }
}

function qualityName(
  data: Readonly<Record<string, unknown>>,
  qualityId: number,
): string {
  const formats = data['support_formats'];
  if (!Array.isArray(formats)) return '';
  for (const item of formats) {
    if (!isPlainObject(item) || getInt(item, 'quality') !== qualityId) continue;
    return getStr(item, 'new_description')
      || getStr(item, 'display_desc')
      || getStr(item, 'description');
  }
  return '';
}

function getStr(mapping: Readonly<Record<string, unknown>>, key: string): string {
  const value = mapping[key];
  return typeof value === 'string' ? value.trim() : '';
}

function getStrs(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? [] : [trimmed];
  }
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item !== '');
  }
  return [];
}

function getInt(mapping: Readonly<Record<string, unknown>>, key: string): number {
  return pythonInt(mapping[key]) ?? 0;
}

function pythonInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^[+-]?\d+$/u.test(trimmed)) return null;
    return Number.parseInt(trimmed, 10);
  }
  return null;
}

function asMapping(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? value : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pythonQuote(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}
