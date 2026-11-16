// 模型准备：按需下载、进度、取消与原子提交。
//
// 行为对齐 `worker/worker_core/model_download.py` 的 ONNX 分支：同一个缓存布局
// （`<根>/models/onnx`）、同一份 `MODEL_VERSION.txt` 就绪标记、同一组固定哈希、
// 同样的「staging → 自校验 → 整目录替换」提交顺序，以及同样的进度事件编码。
// 唯一的实现差异是来源：Python 走 `modelscope` SDK，这里直接请求 ModelScope 的公开
// 文件端点。完整性不依赖 SDK，而依赖 `model-assets.ts` 里逐文件固定的 SHA-256；
// 端点只是搬运工，搬错一个字节就会被哈希拦下。
import {mkdir, open, readdir, rename, rm, stat, statfs} from 'node:fs/promises';
import path from 'node:path';

import {
  ASRModelArchiveInvalidError,
  ASRModelDownloadFailedError,
  ModelDownloadCancelledError,
  isASRError,
} from './errors.ts';
import {
  BPE_SOURCE_MODEL_ID,
  DEFAULT_MODEL_REVISION,
  MODEL_DOWNLOAD_SOURCES,
  MODEL_VERSION_FILE_NAME,
  SENSEVOICE_MODEL_ID,
  VAD_MODEL_ID,
  modelVersionMarker,
  pinnedAssetHashes,
} from './model-assets.ts';
import {fileSha256, resolveModelCacheDir, validateModelCache} from './model-cache.ts';

/** ModelScope 公开文件端点。固定官方来源：不接受自定义 URL、镜像或修订。 */
export const MODEL_REPOSITORY_ENDPOINT = 'https://www.modelscope.cn/api/v1/models';
/**
 * 开始下载前要求的最小剩余空间。与 Python 的 `MIN_MODEL_DOWNLOAD_FREE_BYTES` 一致：
 * 两者判定不同会让「同一台机器上 Python 能下、TypeScript 不能下」变成用户可见的差异。
 */
export const MIN_MODEL_DOWNLOAD_FREE_BYTES = 2 * 1024 ** 3;
/** 单个文件上限，防止坏端点把磁盘写满。 */
export const MAX_MODEL_FILE_BYTES = 2 * 1024 ** 3;
export const DOWNLOAD_ATTEMPTS = 3;
/** 单次读的超时。Python 用 `urlopen(timeout=30)`，这里按空闲读计时。 */
export const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;
export const PROGRESS_EVENT_MIN_INTERVAL_MS = 100;
export const PROGRESS_EVENT_MIN_PERCENT_STEP = 1;

// 进度事件编码与状态沿用 Python 的 `MODEL_PROGRESS_REGISTRY`，字段名保持 snake_case，
// 因为这条事件流直接进桌面 UI。`scripts/tests/asr-verification-assets.test.mjs`
// 会把这张表与 Python 注册表逐项比对。
export const MODEL_PROGRESS_SPECS = {
  'model.download.preparing': {status: 'started', currentFile: 'forbidden', messageArgs: ['model']},
  'model.primary.downloading': {status: 'downloading', currentFile: 'forbidden', messageArgs: ['model']},
  'model.vad.downloading': {status: 'downloading', currentFile: 'forbidden', messageArgs: ['model']},
  'model.bpe.downloading': {status: 'downloading', currentFile: 'forbidden', messageArgs: ['model']},
  'model.file.downloading': {status: 'downloading', currentFile: 'required', messageArgs: []},
  'model.file.completed': {status: 'downloading', currentFile: 'required', messageArgs: []},
  'model.download.completed': {status: 'completed', currentFile: 'forbidden', messageArgs: ['model']},
  'model.download.cancelled': {status: 'cancelled', currentFile: 'forbidden', messageArgs: []},
} as const;

