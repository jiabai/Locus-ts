// 短链解析共用的取页客户端：复现各平台 transport 的 GET 语义
// （跟随重定向并返回最终 URL、超时、正文上限、压缩响应体解码）。
//
// 与 Python 的差异（刻意）：不手发 Accept-Encoding，让 undici 自行协商并
// 透明解压——Python 发 `gzip, deflate, br` 后手动解压，两者在「拿到可读 HTML」
// 这一层面等价，不改变解析语义。
export class PageFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageFetchError';
  }
}

export interface PageResponse {
  readonly status: number;
  /** 响应头取值（大小写不敏感）；无该头时为 null。 */
  header: (name: string) => string | null;
  /** 跟随重定向后的最终 URL。 */
  readonly url: string;
  readonly body: Uint8Array;
}

export type PageFetch = (
  url: string,
  init: {readonly headers: Record<string, string>; readonly timeoutSeconds: number},
) => Promise<PageResponse>;

/** 页面读取上限：与 Python `read(BILIBILI_MAX_RESPONSE_BYTES + 1)` 同位。 */
export const PAGE_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** 与 Python 各 transport 的 `get` 同位：跟随重定向、读回正文（截断到上限+1）。 */
export const defaultPageFetch: PageFetch = async (url, init) => {
  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: init.headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(init.timeoutSeconds * 1000),
    });
  } catch (error) {
    throw new PageFetchError(`Page request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  // 与 Python `read(N + 1)` 一致：多读一个字节，留给上层判定越界。
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader !== undefined) {
    for (;;) {
      const {done, value} = await reader.read();
      if (done || value === undefined) break;
      chunks.push(value);
      total += value.length;
      if (total > PAGE_MAX_RESPONSE_BYTES) break;
    }
  }
  const capped = new Uint8Array(Math.min(total, PAGE_MAX_RESPONSE_BYTES + 1));
  let written = 0;
  for (const chunk of chunks) {
    const remaining = capped.length - written;
    if (remaining <= 0) break;
    const slice = chunk.subarray(0, Math.min(chunk.length, remaining));
    capped.set(slice, written);
    written += slice.length;
  }
  const headers = new Map<string, string>();
  response.headers.forEach((value, key) => {
    headers.set(key.toLowerCase(), value);
  });
  return {
    status: response.status,
    header: (name) => headers.get(name.toLowerCase()) ?? null,
    url: response.url,
    body: capped,
  };
};

/** Python `body.decode('utf-8', errors='replace')`：坏序列替换为 U+FFFD。 */
export function decodeBody(body: Uint8Array): string {
  return new TextDecoder('utf-8').decode(body);
}

function unescapeNamed(name: string): string | null {
  switch (name) {
    case 'amp': return '&';
    case 'lt': return '<';
    case 'gt': return '>';
    case 'quot': return '"';
    case 'apos': return "'";
    case 'nbsp': return '\u00a0';
    default: return null;
  }
}

/** 小朴素的 HTML 实体反转义：URL 场景只需要 `&amp;` 等常见实体与数字形式。 */
export function unescapeHtml(text: string): string {
  return text.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{1,10});?/gu, (match, body: string) => {
    if (body.startsWith('#')) {
      const code = body.startsWith('#x') || body.startsWith('#X')
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code) : match;
    }
    return unescapeNamed(body.toLowerCase()) ?? match;
  });
}
