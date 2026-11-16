// 小红书下载编排：对齐 `worker/worker_core/xiaohongshu_fallback.py`。
//
// 公开笔记页 → 候选流 → 有序尝试（每个候选的主地址与备用地址）→ 顺便抓一条字幕。
// 字幕是「尽力而为」：解析、页面、下载任一环节失败都不影响视频本身；只有视频
// 全部候选都失败时才按最后一个错误归类，尺寸超限与停滞各有独立失败码。
import {mkdir} from 'node:fs/promises';
import path from 'node:path';

import {buildWorkerProgressEvent} from '../../protocol/events.ts';
import type {WorkerProgressEvent} from '../../protocol/events.ts';
import {
  decodeResponseBody,
  extractInitialState,
  isImageOnlyNote,
  lookupNote,
  raiseForPageResponse,
} from './page.ts';
import {buildExploreUrl, parseXiaohongshuSource} from './source.ts';
import {collectDownloadUrls, parseVideoStreams} from './streams.ts';
import {selectPreferredSubtitleTrack} from './subtitles.ts';
import {
  FetchXiaohongshuHttpClient,
  downloadStreamToPath,
  downloadSubtitleToPath,
  isDownloadAttemptError,
  mapDownloadError,
  mediaHeaders,
  pageHeaders,
} from './transport.ts';
import {XiaohongshuFallbackError} from './types.ts';
import type {
  XiaohongshuHttpClient,
  XiaohongshuParseResult,
  XiaohongshuStreamCandidate,
} from './types.ts';

type ProgressCallback = (event: WorkerProgressEvent) => void;

export interface DownloadXiaohongshuVideoOptions {
  readonly httpClient?: XiaohongshuHttpClient;
  readonly onProgress?: ProgressCallback;
}

export interface DownloadXiaohongshuSubtitleOptions {
  readonly httpClient?: XiaohongshuHttpClient;
}

export async function parseXiaohongshuInput(
  rawInput: string,
  httpClient?: XiaohongshuHttpClient,
): Promise<XiaohongshuParseResult> {
  const client = httpClient ?? new FetchXiaohongshuHttpClient();
  return parseXiaohongshuSource(rawInput, client);
}

export function parseVideoStreamCandidates(
  state: Readonly<Record<string, unknown>>,
  noteId: string,
): XiaohongshuStreamCandidate[] {
  return parseVideoStreams(lookupNote(state, noteId), {
    candidateHeaders: mediaHeaders(),
  });
}

export async function downloadXiaohongshuVideo(
  rawInput: string,
  outputDir: string,
  options: DownloadXiaohongshuVideoOptions = {},
): Promise<string> {
  const client = options.httpClient ?? new FetchXiaohongshuHttpClient();
  const parsed = await parseXiaohongshuInput(rawInput, client);

  emitProgress(options.onProgress, 'xiaohongshu.page.resolving', 22);
  const noteObject = await loadPublicNote(parsed, client);
  const candidates = parseVideoStreams(noteObject, {candidateHeaders: mediaHeaders()});
  if (candidates.length === 0) {
    if (isImageOnlyNote(noteObject)) {
      throw new XiaohongshuFallbackError(
        'XHS_IMAGE_ONLY',
        'Xiaohongshu note is image-only and has no playable video.',
      );
    }
    throw new XiaohongshuFallbackError(
      'XHS_NO_PLAYABLE_STREAM',
      'Xiaohongshu public note returned no playable video stream.',
    );
  }

  await mkdir(outputDir, {recursive: true});
  const outputPath = path.join(outputDir, `${parsed.noteId}.mp4`);
  emitProgress(options.onProgress, 'xiaohongshu.video.saving', 30);
  const videoPath = await downloadFirstAvailableStream(
    candidates,
    outputPath,
    client,
    options.onProgress,
  );
  await downloadPreferredSubtitleBestEffort(noteObject, parsed.noteId, outputDir, client);
  return videoPath;
}