export type ModelProgressCode = keyof typeof MODEL_PROGRESS_SPECS;
export type ModelProgressStatus = (typeof MODEL_PROGRESS_SPECS)[ModelProgressCode]['status'];

export interface ModelProgressEvent {
  readonly message_code: ModelProgressCode;
  readonly status: ModelProgressStatus;
  /** 0–100 的整数，随下载推进单调不减。 */
  readonly progress: number;
  readonly current_file?: string;
  readonly message_args?: Readonly<Record<string, string | number>>;
}

export type ModelProgressListener = (event: ModelProgressEvent) => void;

/** 只用到 fetch 的一个子集，便于测试注入而不引入 HTTP 依赖。 */
export interface ModelFetchInit {
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface ModelFetchResponse {
  readonly status: number;
  readonly headers: {get(name: string): string | null};
  readonly body: ReadableStream<Uint8Array> | null;
}

export type ModelFetch = (url: string, init: ModelFetchInit) => Promise<ModelFetchResponse>;

const defaultFetch: ModelFetch = (url, init) => fetch(url, init);

export interface PrepareModelCacheOptions {
  /** 用户数据根；缓存按 `<root>/models/onnx` 解析。 */
  readonly dataRoot?: string;
  /** 直接指定缓存目录，优先于 `dataRoot`（门禁与诊断使用）。 */
  readonly cacheDir?: string;
  readonly onProgress?: ModelProgressListener;
  /** 取消信号。取消后 staging 目录会被清掉，已有缓存不受影响。 */
  readonly signal?: AbortSignal;
  /** 测试注入；生产路径始终用全局 fetch。 */
  readonly fetchImpl?: ModelFetch;
  readonly now?: () => number;
  /** 测试注入的剩余空间探测；返回 `null` 表示无法判断（此时跳过检查）。 */
  readonly freeBytes?: (dir: string) => Promise<number | null>;
  /**
   * 替换固定哈希，对应 Python 的 `onnx_asset_hashes` 覆盖参数：门禁与单测用假资产
   * 跑通完整提交流程时使用。生产路径不传，永远走 `model-assets.ts` 的固定值。
   */
  readonly assetHashes?: Readonly<Record<string, string>>;
  /** 逐次尝试之间的等待，测试可置零。 */
  readonly retryDelayMs?: (attempt: number) => number;
}

export interface PrepareModelCacheResult {
  /** `<根>/models/onnx`，已通过完整性校验。 */
  readonly cacheDir: string;
  /** false 表示复用已有缓存，没有发起任何请求。 */
  readonly downloaded: boolean;
  readonly bytesDownloaded: number;
}

/** 进度分组：与 Python 的三段权重一致（主模型 → VAD → BPE）。 */
interface DownloadGroup {
  readonly messageCode: ModelProgressCode;
  readonly modelId: string;
  readonly leadProgress: number;
  readonly startProgress: number;
  readonly spanProgress: number;
}

const DOWNLOAD_GROUPS: readonly DownloadGroup[] = [
  {
    messageCode: 'model.primary.downloading',
    modelId: SENSEVOICE_MODEL_ID,
    leadProgress: 8,
    startProgress: 10,
    spanProgress: 48,
  },
  {
    messageCode: 'model.vad.downloading',
    modelId: VAD_MODEL_ID,
    leadProgress: 70,
    startProgress: 70,
    spanProgress: 18,
  },
  {
    messageCode: 'model.bpe.downloading',
    modelId: BPE_SOURCE_MODEL_ID,
    leadProgress: 88,
    startProgress: 88,
    spanProgress: 10,
  },
];

export function buildDownloadUrl(modelId: string, repositoryPath: string): string {
  return `${MODEL_REPOSITORY_ENDPOINT}/${modelId}/repo?Revision=${encodeURIComponent(DEFAULT_MODEL_REVISION)}&FilePath=${encodeURIComponent(repositoryPath)}`;
}

/**
 * 保证缓存可用：已就绪直接返回，缺失或损坏则下载到 staging、自校验、整目录替换。
 * 任何失败都不会留下半份缓存，也不会动到用户已有的正确缓存。
 */
export async function prepareModelCache(
  options: PrepareModelCacheOptions,
): Promise<PrepareModelCacheResult> {
  const cacheDir = resolveCacheDir(options);
  const assetHashes = options.assetHashes ?? pinnedAssetHashes();
  const existing = await validateModelCache(cacheDir, assetHashes);
  if (existing.valid) return {cacheDir, downloaded: false, bytesDownloaded: 0};

  const parentDir = path.dirname(cacheDir);
  const stagingDir = intoStaging(cacheDir);
  const reporter = new ProgressReporter(options.onProgress, options.now ?? Date.now);
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  let bytesDownloaded = 0;

  try {
    await mkdir(parentDir, {recursive: true});
    if (await recoverStaleDirectories(parentDir, path.basename(cacheDir), cacheDir)) {
      // 复原出来的可能就是上一次替换被打断前的那份好缓存，先用先得。
      const restored = await validateModelCache(cacheDir, assetHashes);
      if (restored.valid) return {cacheDir, downloaded: false, bytesDownloaded: 0};
    }
    await assertFreeSpace(parentDir, options.freeBytes);
    reporter.emit('model.download.preparing', 0, {messageArgs: {model: SENSEVOICE_MODEL_ID}});

    for (const group of DOWNLOAD_GROUPS) {
      const entries = downloadPlan(group.modelId, assetHashes);
      reporter.emit(group.messageCode, group.leadProgress, {messageArgs: {model: group.modelId}});
      const spanPerFile = group.spanProgress / entries.length;
      entries.forEach((entry, index) => {
        entry.progressWindow = {
          start: group.startProgress + spanPerFile * index,
          span: spanPerFile,
        };
      });
      for (const entry of entries) {
        bytesDownloaded += await fetchAsset({
          entry,
          stagingDir,
          reporter,
          fetchImpl,
          signal: options.signal,
          retryDelayMs: options.retryDelayMs ?? defaultRetryDelayMs,
        });
      }
    }

    await writeReadyMarker(stagingDir);
    const staged = await validateModelCache(stagingDir, assetHashes);
    if (!staged.valid) {
      throw new ASRModelArchiveInvalidError(
        'Downloaded ONNX ASR model cache is incomplete or invalid.',
        describeValidation(staged.problems, staged.markerValid),
      );
    }
    await promote(stagingDir, cacheDir);
  } catch (error) {
    if (isCancelled(error, options.signal)) {
      reporter.emit('model.download.cancelled', reporter.progress);
      throw new ModelDownloadCancelledError();
    }
    if (isASRError(error)) throw error;
    // 文件系统层的失败（EACCES/ENOSPC/rename 失败）也要落在下载码上，
    // 与 Python 把 OSError 包成 ModelDownloadError 的行为一致。
    throw new ASRModelDownloadFailedError(
      'Failed to prepare the ONNX ASR model cache.',
      describeError(error),
    );
  } finally {
    await rm(stagingDir, {recursive: true, force: true}).catch(() => {});
  }

  reporter.emit('model.download.completed', 100, {messageArgs: {model: SENSEVOICE_MODEL_ID}});
  return {cacheDir, downloaded: true, bytesDownloaded};
}

interface DownloadEntry {
  readonly relativePath: string;
  readonly url: string;
  readonly expectedSha256: string;
  progressWindow: {start: number; span: number};
}

function resolveCacheDir(options: PrepareModelCacheOptions): string {
  if (options.cacheDir !== undefined) return options.cacheDir;
  if (options.dataRoot === undefined) {
    throw new TypeError('prepareModelCache needs either dataRoot or cacheDir.');
  }
  return resolveModelCacheDir(options.dataRoot);
}

function downloadPlan(
  modelId: string,
  hashes: Readonly<Record<string, string>>,
): DownloadEntry[] {
  const entries: DownloadEntry[] = [];
  for (const [relativePath, source] of Object.entries(MODEL_DOWNLOAD_SOURCES)) {
    if (source.modelId !== modelId) continue;
    const expectedSha256 = hashes[relativePath];
    if (expectedSha256 === undefined) {
      throw new Error(`Model asset ${relativePath} has no pinned SHA-256.`);
    }
    entries.push({
      relativePath,
      url: buildDownloadUrl(source.modelId, source.repositoryPath),
      expectedSha256,
      progressWindow: {start: 0, span: 0},
    });
  }
  return entries;
}

/** `<根>/models/.onnx-staging-<hex>`：与就绪目录同盘，替换才是原子的。 */
function intoStaging(cacheDir: string): string {
  return path.join(path.dirname(cacheDir), `.${path.basename(cacheDir)}-staging-${randomSuffix()}`);
}

function randomSuffix(): string {
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
}

/**
 * 崩溃残留处理。顺序很重要：`ready` 缺失但存在 backup 时先复原（那是上一次替换
 * 死在中途时唯一完好的副本），然后才清理其它残留。
 */
async function recoverStaleDirectories(
  parentDir: string,
  baseName: string,
  cacheDir: string,
): Promise<boolean> {
  const staged: string[] = [];
  const backups: string[] = [];
  let names: string[];
  try {
    const entries = await readdir(parentDir, {withFileTypes: true});
    names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return false;
  }
  for (const name of names) {
    if (name.startsWith(`.${baseName}-staging-`)) staged.push(path.join(parentDir, name));
    if (name.startsWith(`.${baseName}-backup-`)) backups.push(path.join(parentDir, name));
  }

  for (const dir of staged) {
    await rm(dir, {recursive: true, force: true}).catch(() => {});
  }
  if (backups.length === 0) return false;

  let remaining = backups;
  let restoredBackup = false;
  if (!(await exists(cacheDir))) {
    const [restored, ...rest] = backups;
    await rename(restored, cacheDir).catch(() => {});
    if (await exists(cacheDir)) {
      remaining = rest;
      restoredBackup = true;
    }
  }
  for (const dir of remaining) {
    await rm(dir, {recursive: true, force: true}).catch(() => {});
  }
  return restoredBackup;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function fileSize(target: string): Promise<number> {
  try {
    const info = await stat(target);
    return info.isFile() ? info.size : 0;
  } catch {
    return 0;
  }
}

async function assertFreeSpace(
  dir: string,
  probe: ((dir: string) => Promise<number | null>) | undefined,
): Promise<void> {
  const free = probe === undefined ? await defaultFreeBytes(dir) : await probe(dir);
  if (free === null) return;
  if (free < MIN_MODEL_DOWNLOAD_FREE_BYTES) {
    // 与 Python 同因同码：ENOSPC 在这里是「空间不足」，不是「下载坏了」。
    throw new ASRModelDownloadFailedError(
      `Not enough free disk space for the ASR model: ${free} bytes available.`,
      'ENOSPC',
    );
  }
}

async function defaultFreeBytes(dir: string): Promise<number | null> {
  try {
    const stats = await statfs(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    // 文件系统不支持 statfs 时放行：宁可让下载去撞 ENOSPC，也不要凭空拒绝。
    return null;
  }
}

function writeReadyMarker(stagingDir: string): Promise<void> {
  return writeTextFile(
    path.join(stagingDir, MODEL_VERSION_FILE_NAME),
    modelVersionMarker(),
  );
}

async function writeTextFile(filePath: string, content: string): Promise<void> {
  const handle = await open(filePath, 'w');
  try {
    await handle.write(content);
  } finally {
    await handle.close();
  }
}

/**
 * 整目录替换：旧目录先挪开，新目录顶上，失败则把旧的挪回来。
 * 中途崩溃留下的 backup 由 `recoverStaleDirectories` 在下次启动时复原。
 */
async function promote(stagingDir: string, cacheDir: string): Promise<void> {
  const backupDir = path.join(
    path.dirname(cacheDir),
    `.${path.basename(cacheDir)}-backup-${randomSuffix()}`,
  );
  let backedUp = false;
  if (await exists(cacheDir)) {
    await rename(cacheDir, backupDir);
    backedUp = true;
  }
  try {
    await rename(stagingDir, cacheDir);
  } catch (error) {
    if (backedUp && !(await exists(cacheDir))) {
      await rename(backupDir, cacheDir).catch(() => {});
    }
    throw error;
  }
  if (backedUp) await rm(backupDir, {recursive: true, force: true}).catch(() => {});
}

interface FetchAssetParams {
  readonly entry: DownloadEntry;
  readonly stagingDir: string;
  readonly reporter: ProgressReporter;
  readonly fetchImpl: ModelFetch;
  readonly signal?: AbortSignal;
  readonly retryDelayMs: (attempt: number) => number;
}

/**
 * 下载一个文件并校验哈希。重试语义分层：
 * - 网络错误、5xx、超时、截断 → 退避后重试，已落盘的部分续传；
 * - 哈希不符且这次是续传 → 丢掉残片，从零重下一次（残片可能本身就是坏的）；
 * - 哈希不符且已经是全新下载 → `ASR_MODEL_ARCHIVE_INVALID`，不再重试；
 * - 4xx、体积超限 → 立刻失败，重试没有意义。
 */
async function fetchAsset(params: FetchAssetParams): Promise<number> {
  const {entry, stagingDir, reporter, fetchImpl, signal, retryDelayMs} = params;
  const destination = path.join(stagingDir, entry.relativePath);
  await mkdir(path.dirname(destination), {recursive: true});

  const currentFileName = path.basename(entry.relativePath);
  let resumeFrom = await fileSize(destination);

  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      await downloadAttempt({
        url: entry.url,
        destination,
        resumeFrom,
        fileName: currentFileName,
        reporter,
        window: entry.progressWindow,
        fetchImpl,
        signal,
      });
    } catch (error) {
      if (isCancelled(error, signal)) throw new ModelDownloadCancelledError();
      if (error instanceof ASRModelDownloadFailedError || error instanceof ASRModelArchiveInvalidError) {
        throw error;
      }
      if (error instanceof RangeNotSatisfiableError) {
        resumeFrom = 0;
        await rm(destination, {force: true}).catch(() => {});
        continue;
      }
      if (attempt === DOWNLOAD_ATTEMPTS) {
        throw new ASRModelDownloadFailedError(
          'Failed to prepare the ONNX ASR model cache.',
          `${currentFileName}: ${describeError(error)}`,
        );
      }
      await delay(retryDelayMs(attempt), signal);
      resumeFrom = await fileSize(destination);
      continue;
    }

    const actual = await fileSha256(destination).catch(() => null);
    if (actual === entry.expectedSha256) {
      reporter.emit('model.file.completed', entry.progressWindow.start + entry.progressWindow.span, {
        currentFile: currentFileName,
      });
      return await fileSize(destination);
    }
    if (resumeFrom > 0) {
      // 续传拼出来的内容不对：残片不可信，从零再来一次。
      resumeFrom = 0;
      await rm(destination, {force: true}).catch(() => {});
      continue;
    }
    throw new ASRModelArchiveInvalidError(
      `ASR model asset SHA-256 mismatch: expected ${entry.expectedSha256}, got ${actual ?? 'unreadable'}.`,
      currentFileName,
    );
  }

  throw new ASRModelDownloadFailedError(
    'Failed to prepare the ONNX ASR model cache.',
    `${currentFileName}: retries exhausted`,
  );
}

interface DownloadAttemptParams {
  readonly url: string;
  readonly destination: string;
  readonly resumeFrom: number;
  readonly fileName: string;
  readonly reporter: ProgressReporter;
  readonly window: {start: number; span: number};
  readonly fetchImpl: ModelFetch;
  readonly signal?: AbortSignal;
}

/** 一次尝试：可能续传，也可能被服务端忽略 Range 而从头写。 */
async function downloadAttempt(params: DownloadAttemptParams): Promise<void> {
  const {url, destination, resumeFrom, fileName, reporter, window, fetchImpl, signal} = params;
  const watchdog = new AbortController();
  const requestSignal = signal === undefined
    ? watchdog.signal
    : AbortSignal.any([watchdog.signal, signal]);

  let response: ModelFetchResponse;
  try {
    response = await fetchImpl(url, {
      headers: resumeFrom > 0 ? {Range: `bytes=${resumeFrom}-`} : undefined,
      signal: requestSignal,
    });
  } catch (error) {
    if (isCancelled(error, signal)) throw new ModelDownloadCancelledError();
    throw new AttemptError(`request failed: ${describeError(error)}`);
  }

  if (response.status === 416) throw new RangeNotSatisfiableError();
  if (response.status >= 400) {
    const retryable = response.status >= 500 || response.status === 408 || response.status === 429;
    if (!retryable) {
      throw new ASRModelDownloadFailedError(
        `ASR model file download failed with HTTP ${response.status}.`,
        fileName,
      );
    }
    throw new AttemptError(`HTTP ${response.status}`);
  }
  if (response.status !== 200 && response.status !== 206) {
    throw new AttemptError(`unexpected HTTP ${response.status}`);
  }
  if (response.body === null) throw new AttemptError('empty response body');

  // 服务端忽略 Range 时返回 200，此时必须从头写，不能拼到残片后面。
  const appending = response.status === 206 && resumeFrom > 0;
  const contentLength = Number(response.headers.get('content-length') ?? '0');
  const total = appending
    ? parseContentRangeTotal(response.headers.get('content-range')) ?? resumeFrom + contentLength
    : contentLength;
  if (Number.isFinite(total) && total > MAX_MODEL_FILE_BYTES) {
    throw new ASRModelDownloadFailedError(
      `ASR model file exceeds the size limit (${total} bytes).`,
      fileName,
    );
  }

  const handle = await open(destination, appending ? 'a' : 'w');
  const reader = response.body.getReader();
  let written = appending ? resumeFrom : 0;
  try {
    while (true) {
      const {done, value} = await readChunk(reader, watchdog, signal);
      if (done) break;
      if (value === undefined) continue;
      written += value.byteLength;
      if (written > MAX_MODEL_FILE_BYTES) {
        throw new ASRModelDownloadFailedError('ASR model file exceeds the size limit.', fileName);
      }
      await handle.write(value);
      reporter.emitThrottled(
        'model.file.downloading',
        window.start + window.span * clamp01(total > 0 ? written / total : 0),
        fileName,
        total > 0 ? (100 * written) / total : 0,
      );
    }
  } catch (error) {
    if (isCancelled(error, signal)) throw new ModelDownloadCancelledError();
    if (error instanceof ASRModelDownloadFailedError || error instanceof AttemptError) throw error;
    throw new AttemptError(`stream failed: ${describeError(error)}`);
  } finally {
    await reader.cancel().catch(() => {});
    await handle.close().catch(() => {});
  }

  if (written === 0) throw new AttemptError('download produced an empty file');
  // 长度已知却没读满：这是短读（连接提前关闭），不是「文件就是这样」，
  // 交给重试去续传，否则会把一次网络抖动报成哈希不符。
  if (total > 0 && written < total) {
    throw new AttemptError(`truncated download: ${written}/${total} bytes`);
  }
}

type ChunkRead = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  watchdog: AbortController,
  signal: AbortSignal | undefined,
): Promise<ChunkRead> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      watchdog.abort();
      reject(new AttemptError('read timed out'));
    }, DOWNLOAD_IDLE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } catch (error) {
    if (isCancelled(error, signal)) throw new ModelDownloadCancelledError();
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function parseContentRangeTotal(header: string | null): number | null {
  if (header === null) return null;
  const match = /\/(\d+)\s*$/.exec(header);
  return match === null ? null : Number(match[1]);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new ModelDownloadCancelledError());
    };
    signal?.addEventListener('abort', onAbort, {once: true});
  });
}

