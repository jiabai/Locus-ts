// 媒体准备的公共入口。任务流程只用这里，ffmpeg 参数与探测细节是实现。
export {extractAudio, buildAudioExtractCommand} from './audio.ts';
export {CommandExecutionError, runCommand, structuredErrorCode} from './command.ts';
export type {CommandResult, CommandRunner, CommandRunOptions} from './command.ts';
export {
  buildFfprobeCommand,
  isAudioValid,
  isMediaValid,
  isNormalizedPcmWav,
  parseFfprobeJson,
  probeMediaFile,
} from './ffprobe.ts';
export type {MediaInfo} from './ffprobe.ts';
export {
  MediaPreparationError,
  prepareLocalMedia,
  validateStreams,
} from './local-media.ts';
export type {UrlMediaErrorCode} from './errors.ts';
export {
  prepareUrlMedia,
} from './url-media.ts';
export type {
  PrepareUrlMediaOptions,
  PreparedUrlMedia,
  UrlMediaPaths,
} from './url-media.ts';
export type {
  LocalMediaErrorCode,
  LocalMediaKind,
  LocalMediaPaths,
  PrepareLocalMediaOptions,
  PreparedLocalMedia,
} from './local-media.ts';
export {
  buildYtdlpCommand,
  classifyYoutubeDownloadFailure,
  outputTemplate,
  sanitizeYoutubeError,
  shouldAttemptYoutubeProcessing,
} from './ytdlp.ts';
export {
  FALLBACK_COMMAND_NAMES,
  FallbackDownloadError,
  createFallbackStrategies,
  downloadVideo,
  isBilibiliFallbackCommand,
} from './download.ts';
export type {
  DownloadVideoOptions,
  FallbackDownloadStrategy,
  FallbackCommandName,
} from './download.ts';
export {createPlatformFallbackStrategies} from './platform-strategies.ts';
export {findSubtitleTranscript, parseSubtitleContent} from './subtitles.ts';
export type {SubtitleTranscript, TranscriptSegment} from './subtitles.ts';
export {
  findLatestVideo,
  findNewOrUpdatedVideo,
  findVideoByStem,
  findVideoFromDownloadStdout,
  snapshotVideoFiles,
  canReuseAudio,
} from './download-output.ts';
