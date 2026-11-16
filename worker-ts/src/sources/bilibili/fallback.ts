// B 站下载编排：对齐 `worker/worker_core/bilibili_fallback.py`。
//
// 公开 API 拿分 P 与 DASH 地址，音视频分片各下一份，再用 ffmpeg `-c copy`
// 合成 mp4。番剧/课程/DRM 内容在解析与选择阶段就被拒绝，不做任何绕过尝试。
import {mkdir} from 'node:fs/promises';
import path from 'node:path';

import {buildWorkerProgressEvent} from '../../protocol/events.ts';
import type {WorkerProgressEvent} from '../../protocol/events.ts';
import {
  cleanupCompletedDashFiles,
  cleanupTransientArtifacts,
  downloadFirstAvailableUrl,
  mergeDashFiles,
  replaceFile,
} from './artifacts.ts';
import {
  buildPlayurlUrl,
  buildVideoInfoUrl,
  parsePlayurlResponse,
  parseViewResponse,
  selectDashStreamPair,
} from './playback.ts';
import {parseBilibiliInput} from './source.ts';
import {FetchBilibiliHttpClient, apiHeaders} from './transport.ts';
import {BilibiliFallbackError} from './types.ts';
import type {BilibiliRequestClient, CommandRunner} from './types.ts';

type ProgressCallback = (event: WorkerProgressEvent) => void;

export interface DownloadBilibiliVideoOptions {
  readonly httpClient?: BilibiliRequestClient;
  readonly commandRunner?: CommandRunner;
  readonly onProgress?: ProgressCallback;
}

export async function downloadBilibiliVideo(
  rawInput: string,
  outputDir: string,
  options: DownloadBilibiliVideoOptions = {},
): Promise<string> {
  const client = options.httpClient ?? new FetchBilibiliHttpClient();
  const parsed = await parseBilibiliInput(rawInput, client);

  emitProgress(options.onProgress, 'bilibili.metadata.resolving', 22);
  const viewResponse = await client.get(
    buildVideoInfoUrl(parsed.idKind, parsed.videoId), apiHeaders(), 10,
  );
  const videoInfo = parseViewResponse(viewResponse);
  if (videoInfo.pages.length === 0 || parsed.partIndex >= videoInfo.pages.length) {
    throw new BilibiliFallbackError(
      'BILIBILI_PART_NOT_FOUND',
      'Requested Bilibili part does not exist.',
    );
  }
  const selectedPage = videoInfo.pages[parsed.partIndex];

  emitProgress(options.onProgress, 'bilibili.stream.probing', 26);
  const playurlResponse = await client.get(
    buildPlayurlUrl(videoInfo.bvid, selectedPage.cid), apiHeaders(), 10,
  );
  const playurlData = parsePlayurlResponse(playurlResponse);
  const selection = selectDashStreamPair(playurlData, selectedPage.durationSeconds);

  await mkdir(outputDir, {recursive: true});
  const stem = selectedPage.page <= 1
    ? videoInfo.bvid
    : `${videoInfo.bvid}_p${selectedPage.page}`;
  const outputPath = path.join(outputDir, `${stem}.mp4`);
  const videoTempPath = path.join(outputDir, `${stem}_video.m4s`);
  const audioTempPath = path.join(outputDir, `${stem}_audio.m4s`);
  const mergeTempPath = path.join(outputDir, `${stem}.merge.mp4`);

  try {
    emitProgress(options.onProgress, 'bilibili.video.downloading', 30);
    await downloadFirstAvailableUrl(
      [selection.videoUrl, ...selection.videoBackupUrls], videoTempPath, client,
    );
    emitProgress(options.onProgress, 'bilibili.audio.downloading', 32);
    await downloadFirstAvailableUrl(
      [selection.audioUrl, ...selection.audioBackupUrls], audioTempPath, client,
    );
    emitProgress(options.onProgress, 'bilibili.media.merging', 34);
    await mergeDashFiles(videoTempPath, audioTempPath, mergeTempPath, options.commandRunner);
    await replaceFile(mergeTempPath, outputPath);
  } finally {
    await cleanupTransientArtifacts(videoTempPath, audioTempPath, mergeTempPath);
  }
  await cleanupCompletedDashFiles(videoTempPath, audioTempPath);
  return outputPath;
}

function emitProgress(
  progressCallback: ProgressCallback | undefined,
  messageCode: 'bilibili.metadata.resolving' | 'bilibili.stream.probing'
    | 'bilibili.video.downloading' | 'bilibili.audio.downloading' | 'bilibili.media.merging',
  progress: number,
): void {
  if (progressCallback === undefined) return;
  progressCallback(buildWorkerProgressEvent(messageCode, {
    stage: 'video_extracting',
    progress,
  }));
}
