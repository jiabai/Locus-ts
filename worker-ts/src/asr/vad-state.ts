// funasr_onnx utils/e2e_vad.py 的等价实现：WindowDetector 与 E2EVadModel 的有状态路径，
// 以及生产 _decode_onnx_vad_events / _stream_onnx_vad_segments 的事件解码与跨块配对规则。
// 状态机不依赖 ONNX，只吃每块 logits 与对应 waveform。
import {ASRRuntimeError} from './errors.ts';
import type {VadModelConf} from './config.ts';

const SIL2SIL = 2;
const SIL2SPEECH = 3;
const SPEECH2SIL = 1;
const SPEECH2SPEECH = 0;
const STATE_NO_START = 1;
const STATE_IN_SPEECH = 2;
const STATE_END_DETECTED = 3;
const FRAME_SPEECH = 1;
const FRAME_SIL = 0;
const FRAME_INVALID = -1;
const CHANGE_INVALID = 5;

/** VAD 图输出的 logits 视图；`dim` 是类别维度，`frames` 是本块的帧数。 */
export interface VadScores {
  readonly data: Float32Array;
  readonly frames: number;
  readonly dim: number;
}

/** 一块内产生的原始事件：`-1` 表示该端点尚未闭合。 */
export type VadEventPair = [number, number];
export type VadEventBatch = VadEventPair[];
export type VadChunkEvents = VadEventBatch[];

/** 已配对的分段，单位毫秒。 */
export type VadSegment = [number, number];

interface OutputBufEntry {
  start_ms: number;
  end_ms: number;
  contain_seg_start_point: boolean;
  contain_seg_end_point: boolean;
}

class WindowDetector {
  winSum = 0;
  winState: number[] = [];
  curWinPos = 0;
  preFrameState = FRAME_SIL;
  readonly winSizeFrame: number;
  private readonly silToSpeechThres: number;
  private readonly speechToSilThres: number;

  constructor(conf: VadModelConf) {
    const frameInMs = conf.frame_in_ms;
    this.winSizeFrame = Math.trunc(conf.window_size_ms / frameInMs);
    this.silToSpeechThres = Math.trunc(conf.sil_to_speech_time_thres / frameInMs);
    this.speechToSilThres = Math.trunc(conf.speech_to_sil_time_thres / frameInMs);
    this.reset();
  }

  reset(): void {
    this.winSum = 0;
    this.winState = new Array(this.winSizeFrame).fill(0);
    this.curWinPos = 0;
    this.preFrameState = FRAME_SIL;
  }

  detectOneFrame(frameState: number): number {
    let cur = FRAME_INVALID;
    if (frameState === FRAME_SPEECH) cur = 1;
    else if (frameState === FRAME_SIL) cur = 0;
    else return CHANGE_INVALID;
    this.winSum -= this.winState[this.curWinPos] as number;
    this.winSum += cur;
    this.winState[this.curWinPos] = cur;
    this.curWinPos = (this.curWinPos + 1) % this.winSizeFrame;
    if (this.preFrameState === FRAME_SIL && this.winSum >= this.silToSpeechThres) {
      this.preFrameState = FRAME_SPEECH;
      return SIL2SPEECH;
    }
    if (this.preFrameState === FRAME_SPEECH && this.winSum <= this.speechToSilThres) {
      this.preFrameState = FRAME_SIL;
      return SPEECH2SIL;
    }
    if (this.preFrameState === FRAME_SIL) return SIL2SIL;
    if (this.preFrameState === FRAME_SPEECH) return SPEECH2SPEECH;
    return CHANGE_INVALID;
  }
}

export class E2EVadModel {
  private readonly conf: VadModelConf;
  private readonly frameSampleLength: number;
  private readonly frameShiftSamples: number;
  private readonly maxEndSil: number;
  private readonly windowsDetector: WindowDetector;
  private readonly silPdfIds: readonly number[];
  private readonly speechNoiseThres: number;

  private dataBufStartFrame = 0;
  private frmCnt = 0;
  private latestConfirmedSpeechFrame = 0;
  private lastestConfirmedSilenceFrame = -1;
  private continousSilenceFrameCount = 0;
  private vadStateMachine = STATE_NO_START;
  private confirmedStartFrame = -1;
  private confirmedEndFrame = -1;
  private numberEndTimeDetected = 0;
  private preEndSilenceDetected = false;
  private nextSeg = true;
  private outputDataBuf: OutputBufEntry[] = [];
  private outputDataBufOffset = 0;
  private scores: VadScores | null = null;
  private idxPreChunk = 0;
  private decibel: number[] = [];
  private dataBufSize = 0;
  private dataBufAllSize = 0;
  private frameProbs: number[] = [];
  private silFrame = 0;
  private nnEvalBlockSize = 0;
  private maxEndSilFrameCntThresh: number;
  /** 噪声均值，只在整个流重置时初始化；resetDetection 不动它（与 e2e_vad.py 一致）。 */
  private noiseAverageDecibel = -100.0;
  /** 段起点/终点重复确认的次数；生产同样只累加不消费，留作诊断。 */
  resetWarnings = 0;

