// 最小 BYOK 探针：复现 `worker/worker_core/llm_probe.py`。
//
// API key 只在内存里流转：从 stdin 读进请求，放进 provider 配置，绝不打印、
// 记日志或嵌进结果。stdout 只带封闭的 `{ok, error_code, latency_ms}`。
// 错误分类沿用 chat.ts 的类型化错误（分类只看状态码与异常类型，不看响应体正文），
// 这里只负责把生成路径的错误码翻译成探针自己的封闭错误码。
import {chatCompletion, type ChatFetch} from './chat.ts';
import {DEFAULT_LLM_BASE_URL, type ModelEndpoint} from './config.ts';
import {InsightGenerationError} from './errors.ts';

export const PROBE_MAX_TOKENS = 1;
export const PROBE_TIMEOUT_SECONDS = 15;
const PROBE_PROMPT = 'ping';

export const LLM_PROBE_INVALID_REQUEST = 'LLM_PROBE_INVALID_REQUEST';
export const LLM_PROBE_NETWORK_ERROR = 'LLM_PROBE_NETWORK_ERROR';
export const LLM_PROBE_AUTH_FAILED = 'LLM_PROBE_AUTH_FAILED';
export const LLM_PROBE_MODEL_NOT_FOUND = 'LLM_PROBE_MODEL_NOT_FOUND';
export const LLM_PROBE_TIMEOUT = 'LLM_PROBE_TIMEOUT';
export const LLM_PROBE_RATE_LIMITED = 'LLM_PROBE_RATE_LIMITED';
export const LLM_PROBE_INVALID_RESPONSE = 'LLM_PROBE_INVALID_RESPONSE';
export const LLM_PROBE_UNEXPECTED_ERROR = 'LLM_PROBE_UNEXPECTED_ERROR';

/** 与 Python `ERROR_CODES` 同一闭集。 */
export const LLM_PROBE_ERROR_CODES: readonly string[] = [
  LLM_PROBE_INVALID_REQUEST,
  LLM_PROBE_NETWORK_ERROR,
  LLM_PROBE_AUTH_FAILED,
  LLM_PROBE_MODEL_NOT_FOUND,
  LLM_PROBE_TIMEOUT,
  LLM_PROBE_RATE_LIMITED,
  LLM_PROBE_INVALID_RESPONSE,
  LLM_PROBE_UNEXPECTED_ERROR,
];

const REQUIRED_FIELDS = ['base_url', 'api_key', 'model', 'provider'] as const;
const ALLOWED_PROVIDERS = ['openai', 'openai_compatible'] as const;

interface ProbeRequest {
  readonly base_url: string;
  readonly api_key: string;
  readonly model: string;
  readonly provider: (typeof ALLOWED_PROVIDERS)[number];
}

export interface LlmProbeResult {
  /** Python 的 dict 键序就是输出顺序：ok、error_code、latency_ms。 */
  readonly ok: boolean;
  readonly error_code: string | null;
  readonly latency_ms: number;
}

// 生成路径（相对探针）的错误码：auth / model / rate / network 是 BYOK 用户自己
// 能修的配置问题，探针把它们如实带给 UI；timeout 同理。其余一律 unexpected。
const PROBE_ERROR_CODE_BY_GENERATION_CODE: Readonly<Record<string, string>> = {
  AI_LLM_REQUEST_TIMEOUT: LLM_PROBE_TIMEOUT,
  AI_LLM_KEY_REJECTED: LLM_PROBE_AUTH_FAILED,
  AI_LLM_MODEL_UNAVAILABLE: LLM_PROBE_MODEL_NOT_FOUND,
  AI_LLM_RATE_LIMITED: LLM_PROBE_RATE_LIMITED,
  AI_LLM_NETWORK_FAILED: LLM_PROBE_NETWORK_ERROR,
  AI_LLM_INVALID_RESPONSE: LLM_PROBE_INVALID_RESPONSE,
};

function parseProbeRequest(requestJson: string | undefined): ProbeRequest | null {
  if (!requestJson) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(requestJson);
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  // Python 是集合相等：四个键恰好都在，也没有多余键。
  const keys = Object.keys(record);
  if (keys.length !== REQUIRED_FIELDS.length
    || !REQUIRED_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(record, field))) {
    return null;
  }
  if (!REQUIRED_FIELDS.every((field) => typeof record[field] === 'string')) return null;
  const provider = record.provider as string;
  if (!ALLOWED_PROVIDERS.includes(provider as (typeof ALLOWED_PROVIDERS)[number])) return null;
  return {
    base_url: record.base_url as string,
    api_key: record.api_key as string,
    model: record.model as string,
    provider: provider as (typeof ALLOWED_PROVIDERS)[number],
  };
}

function result(ok: boolean, errorCode: string | null, started: number): LlmProbeResult {
  return {
    ok,
    error_code: errorCode,
    latency_ms: Math.trunc(performance.now() - started),
  };
}

/**
 * 跑一次探针。请求校验失败也返回结果（而不是抛错）：与 Python 一样，
 * 探针永远「正常结束」，退出码恒为 0，语义写在 `ok` 与 `error_code` 里。
 */
export async function runLlmProbe(
  requestJson: string | undefined,
  options: {readonly fetchImpl?: ChatFetch} = {},
): Promise<LlmProbeResult> {
  const started = performance.now();
  const request = parseProbeRequest(requestJson);
  if (request === null) return result(false, LLM_PROBE_INVALID_REQUEST, started);
  // 与 Python `_build_single_call_provider` 一样：字段逐个 strip，空 base_url
  // 回落官方端点，空 key / 空 model 不拦截——让真实请求去失败，如实分类。
  const endpoint: ModelEndpoint = {
    provider: request.provider,
    baseUrl: request.base_url.trim() || DEFAULT_LLM_BASE_URL,
    model: request.model.trim(),
    apiKey: request.api_key.trim(),
    timeoutSeconds: PROBE_TIMEOUT_SECONDS,
    maxOutputTokens: PROBE_MAX_TOKENS,
  };
  try {
    await chatCompletion({
      endpoint,
      messages: [{role: 'user', content: PROBE_PROMPT}],
      ...(options.fetchImpl === undefined ? {} : {fetchImpl: options.fetchImpl}),
    });
  } catch (error) {
    const code = error instanceof InsightGenerationError
      ? PROBE_ERROR_CODE_BY_GENERATION_CODE[error.code] ?? LLM_PROBE_UNEXPECTED_ERROR
      : LLM_PROBE_UNEXPECTED_ERROR;
    return result(false, code, started);
  }
  return result(true, null, started);
}
