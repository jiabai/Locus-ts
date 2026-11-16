// ffprobe 探测与流判定。
//
// 字段与判定条件对齐 `worker/worker_core/media.py` 的 `MediaInfo`：是否含视频/音频、
// 音频编码与采样参数、时长与体积。这三组判定决定了后续走哪条路——「有效音视频」「有效音频」
// 「已经是 16 kHz 单声道 PCM WAV」。
import {CommandExecutionError, type CommandRunner, runCommand} from './command.ts';

export interface MediaInfo {
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
  readonly audioSampleFormat: string | null;
  readonly audioSampleRate: number | null;
  readonly audioChannels: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationSeconds: number | null;
  readonly sizeBytes: number | null;
}

export function isAudioValid(info: MediaInfo): boolean {
  return info.hasAudio
    && info.durationSeconds !== null && info.durationSeconds > 0
    && info.sizeBytes !== null && info.sizeBytes > 0;
}

export function isMediaValid(info: MediaInfo): boolean {
  return info.hasVideo && isAudioValid(info);
}

/** ASR 只吃 16 kHz 单声道 16 位 PCM WAV；别的都是「归一化没做对」。 */
export function isNormalizedPcmWav(info: MediaInfo): boolean {
  return isAudioValid(info)
    && info.audioCodec === 'pcm_s16le'
    && info.audioSampleFormat === 's16'
    && info.audioSampleRate === 16000
    && info.audioChannels === 1;
}

export function buildFfprobeCommand(mediaPath: string): string[] {
  return [
    'ffprobe',
    '-v',
    'error',
    '-show_entries',
    'format=duration,size:stream=index,codec_type,codec_name,width,height,sample_fmt,sample_rate,channels',
    '-of',
    'json',
    mediaPath,
  ];
}

interface FfprobeStream {
  readonly codec_type?: unknown;
  readonly codec_name?: unknown;
  readonly sample_fmt?: unknown;
  readonly sample_rate?: unknown;
  readonly channels?: unknown;
  readonly width?: unknown;
  readonly height?: unknown;
}

function parseFloatOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseIntOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** 解析 ffprobe 的 `-of json` 输出。结构不对就抛错：调用方会映射成校验失败。 */
export function parseFfprobeJson(rawJson: string): MediaInfo {
  const payload = JSON.parse(rawJson) as {streams?: unknown; format?: unknown};
  const streams = Array.isArray(payload.streams) ? payload.streams as FfprobeStream[] : [];
  const videoStream = streams.find((stream) => stream.codec_type === 'video');
  const audioStream = streams.find((stream) => stream.codec_type === 'audio');
  const mediaFormat = (typeof payload.format === 'object' && payload.format !== null)
    ? payload.format as {duration?: unknown; size?: unknown}
    : {};

  return {
    hasVideo: videoStream !== undefined,
    hasAudio: audioStream !== undefined,
    videoCodec: videoStream === undefined ? null : stringOrNull(videoStream.codec_name),
    audioCodec: audioStream === undefined ? null : stringOrNull(audioStream.codec_name),
    audioSampleFormat: audioStream === undefined ? null : stringOrNull(audioStream.sample_fmt),
    audioSampleRate: audioStream === undefined ? null : parseIntOrNull(audioStream.sample_rate),
    audioChannels: audioStream === undefined ? null : parseIntOrNull(audioStream.channels),
    width: videoStream === undefined ? null : parseIntOrNull(videoStream.width),
    height: videoStream === undefined ? null : parseIntOrNull(videoStream.height),
    durationSeconds: parseFloatOrNull(mediaFormat.duration),
    sizeBytes: parseIntOrNull(mediaFormat.size),
  };
}

export async function probeMediaFile(
  mediaPath: string,
  runner: CommandRunner = runCommand,
): Promise<MediaInfo> {
  const result = await runner(buildFfprobeCommand(mediaPath));
  if (result.returncode !== 0) throw new CommandExecutionError(result);
  return parseFfprobeJson(result.stdout);
}
