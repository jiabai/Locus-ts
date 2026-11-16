// 本地媒体准备：把用户选中的文件变成任务可用的产物。
//
// 对齐 `worker/worker_core/media_preparation.py` 的 `_prepare_local`：
// 先把源文件复制到 cache 的 `download/` 里（用户随后挪动/删除原文件不影响任务），
// 再探测、校验流类型，最后按类型落 `media/video.<ext>` 与归一化后的 `media/audio.wav`。
// 每一步的失败码都是契约里的闭集项，前端按码给文案，不能临时造新码。
import {randomBytes} from 'node:crypto';
import {mkdir, open, rm} from 'node:fs/promises';
import path from 'node:path';

import {AtomicFileCommitError, stagedFile} from '../artifacts/atomic-file.ts';
import {VIDEO_EXTENSIONS} from '../protocol/contract.ts';
import type {WorkerProgressCode} from '../protocol/events.ts';
import {extractAudio} from './audio.ts';
import {MediaPreparationError} from './errors.ts';
export {MediaPreparationError} from './errors.ts';
import {CommandExecutionError, type CommandRunner, runCommand} from './command.ts';
import {isMediaValid, isNormalizedPcmWav, probeMediaFile, type MediaInfo, isAudioValid} from './ffprobe.ts';

export type LocalMediaKind = 'video' | 'audio';

/** 本地媒体准备的失败码闭集；管线只按这些码分流。 */
export type LocalMediaErrorCode =
  | 'LOCAL_MEDIA_VALIDATION_FAILED'
  | 'LOCAL_MEDIA_KIND_MISMATCH'
  | 'LOCAL_VIDEO_STREAM_MISSING'
  | 'LOCAL_VIDEO_AUDIO_STREAM_MISSING'
  | 'LOCAL_AUDIO_STREAM_MISSING'
  | 'LOCAL_VIDEO_COPY_FAILED'
  | 'AUDIO_NORMALIZATION_FAILED';

export interface LocalMediaPaths {
  /** cache 下的任务目录：`<cache>/tasks/<id>/download`。 */
  readonly downloadDir: string;
  /** 用户数据目录：`<output>/tasks/<id>/media`。 */
  readonly mediaDir: string;
  /** 归一化音频的最终位置：`<output>/tasks/<id>/media/audio.wav`。 */
  readonly audioPath: string;
  /** 视频按扩展名保存：`<output>/tasks/<id>/media/video.<ext>`。 */
  videoPathForExtension(extension: string): string;
}

export interface PrepareLocalMediaOptions {
  /** 用户选中的原始文件路径（只读）。 */
  readonly sourcePath: string;
  readonly mediaKind: LocalMediaKind;
  readonly sourceExtension: string;
  readonly paths: LocalMediaPaths;
  readonly runner?: CommandRunner;
  readonly onProgress?: (messageCode: WorkerProgressCode, progress: number) => void;
}

export interface PreparedLocalMedia {
  /** 音频任务没有视频产物。 */
  readonly videoPath: string | null;
  readonly audioPath: string;
}

/** 复制到 staging：分块写 + fsync，中途失败不会留下半个文件被当成源。 */
async function copyFileBounded(sourcePath: string, destinationPath: string): Promise<void> {
  const source = await open(sourcePath, 'r');
  try {
    const destination = await open(destinationPath, 'wx');
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      while (true) {
        const {bytesRead} = await source.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        await destination.write(buffer, 0, bytesRead);
      }
      await destination.sync();
    } finally {
      await destination.close();
    }
  } finally {
    await source.close();
  }
}

async function removeFileQuietly(target: string): Promise<void> {
  await rm(target, {force: true}).catch(() => {});
}

