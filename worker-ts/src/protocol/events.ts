// 进度事件的构造与渲染。
//
// 事件形状由 `contracts/desktop-worker-contract.json` 的 `progressEvents` 段定义，
// 宿主按 `message_code` 决定要不要读 `message_args`，所以这里的校验必须和契约一样严：
// 未知码、状态不符、`current_file` 该有没有、`message_args` 越界都要拒收，
// 不能「先发出去再说」——Rust 侧收到非法事件会直接判定 worker 行为异常。
import {MODEL_PROGRESS_SPECS} from '../asr/model-download.ts';
import type {ModelProgressEvent} from '../asr/model-download.ts';
import {jsonLine, MODEL_DOWNLOAD_EVENT_PREFIX, PROGRESS_EVENT_PREFIX} from './contract.ts';

export const WORKER_PROGRESS_STAGES = [
  'waiting_input',
  'video_extracting',
  'video_transcribing',
  'web_loading',
  'web_extracting',
  'web_saving',
  'insights_generating',
  'title_generating',
  'completed',
  'partial_completed',
  'failed',
] as const;

export type WorkerProgressStage = (typeof WORKER_PROGRESS_STAGES)[number];

/** 与 Python `WORKER_PROGRESS_REGISTRY` 一一对应，由静态守卫比对。 */
export const WORKER_PROGRESS_SPECS = {
  'web.page.loading': {allowedArgs: []},
  'web.page.extracting': {allowedArgs: []},
  'web.page.saving': {allowedArgs: []},
  'video.download.preparing': {allowedArgs: []},
  'video.stream.validating': {allowedArgs: []},
  'local.media.validating': {allowedArgs: []},
  'local.video.copying': {allowedArgs: []},
  'local.audio.normalizing': {allowedArgs: []},
  'audio.extract.running': {allowedArgs: []},
  'audio.extract.reused': {allowedArgs: []},
  'subtitle.detect.running': {allowedArgs: []},
  'subtitle.detect.found': {allowedArgs: ['language']},
  'asr.cache.preparing': {allowedArgs: ['model']},
  'asr.transcribe.starting': {allowedArgs: []},
  'asr.transcribe.running': {allowedArgs: []},
  'ai.generation.running': {allowedArgs: ['attempt', 'total']},
  'title.generation.running': {allowedArgs: []},
  'title.generation.completed': {allowedArgs: []},
  'douyin.page.resolving': {allowedArgs: []},
  'douyin.page.retrying': {allowedArgs: ['attempt', 'total']},
  'douyin.stream.probing': {allowedArgs: []},
  'douyin.video.saving': {allowedArgs: []},
  'douyin.stream.retrying': {allowedArgs: ['attempt', 'total']},
  'xiaohongshu.page.resolving': {allowedArgs: []},
  'xiaohongshu.video.saving': {allowedArgs: []},
  'xiaohongshu.stream.retrying': {allowedArgs: ['attempt', 'total']},
  'bilibili.metadata.resolving': {allowedArgs: []},
  'bilibili.stream.probing': {allowedArgs: []},
  'bilibili.video.downloading': {allowedArgs: []},
  'bilibili.audio.downloading': {allowedArgs: []},
  'bilibili.media.merging': {allowedArgs: []},
} as const;

export type WorkerProgressCode = keyof typeof WORKER_PROGRESS_SPECS;

export interface WorkerProgressEvent {
  readonly stage: WorkerProgressStage;
  readonly progress: number;
  readonly message_code: WorkerProgressCode;
  readonly message_args?: Readonly<Record<string, string | number>>;
}

/** 线协议里允许出现的模型标识；与 Python `_ALLOWED_MODELS` 同一集合。 */
const ALLOWED_MODEL_ARGS = new Set([
  'iic/SenseVoiceSmall',
  'iic/speech_fsmn_vad_zh-cn-16k-common-pytorch',
  'iic/SenseVoiceSmall-onnx',
  'iic/speech_fsmn_vad_zh-cn-16k-common-onnx',
]);

const LANGUAGE_TAG_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
/** 契约里 `current_file` 的白名单形状：安全 basename，不含路径分隔符与控制字符。 */
const CURRENT_FILE_PATTERN = /^(?!\.{1,2}$)(?=[A-Za-z0-9._+() -]{1,255}$)(?=.*[A-Za-z0-9])[A-Za-z0-9._+()-](?:[A-Za-z0-9._+() -]{0,253}[A-Za-z0-9_+()-])?$/;
const SENSITIVE_FILE_PATTERN = /(?:^|[^a-z0-9])(?:auth|cookie|credential|password|secret|token)(?:[^a-z0-9]|$)/i;

