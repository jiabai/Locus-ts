// 抖音下载编排：对齐 `worker/worker_core/douyin_fallback.py`。
//
// 分享页偶尔退化成不含 `videoInfoRes` 的瘦身文档，这是服务端的瞬时状态，
// 重试比失败更合理；退避 3–10 秒随机，最多三次。流下载走候选顺序重试，
// 每个候选带一次续传机会，进度按 8 MB 一档、最多推到 33%。
import {buildWorkerProgressEvent} from '../../protocol/events.ts';
import type {WorkerProgressEvent} from '../../protocol/events.ts';
import {parseSharePageRouterData} from './page.ts';
import {buildSharePageUrl, resolveAwemeIdFromInput} from './source.ts';
import {collectStreamCandidates, selectStreamCandidates} from './streams.ts';
import {
  DOUYIN_STREAM_SOCKET_TIMEOUT_SECONDS,
  FetchDouyinHttpClient,
  downloadOrderedCandidates,
  publicHeaders,
} from './transport.ts';
import {DouyinFallbackError} from './types.ts';
import type {DouyinHttpClient, DouyinStreamCandidate} from './types.ts';

export const SHARE_PAGE_ATTEMPTS = 3;
export const SHARE_PAGE_RETRY_DELAY_RANGE_SECONDS: readonly [number, number] = [3, 10];
export const SHARE_PAGE_RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  'DOUYIN_ROUTER_DATA_MISSING',
  'DOUYIN_ROUTER_DATA_MALFORMED',
  'DOUYIN_SHARE_PAGE_UNAVAILABLE',
]);
/** 字节进度的事件间隔：足够密集以反映下载仍在推进，又不至于淹没进度通道。 */
export const STREAM_PROGRESS_EMIT_INTERVAL_BYTES = 8 * 1024 * 1024;
export const STREAM_PROGRESS_MAX_STEP = 3;

type ProgressCallback = (event: WorkerProgressEvent) => void;

export async function downloadFirstAvailableCandidate(
  awemeId: string,
  candidates: readonly DouyinStreamCandidate[],
  outputDir: string,
  httpClient: DouyinHttpClient,
  timeoutSeconds: number = DOUYIN_STREAM_SOCKET_TIMEOUT_SECONDS,
  progressCallback?: ProgressCallback,
): Promise<string> {
  const sortedCandidates = selectStreamCandidates(candidates);
  return downloadOrderedCandidates(
    awemeId,
    sortedCandidates,
    outputDir,
    httpClient,
    timeoutSeconds,
    (failedIndex, total) => emitStreamRetry(progressCallback, failedIndex, total),
    streamProgressEmitter(progressCallback),
  );
}

/** 把字节进度映射成 `30 + step`，只前进不回退。 */
export function streamProgressEmitter(
  progressCallback?: ProgressCallback,
): ((downloadedBytes: number, totalBytes: number) => void) | undefined {
  if (progressCallback === undefined) return undefined;
  let lastEmittedBytes = 0;
  let lastStep = 0;
  return (downloadedBytes: number, totalBytes: number): void => {
    if (totalBytes <= 0) return;
    if (downloadedBytes - lastEmittedBytes < STREAM_PROGRESS_EMIT_INTERVAL_BYTES) return;
    lastEmittedBytes = downloadedBytes;
    const ratio = Math.min(1, downloadedBytes / totalBytes);
    const step = Math.min(STREAM_PROGRESS_MAX_STEP, Math.trunc(ratio * (STREAM_PROGRESS_MAX_STEP + 1)));
    if (step <= lastStep) return;
    lastStep = step;
    emitProgress(progressCallback, 'douyin.video.saving', 30 + step);
  };
}

export interface ResolveSharePageOptions {
  readonly onProgress?: ProgressCallback;
  readonly sleeper?: (seconds: number) => Promise<void>;
  readonly random?: () => number;
}

