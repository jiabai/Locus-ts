// config.yaml 的最小解析器与模型参数读取。
// 只解析推理真正消费的两段（model_conf / frontend_conf），其余段（encoder、dataset 等）
// 直接跳过；在被消费的两段里遇到不认识的写法就报错，避免静默取到错误的模型参数。
import {ASRRuntimeError} from './errors.ts';

const CONSUMED_SECTIONS = new Set(['model_conf', 'frontend_conf']);

export interface AsrFrontendConf {
  readonly lfrM: number;
  readonly lfrN: number;
  readonly numMel: number;
  /** 生产 WavFrontend 的默认值是 1.0；config.yaml 未覆盖时确实带随机抖动。 */
  readonly dither: number;
  readonly frameLengthMs: number;
  readonly frameShiftMs: number;
}

export interface VadFrontendConf {
  readonly lfrM: number;
  readonly lfrN: number;
  readonly numMel: number;
  readonly dither: number;
}

export interface VadModelConf {
  readonly sample_rate: number;
  readonly detect_mode: number;
  readonly max_end_silence_time: number;
  readonly max_start_silence_time: number;
  readonly window_size_ms: number;
  readonly sil_to_speech_time_thres: number;
  readonly speech_to_sil_time_thres: number;
  readonly speech_2_noise_ratio: number;
  readonly max_single_segment_time: number;
  readonly snr_thres: number;
  readonly noise_frame_num_used_for_snr: number;
  readonly decibel_thres: number;
  readonly speech_noise_thres: number;
  readonly fe_prior_thres: number;
  readonly sil_pdf_ids: readonly number[];
  readonly frame_in_ms: number;
  readonly frame_length_ms: number;
  readonly do_extend?: boolean;
  readonly lookback_time_start_point?: number;
  readonly lookahead_time_end_point?: number;
}

export type ParsedConfig = Record<string, Record<string, unknown>>;

type Scalar = string | number | boolean | Scalar[];

function parseScalar(raw: string): Scalar {
  const text = raw.trim();
  if (text === '') return '';
  if (text === 'true' || text === 'True') return true;
  if (text === 'false' || text === 'False') return false;
  if (text.startsWith('[') && text.endsWith(']')) {
    const body = text.slice(1, -1).trim();
    if (!body) return [];
    return body.split(',').map((item) => parseScalar(item));
  }
  const number = Number(text);
  if (text !== '' && Number.isFinite(number)) return number;
  // 其余按纯量字符串处理（例如 unk_symbol: <unk>、${model_conf.sos}）。
  if (/^[{[&*]/.test(text)) {
    throw new ASRRuntimeError('ASR model cache is inconsistent.', `config.yaml unsupported value: ${raw}`);
  }
  return text;
}

export function parseModelConfig(text: string): ParsedConfig {
  const root: ParsedConfig = {};
  let section: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const top = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (top) {
      section = top[1] as string;
      const tail = (top[2] ?? '').trim();
      root[section] = {};
      if (tail !== '') {
        // 顶层标量（model、encoder 等）不影响推理，读进来即可。
        root[section] = {__scalar: parseScalar(tail)} as unknown as Record<string, unknown>;
        section = null;
      }
      continue;
    }
    if (section === null || !CONSUMED_SECTIONS.has(section)) continue;
    const child = line.match(/^\s+([A-Za-z0-9_]+):\s*(.*)$/);
    if (!child) {
      throw new ASRRuntimeError('ASR model cache is inconsistent.', `config.yaml ${section}: ${line.trim()}`);
    }
    (root[section] as Record<string, unknown>)[child[1] as string] = parseScalar(child[2] ?? '');
  }
  for (const required of CONSUMED_SECTIONS) {
    const block = root[required];
    if (!block || '__scalar' in block) {
      throw new ASRRuntimeError('ASR model cache is inconsistent.', `config.yaml missing section ${required}`);
    }
  }
  return root;
}

function numberAt(block: Record<string, unknown>, key: string, fallback?: number): number {
  const value = block[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (fallback !== undefined) return fallback;
  throw new ASRRuntimeError('ASR model cache is inconsistent.', `config.yaml missing numeric ${key}`);
}

export function readAsrConfig(config: ParsedConfig): AsrFrontendConf {
  const frontend = config.frontend_conf as Record<string, unknown>;
  return {
    lfrM: numberAt(frontend, 'lfr_m', 7),
    lfrN: numberAt(frontend, 'lfr_n', 6),
    numMel: numberAt(frontend, 'n_mels', 80),
    dither: numberAt(frontend, 'dither', 1.0),
    frameLengthMs: numberAt(frontend, 'frame_length', 25),
    frameShiftMs: numberAt(frontend, 'frame_shift', 10),
  };
}

export function readVadConfig(config: ParsedConfig): {
  frontend: VadFrontendConf;
  model: VadModelConf;
} {
  const frontend = config.frontend_conf as Record<string, unknown>;
  const model = config.model_conf as Record<string, unknown>;
  const silPdfIds = model.sil_pdf_ids;
  if (!Array.isArray(silPdfIds) || silPdfIds.length === 0
    || silPdfIds.some((id) => typeof id !== 'number')) {
    throw new ASRRuntimeError('ASR model cache is inconsistent.', 'VAD config.yaml missing model_conf.sil_pdf_ids');
  }
  // 生产 config.yaml 用 `do_extend: 1` 这种数字写法表示开关，不能只认布尔。
  const boolAt = (key: string): boolean | undefined => {
    const value = model[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    return undefined;
  };
  return {
    frontend: {
      lfrM: numberAt(frontend, 'lfr_m', 5),
      lfrN: numberAt(frontend, 'lfr_n', 1),
      numMel: numberAt(frontend, 'n_mels', 80),
      dither: numberAt(frontend, 'dither', 0),
    },
    model: {
      sample_rate: numberAt(model, 'sample_rate'),
      detect_mode: numberAt(model, 'detect_mode'),
      max_end_silence_time: numberAt(model, 'max_end_silence_time'),
      max_start_silence_time: numberAt(model, 'max_start_silence_time'),
      window_size_ms: numberAt(model, 'window_size_ms'),
      sil_to_speech_time_thres: numberAt(model, 'sil_to_speech_time_thres'),
      speech_to_sil_time_thres: numberAt(model, 'speech_to_sil_time_thres'),
      speech_2_noise_ratio: numberAt(model, 'speech_2_noise_ratio'),
      max_single_segment_time: numberAt(model, 'max_single_segment_time'),
      snr_thres: numberAt(model, 'snr_thres'),
      noise_frame_num_used_for_snr: numberAt(model, 'noise_frame_num_used_for_snr'),
      decibel_thres: numberAt(model, 'decibel_thres'),
      speech_noise_thres: numberAt(model, 'speech_noise_thres'),
      fe_prior_thres: numberAt(model, 'fe_prior_thres'),
      sil_pdf_ids: silPdfIds as number[],
      frame_in_ms: numberAt(model, 'frame_in_ms'),
      frame_length_ms: numberAt(model, 'frame_length_ms'),
      do_extend: boolAt('do_extend'),
      lookback_time_start_point: numberAt(model, 'lookback_time_start_point', 0),
      lookahead_time_end_point: numberAt(model, 'lookahead_time_end_point', 0),
    },
  };
}
