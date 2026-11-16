// AI 生成的错误语义。
//
// 对齐 `worker/worker_core/insight_errors.py` 与 `ai_runtime.py` 的分类表：
// 错误码是闭集，前端按码给文案；供应商原文（可能带密钥前缀、账号信息）一律不进
// message——分类只看状态码与异常类型，不看响应体正文。
export type InsightGenerationCode =
  | 'AI_CONFIG_MISSING'
  | 'AI_LLM_AUTH_REQUIRED'
  | 'AI_LLM_QUOTA_UNAVAILABLE'
  | 'AI_LLM_CONFIG_MISSING'
  | 'AI_LLM_CHECKOUT_TIMEOUT'
  | 'AI_LLM_CHECKOUT_FAILED'
  | 'AI_LLM_CHECKOUT_INVALID_RESPONSE'
  | 'AI_LLM_REQUEST_TIMEOUT'
  | 'AI_LLM_KEY_REJECTED'
  | 'AI_LLM_MODEL_UNAVAILABLE'
  | 'AI_LLM_RATE_LIMITED'
  | 'AI_LLM_NETWORK_FAILED'
  | 'AI_LLM_INVALID_RESPONSE'
  | 'AI_LLM_REQUEST_FAILED'
  | 'AI_EMPTY_TRANSCRIPT'
  | 'AI_EMPTY_SUMMARY'
  | 'AI_INVALID_MINDMAP'
  // 启发灵感 agent 的交付校验：前者只作为工具反馈（模型重交），后者在轮数耗尽时上报。
  | 'AI_INVALID_RESULT'
  | 'AI_EMPTY_RESULT';

export class InsightGenerationError extends Error {
  readonly code: InsightGenerationCode;

  constructor(code: InsightGenerationCode, message: string) {
    super(message);
    this.name = 'InsightGenerationError';
    this.code = code;
  }
}

/** 与 Python `_CHECKOUT_ERROR_MESSAGES` 同文案：这些码走到界面时不能再改写。 */
export const CHECKOUT_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  AI_CONFIG_MISSING: 'Insight agent LLM is not configured.',
  AI_LLM_AUTH_REQUIRED: 'Locus login is required to use the managed LLM.',
  AI_LLM_QUOTA_UNAVAILABLE: 'No cloud LLM API-call uses are available for this account.',
  AI_LLM_CONFIG_MISSING: 'Locus managed LLM is not configured.',
  AI_LLM_CHECKOUT_TIMEOUT: 'Locus LLM checkout timed out. Please retry later.',
  AI_LLM_CHECKOUT_FAILED: 'Locus LLM checkout failed before a usable response was returned.',
  AI_LLM_CHECKOUT_INVALID_RESPONSE: 'Locus LLM checkout did not return usable configuration.',
};

/** 与 Python `_GENERATION_ERROR_MESSAGES` 同文案。 */
export const GENERATION_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  AI_LLM_REQUEST_TIMEOUT: 'The model request timed out before a usable response.',
  AI_LLM_KEY_REJECTED: 'The model provider rejected the configured API key.',
  AI_LLM_MODEL_UNAVAILABLE: 'The configured model is not available from the provider.',
  AI_LLM_RATE_LIMITED: 'The model provider temporarily rate-limited the request.',
  AI_LLM_NETWORK_FAILED: 'Could not reach the model provider; check the network or base URL.',
  AI_LLM_INVALID_RESPONSE: 'The model provider returned an unreadable response.',
};

export type ProviderFailureCategory =
  | 'timeout'
  | 'auth'
  | 'model_not_found'
  | 'rate_limit'
  | 'network'
  | 'invalid_response'
  | 'unexpected';

const CODE_BY_CATEGORY: Readonly<Record<ProviderFailureCategory, InsightGenerationCode | null>> = {
  timeout: 'AI_LLM_REQUEST_TIMEOUT',
  auth: 'AI_LLM_KEY_REJECTED',
  model_not_found: 'AI_LLM_MODEL_UNAVAILABLE',
  rate_limit: 'AI_LLM_RATE_LIMITED',
  network: 'AI_LLM_NETWORK_FAILED',
  invalid_response: 'AI_LLM_INVALID_RESPONSE',
  // `unexpected` 保留笼统的请求失败码，不硬套一个更具体的错误。
  unexpected: null,
};

export function generationErrorCodeFor(category: ProviderFailureCategory): InsightGenerationCode | null {
  return CODE_BY_CATEGORY[category];
}

export function generationError(code: InsightGenerationCode, detail?: string): InsightGenerationError {
  return new InsightGenerationError(code, GENERATION_ERROR_MESSAGES[code] ?? CHECKOUT_ERROR_MESSAGES[code] ?? detail ?? code);
}
