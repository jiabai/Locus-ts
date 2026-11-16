// 小红书候选流解析：对齐 `worker/worker_core/xiaohongshu/streams.py`。
//
// 页面里同一画质可能出现多条（不同编码/备用 CDN）；按与 Python 完全相同的九元组
// 打分，同分保留先出现的那条，最后按分数降序尝试。
import {stripPythonSpace} from '../../protocol/process-request.ts';
import {asMapping} from './page.ts';
import type {XiaohongshuStreamCandidate} from './types.ts';

export interface ParseVideoStreamsOptions {
  readonly candidateHeaders: Readonly<Record<string, string>>;
}

export function parseVideoStreams(
  noteObject: Readonly<Record<string, unknown>>,
  options: ParseVideoStreamsOptions,
): XiaohongshuStreamCandidate[] {
  const video = asMapping(noteObject.video);
  const media = video === null ? null : asMapping(video.media);
  const stream = media === null ? undefined : media.stream;
  const rawCandidates: {readonly raw: Record<string, unknown>; readonly hint: string}[] = [];

  if (Array.isArray(stream)) {
    for (const item of stream) {
      const raw = asMapping(item);
      if (raw !== null) rawCandidates.push({raw, hint: ''});
    }
  } else {
    const streamMapping = asMapping(stream);
    if (streamMapping !== null) {
      for (const [codecKey, codecStreams] of Object.entries(streamMapping)) {
        if (!Array.isArray(codecStreams)) continue;
        for (const item of codecStreams) {
          const raw = asMapping(item);
          if (raw !== null) rawCandidates.push({raw, hint: codecKey});
        }
      }
    }
  }

  const bestByKey = new Map<string, XiaohongshuStreamCandidate>();
  for (const {raw, hint} of rawCandidates) {
    const candidate = parseStreamCandidate(raw, hint, options.candidateHeaders);
    if (candidate === null) continue;
    const existing = bestByKey.get(candidate.qualityKey);
    if (existing === undefined || compareScore(candidate, existing) > 0) {
      bestByKey.set(candidate.qualityKey, candidate);
    }
  }

  return [...bestByKey.values()].sort((left, right) => compareScore(right, left));
}

export function collectDownloadUrls(
  primaryUrl: string,
  backupUrls: readonly string[],
): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const rawUrl of [primaryUrl, ...backupUrls]) {
    const url = stripPythonSpace(rawUrl);
    if (url === '' || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

function parseStreamCandidate(
  raw: Readonly<Record<string, unknown>>,
  codecHint: string,
  candidateHeaders: Readonly<Record<string, string>>,
): XiaohongshuStreamCandidate | null {
  const urls = collectDownloadUrls(
    getString(raw, 'masterUrl') || getString(raw, 'url'),
    getStrings(raw.backupUrls),
  );
  if (urls.length === 0) return null;

  const streamType = getInt(raw, 'streamType');
  let qualityName = getString(raw, 'qualityType') || getString(raw, 'quality');
  if (qualityName === '' && streamType > 0) qualityName = `Stream ${streamType}`;
  const qualityKey = buildQualityKey(qualityName, streamType);

  return {
    qualityKey,
    url: urls[0],
    backupUrls: urls.slice(1),
    sizeBytes: getInt(raw, 'size'),
    width: optionalInt(raw, 'width'),
    height: optionalInt(raw, 'height'),
    videoCodec: getString(raw, 'videoCodec') || codecHint,
    videoBitrate: getInt(raw, 'videoBitrate'),
    streamType,
    weight: getInt(raw, 'weight'),
    defaultStream: getInt(raw, 'defaultStream'),
    headers: {...candidateHeaders},
  };
}

function compareScore(
  left: XiaohongshuStreamCandidate,
  right: XiaohongshuStreamCandidate,
): number {
  const leftScore = streamScore(left);
  const rightScore = streamScore(right);
  for (let index = 0; index < leftScore.length; index += 1) {
    if (leftScore[index] !== rightScore[index]) {
      return leftScore[index] > rightScore[index] ? 1 : -1;
    }
  }
  return 0;
}

function streamScore(
  candidate: XiaohongshuStreamCandidate,
): readonly number[] {
  const pixels = (candidate.width ?? 0) * (candidate.height ?? 0);
  return [
    stripPythonSpace(candidate.url) !== '' ? 1 : 0,
    codecRank(candidate.videoCodec, candidate.streamType),
    candidate.weight,
    streamTypeRank(candidate.streamType),
    candidate.defaultStream,
    pixels,
    candidate.videoBitrate,
    candidate.sizeBytes,
    candidate.backupUrls.length,
  ];
}

function codecRank(codec: string, streamType: number): number {
  const normalized = codec.toLowerCase()
    .replaceAll('.', '')
    .replaceAll('-', '')
    .replaceAll('_', '');
  if (normalized === 'h265' || normalized === 'hevc'
    || streamType === 114 || streamType === 115) {
    return 4;
  }
  if (normalized === 'h264' || normalized === 'avc' || streamType === 259) return 3;
  if (normalized === 'av1' || normalized === 'h266' || normalized === 'vvc') return 2;
  return 1;
}

function streamTypeRank(streamType: number): number {
  if (streamType === 115) return 300;
  if (streamType === 114) return 200;
  if (streamType === 259) return 100;
  return 0;
}

function buildQualityKey(qualityName: string, streamType: number): string {
  let base = stripPythonSpace(qualityName).toLowerCase();
  if (streamType > 0) {
    if (base === '' || base.startsWith('stream ')) return `stream_${streamType}`;
    base = base.replace(/[\s/\\:]+/gu, '_');
    return `${base}_${streamType}`;
  }
  return base === '' ? 'default' : base;
}

function getString(mapping: Readonly<Record<string, unknown>>, key: string): string {
  const value = mapping[key];
  return typeof value === 'string' ? stripPythonSpace(value) : '';
}

function getStrings(value: unknown): string[] {
  if (typeof value === 'string') {
    const text = stripPythonSpace(value);
    return text === '' ? [] : [text];
  }
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => stripPythonSpace(item))
      .filter((item) => item !== '');
  }
  return [];
}

/** `int(value)` 的语义：数字截断取整、布尔当 0/1、字符串只认十进制整数。 */
export function getInt(mapping: Readonly<Record<string, unknown>>, key: string): number {
  return pythonInt(mapping[key]);
}

function optionalInt(
  mapping: Readonly<Record<string, unknown>>,
  key: string,
): number | null {
  const value = getInt(mapping, key);
  return value === 0 ? null : value;
}

export function pythonInt(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value) : 0;
  }
  if (typeof value === 'string') {
    const text = stripPythonSpace(value);
    if (!/^[+-]?\d(?:_?\d)*$/u.test(text)) return 0;
    const parsed = Number.parseInt(text.replaceAll('_', ''), 10);
    return Number.isSafeInteger(parsed) ? parsed : 0;
  }
  return 0;
}