  constructor(conf: VadModelConf) {
    this.conf = conf;
    this.frameSampleLength = Math.trunc((conf.frame_length_ms * conf.sample_rate) / 1000);
    this.frameShiftSamples = Math.trunc((conf.frame_in_ms * conf.sample_rate) / 1000);
    this.maxEndSil = conf.max_end_silence_time;
    this.windowsDetector = new WindowDetector(conf);
    this.silPdfIds = conf.sil_pdf_ids;
    this.speechNoiseThres = conf.speech_noise_thres;
    this.maxEndSilFrameCntThresh = this.maxEndSil - conf.speech_to_sil_time_thres;
    this.allResetDetection();
  }

  allResetDetection(): void {
    this.dataBufStartFrame = 0;
    this.frmCnt = 0;
    this.latestConfirmedSpeechFrame = 0;
    this.lastestConfirmedSilenceFrame = -1;
    this.continousSilenceFrameCount = 0;
    this.vadStateMachine = STATE_NO_START;
    this.confirmedStartFrame = -1;
    this.confirmedEndFrame = -1;
    this.numberEndTimeDetected = 0;
    this.preEndSilenceDetected = false;
    this.nextSeg = true;
    this.outputDataBuf = [];
    this.outputDataBufOffset = 0;
    this.frameProbs = [];
    this.scores = null;
    this.idxPreChunk = 0;
    this.decibel = [];
    this.dataBufSize = 0;
    this.dataBufAllSize = 0;
    this.noiseAverageDecibel = -100.0;
    this.resetDetection();
  }

  resetDetection(): void {
    this.continousSilenceFrameCount = 0;
    this.latestConfirmedSpeechFrame = 0;
    this.lastestConfirmedSilenceFrame = -1;
    this.confirmedStartFrame = -1;
    this.confirmedEndFrame = -1;
    this.vadStateMachine = STATE_NO_START;
    this.windowsDetector.reset();
    this.silFrame = 0;
    this.frameProbs = [];
  }

  private computeDecibel(waveform: Float32Array): void {
    if (this.dataBufAllSize === 0) {
      this.dataBufAllSize = waveform.length;
      this.dataBufSize = this.dataBufAllSize;
    } else {
      this.dataBufAllSize += waveform.length;
    }
    const {frameSampleLength, frameShiftSamples} = this;
    for (let offset = 0; offset + frameSampleLength <= waveform.length; offset += frameShiftSamples) {
      let sum = 0;
      for (let index = offset; index < offset + frameSampleLength; index += 1) {
        sum += (waveform[index] as number) * (waveform[index] as number);
      }
      this.decibel.push(10 * Math.log10(sum + 0.000001));
    }
  }

  private popDataBufTillFrame(frameIdx: number): void {
    while (this.dataBufStartFrame < frameIdx) {
      if (this.dataBufSize >= this.frameShiftSamples) {
        this.dataBufStartFrame += 1;
        this.dataBufSize = this.dataBufAllSize - this.dataBufStartFrame * this.frameShiftSamples;
      } else {
        break;
      }
    }
  }

  private popDataToOutputBuf(
    startFrm: number,
    frmCnt: number,
    firstIsStartPoint: boolean,
    lastIsEndPoint: boolean,
    endPointIsSentEnd: boolean,
  ): void {
    this.popDataBufTillFrame(startFrm);
    const {sample_rate: sampleRate, frame_in_ms: frameInMs} = this.conf;
    let expectedSampleNumber = Math.trunc((frmCnt * sampleRate * frameInMs) / 1000);
    if (lastIsEndPoint) {
      expectedSampleNumber += Math.max(0, this.frameSampleLength - this.frameShiftSamples);
    }
    if (endPointIsSentEnd) expectedSampleNumber = Math.max(expectedSampleNumber, this.dataBufSize);
    if (this.outputDataBuf.length === 0 || firstIsStartPoint) {
      this.outputDataBuf.push({
        start_ms: startFrm * frameInMs,
        end_ms: startFrm * frameInMs,
        contain_seg_start_point: false,
        contain_seg_end_point: false,
      });
    }
    const curSeg = this.outputDataBuf[this.outputDataBuf.length - 1] as OutputBufEntry;
    this.dataBufStartFrame += frmCnt;
    curSeg.end_ms = (startFrm + frmCnt) * frameInMs;
    if (firstIsStartPoint) curSeg.contain_seg_start_point = true;
    if (lastIsEndPoint) curSeg.contain_seg_end_point = true;
  }

