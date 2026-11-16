// SenseVoice ONNX 适配器：当前唯一实现，实现公共 `Transcriber` 接口。
//
// 职责边界（见 docs/design-docs/2026-11-13-typescript-worker-asr-boundary.md）：
// 本模块只管理自己的推理资源、VAD、分段、语言映射与结果转换。
// 不下载模型、不写任务产物、不碰账号与云端 LLM；模型准备负责把已验证的本地文件交给它。
import {readFile} from 'node:fs/promises';
import path from 'node:path';

import {readWavMono16, SAMPLE_RATE} from './audio.ts';
import {parseCmvn, type Cmvn} from './cmvn.ts';
import {
  parseModelConfig,
  readAsrConfig,
  readVadConfig,
  type AsrFrontendConf,
  type VadFrontendConf,
  type VadModelConf,
} from './config.ts';
import {decodeTokens, greedyDecode, type CtcLogits} from './ctc.ts';
import {
  ASRDependencyError,
  ASREmptyTranscriptError,
  ASRRuntimeError,
} from './errors.ts';
import {WavFrontend} from './fbank.ts';
import {
  assertCacheDirReadable,
  assertModelCacheReady,
  modelFilePaths,
} from './model-cache.ts';
import {SUPPORTED_ASR_MODELS, type SupportedAsrModel, type Transcript, type TranscriptSegment, type Transcriber} from './types.ts';
import {E2EVadModel, pairEvents, type VadChunkEvents, type VadScores} from './vad-state.ts';
import {WavFrontendOnline} from './vad-online.ts';

const VAD_CHUNK_SECONDS = 10;
/** `max_single_segment_time` 是 20000 ms，留一个窗长余量用于端点对齐。 */
export const MAX_BLOCK_SECONDS = 20.5;
const TEXTNORM_WITH_ITN = 14;

/** 语言到模型图输入的映射，与生产 `_sensevoice_language` 一致。 */
export function senseVoiceLanguage(language: string): 'zh' | 'en' | 'auto' {
  const normalized = language.trim().toLowerCase();
  if (normalized === 'chinese' || normalized === 'zh' || normalized === 'zh-cn' || normalized === 'mandarin') {
    return 'zh';
  }
  if (normalized === 'english' || normalized === 'en') return 'en';
  return 'auto';
}

const LANGUAGE_IDS: Readonly<Record<string, number>> = {zh: 3, en: 4, auto: 0};

// 只为拿到最小的运行时形状，不把 onnxruntime-node 的类型泄漏到公共接口。
interface OrtTensor {
  readonly data: Float32Array | Int32Array;
  readonly dims: readonly number[];
}
interface OrtSession {
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
}
interface OrtModule {
  Tensor: new (type: 'float32' | 'int32', data: Float32Array | Int32Array, dims: number[]) => OrtTensor;
  InferenceSession: {create(modelPath: string, options: Record<string, unknown>): Promise<OrtSession>};
}

export interface SenseVoiceOptions {
  /** `<数据根>/models/onnx` 或等价的缓存目录。 */
  cacheDir: string;
  language?: string;
  /**
   * 前端抖动强度。生产默认取自 config.yaml（实际是 1.0，用当前时间做随机种子，每次结果都不同）；
   * 门禁固定为 0 以获得可逐字比对的结果。
   */
  dither?: number;
  /** ONNX Runtime 算子内线程数；默认 1，避免小模型上的线程开销。 */
  threads?: number;
}

interface LoadedModel {
  ort: OrtModule;
  asrSession: OrtSession;
  vadSession: OrtSession;
  asrConfig: AsrFrontendConf;
  asrCmvn: Cmvn;
  vadFrontendOptions: VadFrontendConf & {cmvn: Cmvn};
  vadModelConf: VadModelConf;
  tokens: string[];
}

async function importOnnxRuntime(): Promise<OrtModule> {
  let module: Record<string, unknown>;
  try {
    module = (await import('onnxruntime-node')) as unknown as Record<string, unknown>;
  } catch (error) {
    throw new ASRDependencyError(
      'onnxruntime-node is not available for the ASR runtime.',
      (error as Error).message,
    );
  }
  const ort = (module.default ?? module) as unknown as OrtModule;
  if (typeof ort.InferenceSession?.create !== 'function' || typeof ort.Tensor !== 'function') {
    throw new ASRDependencyError('onnxruntime-node does not expose InferenceSession/Tensor.');
  }
  return ort;
}