/** 字幕探测：任何失败都收敛成 `null`，调用方（含 yt-dlp 成功后的探测）不感知错误。 */
export async function downloadXiaohongshuSubtitle(
  rawInput: string,
  outputDir: string,
  options: DownloadXiaohongshuSubtitleOptions = {},
): Promise<string | null> {
  const client = options.httpClient ?? new FetchXiaohongshuHttpClient();
  try {
    const parsed = await parseXiaohongshuInput(rawInput, client);
    const noteObject = await loadPublicNote(parsed, client);
    return await downloadPreferredSubtitleBestEffort(
      noteObject,
      parsed.noteId,
      outputDir,
      client,
    );
  } catch (error) {
    if (isDownloadAttemptError(error)) return null;
    throw error;
  }
}

async function loadPublicNote(
  parsed: XiaohongshuParseResult,
  client: XiaohongshuHttpClient,
): Promise<Record<string, unknown>> {
  const pageResponse = await client.get(
    buildExploreUrl(parsed.noteId, parsed.xsecToken),
    pageHeaders(),
    10,
  );
  raiseForPageResponse(pageResponse);
  const state = extractInitialState(decodeResponseBody(pageResponse));
  return lookupNote(state, parsed.noteId);
}

async function downloadPreferredSubtitleBestEffort(
  noteObject: Readonly<Record<string, unknown>>,
  noteId: string,
  outputDir: string,
  client: XiaohongshuHttpClient,
): Promise<string | null> {
  const track = selectPreferredSubtitleTrack(noteObject);
  if (track === null) return null;
  await mkdir(outputDir, {recursive: true});
  const outputPath = path.join(outputDir, `${noteId}.${track.language}${track.suffix}`);
  try {
    await downloadSubtitleToPath(track.url, outputPath, client);
  } catch (error) {
    if (isDownloadAttemptError(error)) return null;
    throw error;
  }
  return outputPath;
}

async function downloadFirstAvailableStream(
  candidates: readonly XiaohongshuStreamCandidate[],
  outputPath: string,
  httpClient: XiaohongshuHttpClient,
  progressCallback?: ProgressCallback,
): Promise<string> {
  let lastError: unknown = null;
  for (const [index, candidate] of candidates.entries()) {
    for (const streamUrl of streamUrls(candidate)) {
      try {
        await downloadStreamToPath(streamUrl, outputPath, httpClient);
      } catch (error) {
        if (!isDownloadAttemptError(error)) throw error;
        lastError = error;
        continue;
      }
      return outputPath;
    }
    emitStreamRetry(progressCallback, index, candidates.length);
  }

  throw mapDownloadError(lastError);
}

function streamUrls(candidate: XiaohongshuStreamCandidate): string[] {
  return collectDownloadUrls(candidate.url, candidate.backupUrls);
}

function emitProgress(
  progressCallback: ProgressCallback | undefined,
  messageCode: 'xiaohongshu.page.resolving' | 'xiaohongshu.video.saving'
    | 'xiaohongshu.stream.retrying',
  progress: number,
  messageArgs?: Readonly<Record<string, number>>,
): void {
  if (progressCallback === undefined) return;
  progressCallback(buildWorkerProgressEvent(messageCode, {
    stage: 'video_extracting',
    progress,
    ...(messageArgs === undefined ? {} : {messageArgs}),
  }));
}

/** 与 Python `_emit_stream_retry` 同位：只在「还有下一个候选」时报重试。 */
export function emitStreamRetry(
  progressCallback: ProgressCallback | undefined,
  failedIndex: number,
  total: number,
): void {
  if (progressCallback === undefined || failedIndex >= total - 1) return;
  const attempt = failedIndex + 2;
  if (!(attempt >= 1 && attempt <= total && total <= 100)) return;
  emitProgress(progressCallback, 'xiaohongshu.stream.retrying', 30, {attempt, total});
}