  private onSilenceDetected(validFrame: number): void {
    this.lastestConfirmedSilenceFrame = validFrame;
    if (this.vadStateMachine === STATE_NO_START) this.popDataBufTillFrame(validFrame);
  }

  private onVoiceDetected(validFrame: number): void {
    this.latestConfirmedSpeechFrame = validFrame;
    this.popDataToOutputBuf(validFrame, 1, false, false, false);
  }

  private onVoiceStart(startFrame: number, fakeResult = false): void {
    if (this.confirmedStartFrame !== -1) {
      this.resetWarnings += 1;
    } else {
      this.confirmedStartFrame = startFrame;
    }
    if (!fakeResult && this.vadStateMachine === STATE_NO_START) {
      this.popDataToOutputBuf(this.confirmedStartFrame, 1, true, false, false);
    }
  }

  private onVoiceEnd(endFrame: number, fakeResult: boolean, isLastFrame: boolean): void {
    for (let t = this.latestConfirmedSpeechFrame + 1; t < endFrame; t += 1) this.onVoiceDetected(t);
    if (this.confirmedEndFrame !== -1) {
      this.resetWarnings += 1;
    } else {
      this.confirmedEndFrame = endFrame;
    }
    if (!fakeResult) {
      this.silFrame = 0;
      this.popDataToOutputBuf(this.confirmedEndFrame, 1, false, true, isLastFrame);
    }
    this.numberEndTimeDetected += 1;
  }

  private maybeOnVoiceEndIfLastFrame(isFinalFrame: boolean, curFrmIdx: number): void {
    if (isFinalFrame) {
      this.onVoiceEnd(curFrmIdx, false, true);
      this.vadStateMachine = STATE_END_DETECTED;
    }
  }

  private latencyFrmNumAtStartPoint(): number {
    let latency = this.windowsDetector.winSizeFrame;
    if (this.conf.do_extend) {
      latency += Math.trunc((this.conf.lookback_time_start_point ?? 0) / this.conf.frame_in_ms);
    }
    return latency;
  }

  private getFrameState(t: number): number {
    const curDecibel = this.decibel[t] as number;
    const curSnr = curDecibel - this.noiseAverageDecibel;
    if (curDecibel < this.conf.decibel_thres) {
      this.detectOneFrame(FRAME_SIL, t, false);
      return FRAME_SIL;
    }
    const scores = this.scores as VadScores;
    const scoreRow = (t - this.idxPreChunk) * scores.dim;
    let sumScore = 0;
    for (const pdfId of this.silPdfIds) sumScore += scores.data[scoreRow + pdfId] as number;
    const noiseProb = Math.log(sumScore) * this.conf.speech_2_noise_ratio;
    sumScore = 1 - sumScore;
    const speechProb = Math.log(sumScore);
    if (Math.exp(speechProb) >= Math.exp(noiseProb) + this.speechNoiseThres) {
      if (curSnr >= this.conf.snr_thres && curDecibel >= this.conf.decibel_thres) return FRAME_SPEECH;
      return FRAME_SIL;
    }
    if (this.noiseAverageDecibel < -99.9) {
      this.noiseAverageDecibel = curDecibel;
    } else {
      this.noiseAverageDecibel = (
        curDecibel + this.noiseAverageDecibel * (this.conf.noise_frame_num_used_for_snr - 1)
      ) / this.conf.noise_frame_num_used_for_snr;
    }
    return FRAME_SIL;
  }

  private detectCommonFrames(): void {
    if (this.vadStateMachine === STATE_END_DETECTED) return;
    const blockSize = this.nnEvalBlockSize;
    for (let i = blockSize - 1; i >= 0; i -= 1) {
      this.detectOneFrame(this.getFrameState(this.frmCnt - 1 - i), this.frmCnt - 1 - i, false);
    }
    this.idxPreChunk += (this.scores as VadScores).frames;
  }

  private detectLastFrames(): void {
    if (this.vadStateMachine === STATE_END_DETECTED) return;
    const blockSize = this.nnEvalBlockSize;
    for (let i = blockSize - 1; i >= 0; i -= 1) {
      this.detectOneFrame(this.getFrameState(this.frmCnt - 1 - i), this.frmCnt - 1 - i, i === 0);
    }
  }

