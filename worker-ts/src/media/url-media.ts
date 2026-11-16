// URL 媒体准备：把下载到的视频变成任务可用的产物。
//
// 对齐 `worker/worker_core/media_preparation.py` 的 `_prepare_url` / `_commit_video` /
// `_prepare_audio`：进度事件的值与顺序、四级视频定位、流校验、音频复用、字幕探测与
// 失败码逐项一致。下载编排本身在 `download.ts`，三平台 fallback 与小红书字幕探测
// 由调用方注入（尚未迁移的那部分传输层）。
import {copyFile, mkdir} from 'node:fs/promises';

import {AtomicFileCommitError, stagedFile} from '../artifacts/atomic-file.ts';
import {buildWorkerProgressEvent} from '../protocol/events.ts';
import type {WorkerProgressCode, WorkerProgressEvent, WorkerProgressStage} from '../protocol/events.ts';
import {sanitizeSourceText} from '../sources/source-resolution.ts';
import type {SourceRequest} from '../sources/source-resolution.ts';
import {CommandExecutionError} from './command.ts';
import type {CommandRunner} from './command.ts';
import {extractAudio} from './audio.ts';
import {isAudioValid, isMediaValid, probeMediaFile} from './ffprobe.ts';
import {MediaPreparationError} from './errors.ts';
import {
  canReuseAudio,
  findLatestVideo,
  findNewOrUpdatedVideo,
  findVideoByStem,
  findVideoFromDownloadStdout,
  snapshotVideoFiles,
} from './download-output.ts';
import {
  downloadVideo,
  isBilibiliFallbackCommand,
} from './download.ts';
import type {FallbackDownloadStrategy} from './download.ts';
import {findSubtitleTranscript} from './subtitles.ts';
import type {SubtitleTranscript} from './subtitles.ts';

export interface UrlMediaPaths {
  /** `<cache>/tasks/<id>/download`：下载器写视频与字幕的地方。 */
  readonly downloadDir: string;
  /** `<output>/tasks/<id>/media`。 */
  readonly mediaDir: string;
  readonly audioPath: string;
  /** URL 任务恒定用 `video.mp4`，与 Python `TaskPaths.video_path` 一致。 */
  readonly videoPath: string;
}

export interface PrepareUrlMediaOptions {
  readonly source: SourceRequest;
  readonly paths: UrlMediaPaths;
  /** 官方独立 yt-dlp 可执行文件及其前置参数，由应用层解析后注入。 */
  readonly launcher: readonly string[];
  readonly runner: CommandRunner;
  readonly strategies: readonly FallbackDownloadStrategy[];
  readonly probeXiaohongshuSubtitle: (url: string, outputDir: string) => Promise<void>;
  readonly onProgress?: (event: WorkerProgressEvent) => void;
}

export interface PreparedUrlMedia {
  readonly videoPath: string;
  readonly audioPath: string;
  readonly subtitleCandidate: SubtitleTranscript | null;
}

const VIDEO_DOWNLOAD_FAILED = 'VIDEO_DOWNLOAD_FAILED';
const VIDEO_OUTPUT_MISSING = 'VIDEO_DOWNLOAD_OUTPUT_MISSING';
const MEDIA_VALIDATION_FAILED = 'MEDIA_VALIDATION_FAILED';
const AUDIO_EXTRACTION_FAILED = 'AUDIO_EXTRACTION_FAILED';

function emit(
  options: PrepareUrlMediaOptions,
  messageCode: WorkerProgressCode,
  progress: number,
  stage: WorkerProgressStage = 'video_extracting',
): void {
  options.onProgress?.(buildWorkerProgressEvent(messageCode, {stage, progress}));
}

async function commitVideo(sourcePath: string, destination: string, runner: CommandRunner): Promise<void> {
  try {
    await stagedFile(
      destination,
      async (stagingPath) => {
        await copyFile(sourcePath, stagingPath);
      },
      async (stagingPath) => {
        let valid: boolean;
        try {
          valid = isMediaValid(await probeMediaFile(stagingPath, runner));
        } catch {
          throw new MediaPreparationError(
            MEDIA_VALIDATION_FAILED,
            'Prepared video could not be validated.',
          );
        }
        if (!valid) {
          throw new MediaPreparationError(
            MEDIA_VALIDATION_FAILED,
            'Prepared video must contain valid video and audio streams.',
          );
        }
      },
    );
  } catch (error) {
    if (error instanceof MediaPreparationError) throw error;
    if (error instanceof AtomicFileCommitError) {
      throw new MediaPreparationError(
        MEDIA_VALIDATION_FAILED,
        'Prepared video could not be stored safely.',
      );
    }
    throw error;
  }
}