function defaultRetryDelayMs(attempt: number): number {
  return 500 * 2 ** (attempt - 1);
}

function isCancelled(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true;
  // 只能认自己的取消类：watchdog 超时也会产出 `AbortError`，把它当取消会让网络
  // 抖动被报成「用户取消」。
  return error instanceof ModelDownloadCancelledError;
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function describeValidation(
  problems: readonly {relativePath: string; reason: string}[],
  markerValid: boolean,
): string {
  const parts = problems.map((problem) => `${problem.relativePath} ${problem.reason}`);
  if (!markerValid) parts.push(`${MODEL_VERSION_FILE_NAME} missing or incomplete`);
  return parts.join('; ');
}

/** 单个文件的一次尝试失败：可重试，残片可续传。 */
class AttemptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttemptError';
  }
}

/** 服务端拒绝 Range（残片比目标文件还大或已失效），从头来。 */
class RangeNotSatisfiableError extends Error {
  constructor() {
    super('range not satisfiable');
    this.name = 'RangeNotSatisfiableError';
  }
}

/**
 * 进度播报。只做三件事：按 registry 校验事件形状、保证进度单调、按 100 ms / 1% 节流。
 * 节流是必要的：241 MB 的模型按 1 MB 分块会发两百多条事件，桌面 IPC 承受不住。
 */