  private detectOneFrame(curFrmState: number, curFrmIdx: number, isFinalFrame: boolean): void {
    let tmpState = FRAME_INVALID;
    if (curFrmState === FRAME_SPEECH) {
      tmpState = Math.abs(1) > this.conf.fe_prior_thres ? FRAME_SPEECH : FRAME_SIL;
    } else if (curFrmState === FRAME_SIL) {
      tmpState = FRAME_SIL;
    }
    const stateChange = this.windowsDetector.detectOneFrame(tmpState);
    const conf = this.conf;
    const frameInMs = conf.frame_in_ms;
    const maxSegmentFrames = conf.max_single_segment_time / frameInMs;
    if (stateChange === SIL2SPEECH) {
      this.continousSilenceFrameCount = 0;
      this.preEndSilenceDetected = false;
      if (this.vadStateMachine === STATE_NO_START) {
        const startFrame = Math.max(this.dataBufStartFrame, curFrmIdx - this.latencyFrmNumAtStartPoint());
        this.onVoiceStart(startFrame);
        this.vadStateMachine = STATE_IN_SPEECH;
        for (let t = startFrame + 1; t <= curFrmIdx; t += 1) this.onVoiceDetected(t);
      } else if (this.vadStateMachine === STATE_IN_SPEECH) {
        for (let t = this.latestConfirmedSpeechFrame + 1; t < curFrmIdx; t += 1) this.onVoiceDetected(t);
        if (curFrmIdx - this.confirmedStartFrame + 1 > maxSegmentFrames) {
          this.onVoiceEnd(curFrmIdx, false, false);
          this.vadStateMachine = STATE_END_DETECTED;
        } else if (!isFinalFrame) {
          this.onVoiceDetected(curFrmIdx);
        } else {
          this.maybeOnVoiceEndIfLastFrame(isFinalFrame, curFrmIdx);
        }
      }
    } else if (stateChange === SPEECH2SIL || stateChange === SPEECH2SPEECH) {
      this.continousSilenceFrameCount = 0;
      if (this.vadStateMachine === STATE_IN_SPEECH) {
        if (curFrmIdx - this.confirmedStartFrame + 1 > maxSegmentFrames) {
          this.onVoiceEnd(curFrmIdx, false, false);
          this.vadStateMachine = STATE_END_DETECTED;
        } else if (!isFinalFrame) {
          this.onVoiceDetected(curFrmIdx);
        } else {
          this.maybeOnVoiceEndIfLastFrame(isFinalFrame, curFrmIdx);
        }
      }
    } else if (stateChange === SIL2SIL) {
      this.continousSilenceFrameCount += 1;
      if (this.vadStateMachine === STATE_NO_START) {
        const singleModeTimeout = conf.detect_mode === 0
          && this.continousSilenceFrameCount * frameInMs > conf.max_start_silence_time;
        if (singleModeTimeout || (isFinalFrame && this.numberEndTimeDetected === 0)) {
          for (let t = this.lastestConfirmedSilenceFrame + 1; t < curFrmIdx; t += 1) this.onSilenceDetected(t);
          this.onVoiceStart(0, true);
          this.onVoiceEnd(0, true, false);
          this.vadStateMachine = STATE_END_DETECTED;
        } else if (curFrmIdx >= this.latencyFrmNumAtStartPoint()) {
          this.onSilenceDetected(curFrmIdx - this.latencyFrmNumAtStartPoint());
        }
      } else if (this.vadStateMachine === STATE_IN_SPEECH) {
        if (this.continousSilenceFrameCount * frameInMs >= this.maxEndSilFrameCntThresh) {
          let lookbackFrame = Math.trunc(this.maxEndSilFrameCntThresh / frameInMs);
          if (conf.do_extend) {
            lookbackFrame -= Math.trunc((conf.lookahead_time_end_point ?? 0) / frameInMs);
            lookbackFrame -= 1;
            lookbackFrame = Math.max(0, lookbackFrame);
          }
          this.onVoiceEnd(curFrmIdx - lookbackFrame, false, false);
          this.vadStateMachine = STATE_END_DETECTED;
        } else if (curFrmIdx - this.confirmedStartFrame + 1 > maxSegmentFrames) {
          this.onVoiceEnd(curFrmIdx, false, false);
          this.vadStateMachine = STATE_END_DETECTED;
        } else if (conf.do_extend && !isFinalFrame) {
          if (this.continousSilenceFrameCount <= Math.trunc((conf.lookahead_time_end_point ?? 0) / frameInMs)) {
            this.onVoiceDetected(curFrmIdx);
          }
        } else {
          this.maybeOnVoiceEndIfLastFrame(isFinalFrame, curFrmIdx);
        }
      }
    }
    if (this.vadStateMachine === STATE_END_DETECTED && conf.detect_mode === 1) this.resetDetection();
  }