export class ProgressEventInvalidError extends Error {
  constructor() {
    // 不回显事件内容：非法事件里可能带着路径或用户文本。
    super('Progress event was invalid.');
    this.name = 'ProgressEventInvalidError';
  }
}

function invalid(): ProgressEventInvalidError {
  return new ProgressEventInvalidError();
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum;
}

export function isSafeCurrentFile(name: string): boolean {
  return CURRENT_FILE_PATTERN.test(name) && !SENSITIVE_FILE_PATTERN.test(name);
}

function validateMessageArgs(
  args: Readonly<Record<string, unknown>> | undefined,
  allowed: readonly string[],
): Record<string, string | number> | undefined {
  const source = args ?? {};
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) throw invalid();
  }
  const validated: Record<string, string | number> = {};
  for (const key of allowed) {
    if (!(key in source)) continue;
    const value = source[key];
    if (key === 'model') {
      if (typeof value !== 'string' || !ALLOWED_MODEL_ARGS.has(value)) throw invalid();
      validated[key] = value;
    } else if (key === 'language') {
      if (typeof value !== 'string' || value.length < 2 || value.length > 35
        || !LANGUAGE_TAG_PATTERN.test(value)) {
        throw invalid();
      }
      validated[key] = value;
    } else if (key === 'attempt' || key === 'total') {
      if (!isIntegerInRange(value, 1, 100)) throw invalid();
      validated[key] = value as number;
    } else {
      throw invalid();
    }
  }
  if (validated.attempt !== undefined && validated.total !== undefined
    && Number(validated.attempt) > Number(validated.total)) {
    throw invalid();
  }
  return Object.keys(validated).length === 0 ? undefined : validated;
}

/** 构造并校验一个 worker 进度事件；越界直接抛错，不发半成品。 */
export function buildWorkerProgressEvent(
  messageCode: WorkerProgressCode,
  options: {
    stage: WorkerProgressStage;
    progress: number;
    messageArgs?: Readonly<Record<string, unknown>>;
  },
): WorkerProgressEvent {
  const spec = WORKER_PROGRESS_SPECS[messageCode];
  if (spec === undefined) throw invalid();
  if (!WORKER_PROGRESS_STAGES.includes(options.stage)) throw invalid();
  if (!isIntegerInRange(options.progress, 0, 100)) throw invalid();

  const messageArgs = validateMessageArgs(options.messageArgs, spec.allowedArgs);
  return {
    stage: options.stage,
    progress: options.progress,
    message_code: messageCode,
    ...(messageArgs === undefined ? {} : {message_args: messageArgs}),
  };
}

function validateModelEvent(event: ModelProgressEvent): void {
  const spec = MODEL_PROGRESS_SPECS[event.message_code];
  if (spec === undefined) throw invalid();
  if (event.status !== spec.status) throw invalid();
  if (!isIntegerInRange(event.progress, 0, 100)) throw invalid();
  if (spec.currentFile === 'required') {
    if (event.current_file === undefined || !isSafeCurrentFile(event.current_file)) throw invalid();
  } else if (event.current_file !== undefined) {
    throw invalid();
  }
  validateMessageArgs(event.message_args, spec.messageArgs);
}

export function renderWorkerProgressEvent(event: WorkerProgressEvent): string {
  const spec = WORKER_PROGRESS_SPECS[event.message_code];
  if (spec === undefined) throw invalid();
  if (!WORKER_PROGRESS_STAGES.includes(event.stage)) throw invalid();
  if (!isIntegerInRange(event.progress, 0, 100)) throw invalid();
  const args = validateMessageArgs(event.message_args, spec.allowedArgs);
  const payload: Record<string, unknown> = {
    stage: event.stage,
    progress: event.progress,
    message_code: event.message_code,
  };
  if (args !== undefined) payload.message_args = args;
  return `${PROGRESS_EVENT_PREFIX}${jsonLine(payload)}`;
}

export function renderModelProgressEvent(event: ModelProgressEvent): string {
  validateModelEvent(event);
  return `${MODEL_DOWNLOAD_EVENT_PREFIX}${jsonLine({
    status: event.status,
    progress: event.progress,
    message_code: event.message_code,
    ...(event.current_file === undefined ? {} : {current_file: event.current_file}),
    ...(event.message_args === undefined ? {} : {message_args: event.message_args}),
  })}`;
}