async function loadModel(cacheDir: string, threads: number): Promise<LoadedModel> {
  await assertCacheDirReadable(cacheDir);
  await assertModelCacheReady(cacheDir, SUPPORTED_ASR_MODELS[0]);
  const ort = await importOnnxRuntime();
  const {asrDir, vadDir, asrModel, vadModel} = modelFilePaths(cacheDir);

  const asrConfig = readAsrConfig(parseModelConfig(await readFile(path.join(asrDir, 'config.yaml'), 'utf8')));
  const vadConfig = readVadConfig(parseModelConfig(await readFile(path.join(vadDir, 'config.yaml'), 'utf8')));
  const asrCmvn = parseCmvn(await readFile(path.join(asrDir, 'am.mvn'), 'utf8'), 560);
  const vadCmvn = parseCmvn(await readFile(path.join(vadDir, 'am.mvn'), 'utf8'), 400);
  const tokens = JSON.parse(await readFile(path.join(asrDir, 'tokens.json'), 'utf8')) as unknown;
  if (!Array.isArray(tokens) || tokens.length < 1000) {
    throw new ASRRuntimeError('ASR model cache is inconsistent.', 'tokens.json is not a token array');
  }

  const sessionOptions = {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
    enableCpuMemArena: false,
  };
  let asrSession: OrtSession;
  let vadSession: OrtSession;
  try {
    asrSession = await ort.InferenceSession.create(asrModel, sessionOptions);
    vadSession = await ort.InferenceSession.create(vadModel, sessionOptions);
  } catch (error) {
    // 哈希已通过却加载失败，说明不是「没下载」而是运行时或图本身的问题。
    throw new ASRRuntimeError('Failed to load the ASR model graph.', (error as Error).message);
  }

  return {
    ort,
    asrSession,
    vadSession,
    asrConfig,
    asrCmvn,
    tokens: tokens as string[],
    vadFrontendOptions: {cmvn: vadCmvn, ...vadConfig.frontend},
    vadModelConf: vadConfig.model,
  };
}

export class SenseVoiceOnnxTranscriber implements Transcriber {
  readonly model: SupportedAsrModel = SUPPORTED_ASR_MODELS[0];

  private loaded: LoadedModel | null;
  private disposed = false;
  private readonly defaultLanguage: string;
  private readonly dither: number;

  private constructor(loaded: LoadedModel, options: SenseVoiceOptions) {
    this.loaded = loaded;
    this.defaultLanguage = options.language ?? 'Chinese';
    this.dither = options.dither ?? loaded.asrConfig.dither;
  }

  static async create(options: SenseVoiceOptions): Promise<SenseVoiceOnnxTranscriber> {
    const loaded = await loadModel(options.cacheDir, options.threads ?? 1);
    return new SenseVoiceOnnxTranscriber(loaded, options);
  }

  private requireLoaded(): LoadedModel {
    if (this.disposed || this.loaded === null) {
      throw new ASRRuntimeError('ASR transcriber has been disposed.');
    }
    return this.loaded;
  }

  /** 按 10 秒分块做有状态 VAD 推理，返回配对后的分段时间戳。 */
  private async detectSegments(samples: Float32Array): Promise<readonly [number, number][]> {
    const loaded = this.requireLoaded();
    const frontend = new WavFrontendOnline(loaded.vadFrontendOptions);
    const scorer = new E2EVadModel(loaded.vadModelConf);
    const chunkSamples = SAMPLE_RATE * VAD_CHUNK_SECONDS;
    const zeroCache = (): Float32Array => new Float32Array(128 * 19);
    let caches = [zeroCache(), zeroCache(), zeroCache(), zeroCache()];
    const chunks: VadChunkEvents[] = [];

    for (let offset = 0; offset < samples.length; offset += chunkSamples) {
      const end = Math.min(samples.length, offset + chunkSamples);
      const isFinal = end === samples.length;
      const {feats} = frontend.extractFbank(samples.subarray(offset, end), isFinal);
      if (!feats.length) {
        chunks.push([]);
        continue;
      }
      const dim = feats[0]?.length ?? 0;
      const flat = new Float32Array(feats.length * dim);
      for (let index = 0; index < feats.length; index += 1) flat.set(feats[index] as Float64Array, index * dim);
      const feeds: Record<string, OrtTensor> = {
        speech: new loaded.ort.Tensor('float32', flat, [1, feats.length, dim]),
      };
      for (let index = 0; index < 4; index += 1) {
        feeds[`in_cache${index}`] = new loaded.ort.Tensor('float32', caches[index] as Float32Array, [1, 128, 19, 1]);
      }
      const outputs = await loaded.vadSession.run(feeds);
      caches = [0, 1, 2, 3].map((index) => Float32Array.from((outputs[`out_cache${index}`] as OrtTensor).data));
      const logits = outputs.logits as OrtTensor;
      const scores: VadScores = {
        data: logits.data as Float32Array,
        frames: logits.dims[1] as number,
        dim: logits.dims[2] as number,
      };
      chunks.push(scorer.call(scores, frontend.waveforms ?? new Float32Array(0), isFinal));
    }
    return pairEvents(chunks);
  }

