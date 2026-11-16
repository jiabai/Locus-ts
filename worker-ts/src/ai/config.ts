// AI 生成的配置来源与托管凭证兑换。
//
// 对齐 `worker/worker_core/llm.py` 与 `ai_runtime.build_insight_provider`：
// - BYOK：直接读 `APP_LLM_API_KEY` / `APP_LLM_MODEL` / `APP_LLM_BASE_URL` 等；
// - 托管（`APP_LLM_SOURCE=server`）：每次模型调用前用会话令牌换一次临时凭证，
//   调用序号进 `request_id`，服务端据此计量。
// 输出预算在最前面校验：非法值必须在 checkout 之前失败，不能先扣一次额度再报错。
import {
  CHECKOUT_ERROR_MESSAGES,
  InsightGenerationError,
} from './errors.ts';

export const DEFAULT_LLM_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_LLM_TIMEOUT_SECONDS = 60;
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

const LLM_PROVIDER_ENV = 'APP_LLM_PROVIDER';
const LLM_API_KEY_ENV = 'APP_LLM_API_KEY';
const LLM_MODEL_ENV = 'APP_LLM_MODEL';
const LLM_BASE_URL_ENV = 'APP_LLM_BASE_URL';
const LLM_TIMEOUT_ENV = 'APP_LLM_TIMEOUT_SECONDS';
const LLM_SOURCE_ENV = 'APP_LLM_SOURCE';
const LLM_CHECKOUT_URL_ENV = 'APP_LLM_CHECKOUT_URL';
const LLM_SESSION_TOKEN_ENV = 'APP_LLM_SESSION_TOKEN';
export const LLM_CHECKOUT_REQUEST_ID_ENV = 'APP_LLM_CHECKOUT_REQUEST_ID';
export const LLM_MAX_TOKENS_ENV = 'APP_LLM_MAX_TOKENS';

/** 一次真实调用的配置：BYOK 直接来自环境，托管来自 checkout。 */
export interface ModelEndpoint {
  readonly provider: 'openai' | 'openai_compatible';
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly timeoutSeconds: number;
  readonly maxOutputTokens: number;
}

export interface ByokConfig extends ModelEndpoint {
  readonly mode: 'byok';
}

export interface ManagedConfig {
  readonly mode: 'managed';
  readonly checkoutUrl: string;
  readonly sessionToken: string;
  readonly requestId: string;
  readonly timeoutSeconds: number;
  readonly maxOutputTokens: number;
}

export type InsightLlmConfig = ByokConfig | ManagedConfig;

export type Transport = (
  url: string,
  init: {readonly method: string; readonly headers: Record<string, string>; readonly body: string; readonly signal?: AbortSignal},
  timeoutMs: number,
) => Promise<{readonly status: number; readonly body: string}>;

function missingConfig(): InsightGenerationError {
  return new InsightGenerationError('AI_CONFIG_MISSING', CHECKOUT_ERROR_MESSAGES.AI_CONFIG_MISSING);
}

/** 非法的输出预算与缺失配置同类：都是「部署配置不对」，不是模型调用失败。 */
export function readMaxOutputTokens(
  environ: Readonly<Record<string, string | undefined>>,
): number {
  const raw = environ[LLM_MAX_TOKENS_ENV]?.trim() ?? '';
  if (raw === '') return DEFAULT_MAX_OUTPUT_TOKENS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new InsightGenerationError(
      'AI_CONFIG_MISSING',
      'Insight agent output token budget is invalid.',
    );
  }
  return value;
}

/** 超时秒数：非法或非正数一律回落到 60 秒，与 Python `parse_timeout` 一致。 */
export function parseTimeoutSeconds(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LLM_TIMEOUT_SECONDS;
  const value = Number(raw.trim());
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_LLM_TIMEOUT_SECONDS;
}

/** 每次调用一个 request id，服务端按它计量；超长时截断种子而不是截断后缀。 */
export function derivePerCallRequestId(seed: string, callIndex: number): string {
  const suffix = `-call-${String(callIndex).padStart(4, '0')}`;
  const maxLength = 160;
  if (seed.length + suffix.length <= maxLength) return `${seed}${suffix}`;
  return `${seed.slice(0, maxLength - suffix.length)}${suffix}`;
}

export function resolveInsightLlmConfig(
  environ: Readonly<Record<string, string | undefined>>,
): InsightLlmConfig {
  // 先校验输出预算：非法值不能等到扣完额度才发现。
  const maxOutputTokens = readMaxOutputTokens(environ);
  const timeoutSeconds = parseTimeoutSeconds(environ[LLM_TIMEOUT_ENV]);

  if ((environ[LLM_SOURCE_ENV] ?? '').trim().toLowerCase() === 'server') {
    const checkoutUrl = environ[LLM_CHECKOUT_URL_ENV]?.trim() ?? '';
    const sessionToken = environ[LLM_SESSION_TOKEN_ENV]?.trim() ?? '';
    const requestId = environ[LLM_CHECKOUT_REQUEST_ID_ENV]?.trim() ?? '';
    if (!checkoutUrl || !sessionToken || !requestId) throw missingConfig();
    return {mode: 'managed', checkoutUrl, sessionToken, requestId, timeoutSeconds, maxOutputTokens};
  }

  const provider = (environ[LLM_PROVIDER_ENV] ?? 'openai_compatible').trim().toLowerCase();
  const apiKey = environ[LLM_API_KEY_ENV]?.trim() ?? '';
  const model = environ[LLM_MODEL_ENV]?.trim() ?? '';
  if (!apiKey || !model || (provider !== 'openai' && provider !== 'openai_compatible')) {
    throw missingConfig();
  }
  return {
    mode: 'byok',
    provider,
    apiKey,
    model,
    baseUrl: environ[LLM_BASE_URL_ENV]?.trim() || DEFAULT_LLM_BASE_URL,
    timeoutSeconds,
    maxOutputTokens,
  };
}

