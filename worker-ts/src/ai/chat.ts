// OpenAI 兼容的对话补全调用（含工具调用）。
//
// 请求形状以 Python SDK 实际发出的请求为准（`work/ai-spike/capture_py_request.py` 抓包）：
// `model` / `stream:false` / `messages` / `tool_choice:"auto"` / `tools` / `max_tokens`。
// 测试会用那份抓包当 golden 逐字段比对，避免「照文档写」和「照着实现写」的偏差。
//
// 失败只向外抛 `InsightGenerationError`：HTTP 状态码与网络/超时分别映射到闭集里的码，
// 供应商响应正文不进错误消息——它可能回显密钥片段或账号信息。
import {
  CHECKOUT_ERROR_MESSAGES,
  GENERATION_ERROR_MESSAGES,
  InsightGenerationError,
  type InsightGenerationCode,
} from './errors.ts';
import {isTimeoutError, type ModelEndpoint} from './config.ts';

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** 模型给出的 JSON 字符串，未解析：解析失败属于「模型输出不对」，不是传输错误。 */
  readonly arguments: string;
}

export type ChatMessage =
  | {readonly role: 'system' | 'user'; readonly content: string}
  | {readonly role: 'assistant'; readonly content: string | null; readonly toolCalls: readonly ToolCall[]}
  | {readonly role: 'tool'; readonly toolCallId: string; readonly content: string};

/** 工具描述只用 OpenAI 的 function schema，不引入任何 SDK 类型。 */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface ChatCompletion {
  /** 没有文本时是 null（纯工具调用的回复就是这样）。 */
  readonly text: string | null;
  readonly toolCalls: readonly ToolCall[];
}

export type ChatFetch = (
  url: string,
  init: {readonly method: string; readonly headers: Record<string, string>; readonly body: string; readonly signal?: AbortSignal},
) => Promise<{readonly status: number; readonly body: string}>;

export interface ChatCompletionOptions {
  readonly endpoint: ModelEndpoint;
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolSpec[];
  readonly fetchImpl?: ChatFetch;
  /** 标题 agent 要求 JSON 对象输出；其余 agent 不带这个键（抓包 golden 不变）。 */
  readonly responseFormat?: 'json_object';
  /**
   * 整理稿 agent 复用草稿 provider 的语义：未显式配置 APP_LLM_MAX_TOKENS 时不发
   * `max_tokens`。缺省为 false，既有 agent 的请求体形状不变。
   */
  readonly omitMaxTokens?: boolean;
  /** 外部取消：宿主终止进程前可以先 abort，避免把一次慢请求拖到超时。 */
  readonly signal?: AbortSignal;
}

function serializeMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content,
      ...(message.toolCalls.length === 0
        ? {}
        : {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: {name: call.name, arguments: call.arguments},
          })),
        }),
    };
  }
  if (message.role === 'tool') {
    return {role: 'tool', tool_call_id: message.toolCallId, content: message.content};
  }
  return {role: message.role, content: message.content};
}

/**
 * 组装请求体。键顺序与 Python SDK 一致，便于把抓包当 golden 直接比对；
 * 没有工具时不发 `tools` 与 `tool_choice`（不少兼容端点对空数组会报错）。
 */
export function buildChatRequestBody(
  endpoint: ModelEndpoint,
  messages: readonly ChatMessage[],
  tools: readonly ToolSpec[],
  maxOutputTokens: number,
  responseFormat?: 'json_object',
): Record<string, unknown> {
  return {
    model: endpoint.model,
    stream: false,
    messages: messages.map(serializeMessage),
    ...(tools.length === 0 ? {} : {tool_choice: 'auto', tools: tools.map(toWireTool)}),
    max_tokens: maxOutputTokens,
    ...(responseFormat === undefined ? {} : {response_format: {type: responseFormat}}),
  };
}

function toWireTool(tool: ToolSpec): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

export function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

