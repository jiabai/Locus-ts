// URL 任务请求的解析。
//
// 对齐 `worker/worker_core/requests.py` 的 `parse_process_request`：字段集合必须完全一致，
// contract_version 取契约常量，url 去掉首尾空白，asr_model 取桌面契约的模型闭集。
// 这里只校验形状；URL 能否下载由后面的下载管线判断。
import {
  DESKTOP_ASR_MODELS,
  PROCESS_VIDEO_CONTRACT_VERSION,
} from './contract.ts';

const PROCESS_VIDEO_REQUEST_FIELDS = new Set([
  'contract_version',
  'url',
  'asr_model',
]);

/** 应用层 `failed_result` 用的错误码与固定文案，两侧必须逐字相同。 */
export const INVALID_PROCESS_PAYLOAD_CODE = 'INVALID_REQUEST_PAYLOAD';
export const INVALID_PROCESS_PAYLOAD_MESSAGE = 'Process request payload was invalid.';

export interface ProcessVideoRequest {
  /** 已按 Python `str.strip()` 去掉首尾空白。 */
  readonly url: string;
  readonly asrModel: string;
}

export class InvalidProcessRequestError extends Error {
  readonly code = INVALID_PROCESS_PAYLOAD_CODE;

  constructor() {
    super(INVALID_PROCESS_PAYLOAD_MESSAGE);
    this.name = 'InvalidProcessRequestError';
  }
}

function invalid(): InvalidProcessRequestError {
  return new InvalidProcessRequestError();
}

// Python `str.isspace()` 的闭集。JS `trim()` 多接受 U+FEFF、少接受 U+001C..U+001F
// 与 U+0085，请求层的 URL 边界必须按 Python 逐字裁剪。
const PYTHON_SPACE = /^[\u0009-\u000d\u001c-\u001f\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u001f\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu;

export function stripPythonSpace(value: string): string {
  return value.replace(PYTHON_SPACE, '');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseProcessVideoRequest(payload: unknown): ProcessVideoRequest {
  if (!isPlainObject(payload)) throw invalid();
  for (const key of Object.keys(payload)) {
    if (!PROCESS_VIDEO_REQUEST_FIELDS.has(key)) throw invalid();
  }
  for (const key of PROCESS_VIDEO_REQUEST_FIELDS) {
    if (!(key in payload)) throw invalid();
  }

  // Python 用 `!=` 比较版本号：3 与 3.0 都接受，字符串 "3"、布尔值与 null 都拒绝。
  const contractVersion = payload.contract_version;
  if (typeof contractVersion !== 'number' || contractVersion !== PROCESS_VIDEO_CONTRACT_VERSION) {
    throw invalid();
  }

  const rawUrl = payload.url;
  if (typeof rawUrl !== 'string') throw invalid();
  const url = stripPythonSpace(rawUrl);
  if (url.length === 0) throw invalid();

  const asrModel = payload.asr_model;
  if (typeof asrModel !== 'string' || !DESKTOP_ASR_MODELS.has(asrModel)) throw invalid();

  return {url, asrModel};
}
