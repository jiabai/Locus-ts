// PCM WAV 读取。只接受 16 kHz、单声道、16 位，与生产
// `_read_pcm_wav_mono_float32` 的归一化方式一致（int16 / 32768）。
import {ASRRuntimeError} from './errors.ts';

export const SAMPLE_RATE = 16000;

export interface WavFormat {
  readonly channels: number;
  readonly sampleRate: number;
  readonly bits: number;
}

function readFormat(buffer: Buffer, headerOffset: number): WavFormat {
  return {
    channels: buffer.readUInt16LE(headerOffset + 2),
    sampleRate: buffer.readUInt32LE(headerOffset + 4),
    bits: buffer.readUInt16LE(headerOffset + 14),
  };
}

export function readWavMono16(label: string, buffer: Buffer): Float32Array {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF'
    || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new ASRRuntimeError('ONNX ASR could not read normalized PCM WAV audio.', `${label}: not RIFF/WAVE`);
  }
  let offset = 12;
  let format: WavFormat | null = null;
  let data: Buffer | null = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = readFormat(buffer, body);
    } else if (id === 'data') {
      data = buffer.subarray(body, Math.min(body + size, buffer.length));
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!format || !data) {
    throw new ASRRuntimeError('ONNX ASR could not read normalized PCM WAV audio.', `${label}: missing fmt/data`);
  }
  if (format.channels !== 1 || format.bits !== 16 || format.sampleRate !== SAMPLE_RATE) {
    throw new ASRRuntimeError(
      'ONNX ASR could not read normalized PCM WAV audio.',
      `${label}: ${JSON.stringify(format)}`,
    );
  }
  const samples = new Float32Array(Math.floor(data.length / 2));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = data.readInt16LE(index * 2) / 32768;
  }
  return samples;
}