  /** 单个切片的识别：前端 → CTC → 词表，返回文本与 token id。 */
  private async recognizeBlock(
    samples: Float32Array,
    languageId: number,
  ): Promise<{text: string; tokenIds: number[]}> {
    const loaded = this.requireLoaded();
    const frontend = new WavFrontend({
      cmvn: loaded.asrCmvn,
      lfrM: loaded.asrConfig.lfrM,
      lfrN: loaded.asrConfig.lfrN,
      numMel: loaded.asrConfig.numMel,
      dither: this.dither,
    });
    const rows = frontend.extract(samples);
    if (!rows.length) return {text: '', tokenIds: []};
    const frames = rows.length;
    const dim = rows[0]?.length ?? 0;
    const flat = new Float32Array(frames * dim);
    for (let index = 0; index < frames; index += 1) flat.set(rows[index] as Float64Array, index * dim);
    const outputs = await loaded.asrSession.run({
      speech: new loaded.ort.Tensor('float32', flat, [1, frames, dim]),
      speech_lengths: new loaded.ort.Tensor('int32', Int32Array.from([frames]), [1]),
      language: new loaded.ort.Tensor('int32', Int32Array.from([languageId]), [1]),
      textnorm: new loaded.ort.Tensor('int32', Int32Array.from([TEXTNORM_WITH_ITN]), [1]),
    });
    const ctc = outputs.ctc_logits as OrtTensor;
    const lengths = outputs.encoder_out_lens as OrtTensor;
    const logits: CtcLogits = {
      data: ctc.data as Float32Array,
      frames: ctc.dims[1] as number,
      vocab: ctc.dims[2] as number,
    };
    const tokenIds = greedyDecode(logits, Number(lengths.data[0]));
    return {text: decodeTokens(tokenIds, loaded.tokens), tokenIds};
  }

  async transcribe(audioPath: string, language: string = this.defaultLanguage): Promise<Transcript> {
    this.requireLoaded();
    const samples = readWavMono16(audioPath, await readFile(audioPath));
    const vadSegments = await this.detectSegments(samples);
    if (!vadSegments.length) throw new ASREmptyTranscriptError();

    const languageId = LANGUAGE_IDS[senseVoiceLanguage(language)] as number;
    const segments: TranscriptSegment[] = [];
    const totalBlocks = vadSegments.length;
    for (let index = 0; index < totalBlocks; index += 1) {
      const [startMs, endMs] = vadSegments[index] as [number, number];
      const startIndex = Math.max(0, Math.trunc((startMs * SAMPLE_RATE) / 1000));
      const endIndex = Math.min(samples.length, Math.trunc((endMs * SAMPLE_RATE) / 1000));
      if (endIndex <= startIndex) continue;
      if (endIndex - startIndex > MAX_BLOCK_SECONDS * SAMPLE_RATE) {
        throw new ASRRuntimeError(
          `ONNX ASR segment ${index + 1} of ${totalBlocks} exceeds ${MAX_BLOCK_SECONDS} seconds.`,
        );
      }
      let text: string;
      try {
        ({text} = await this.recognizeBlock(samples.subarray(startIndex, endIndex), languageId));
      } catch (error) {
        if (error instanceof ASRRuntimeError || error instanceof ASREmptyTranscriptError) throw error;
        throw new ASRRuntimeError(
          `ONNX ASR segment ${index + 1} of ${totalBlocks} failed: ${(error as Error).message}`,
        );
      }
      if (text) {
        segments.push({
          id: `seg-${String(segments.length + 1).padStart(4, '0')}`,
          start_ms: startMs,
          end_ms: endMs,
          text,
        });
      }
    }
    if (!segments.length) throw new ASREmptyTranscriptError('ASR returned an empty transcript.');

    return {
      text: segments.map((segment) => segment.text).join(' '),
      language,
      segments,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // onnxruntime-node 的会话没有显式 close；释放引用后由 GC 回收原生资源。
    this.loaded = null;
  }
}