  /** 对应 E2EVadModel.__call__(online=True)，即生产 Fsmn_vad_online 的路径。 */
  call(scores: VadScores, waveform: Float32Array, isFinal: boolean): VadChunkEvents {
    this.maxEndSilFrameCntThresh = this.maxEndSil - this.conf.speech_to_sil_time_thres;
    this.computeDecibel(waveform);
    this.nnEvalBlockSize = scores.frames;
    this.frmCnt += scores.frames;
    this.scores = scores;
    if (isFinal) this.detectLastFrames();
    else this.detectCommonFrames();

    const segmentBatch: VadEventBatch = [];
    if (this.outputDataBuf.length > 0) {
      const end = this.outputDataBuf.length;
      for (let i = this.outputDataBufOffset; i < end; i += 1) {
        const buf = this.outputDataBuf[i] as OutputBufEntry;
        if (!buf.contain_seg_start_point) continue;
        if (!this.nextSeg && !buf.contain_seg_end_point) continue;
        const startMs = this.nextSeg ? buf.start_ms : -1;
        let endMs: number;
        if (buf.contain_seg_end_point) {
          endMs = buf.end_ms;
          this.nextSeg = true;
          this.outputDataBufOffset += 1;
        } else {
          endMs = -1;
          this.nextSeg = false;
        }
        segmentBatch.push([startMs, endMs]);
      }
    }
    if (isFinal) this.allResetDetection();
    return segmentBatch.length ? [segmentBatch] : [];
  }
}

/**
 * 对应 `_decode_onnx_vad_events`：结果必须是「batch 长度 1 的块」，
 * 每个事件是两个整数，`-1` 表示未闭合端点，双侧 `-1` 视为非法。
 */
export function decodeEvents(chunk: VadChunkEvents): ([number | null, number | null])[] {
  if (Array.isArray(chunk) && chunk.length === 0) return [];
  if (!Array.isArray(chunk) || chunk.length !== 1 || !Array.isArray(chunk[0]) || !chunk[0].length) {
    throw new ASRRuntimeError('ONNX VAD returned an invalid event stream.', JSON.stringify(chunk));
  }
  return (chunk[0] as VadEventBatch).map((pair) => {
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new ASRRuntimeError('ONNX VAD returned an invalid event stream.', JSON.stringify(pair));
    }
    const rawStart = Number(pair[0]);
    const rawEnd = Number(pair[1]);
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
      throw new ASRRuntimeError('ONNX VAD returned an invalid event stream.', JSON.stringify(pair));
    }
    const start = Math.trunc(rawStart);
    const end = Math.trunc(rawEnd);
    if (start < -1 || end < -1 || (start === -1 && end === -1)) {
      throw new ASRRuntimeError('ONNX VAD returned an invalid event stream.', JSON.stringify(pair));
    }
    return [start === -1 ? null : start, end === -1 ? null : end];
  });
}

/** 对应 `_stream_onnx_vad_segments` 的跨块配对与拒止规则。 */
export function pairEvents(chunks: readonly VadChunkEvents[]): VadSegment[] {
  const segments: VadSegment[] = [];
  let pendingStartMs: number | null = null;
  for (const chunk of chunks) {
    for (const [startMs, endMs] of decodeEvents(chunk)) {
      const lastEndMs = segments.length ? (segments[segments.length - 1] as VadSegment)[1] : 0;
      if (startMs !== null && endMs === null) {
        if (pendingStartMs !== null || startMs < lastEndMs) {
          throw new ASRRuntimeError('ONNX VAD returned an invalid event stream.', 'unexpected start event');
        }
        pendingStartMs = startMs;
      } else if (startMs === null && endMs !== null) {
        if (pendingStartMs === null || endMs <= pendingStartMs) {
          throw new ASRRuntimeError('ONNX VAD returned an invalid event stream.', 'unexpected end event');
        }
        segments.push([pendingStartMs, endMs]);
        pendingStartMs = null;
      } else {
        if (startMs === null || endMs === null || pendingStartMs !== null
          || startMs < lastEndMs || endMs <= startMs) {
          throw new ASRRuntimeError('ONNX VAD returned an invalid event stream.', 'invalid event pair');
        }
        segments.push([startMs, endMs]);
      }
    }
  }
  if (pendingStartMs !== null) {
    throw new ASRRuntimeError('ONNX VAD returned an invalid event stream.', 'unterminated segment');
  }
  return segments;
}