/**
 * 兑换托管凭证。响应形状与 LLM checkout 一一对应：
 * `{provider, base_url, model, api_key, timeout_seconds?}`。
 * 解不出可用配置就是 `AI_LLM_CHECKOUT_INVALID_RESPONSE`——不猜、不回退到默认端点。
 */
export function parseManagedCheckoutResponse(raw: string): ModelEndpoint & {readonly maxOutputTokens: number} {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw checkoutInvalid();
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw checkoutInvalid();
  }
  const record = payload as Record<string, unknown>;
  const provider = String(record.provider ?? '').trim().toLowerCase();
  const baseUrl = String(record.base_url ?? '').trim();
  const model = String(record.model ?? '').trim();
  const apiKey = String(record.api_key ?? '').trim();
  const timeoutRaw = record.timeout_seconds;
  const timeoutSeconds = timeoutRaw === undefined
    ? DEFAULT_LLM_TIMEOUT_SECONDS
    : parseTimeoutSeconds(String(timeoutRaw));

  if ((provider !== 'openai' && provider !== 'openai_compatible') || !baseUrl || !model || !apiKey) {
    throw checkoutInvalid();
  }
  return {
    provider,
    baseUrl,
    model,
    apiKey,
    timeoutSeconds,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  };
}

function checkoutInvalid(): InsightGenerationError {
  return new InsightGenerationError(
    'AI_LLM_CHECKOUT_INVALID_RESPONSE',
    CHECKOUT_ERROR_MESSAGES.AI_LLM_CHECKOUT_INVALID_RESPONSE,
  );
}

/** 从服务端错误体里取 `{"error": "CODE"}`；取不到就返回空串，不把正文往上带。 */
function extractErrorCode(body: string): string {
  try {
    const payload = JSON.parse(body) as Record<string, unknown>;
    return typeof payload.error === 'string' ? payload.error : '';
  } catch {
    return '';
  }
}

function checkoutHttpError(status: number, body: string): InsightGenerationError {
  if (status === 401) {
    return new InsightGenerationError(
      'AI_LLM_AUTH_REQUIRED',
      CHECKOUT_ERROR_MESSAGES.AI_LLM_AUTH_REQUIRED,
    );
  }
  if (status === 403) {
    return new InsightGenerationError(
      'AI_LLM_QUOTA_UNAVAILABLE',
      CHECKOUT_ERROR_MESSAGES.AI_LLM_QUOTA_UNAVAILABLE,
    );
  }
  if (extractErrorCode(body) === 'LLM_CONFIG_MISSING') {
    return new InsightGenerationError(
      'AI_LLM_CONFIG_MISSING',
      CHECKOUT_ERROR_MESSAGES.AI_LLM_CONFIG_MISSING,
    );
  }
  return new InsightGenerationError(
    'AI_LLM_CHECKOUT_FAILED',
    CHECKOUT_ERROR_MESSAGES.AI_LLM_CHECKOUT_FAILED,
  );
}

export interface CheckoutOptions {
  readonly transport?: Transport;
  /** 每次调用递增；托管模式下每次调用都要换一次凭证。 */
  readonly callIndex?: number;
}

export async function checkoutManagedLlm(
  config: ManagedConfig,
  options: CheckoutOptions = {},
): Promise<ModelEndpoint> {
  const transport = options.transport ?? defaultTransport;
  const requestId = derivePerCallRequestId(config.requestId, options.callIndex ?? 1);
  let response;
  try {
    response = await transport(
      config.checkoutUrl,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.sessionToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({request_id: requestId}),
      },
      config.timeoutSeconds * 1000,
    );
  } catch (error) {
    throw checkoutTransportError(error);
  }

  if (response.status < 200 || response.status >= 300) {
    throw checkoutHttpError(response.status, response.body);
  }
  const endpoint = parseManagedCheckoutResponse(response.body);
  return {...endpoint, maxOutputTokens: config.maxOutputTokens};
}

function checkoutTransportError(error: unknown): InsightGenerationError {
  if (isTimeoutError(error)) {
    return new InsightGenerationError(
      'AI_LLM_CHECKOUT_TIMEOUT',
      CHECKOUT_ERROR_MESSAGES.AI_LLM_CHECKOUT_TIMEOUT,
    );
  }
  return new InsightGenerationError(
    'AI_LLM_CHECKOUT_FAILED',
    CHECKOUT_ERROR_MESSAGES.AI_LLM_CHECKOUT_FAILED,
  );
}

export function isTimeoutError(error: unknown): boolean {
  const name = (error as {name?: unknown} | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/** 默认传输：`fetch` + 超时。响应体一律按文本读回，由上层决定是否解析。 */
export const defaultTransport: Transport = async (url, init, timeoutMs) => {
  const response = await fetch(url, {...init, signal: AbortSignal.timeout(timeoutMs)});
  return {status: response.status, body: await response.text()};
};
