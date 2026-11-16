// 抖音流候选：对齐 `worker/worker_core/douyin/streams.py`。
//
// 优先用分享页里声明的 `bit_rate` 档位；没有声明时按 1080p→360p 依次探测
// `play_addr.uri` 的播放地址。排序不看分辨率标签，只看声明大小——抖音的档位名
// 并不可靠，大小才是实际拿得到的字节数。
import {publicHeaders} from './transport.ts';
import {DouyinFallbackError} from './types.ts';
import type {DouyinHttpClient, DouyinStreamCandidate} from './types.ts';

export const PLAY_QUALITIES: readonly string[] = ['1080p', '720p', '540p', '480p', '360p'];
const QUALITY_RANK = new Map(PLAY_QUALITIES.map((quality, index) => [quality, index]));
const CONTENT_RANGE_TOTAL_PATTERN = /\/(\d+)\s*$/u;

/** `quote(uri, safe="")`：`encodeURIComponent` 额外放过 `!'()*`，逐字补编码。 */
export function buildPlayUrl(uri: string, quality: string): string {
  const videoId = encodeURIComponent(uri)
    .replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return 'https://www.iesdouyin.com/aweme/v1/play/'
    + `?video_id=${videoId}&ratio=${quality}&line=0`;
}

export async function collectStreamCandidates(
  item: Readonly<Record<string, unknown>>,
  httpClient: DouyinHttpClient,
  timeoutSeconds = 10,
): Promise<DouyinStreamCandidate[]> {
  const video = item['video'];
  if (!isPlainObject(video)) {
    throw new DouyinFallbackError('DOUYIN_NO_PLAYABLE_STREAM', 'Douyin item has no video.');
  }

  let candidates = collectBitRateCandidates(video);
  if (candidates.length === 0) {
    candidates = await probePlayAddrCandidates(video, httpClient, timeoutSeconds);
  }
  return selectStreamCandidates(candidates);
}

/** 大文件优先；同大小按档位名排序，再按“已见过的大小”去重。 */
export function selectStreamCandidates(
  candidates: readonly DouyinStreamCandidate[],
): DouyinStreamCandidate[] {
  const sorted = [...candidates].sort((left, right) => {
    if (left.sizeBytes !== right.sizeBytes) return right.sizeBytes - left.sizeBytes;
    return qualityRank(left.quality) - qualityRank(right.quality);
  });
  const seenSizes = new Set<number>();
  const deduped: DouyinStreamCandidate[] = [];
  for (const candidate of sorted) {
    if (candidate.sizeBytes <= 0 || seenSizes.has(candidate.sizeBytes)) continue;
    seenSizes.add(candidate.sizeBytes);
    deduped.push(candidate);
  }
  return deduped;
}

function qualityRank(quality: string): number {
  return QUALITY_RANK.get(quality) ?? QUALITY_RANK.size;
}

function collectBitRateCandidates(
  video: Readonly<Record<string, unknown>>,
): DouyinStreamCandidate[] {
  const bitRates = video['bit_rate'];
  if (!Array.isArray(bitRates)) return [];

  const candidates: DouyinStreamCandidate[] = [];
  for (const bitRate of bitRates) {
    if (!isPlainObject(bitRate)) continue;
    const playAddr = bitRate['play_addr'];
    if (!isPlainObject(playAddr)) continue;
    const url = firstUrl(playAddr);
    const sizeBytes = parsePythonInt(pick(
      bitRate['data_size'], bitRate['size'], playAddr['data_size'], playAddr['size'],
    ));
    if (url === null || sizeBytes === null || sizeBytes === 0) continue;
    const quality = pythonStr(pick(
      bitRate['gear_name'], bitRate['quality'], bitRate['quality_type'], 'unknown',
    ));
    candidates.push({
      quality,
      url,
      sizeBytes,
      width: parsePythonInt(pick(playAddr['width'], bitRate['width'])),
      height: parsePythonInt(pick(playAddr['height'], bitRate['height'])),
      headers: publicHeaders(),
    });
  }
  return candidates;
}

async function probePlayAddrCandidates(
  video: Readonly<Record<string, unknown>>,
  httpClient: DouyinHttpClient,
  timeoutSeconds: number,
): Promise<DouyinStreamCandidate[]> {
  const playAddr = video['play_addr'];
  const uri = isPlainObject(playAddr) ? playAddr['uri'] : null;
  if (typeof uri !== 'string' || uri.trim() === '') return [];

  const candidates: DouyinStreamCandidate[] = [];
  for (const quality of PLAY_QUALITIES) {
    const probeUrl = buildPlayUrl(uri, quality);
    const probeHeaders = publicHeaders({Range: 'bytes=0-1'});
    let response;
    try {
      response = await httpClient.get(probeUrl, probeHeaders, timeoutSeconds);
    } catch {
      // 探测失败只说明这一档不可用，不影响其它档位。
      continue;
    }
    const sizeBytes = parseContentRangeTotal(headerOf(response.headers, 'Content-Range'));
    if (response.status !== 206 || sizeBytes === null || sizeBytes === 0
      || !isMediaContentType(headerOf(response.headers, 'Content-Type'))) {
      continue;
    }
    candidates.push({
      quality,
      url: response.url,
      sizeBytes,
      headers: publicHeaders(),
    });
  }
  return candidates;
}

function firstUrl(playAddr: Readonly<Record<string, unknown>>): string | null {
  const urlList = playAddr['url_list'];
  if (Array.isArray(urlList)) {
    for (const url of urlList) {
      if (typeof url === 'string' && url !== '') return url;
    }
  }
  const url = playAddr['url'];
  return typeof url === 'string' && url !== '' ? url : null;
}

/** Python `a or b or c`：取第一个真值，全空时返回 null。 */
function pick(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== false && value !== 0 && value !== '') {
      return value;
    }
  }
  return null;
}

function pythonStr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return String(value);
}

/** 尽力复刻 Python `int()`：数字截断、布尔转 0/1、十进制字符串可解析。 */
function parsePythonInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Math.trunc(value);
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^[+-]?\d+$/u.test(trimmed)) return null;
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function parseContentRangeTotal(contentRange: string | null): number | null {
  if (contentRange === null || contentRange === '') return null;
  const match = CONTENT_RANGE_TOTAL_PATTERN.exec(contentRange);
  if (match === null) return null;
  return parsePythonInt(match[1]);
}

function headerOf(headers: Readonly<Record<string, string>>, name: string): string | null {
  const lowered = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowered) return value;
  }
  return null;
}

function isMediaContentType(contentType: string | null): boolean {
  if (contentType === null || contentType === '') return true;
  const normalized = contentType.split(';', 1)[0].trim().toLowerCase();
  return normalized.startsWith('video/') || normalized === 'application/octet-stream';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
