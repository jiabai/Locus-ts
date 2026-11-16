// kaldi 兼容的 Fbank 前端 + 离线 LFR/CMVN，对齐 funasr_onnx 的 WavFrontend。
// 参数来自生产 SenseVoiceSmall 的 config.yaml 与 kaldi-native-fbank 默认值：
// 16 kHz、25 ms 窗长（400 样本）、10 ms 帧移（160 样本）、去直流、0.97 预加重、
// hamming 窗、512 点 FFT、80 维 HTK mel（20 Hz ~ Nyquist）、log 能量下限 FLT_EPSILON。
// 前端内部用 double 计算，只在构造张量时降为 float32；与 C++ float32 实现存在
// 1e-5 量级的浮点差异（FFT 运算顺序不同），这是被接受的既有事实，门禁按数值容差比对。
import {applyCmvn, type Cmvn} from './cmvn.ts';
import {SAMPLE_RATE} from './audio.ts';

export const FRAME_LENGTH = 400;
export const FRAME_SHIFT = 160;
export const NUM_MEL = 80;
const PADDED = 512;
const NUM_FFT_BINS = PADDED / 2;
const PREEMPH = 0.97;
const FLT_EPSILON = 1.1920928955078125e-7;
const FFT_BIN_WIDTH = SAMPLE_RATE / PADDED;
const LOW_FREQ = 20;
const HIGH_FREQ = SAMPLE_RATE / 2;

const melScale = (freq: number): number => 1127 * Math.log(1 + freq / 700);

const windowCoeffs = new Float64Array(FRAME_LENGTH);
{
  const base = (2 * Math.PI) / (FRAME_LENGTH - 1);
  for (let index = 0; index < FRAME_LENGTH; index += 1) {
    windowCoeffs[index] = 0.54 - 0.46 * Math.cos(base * index);
  }
}

// 三角滤波器组权重按 kaldi 的 InitKaldiMelBanks 构造：只在 left<mel<right 的
// FFT bin 上非零，Nyquist bin 不参与（与原实现一致）。
interface MelBin { indices: Int32Array; weights: Float64Array }

function buildMelBins(numMel: number): MelBin[] {
  const melLow = melScale(LOW_FREQ);
  const melHigh = melScale(HIGH_FREQ);
  const melDelta = (melHigh - melLow) / (numMel + 1);
  const binMels = new Float64Array(NUM_FFT_BINS + 1);
  for (let index = 0; index <= NUM_FFT_BINS; index += 1) binMels[index] = melScale(FFT_BIN_WIDTH * index);
  const bins: MelBin[] = new Array(numMel);
  for (let bin = 0; bin < numMel; bin += 1) {
    const left = melLow + bin * melDelta;
    const center = melLow + (bin + 1) * melDelta;
    const right = melLow + (bin + 2) * melDelta;
    const indices = [];
    const weights = [];
    for (let index = 0; index < NUM_FFT_BINS; index += 1) {
      const mel = binMels[index];
      if (mel <= left || mel >= right) continue;
      indices.push(index);
      weights.push(mel <= center ? (mel - left) / (center - left) : (right - mel) / (right - center));
    }
    bins[bin] = {indices: Int32Array.from(indices), weights: Float64Array.from(weights)};
  }
  return bins;
}

// 512 点基 2 实数 FFT（补零到 512，虚部全零）。输出布局与 kaldi 一致：
// index 0 与 Nyquist 为纯实数，其余 bin 用 re/im 平方和求功率。
const COS_TABLE = new Float64Array(PADDED / 2);
const SIN_TABLE = new Float64Array(PADDED / 2);
for (let k = 0; k < PADDED / 2; k += 1) {
  const angle = (-2 * Math.PI * k) / PADDED;
  COS_TABLE[k] = Math.cos(angle);
  SIN_TABLE[k] = Math.sin(angle);
}

function fft512(frame: Float64Array, re: Float64Array, im: Float64Array): void {
  re.fill(0);
  im.fill(0);
  for (let index = 0; index < FRAME_LENGTH; index += 1) re[index] = frame[index];
  for (let i = 1, j = 0; i < PADDED; i += 1) {
    let bit = PADDED >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const reTemp = re[i]; re[i] = re[j]; re[j] = reTemp;
      const imTemp = im[i]; im[i] = im[j]; im[j] = imTemp;
    }
  }
  for (let length = 2; length <= PADDED; length <<= 1) {
    const half = length >> 1;
    const step = PADDED / length;
    for (let start = 0; start < PADDED; start += length) {
      for (let k = 0; k < half; k += 1) {
        const wr = COS_TABLE[k * step];
        const wi = SIN_TABLE[k * step];
        const a = start + k;
        const b = a + half;
        const vr = re[b] * wr - im[b] * wi;
        const vi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - vr;
        im[b] = im[a] - vi;
        re[a] += vr;
        im[a] += vi;
      }
    }
  }
}

