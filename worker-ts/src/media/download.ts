// 下载编排：复现 `worker/worker_core/media.py` 的 `download_video`。
//
// 主路径调用官方独立 yt-dlp；YouTube 的字幕失败与可重试失败各有一条重试路径；
// 三平台 fallback 的触发条件与错误映射在这里，具体传输实现由调用方注入
// （属于下载器迁移的下一块），因此没有默认策略，未接通时不会静默成功。
import {mkdir} from 'node:fs/promises';

import {toPosixPath} from '../tasks/paths.ts';
import {CommandExecutionError, structuredErrorCode} from './command.ts';
import type {CommandResult, CommandRunner} from './command.ts';
import {findLatestVideo} from './download-output.ts';
import type {WorkerProgressEvent} from '../protocol/events.ts';
import {
  YTDLP_DOWNLOAD_TIMEOUT_CODE,
  YTDLP_DOWNLOAD_TIMEOUT_SECONDS,
  buildYtdlpCommand,
  classifyYoutubeDownloadFailure,
  isRetryableYoutubeFailure,
  isYoutubeSubtitleDownloadFailure,
  shouldAttemptBilibiliFallback,
  shouldAttemptDouyinFallback,
  shouldAttemptXiaohongshuFallback,
  shouldAttemptYoutubeProcessing,
  containsSupportedUrl,
  XIAOHONGSHU_HOST_SUFFIXES,
} from './ytdlp.ts';

export const FALLBACK_COMMAND_NAMES = {
  douyin: 'douyin-fallback',
  xiaohongshu: 'xiaohongshu-fallback',
  bilibili: 'bilibili-fallback',
} as const;

export type FallbackCommandName = typeof FALLBACK_COMMAND_NAMES[keyof typeof FALLBACK_COMMAND_NAMES];

export class FallbackDownloadError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'FallbackDownloadError';
    this.code = code;
  }
}

export interface FallbackDownloadContext {
  readonly url: string;
  readonly outputDir: string;
  readonly onProgress?: (event: WorkerProgressEvent) => void;
  /** 需要合并分片的平台（B 站）共用主路径的 runner。 */
  readonly runner?: CommandRunner;
}

export interface FallbackDownloadStrategy {
  readonly commandName: FallbackCommandName;
  readonly shouldAttempt: (url: string, failureMessage: string) => boolean;
  /** 下载完成后的视频文件路径（绝对路径）。失败时抛 `FallbackDownloadError`。 */
  readonly download: (context: FallbackDownloadContext) => Promise<string>;
}

export interface DownloadVideoOptions {
  readonly url: string;
  readonly outputDir: string;
  /** 官方独立 yt-dlp 可执行文件及其前置参数。 */
  readonly launcher: readonly string[];
  readonly runner: CommandRunner;
  readonly strategies: readonly FallbackDownloadStrategy[];
  /** 小红书字幕探测；真实实现内部收敛网络异常。 */
  readonly probeXiaohongshuSubtitle: (url: string, outputDir: string) => Promise<void>;
  readonly onProgress?: (event: WorkerProgressEvent) => void;
}

/**
 * 按平台拼装 fallback 策略。允许只提供已实现平台的下载函数：
 * 未提供的平台不出现在返回的列表里，也就不会被误判成「尝试过但失败」。
 */
export function createFallbackStrategies(
  implementations: Partial<Readonly<Record<FallbackCommandName, FallbackDownloadStrategy['download']>>>,
): readonly FallbackDownloadStrategy[] {
  const definitions: readonly {
    readonly commandName: FallbackCommandName;
    readonly shouldAttempt: FallbackDownloadStrategy['shouldAttempt'];
  }[] = [
    {
      commandName: FALLBACK_COMMAND_NAMES.douyin,
      shouldAttempt: shouldAttemptDouyinFallback,
    },
    {
      commandName: FALLBACK_COMMAND_NAMES.xiaohongshu,
      shouldAttempt: shouldAttemptXiaohongshuFallback,
    },
    {
      commandName: FALLBACK_COMMAND_NAMES.bilibili,
      shouldAttempt: shouldAttemptBilibiliFallback,
    },
  ];
  const strategies: FallbackDownloadStrategy[] = [];
  for (const definition of definitions) {
    const download = implementations[definition.commandName];
    if (download === undefined) continue;
    strategies.push({
      commandName: definition.commandName,
      shouldAttempt: definition.shouldAttempt,
      download,
    });
  }
  return strategies;
}