async function prepareAudio(
  videoPath: string,
  audioPath: string,
  runner: CommandRunner,
  options: PrepareUrlMediaOptions,
): Promise<string> {
  emit(options, 'audio.extract.running', 48);
  if (await canReuseAudio(audioPath, runner)) {
    emit(options, 'audio.extract.reused', 50);
    return audioPath;
  }
  try {
    await stagedFile(
      audioPath,
      async (stagingPath) => {
        await extractAudio({inputPath: videoPath, outputPath: stagingPath, runner});
      },
      async (stagingPath) => {
        let valid: boolean;
        try {
          valid = isAudioValid(await probeMediaFile(stagingPath, runner));
        } catch {
          valid = false;
        }
        if (!valid) {
          throw new MediaPreparationError(
            AUDIO_EXTRACTION_FAILED,
            'Extracted audio could not be validated.',
          );
        }
      },
    );
  } catch (error) {
    if (error instanceof MediaPreparationError) throw error;
    if (error instanceof CommandExecutionError) {
      throw new MediaPreparationError(AUDIO_EXTRACTION_FAILED, 'Audio extraction failed.');
    }
    if (error instanceof AtomicFileCommitError) {
      throw new MediaPreparationError(
        AUDIO_EXTRACTION_FAILED,
        'Extracted audio could not be stored safely.',
      );
    }
    throw error;
  }
  return audioPath;
}

export async function prepareUrlMedia(options: PrepareUrlMediaOptions): Promise<PreparedUrlMedia> {
  const {source, paths, runner} = options;
  await mkdir(paths.downloadDir, {recursive: true});
  const previousSnapshot = await snapshotVideoFiles(paths.downloadDir);
  emit(options, 'video.download.preparing', 18);

  let downloadResult;
  try {
    downloadResult = await downloadVideo({
      url: source.downloadUrl,
      outputDir: paths.downloadDir,
      launcher: options.launcher,
      runner,
      strategies: options.strategies,
      probeXiaohongshuSubtitle: options.probeXiaohongshuSubtitle,
      ...(options.onProgress === undefined ? {} : {onProgress: options.onProgress}),
    });
  } catch (error) {
    if (!(error instanceof CommandExecutionError)) throw error;
    // 下载器的报错可能带签名 URL 或平台 token：写进清单前按来源清洗。
    throw new MediaPreparationError(
      VIDEO_DOWNLOAD_FAILED,
      sanitizeSourceText(error.message, source),
    );
  }

  emit(options, 'video.stream.validating', 34);
  let videoPath = await findVideoFromDownloadStdout(downloadResult.stdout, paths.downloadDir);
  if (videoPath === null) videoPath = await findVideoByStem(paths.downloadDir, source.identity.stableId);
  if (videoPath === null) videoPath = await findNewOrUpdatedVideo(paths.downloadDir, previousSnapshot);
  if (videoPath === null) videoPath = await findLatestVideo(paths.downloadDir);
  if (videoPath === null) {
    throw new MediaPreparationError(
      VIDEO_OUTPUT_MISSING,
      'Video download completed but no media file was found.',
    );
  }

  let valid: boolean;
  try {
    valid = isMediaValid(await probeMediaFile(videoPath, runner));
  } catch {
    throw new MediaPreparationError(
      MEDIA_VALIDATION_FAILED,
      'Downloaded media could not be validated.',
    );
  }
  if (!valid) {
    throw new MediaPreparationError(
      MEDIA_VALIDATION_FAILED,
      'Downloaded file must contain valid video and audio streams.',
    );
  }

  await commitVideo(videoPath, paths.videoPath, runner);
  const audioPath = await prepareAudio(paths.videoPath, paths.audioPath, runner, options);

  emit(options, 'subtitle.detect.running', 58, 'video_transcribing');
  // B 站 fallback 自己带字幕，不再扫下载目录；其余路径按语言优先序找 SRT/VTT。
  const subtitleCandidate = isBilibiliFallbackCommand(downloadResult.command)
    ? null
    : await findSubtitleTranscript(paths.downloadDir);

  return {videoPath: paths.videoPath, audioPath, subtitleCandidate};
}
