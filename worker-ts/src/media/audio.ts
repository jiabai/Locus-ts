// 音频归一化：任意容器 → 16 kHz 单声道 16 位 PCM WAV。
//
// 参数与 `worker/worker_core/media.py` 的 `build_audio_extract_command` 完全一致：
// `-vn -ac 1 -ar 16000 -c:a pcm_s16le`。参数变了 ASR 前端就会拿到不同采样率的数据，
// 识别结果随之改变，因此这里不做「优化」。
import {mkdir} from 'node:fs/promises';
import path from 'node:path';

import {CommandExecutionError, type CommandRunner, type CommandResult, runCommand} from './command.ts';

export function buildAudioExtractCommand(inputPath: string, outputPath: string): string[] {
  return [
    'ffmpeg',
    '-y',
    '-i',
    inputPath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    outputPath,
  ];
}

/** 提取音频到 `outputPath`（覆盖写）。失败抛 `CommandExecutionError`，由调用方映射错误码。 */
export async function extractAudio(
  options: {
    readonly inputPath: string;
    readonly outputPath: string;
    readonly runner?: CommandRunner;
  },
): Promise<CommandResult> {
  const runner = options.runner ?? runCommand;
  await mkdir(path.dirname(options.outputPath), {recursive: true});
  const result = await runner(buildAudioExtractCommand(options.inputPath, options.outputPath));
  if (result.returncode !== 0) throw new CommandExecutionError(result);
  return result;
}