export async function prepareLocalMedia(
  options: PrepareLocalMediaOptions,
): Promise<PreparedLocalMedia> {
  const runner = options.runner ?? runCommand;
  const emit = options.onProgress ?? (() => {});
  const {paths, mediaKind, sourceExtension} = options;

  // 对应 Python `_probe_local_source`：探测失败一律是「这个本地文件不像媒体」。
  // 自己的 MediaPreparationError 不能在这里被吞掉，否则归一化失败会被误报成校验失败。
  const probeStaged = async (target: string): Promise<MediaInfo> => {
    try {
      return await probeMediaFile(target, runner);
    } catch (error) {
      if (error instanceof MediaPreparationError) throw error;
      throw new MediaPreparationError(
        'LOCAL_MEDIA_VALIDATION_FAILED',
        'Local media could not be validated.',
      );
    }
  };

  const validateNormalized = async (target: string): Promise<void> => {
    let info: MediaInfo;
    try {
      info = await probeMediaFile(target, runner);
    } catch {
      throw new MediaPreparationError(
        'AUDIO_NORMALIZATION_FAILED',
        'Normalized audio could not be validated.',
      );
    }
    if (!isNormalizedPcmWav(info)) {
      throw new MediaPreparationError(
        'AUDIO_NORMALIZATION_FAILED',
        'Normalized audio must be 16 kHz mono 16-bit PCM WAV.',
      );
    }
  };

  const normalizeAudio = async (sourcePath: string): Promise<string> => {
    try {
      await stagedFile(
        paths.audioPath,
        async (stagingPath) => {
          await extractAudio({inputPath: sourcePath, outputPath: stagingPath, runner});
        },
        validateNormalized,
      );
    } catch (error) {
      if (error instanceof MediaPreparationError) throw error;
      if (error instanceof CommandExecutionError || error instanceof AtomicFileCommitError) {
        throw new MediaPreparationError(
          'AUDIO_NORMALIZATION_FAILED',
          'Local audio could not be normalized safely.',
        );
      }
      throw error;
    }
    return paths.audioPath;
  };

  emit('local.media.validating', 18);
  await mkdir(paths.downloadDir, {recursive: true});
  const stagingPath = path.join(
    paths.downloadDir,
    `local-source-${randomBytes(8).toString('hex')}.${sourceExtension}`,
  );

  try {
    try {
      await copyFileBounded(options.sourcePath, stagingPath);
    } catch {
      throw new MediaPreparationError(
        mediaKind === 'video' ? 'LOCAL_VIDEO_COPY_FAILED' : 'AUDIO_NORMALIZATION_FAILED',
        mediaKind === 'video'
          ? 'Local video could not be copied safely.'
          : 'Local audio could not be prepared safely.',
      );
    }

    const info = await probeStaged(stagingPath);
    validateStreams(mediaKind, info);

    if (mediaKind === 'video') {
      emit('local.video.copying', 34);
      const videoPath = paths.videoPathForExtension(sourceExtension);
      try {
        await stagedFile(
          videoPath,
          async (target) => {
            await copyFileBounded(stagingPath, target);
          },
          async (target) => {
            const staged = await probeStaged(target);
            if (!isMediaValid(staged)) {
              throw new MediaPreparationError(
                'LOCAL_MEDIA_VALIDATION_FAILED',
                'Local video must contain valid video and audio streams.',
              );
            }
          },
        );
      } catch (error) {
        if (error instanceof MediaPreparationError) throw error;
        if (error instanceof AtomicFileCommitError) {
          throw new MediaPreparationError(
            'LOCAL_VIDEO_COPY_FAILED',
            'Local video could not be copied safely.',
          );
        }
        throw error;
      }
      emit('audio.extract.running', 48);
      const audioPath = await normalizeAudio(videoPath);
      return {videoPath, audioPath};
    }

    emit('local.audio.normalizing', 34);
    const audioPath = await normalizeAudio(stagingPath);
    return {videoPath: null, audioPath};
  } finally {
    await removeFileQuietly(stagingPath);
  }
}

/** 流类型与媒体类型必须一致：把音频当视频、把视频当音频都要按契约里的码拒止。 */
export function validateStreams(kind: LocalMediaKind, info: MediaInfo): void {
  const {hasVideo, hasAudio} = info;
  const validAudio = isAudioValid(info);

  if (kind === 'video') {
    if (!hasVideo) {
      throw new MediaPreparationError(
        hasAudio ? 'LOCAL_MEDIA_KIND_MISMATCH' : 'LOCAL_VIDEO_STREAM_MISSING',
        'Local video must contain a valid video stream.',
      );
    }
    if (!hasAudio) {
      throw new MediaPreparationError(
        'LOCAL_VIDEO_AUDIO_STREAM_MISSING',
        'Local video must contain a valid audio stream.',
      );
    }
    if (!validAudio) {
      throw new MediaPreparationError(
        'LOCAL_MEDIA_VALIDATION_FAILED',
        'Local video stream metadata is invalid.',
      );
    }
    return;
  }

  if (!hasAudio) {
    throw new MediaPreparationError(
      hasVideo ? 'LOCAL_MEDIA_KIND_MISMATCH' : 'LOCAL_AUDIO_STREAM_MISSING',
      'Local audio must contain a valid audio stream.',
    );
  }
  if (!validAudio) {
    throw new MediaPreparationError(
      'LOCAL_MEDIA_VALIDATION_FAILED',
      'Local audio stream metadata is invalid.',
    );
  }
}
