// B 站 DASH 产物：对齐 `worker/worker_core/bilibili/artifacts.py`。
//
// 音视频分片先落 `.m4s`，交给 ffmpeg `-c copy` 合成 mp4，再原子改名；
// 临时文件在成功与失败路径都清理，`.part` 由可靠下载模块负责。
import {rename, rm, stat} from 'node:fs/promises';

import {SafeDownloadError} from '../../download-reliability.ts';
import {runCommand} from '../../media/command.ts';
import {toPosixPath} from '../../tasks/paths.ts';
import {downloadUrlToPath} from './transport.ts';
import {BilibiliFallbackError} from './types.ts';
import type {BilibiliRequestClient, CommandRunner} from './types.ts';

export async function cleanupTransientArtifacts(
  videoPath: string,
  audioPath: string,
  mergePath: string,
): Promise<void> {
  await rm(mergePath, {force: true});
  await rm(`${videoPath}.part`, {force: true});
  await rm(`${audioPath}.part`, {force: true});
}

export async function cleanupCompletedDashFiles(
  videoPath: string,
  audioPath: string,
): Promise<void> {
  await rm(videoPath, {force: true});
  await rm(audioPath, {force: true});
}

/** 主地址失败就换备用地址；全部失败才报 DASH 下载失败。 */
export async function downloadFirstAvailableUrl(
  urls: readonly string[],
  outputPath: string,
  httpClient: BilibiliRequestClient,
): Promise<string> {
  let lastError: unknown = null;
  for (const url of urls) {
    try {
      await downloadUrlToPath(url, outputPath, httpClient);
    } catch (error) {
      if (!(error instanceof SafeDownloadError) && !(error instanceof BilibiliFallbackError)) {
        throw error;
      }
      lastError = error;
      continue;
    }
    return outputPath;
  }
  throw new BilibiliFallbackError(
    'BILIBILI_DASH_DOWNLOAD_FAILED',
    'All Bilibili DASH media URLs failed to download.',
  );
}

export async function mergeDashFiles(
  videoPath: string,
  audioPath: string,
  outputPath: string,
  commandRunner?: CommandRunner,
): Promise<void> {
  const command = [
    'ffmpeg',
    '-y',
    '-i',
    toPosixPath(videoPath),
    '-i',
    toPosixPath(audioPath),
    '-c',
    'copy',
    toPosixPath(outputPath),
  ];
  const runner: CommandRunner = commandRunner
    ?? ((value) => runCommand(value));
  const result = await runner(command);
  if (result.returncode !== 0) {
    throw new BilibiliFallbackError(
      'BILIBILI_FFMPEG_MERGE_FAILED',
      'ffmpeg exited with a non-zero status while merging Bilibili DASH streams.',
    );
  }
  let merged = false;
  try {
    const info = await stat(outputPath);
    merged = info.isFile() && info.size > 0;
  } catch {
    merged = false;
  }
  if (!merged) {
    throw new BilibiliFallbackError(
      'BILIBILI_FFMPEG_MERGE_FAILED',
      'ffmpeg did not produce a merged Bilibili MP4.',
    );
  }
}

export async function replaceFile(source: string, destination: string): Promise<void> {
  await rename(source, destination);
}