class ProgressReporter {
  progress = 0;
  private lastEmitAt = 0;
  private lastFilePercent = Number.NEGATIVE_INFINITY;
  private readonly listener: ModelProgressListener | undefined;
  private readonly now: () => number;

  // 不用参数属性：Node 的 `--experimental-strip-types` 只删类型，不生成赋值代码。
  constructor(listener: ModelProgressListener | undefined, now: () => number) {
    this.listener = listener;
    this.now = now;
  }

  emit(
    code: ModelProgressCode,
    progress: number,
    extra: {currentFile?: string; messageArgs?: Readonly<Record<string, string | number>>} = {},
  ): void {
    const spec = MODEL_PROGRESS_SPECS[code];
    const status = spec.status;
    if (spec.currentFile === 'required' && extra.currentFile === undefined) {
      throw new Error(`${code} requires current_file.`);
    }
    if (spec.currentFile === 'forbidden' && extra.currentFile !== undefined) {
      throw new Error(`${code} must not carry current_file.`);
    }
    const rounded = Math.max(this.progress, Math.min(100, Math.round(progress)));
    this.progress = rounded;
    if (this.listener === undefined) return;
    const event: ModelProgressEvent = {
      message_code: code,
      status,
      progress: rounded,
      ...(extra.currentFile === undefined ? {} : {current_file: extra.currentFile}),
      ...(extra.messageArgs === undefined ? {} : {message_args: extra.messageArgs}),
    };
    this.listener(event);
  }

  emitThrottled(
    code: ModelProgressCode,
    progress: number,
    currentFile: string,
    filePercent: number,
  ): void {
    const at = this.now();
    const due = at - this.lastEmitAt >= PROGRESS_EVENT_MIN_INTERVAL_MS
      || filePercent - this.lastFilePercent >= PROGRESS_EVENT_MIN_PERCENT_STEP;
    if (!due) return;
    this.lastEmitAt = at;
    this.lastFilePercent = filePercent;
    this.emit(code, progress, {currentFile});
  }
}
