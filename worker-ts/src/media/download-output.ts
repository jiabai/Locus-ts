// 下载产物的定位与复用判定：复现 `worker/worker_core/media_preparation.py`
// 的 `find_latest_video` / `snapshot_video_files` / `find_new_or_updated_video` /
// `find_video_by_stem` / `find_video_from_download_stdout` / `can_reuse_audio`。
import {readdir, realpath, stat} from 'node:fs/promises';
import path from 'node:path';

import type {CommandRunner} from './command.ts';
import {probeMediaFile, isAudioValid} from './ffprobe.ts';
import {stripPythonSpace} from '../protocol/process-request.ts';
import {toPosixPath} from '../tasks/paths.ts';

export const VIDEO_SUFFIXES: readonly string[] = ['.mp4', '.mov', '.mkv', '.webm', '.m4v'];

interface VideoFile {
  readonly filePath: string;
  readonly name: string;
  readonly mtimeNs: bigint;
  readonly size: bigint;
}

async function videoFiles(outputDir: string): Promise<VideoFile[]> {
  let entries;
  try {
    entries = await readdir(outputDir, {withFileTypes: true});
  } catch {
    return [];
  }
  const result: VideoFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !VIDEO_SUFFIXES.includes(path.extname(entry.name).toLowerCase())) {
      continue;
    }
    const filePath = path.join(outputDir, entry.name);
    let info;
    try {
      info = await stat(filePath, {bigint: true});
    } catch {
      continue;
    }
    result.push({filePath, name: entry.name, mtimeNs: info.mtimeNs, size: info.size});
  }
  return result;
}

function posixKey(filePath: string): string {
  return toPosixPath(filePath);
}

/** Python `max(candidates, key=st_mtime)`：并列时保留先遍历到的那个。 */
export async function findLatestVideo(outputDir: string): Promise<string | null> {
  const files = await videoFiles(outputDir);
  let selected: VideoFile | null = null;
  for (const file of files) {
    if (selected === null || file.mtimeNs > selected.mtimeNs) selected = file;
  }
  return selected?.filePath ?? null;
}

export type VideoSnapshot = ReadonlyMap<string, readonly [bigint, bigint]>;

export async function snapshotVideoFiles(outputDir: string): Promise<VideoSnapshot> {
  const snapshot = new Map<string, readonly [bigint, bigint]>();
  for (const file of await videoFiles(outputDir)) {
    snapshot.set(posixKey(file.filePath), [file.mtimeNs, file.size]);
  }
  return snapshot;
}

export async function findNewOrUpdatedVideo(
  outputDir: string,
  previousSnapshot: VideoSnapshot,
): Promise<string | null> {
  let selected: VideoFile | null = null;
  for (const file of await videoFiles(outputDir)) {
    const previous = previousSnapshot.get(posixKey(file.filePath));
    if (previous !== undefined && previous[0] === file.mtimeNs && previous[1] === file.size) {
      continue;
    }
    if (selected === null || file.mtimeNs > selected.mtimeNs) selected = file;
  }
  return selected?.filePath ?? null;
}

export async function findVideoByStem(
  outputDir: string,
  stem: string | null,
): Promise<string | null> {
  if (stem === null) return null;
  const files = (await videoFiles(outputDir)).filter((file) => path.parse(file.name).name === stem);
  let selected: VideoFile | null = null;
  for (const file of files) {
    if (selected === null || file.mtimeNs > selected.mtimeNs) selected = file;
  }
  return selected?.filePath ?? null;
}

function isRelativeTo(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** stdout 末行的路径优先；越界路径（含盘符逃逸）一律拒绝。 */
export async function findVideoFromDownloadStdout(
  stdout: string,
  outputDir: string,
): Promise<string | null> {
  if (stripPythonSpace(stdout).length === 0) return null;
  let outputRoot: string;
  try {
    outputRoot = await realpath(outputDir);
  } catch {
    return null;
  }
  const lines = stdout.split(/\r\n|[\n\r\u000b\u000c\u001c-\u001e\u0085\u2028\u2029]/u).reverse();
  for (const rawLine of lines) {
    // Python `raw_line.strip().strip("\"'")`：先去首尾空白，再逐字符剥掉引号。
    const rawPath = stripPythonSpace(rawLine).replace(/^["']+|["']+$/gu, '');
    if (rawPath.length === 0) continue;
    const candidate = path.isAbsolute(rawPath) ? rawPath : path.join(outputDir, rawPath);
    let resolved: string;
    try {
      resolved = await realpath(candidate);
    } catch {
      continue;
    }
    if (!isRelativeTo(outputRoot, resolved)) continue;
    let info;
    try {
      info = await stat(candidate);
    } catch {
      continue;
    }
    if (info.isFile() && VIDEO_SUFFIXES.includes(path.extname(candidate).toLowerCase())) {
      return candidate;
    }
  }
  return null;
}

/** 已存在的合法音频可以直接复用，不重复跑 ffmpeg。 */
export async function canReuseAudio(
  audioPath: string,
  runner?: CommandRunner,
): Promise<boolean> {
  let exists = false;
  try {
    exists = (await stat(audioPath)).isFile();
  } catch {
    return false;
  }
  if (!exists) return false;
  try {
    return isAudioValid(await probeMediaFile(audioPath, runner));
  } catch {
    return false;
  }
}