export async function resolveSharePageItem(
  awemeId: string,
  httpClient: DouyinHttpClient,
  options: ResolveSharePageOptions = {},
): Promise<Record<string, unknown>> {
  const sleep = options.sleeper ?? defaultSleeper;
  const random = options.random ?? Math.random;
  let lastError: DouyinFallbackError | null = null;

  for (let attempt = 1; attempt <= SHARE_PAGE_ATTEMPTS; attempt += 1) {
    try {
      return await fetchSharePageItem(awemeId, httpClient);
    } catch (error) {
      if (!(error instanceof DouyinFallbackError)) throw error;
      if (!SHARE_PAGE_RETRYABLE_ERROR_CODES.has(error.code)) throw error;
      lastError = error;
      const nextAttempt = attempt + 1;
      if (nextAttempt > SHARE_PAGE_ATTEMPTS) break;
      emitProgress(options.onProgress, 'douyin.page.retrying', 22, {
        attempt: nextAttempt,
        total: SHARE_PAGE_ATTEMPTS,
      });
      const [low, high] = SHARE_PAGE_RETRY_DELAY_RANGE_SECONDS;
      await sleep(low + random() * (high - low));
    }
  }

  if (lastError === null) {
    throw new DouyinFallbackError('DOUYIN_SHARE_PAGE_UNAVAILABLE',
      'Douyin public share page was unavailable.');
  }
  throw lastError;
}

async function fetchSharePageItem(
  awemeId: string,
  httpClient: DouyinHttpClient,
): Promise<Record<string, unknown>> {
  const shareResponse = await httpClient.get(buildSharePageUrl(awemeId), publicHeaders(), 10);
  if (shareResponse.status !== 200 || shareResponse.body.length === 0) {
    throw new DouyinFallbackError(
      'DOUYIN_SHARE_PAGE_UNAVAILABLE',
      'Douyin public share page was unavailable.',
    );
  }
  return parseSharePageRouterData(new TextDecoder('utf-8').decode(shareResponse.body));
}

export interface DownloadDouyinVideoOptions {
  readonly httpClient?: DouyinHttpClient;
  readonly onProgress?: ProgressCallback;
  readonly sleeper?: (seconds: number) => Promise<void>;
  readonly random?: () => number;
}

export async function downloadDouyinVideo(
  url: string,
  outputDir: string,
  options: DownloadDouyinVideoOptions = {},
): Promise<string> {
  const client = options.httpClient ?? new FetchDouyinHttpClient();
  const awemeId = await resolveAwemeIdFromInput(url, client);
  if (awemeId === null) {
    throw new DouyinFallbackError(
      'DOUYIN_ID_PARSE_FAILED',
      'Could not extract Douyin video ID from URL.',
    );
  }

  emitProgress(options.onProgress, 'douyin.page.resolving', 22);
  const item = await resolveSharePageItem(awemeId, client, {
    ...(options.onProgress === undefined ? {} : {onProgress: options.onProgress}),
    ...(options.sleeper === undefined ? {} : {sleeper: options.sleeper}),
    ...(options.random === undefined ? {} : {random: options.random}),
  });

  emitProgress(options.onProgress, 'douyin.stream.probing', 26);
  const candidates = await collectStreamCandidates(item, client);
  if (candidates.length === 0) {
    throw new DouyinFallbackError(
      'DOUYIN_NO_PLAYABLE_STREAM',
      'Douyin public share page returned no playable streams.',
    );
  }

  emitProgress(options.onProgress, 'douyin.video.saving', 30);
  return downloadFirstAvailableCandidate(
    awemeId,
    candidates,
    outputDir,
    client,
    DOUYIN_STREAM_SOCKET_TIMEOUT_SECONDS,
    options.onProgress,
  );
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
  emitProgress(progressCallback, 'douyin.stream.retrying', 30, {attempt, total});
}

function emitProgress(
  progressCallback: ProgressCallback | undefined,
  messageCode: 'douyin.page.resolving' | 'douyin.page.retrying' | 'douyin.stream.probing'
    | 'douyin.video.saving' | 'douyin.stream.retrying',
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

async function defaultSleeper(seconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}
