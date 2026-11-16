// VAD 在线前端，对齐 funasr_onnx 的 WavFrontendOnline（生产 FSMN VAD 使用的那一套）。
// 与 ASR 前端不同：dither=0.0、LFR 5/1、输出 400 维，并跨 10 秒块维护
// input_cache / lfr_splice_cache / reserve_waveforms 三份状态。
import {applyCmvn, type Cmvn} from './cmvn.ts';
import {FRAME_LENGTH, FRAME_SHIFT, createFbank} from './fbank.ts';

const concatF32 = (a: Float32Array, b: Float32Array): Float32Array => {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

const computeFrameNum = (length: number): number => {
  const frames = Math.trunc((length - FRAME_LENGTH) / FRAME_SHIFT + 1);
  return frames >= 1 && length >= FRAME_LENGTH ? frames : 0;
};

export interface VadFrontendOptions {
  cmvn: Cmvn;
  lfrM?: number;
  lfrN?: number;
  numMel?: number;
}

export interface FbankChunkResult {
  readonly feats: Float64Array[];
  readonly featsLen: number;
}

interface LfrOnlineResult {
  readonly rows: Float64Array[];
  readonly cache: Float64Array[];
  readonly spliceIdx: number;
}

export class WavFrontendOnline {
  private readonly cmvn: Cmvn;
  private readonly lfrM: number;
  private readonly lfrN: number;
  private readonly fbank: (samples: Float32Array) => Float64Array[];
  private inputCache: Float32Array | null = null;
  private reserveWaveforms: Float32Array | null = null;
  private lfrSpliceCache: Float64Array[] | null = null;
  /** 最近一块送去状态机计算分贝的 waveform；跨块累积到端点闭合为止。 */
  waveforms: Float32Array | null = null;

  constructor({cmvn, lfrM = 5, lfrN = 1, numMel = 80}: VadFrontendOptions) {
    this.cmvn = cmvn;
    this.lfrM = lfrM;
    this.lfrN = lfrN;
    this.fbank = createFbank({numMel, dither: 0});
  }

  cacheReset(): void {
    this.inputCache = null;
    this.reserveWaveforms = null;
    this.lfrSpliceCache = null;
  }

  private applyLfrOnline(inputs: readonly Float64Array[], isFinal: boolean): LfrOnlineResult {
    const {lfrM, lfrN} = this;
    const total = inputs.length;
    const dim = inputs[0]?.length ?? 0;
    const lfrTotal = Math.ceil((total - Math.floor((lfrM - 1) / 2)) / lfrN);
    let spliceIdx = lfrTotal;
    const rows: Float64Array[] = [];
    for (let i = 0; i < lfrTotal; i += 1) {
      if (lfrM <= total - i * lfrN) {
        const row = new Float64Array(lfrM * dim);
        for (let k = 0; k < lfrM; k += 1) row.set(inputs[i * lfrN + k] as Float64Array, k * dim);
        rows.push(row);
      } else if (isFinal) {
        const available = total - i * lfrN;
        const row = new Float64Array(lfrM * dim);
        for (let k = 0; k < available; k += 1) row.set(inputs[i * lfrN + k] as Float64Array, k * dim);
        for (let k = available; k < lfrM; k += 1) row.set(inputs[total - 1] as Float64Array, k * dim);
        rows.push(row);
      } else {
        spliceIdx = i;
        break;
      }
    }
    const splice = Math.min(total - 1, spliceIdx * lfrN);
    return {rows, cache: inputs.slice(splice), spliceIdx: splice};
  }

  private fbankChunk(input: Float32Array): {waveform: Float32Array; feats: Float64Array[]} {
    const merged = this.inputCache === null || this.inputCache.length === 0
      ? input.slice()
      : concatF32(this.inputCache, input);
    const frameNum = computeFrameNum(merged.length);
    const tail = merged.length - frameNum * FRAME_SHIFT;
    // 生产实现写作 input[:, -(len - frame_num*shift):]；尾巴长度为 0 时 Python 的
    // -0 等于 0，切片退化为整段，因此这里必须同样保留整段缓存，不能"更合理"地清空。
    this.inputCache = tail === 0 ? merged.slice() : merged.slice(merged.length - tail);
    if (!frameNum) return {waveform: new Float32Array(0), feats: []};
    const waveform = merged.slice(0, (frameNum - 1) * FRAME_SHIFT + FRAME_LENGTH);
    const feats = this.fbank(waveform);
    if (feats.length !== frameNum) {
      throw new Error(`Fbank frame count ${feats.length} != expected ${frameNum}`);
    }
    return {waveform, feats};
  }

  extractFbank(input: Float32Array, isFinal: boolean): FbankChunkResult {
    const {lfrM, lfrN} = this;
    const {waveform, feats} = this.fbankChunk(input);
    if (feats.length) {
      this.waveforms = this.reserveWaveforms === null
        ? waveform
        : concatF32(this.reserveWaveforms, waveform);
      if (this.lfrSpliceCache === null) {
        this.lfrSpliceCache = Array.from(
          {length: Math.floor((lfrM - 1) / 2)},
          () => (feats[0] as Float64Array).slice(),
        );
      }
      const spliceCache = this.lfrSpliceCache;
      if (feats.length + spliceCache.length >= lfrM) {
        const mergedFeats = [...spliceCache, ...feats];
        const frameFromWaveforms = Math.trunc((this.waveforms.length - FRAME_LENGTH) / FRAME_SHIFT + 1);
        const minusFrame = this.reserveWaveforms === null ? Math.floor((lfrM - 1) / 2) : 0;
        const {rows, cache, spliceIdx} = this.applyLfrOnline(mergedFeats, isFinal);
        const output = applyCmvn(rows, this.cmvn);
        this.lfrSpliceCache = cache;
        if (lfrM !== 1) {
          const reserveFrameIdx = spliceIdx - minusFrame;
          this.reserveWaveforms = this.waveforms.slice(
            reserveFrameIdx * FRAME_SHIFT,
            frameFromWaveforms * FRAME_SHIFT,
          );
          this.waveforms = this.waveforms.slice(0, (frameFromWaveforms - 1) * FRAME_SHIFT + FRAME_LENGTH);
        } else {
          this.reserveWaveforms = null;
        }
        if (isFinal) this.cacheReset();
        return {feats: output, featsLen: output.length};
      }
      this.reserveWaveforms = this.waveforms.slice(
        0,
        this.waveforms.length - (FRAME_LENGTH - FRAME_SHIFT),
      );
      this.lfrSpliceCache = [...spliceCache, ...feats];
      return {feats: [], featsLen: feats.length};
    }
    if (isFinal) {
      this.waveforms = this.reserveWaveforms === null ? waveform : this.reserveWaveforms;
      const {rows} = this.applyLfrOnline(this.lfrSpliceCache ?? [], true);
      const output = applyCmvn(rows, this.cmvn);
      this.cacheReset();
      return {feats: output, featsLen: output.length};
    }
    return {feats: [], featsLen: feats.length};
  }
}