function commandFor(options: DownloadVideoOptions, includeSubtitles: boolean): string[] {
  return buildYtdlpCommand({
    url: options.url,
    outputDir: options.outputDir,
    launcher: options.launcher,
    includeSubtitles,
  });
}

async function runYtdlp(options: DownloadVideoOptions, command: string[]): Promise<CommandResult> {
  const result = await options.runner(command, {
    timeoutMs: YTDLP_DOWNLOAD_TIMEOUT_SECONDS * 1000,
  });
  // Python 的 `_raise_if_download_timeout` 只看 stderr 里的结构化码，重试路径同样生效。
  if (structuredErrorCode(result.stderr) === YTDLP_DOWNLOAD_TIMEOUT_CODE) {
    throw new CommandExecutionError(result);
  }
  return result;
}

function fallbackFailure(commandName: string, url: string, error: FallbackDownloadError): CommandResult {
  return {
    command: [commandName, url],
    returncode: 1,
    stdout: '',
    stderr: `${error.code}: ${error.message}`,
  };
}

export async function downloadVideo(options: DownloadVideoOptions): Promise<CommandResult> {
  await mkdir(options.outputDir, {recursive: true});
  let downloadCommand = commandFor(options, true);
  let result = await runYtdlp(options, downloadCommand);

  if (result.returncode !== 0) {
    let failureMessage = result.stderr || result.stdout;
    const isYoutubeVideo = shouldAttemptYoutubeProcessing(options.url);

    if (isYoutubeVideo && isYoutubeSubtitleDownloadFailure(failureMessage)) {
      const downloadedMedia = await findLatestVideo(options.outputDir);
      if (downloadedMedia !== null) {
        return {
          command: result.command,
          returncode: 0,
          stdout: toPosixPath(downloadedMedia),
          stderr: result.stderr,
        };
      }
      downloadCommand = commandFor(options, false);
      result = await runYtdlp(options, downloadCommand);
      if (result.returncode === 0) return result;
      failureMessage = result.stderr || result.stdout;
    }

    if (isYoutubeVideo && isRetryableYoutubeFailure(result)) {
      result = await runYtdlp(options, downloadCommand);
      if (result.returncode === 0) return result;
      failureMessage = result.stderr || result.stdout;
    }

    for (const strategy of options.strategies) {
      if (!strategy.shouldAttempt(options.url, failureMessage)) continue;
      let videoPath: string;
      try {
        videoPath = await strategy.download({
          url: options.url,
          outputDir: options.outputDir,
          ...(options.onProgress === undefined ? {} : {onProgress: options.onProgress}),
          runner: options.runner,
        });
      } catch (error) {
        if (!(error instanceof FallbackDownloadError)) throw error;
        throw new CommandExecutionError(
          fallbackFailure(strategy.commandName, options.url, error),
        );
      }
      return {
        command: [strategy.commandName, options.url],
        returncode: 0,
        stdout: toPosixPath(videoPath),
        stderr: '',
      };
    }

    if (isYoutubeVideo) {
      throw new CommandExecutionError(classifyYoutubeDownloadFailure(result));
    }
    throw new CommandExecutionError(result);
  }

  // 小红书视频的成功路径要顺带探测平台字幕；其余平台不触碰网络。
  if (containsSupportedUrl(options.url, XIAOHONGSHU_HOST_SUFFIXES)) {
    await options.probeXiaohongshuSubtitle(options.url, options.outputDir);
  }
  return result;
}

/** 供媒体准备层判断：bilibili fallback 会关闭字幕检测。 */
export function isBilibiliFallbackCommand(command: readonly string[]): boolean {
  return command[0] === FALLBACK_COMMAND_NAMES.bilibili;
}