export async function chatCompletion(options: ChatCompletionOptions): Promise<ChatCompletion> {
  const {endpoint, messages, tools = []} = options;
  const requestBody = buildChatRequestBody(
    endpoint,
    messages,
    tools,
    endpoint.maxOutputTokens,
    options.responseFormat,
  );
  // 只影响显式要求的调用：不能用 buildChatRequestBody 的参数表达，否则抓包 golden
  // 里的键顺序和默认形状都会被动到。
  if (options.omitMaxTokens === true) delete requestBody.max_tokens;
  const body = JSON.stringify(requestBody);
  const fetcher = options.fetchImpl ?? defaultChatFetch;
  const signal = combineSignals(
    AbortSignal.timeout(endpoint.timeoutSeconds * 1000),
    options.signal,
  );

  let response;
  try {
    response = await fetcher(chatCompletionsUrl(endpoint.baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${endpoint.apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
      ...(signal === undefined ? {} : {signal}),
    });
  } catch (error) {
    throw transportError(error);
  }

  if (response.status < 200 || response.status >= 300) {
    throw providerHttpError(response.status, response.body);
  }
  return parseCompletion(response.body);
}

function transportError(error: unknown): InsightGenerationError {
  if (isTimeoutError(error)) {
    return new InsightGenerationError('AI_LLM_REQUEST_TIMEOUT', GENERATION_ERROR_MESSAGES.AI_LLM_REQUEST_TIMEOUT);
  }
  // `fetch` 的连接失败是 TypeError；DNS、拒绝连接、代理错误都走这条。
  if (error instanceof TypeError) {
    return new InsightGenerationError('AI_LLM_NETWORK_FAILED', GENERATION_ERROR_MESSAGES.AI_LLM_NETWORK_FAILED);
  }
  return new InsightGenerationError('AI_LLM_REQUEST_FAILED', CHECKOUT_ERROR_MESSAGES.AI_LLM_CHECKOUT_FAILED);
}

/** 有些服务商用 400 而不是 404 表示「模型不存在」，只能从响应体里的措辞判断。 */
const UNKNOWN_MODEL_HINTS = [
  'invalid model', 'model is invalid', 'does not exist', "doesn't exist", 'not exist',
  'not found', 'notfound', 'not_found', 'unknown', 'unsupported', 'not available', 'no such',
];

function looksLikeUnknownModel(body: string): boolean {
  const detail = body.toLowerCase();
  if (!detail.includes('model')) return false;
  return UNKNOWN_MODEL_HINTS.some((hint) => detail.includes(hint));
}

function providerHttpError(status: number, body: string): InsightGenerationError {
  if (status === 401 || status === 403) {
    return new InsightGenerationError('AI_LLM_KEY_REJECTED', GENERATION_ERROR_MESSAGES.AI_LLM_KEY_REJECTED);
  }
  if (status === 404 || (status === 400 && looksLikeUnknownModel(body))) {
    return new InsightGenerationError('AI_LLM_MODEL_UNAVAILABLE', GENERATION_ERROR_MESSAGES.AI_LLM_MODEL_UNAVAILABLE);
  }
  if (status === 429) {
    return new InsightGenerationError('AI_LLM_RATE_LIMITED', GENERATION_ERROR_MESSAGES.AI_LLM_RATE_LIMITED);
  }
  // 其余状态（含 5xx 与 400 的其他原因）保持笼统失败码，不编造更具体的解释。
  return new InsightGenerationError('AI_LLM_REQUEST_FAILED', 'Insight agent LLM request failed.');
}

function parseCompletion(raw: string): ChatCompletion {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw invalidResponse();
  }
  if (payload === null || typeof payload !== 'object') throw invalidResponse();
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) throw invalidResponse();
  const first = choices[0];
  if (first === null || typeof first !== 'object') throw invalidResponse();
  const message = (first as Record<string, unknown>).message;
  if (message === null || typeof message !== 'object') throw invalidResponse();
  const record = message as Record<string, unknown>;

  const content = record.content;
  if (content !== null && content !== undefined && typeof content !== 'string') throw invalidResponse();

  const toolCalls = parseToolCalls(record.tool_calls);
  return {text: typeof content === 'string' ? content : null, toolCalls};
}

function parseToolCalls(raw: unknown): ToolCall[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw invalidResponse();
  return raw.map((item) => {
    if (item === null || typeof item !== 'object') throw invalidResponse();
    const record = item as Record<string, unknown>;
    const fn = record.function;
    if (fn === null || typeof fn !== 'object') throw invalidResponse();
    const fnRecord = fn as Record<string, unknown>;
    const name = fnRecord.name;
    const args = fnRecord.arguments;
    if (typeof name !== 'string' || name.length === 0) throw invalidResponse();
    if (typeof args !== 'string') throw invalidResponse();
    const id = typeof record.id === 'string' && record.id.length > 0 ? record.id : `call_${name}`;
    return {id, name, arguments: args};
  });
}

function invalidResponse(): InsightGenerationError {
  return new InsightGenerationError('AI_LLM_INVALID_RESPONSE', GENERATION_ERROR_MESSAGES.AI_LLM_INVALID_RESPONSE);
}

const defaultChatFetch: ChatFetch = async (url, init) => {
  const response = await fetch(url, init);
  return {status: response.status, body: await response.text()};
};

/** 同时受「超时」与「外部取消」约束；两者都没有时返回 undefined，避免多建一个信号。 */
function combineSignals(timeout: AbortSignal, external: AbortSignal | undefined): AbortSignal | undefined {
  if (external === undefined) return timeout;
  return AbortSignal.any([timeout, external]);
}

export type {InsightGenerationCode};