// kaldi 的 dither 用当前时间做随机种子，同一段音频每次结果都不同，无法逐位复现。
// 这里保留同分布的噪声实现，仅用于与生产 dither=1.0 行为对照；门禁一律使用 dither=0。
const randUniform = () => (Math.floor(Math.random() * 32768) + 1) / 32769;
const randGauss = () => Math.sqrt(-2 * Math.log(randUniform())) * Math.cos(2 * Math.PI * randUniform());

export interface FbankOptions { numMel?: number; dither?: number }

export function createFbank({numMel = NUM_MEL, dither = 0}: FbankOptions = {}): (samples: Float32Array) => Float64Array[] {
  const melBins = buildMelBins(numMel);
  const frame = new Float64Array(PADDED);
  const re = new Float64Array(PADDED);
  const im = new Float64Array(PADDED);
  const power = new Float64Array(NUM_FFT_BINS + 1);

  function computeFrame(samples: Float32Array, start: number): Float64Array {
    frame.fill(0);
    for (let index = 0; index < FRAME_LENGTH; index += 1) {
      frame[index] = samples[start + index] * (1 << 15);
    }
    if (dither !== 0) {
      for (let index = 0; index < FRAME_LENGTH; index += 1) frame[index] += randGauss() * dither;
    }
    let sum = 0;
    for (let index = 0; index < FRAME_LENGTH; index += 1) sum += frame[index];
    const mean = sum / FRAME_LENGTH;
    for (let index = 0; index < FRAME_LENGTH; index += 1) frame[index] -= mean;
    for (let index = FRAME_LENGTH - 1; index > 0; index -= 1) {
      frame[index] -= PREEMPH * frame[index - 1];
    }
    frame[0] -= PREEMPH * frame[0];
    for (let index = 0; index < FRAME_LENGTH; index += 1) frame[index] *= windowCoeffs[index];

    fft512(frame, re, im);
    power[0] = re[0] * re[0];
    power[NUM_FFT_BINS] = re[NUM_FFT_BINS] * re[NUM_FFT_BINS];
    for (let index = 1; index < NUM_FFT_BINS; index += 1) {
      power[index] = re[index] * re[index] + im[index] * im[index];
    }
    const feature = new Float64Array(numMel);
    for (let bin = 0; bin < numMel; bin += 1) {
      const {indices, weights} = melBins[bin];
      let energy = 0;
      for (let i = 0; i < indices.length; i += 1) energy += weights[i] * power[indices[i]];
      feature[bin] = Math.log(Math.max(energy, FLT_EPSILON));
    }
    return feature;
  }

  return function fbank(samples: Float32Array): Float64Array[] {
    const frameCount = 1 + Math.floor((samples.length - FRAME_LENGTH) / FRAME_SHIFT);
    if (frameCount <= 0) return [];
    const rows: Float64Array[] = new Array(frameCount);
    for (let index = 0; index < frameCount; index += 1) {
      rows[index] = computeFrame(samples, index * FRAME_SHIFT);
    }
    return rows;
  };
}

// 离线 LFR：左补 floor((m-1)/2) 帧、按 n 帧步长拼接，尾部不足时重复最后一帧。
function applyLfrOffline(rows: readonly Float64Array[], lfrM: number, lfrN: number): Float64Array[] {
  const dim = rows[0].length;
  const left = Math.floor((lfrM - 1) / 2);
  const padded: Float64Array[] = [];
  for (let index = 0; index < left; index += 1) padded.push(rows[0]);
  padded.push(...rows);
  const total = Math.ceil(rows.length / lfrN);
  const out: Float64Array[] = new Array(total);
  for (let i = 0; i < total; i += 1) {
    const row = new Float64Array(lfrM * dim);
    const available = padded.length - i * lfrN;
    if (lfrM <= available) {
      for (let k = 0; k < lfrM; k += 1) row.set(padded[i * lfrN + k], k * dim);
    } else {
      for (let k = 0; k < available; k += 1) row.set(padded[i * lfrN + k], k * dim);
      const last = padded[padded.length - 1];
      for (let k = available; k < lfrM; k += 1) row.set(last, k * dim);
    }
    out[i] = row;
  }
  return out;
}

// 生产 ASR 前端：LFR 7/6 + 560 维 CMVN，dither 由 config.yaml 决定。
export interface WavFrontendOptions {
  cmvn: Cmvn;
  lfrM?: number;
  lfrN?: number;
  numMel?: number;
  dither?: number;
}

export class WavFrontend {
  private readonly cmvn: Cmvn;
  readonly lfrM: number;
  readonly lfrN: number;
  readonly dither: number;
  private readonly fbank: (samples: Float32Array) => Float64Array[];

  constructor({cmvn, lfrM = 7, lfrN = 6, numMel = NUM_MEL, dither = 0}: WavFrontendOptions) {
    this.cmvn = cmvn;
    this.lfrM = lfrM;
    this.lfrN = lfrN;
    this.dither = dither;
    this.fbank = createFbank({numMel, dither});
  }

  extract(samples: Float32Array): Float64Array[] {
    const rows = this.fbank(samples);
    if (!rows.length) return [];
    return applyCmvn(applyLfrOffline(rows, this.lfrM, this.lfrN), this.cmvn);
  }
}
