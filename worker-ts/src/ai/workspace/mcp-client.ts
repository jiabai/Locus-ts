// anysearch 检索工具的 MCP 客户端。
//
// Python 侧 `worker_core.draft_agent` 通过 `agent_runtime` 的 FunctionToolManager 启用
// `streamable-http` MCP 服务，再把 `tools/list` 的动态工具并入成稿工具集。这里用
// TypeScript 官方 MCP SDK 做同一件事；工具名与参数结构完全来自服务端，本地不预设。
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type {Transport} from '../config.ts';
import {defaultTransport, DEFAULT_LLM_TIMEOUT_SECONDS} from '../config.ts';
import type {Tool} from '../tool-loop.ts';

const ANYSEARCH_SOURCE_ENV = 'APP_ANYSEARCH_SOURCE';
const ANYSEARCH_MCP_URL_ENV = 'ANYSEARCH_MCP_URL';
const ANYSEARCH_API_KEY_ENV = 'ANYSEARCH_API_KEY';

class AnysearchConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnysearchConfigError';
  }
}

export interface AnysearchConfig {
  readonly url: string;
  readonly apiKey: string | null;
}

export interface McpSession {
  /** `tools/list` 返回的工具，已转成工具循环可直接使用的 Tool。 */
  readonly tools: readonly Tool[];
  close(): Promise<void>;
}

export interface ResolveAnysearchOptions {
  readonly transport?: Transport;
  readonly signal?: AbortSignal;
}

/** 从 checkout 错误体里取 `{"error": "CODE"}`；取不到就返回空串，不把正文往上带。 */
function extractAnysearchErrorCode(body: string): string {
  try {
    const payload = JSON.parse(body) as Record<string, unknown>;
    return typeof payload.error === 'string' ? payload.error : '';
  } catch {
    return '';
  }
}

/** 托管 checkout：`{mcp_url, api_key?}`；缺 api_key 表示匿名访问。 */
export async function checkoutAnysearchConfig(
  environ: Readonly<Record<string, string | undefined>>,
  options: ResolveAnysearchOptions = {},
): Promise<{readonly mcpUrl: string; readonly apiKey: string | null}> {
  const checkoutUrl = environ.APP_ANYSEARCH_CHECKOUT_URL?.trim() ?? '';
  const sessionToken = environ.APP_ANYSEARCH_SESSION_TOKEN?.trim() ?? '';
  if (!checkoutUrl || !sessionToken) {
    throw new AnysearchConfigError(
      'APP_ANYSEARCH_SOURCE=server 但缺少 APP_ANYSEARCH_CHECKOUT_URL / _SESSION_TOKEN 之一，'
      + '无法 checkout anysearch 凭证。',
    );
  }
  const transport = options.transport ?? defaultTransport;
  let response: {readonly status: number; readonly body: string};
  try {
    response = await transport(
      checkoutUrl,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
        ...(options.signal === undefined ? {} : {signal: options.signal}),
      },
      DEFAULT_LLM_TIMEOUT_SECONDS * 1000,
    );
  } catch {
    throw new AnysearchConfigError('anysearch checkout 请求失败，未返回可用响应。');
  }
  if (response.status < 200 || response.status >= 300) {
    if (response.status === 401) {
      throw new AnysearchConfigError('anysearch checkout 需要登录（鉴权失败，401）。');
    }
    if (extractAnysearchErrorCode(response.body) === 'ANYSEARCH_CONFIG_MISSING') {
      throw new AnysearchConfigError('服务端未配置 anysearch（APP_ANYSEARCH_MCP_URL 缺失）。');
    }
    throw new AnysearchConfigError(`anysearch checkout 失败，HTTP ${response.status}。`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(response.body);
  } catch {
    throw new AnysearchConfigError('anysearch checkout 未返回可用配置（缺少 mcp_url）。');
  }
  const mcpUrl = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? String((payload as Record<string, unknown>).mcp_url ?? '').trim()
    : '';
  if (!mcpUrl) {
    throw new AnysearchConfigError('anysearch checkout 未返回可用配置（mcp_url 为空）。');
  }
  const rawKey = (payload as Record<string, unknown>).api_key;
  const apiKey = typeof rawKey === 'string' && rawKey.trim() ? rawKey.trim() : null;
  return {mcpUrl, apiKey};
}

/** 与 Python `resolve_draft_credentials` 相同的覆盖语义：托管配置整体覆盖本地残留。 */
export async function resolveAnysearchConfig(
  environ: Readonly<Record<string, string | undefined>>,
  options: ResolveAnysearchOptions = {},
): Promise<AnysearchConfig> {
  const source = (environ[ANYSEARCH_SOURCE_ENV] ?? '').trim().toLowerCase();
  if (source === 'server') {
    const checked = await checkoutAnysearchConfig(environ, options);
    return {url: checked.mcpUrl, apiKey: checked.apiKey};
  }
  const url = environ[ANYSEARCH_MCP_URL_ENV]?.trim() ?? '';
  if (!url) {
    throw new AnysearchConfigError(
      'ANYSEARCH_MCP_URL 未配置：anysearch streamable-http MCP 端点未知，请通过 .env 提供。',
    );
  }
  const apiKey = environ[ANYSEARCH_API_KEY_ENV]?.trim() || null;
  return {url, apiKey};
}

/** 把 MCP `tools/call` 的 content 块转成一条 tool 消息文本。 */
export function mcpResultToText(result: unknown): string {
  const content = (result as {content?: unknown} | null)?.content;
  if (!Array.isArray(content)) return JSON.stringify(result);
  const parts: string[] = [];
  for (const item of content) {
    if (item !== null && typeof item === 'object'
      && (item as {type?: unknown}).type === 'text'
      && typeof (item as {text?: unknown}).text === 'string') {
      parts.push((item as {text: string}).text);
    } else {
      parts.push(JSON.stringify(item));
    }
  }
  return parts.join('\n');
}

export async function connectAnysearch(config: AnysearchConfig): Promise<McpSession> {
  const client = new Client({name: 'locus-worker-ts', version: '0.0.0'});
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: {
      headers: config.apiKey === null ? {} : {Authorization: `Bearer ${config.apiKey}`},
    },
  });
  await client.connect(transport);
  try {
    const {tools} = await client.listTools();
    const wired: Tool[] = tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.inputSchema as Record<string, unknown>,
      handler: async ({args}) => {
        const result = await client.callTool({name: tool.name, arguments: args});
        return mcpResultToText(result);
      },
    }));
    return {tools: wired, close: () => client.close()};
  } catch (error) {
    await client.close();
    throw error;
  }
}
