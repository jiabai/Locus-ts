// `urllib.parse` 的最小复刻：小红书解析要用 Python 的语义而不是 `new URL` 的。
//
// 两处差异必须保留：`new URL` 会把主机名小写化并补默认端口，而清单里要写回
// 用户原始输入（大小写、尾随点都保留）；`parse_qs` 会丢掉空值再取第一个，
// 与 `URLSearchParams` 的「空值也算命中」不同。
export interface ParsedUrl {
  readonly scheme: string;
  readonly netloc: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;
  readonly hostname: string | null;
  readonly username: string | null;
  readonly password: string | null;
}

const SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):/u;

export function splitUrl(raw: string): ParsedUrl {
  // 与 Python 3.11+ 的 `urlsplit` 一致：先去掉内嵌的 tab/CR/LF，再剥掉开头的
  // C0 控制符与空格；结尾空格属于 path，必须保留。
  let rest = raw.replaceAll('\t', '').replaceAll('\r', '').replaceAll('\n', '');
  rest = rest.replace(/^[\u0000-\u0020\u007f]+/u, '');
  let scheme = '';
  const schemeMatch = SCHEME_PATTERN.exec(rest);
  if (schemeMatch !== null) {
    scheme = schemeMatch[1].toLowerCase();
    rest = rest.slice(schemeMatch[0].length);
  }

  let fragment = '';
  const hashIndex = rest.indexOf('#');
  if (hashIndex >= 0) {
    fragment = rest.slice(hashIndex + 1);
    rest = rest.slice(0, hashIndex);
  }

  let query = '';
  const queryIndex = rest.indexOf('?');
  if (queryIndex >= 0) {
    query = rest.slice(queryIndex + 1);
    rest = rest.slice(0, queryIndex);
  }

  let netloc = '';
  if (rest.startsWith('//')) {
    const afterSlashes = rest.slice(2);
    const end = afterSlashes.indexOf('/');
    netloc = end < 0 ? afterSlashes : afterSlashes.slice(0, end);
    rest = end < 0 ? '' : afterSlashes.slice(end);
  }

  const {hostname, username, password} = hostInfo(netloc);
  return {scheme, netloc, path: rest, query, fragment, hostname, username, password};
}

/** 与 Python `geturl()` 一致：只小写 scheme，其余部分按原样拼回。 */
export function rebuildUrl(parsed: ParsedUrl): string {
  const authority = parsed.netloc === '' ? '' : `//${parsed.netloc}`;
  const query = parsed.query === '' ? '' : `?${parsed.query}`;
  const fragment = parsed.fragment === '' ? '' : `#${parsed.fragment}`;
  return `${parsed.scheme}:${authority}${parsed.path}${query}${fragment}`;
}

/** `parse_qs(..., keep_blank_values=False)` 后取第一个值。 */
export function queryFirstValue(query: string, name: string): string {
  for (const field of query.split('&')) {
    const separator = field.indexOf('=');
    const key = unquotePlus(separator < 0 ? field : field.slice(0, separator));
    const value = separator < 0 ? '' : unquotePlus(field.slice(separator + 1));
    if (value === '') continue;
    if (key === name) return value;
  }
  return '';
}

/** `urllib.parse.quote(value, safe="")`：`!'()*` 也要转义。 */
export function pythonQuote(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let result = '';
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    if (/[A-Za-z0-9_.\-~]/u.test(char)) {
      result += char;
    } else {
      result += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return result;
}

export function unquotePlus(value: string): string {
  return percentDecode(value.replaceAll('+', ' '));
}

/** 百分号解码按 UTF-8 替换非法序列，与 `unquote(errors="replace")` 对齐。 */
export function percentDecode(value: string): string {
  const bytes: number[] = [];
  let index = 0;
  while (index < value.length) {
    const char = value[index];
    if (char === '%' && index + 2 < value.length) {
      const hex = value.slice(index + 1, index + 3);
      if (/^[0-9A-Fa-f]{2}$/u.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        index += 3;
        continue;
      }
    }
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    const literal = String.fromCodePoint(codePoint);
    for (const byte of new TextEncoder().encode(literal)) bytes.push(byte);
    index += literal.length;
  }
  return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
}

function hostInfo(netloc: string): {
  hostname: string | null;
  username: string | null;
  password: string | null;
} {
  const atIndex = netloc.lastIndexOf('@');
  const hasUserInfo = atIndex >= 0;
  const userInfo = hasUserInfo ? netloc.slice(0, atIndex) : '';
  const hostInfoText = hasUserInfo ? netloc.slice(atIndex + 1) : netloc;

  let username: string | null = null;
  let password: string | null = null;
  if (hasUserInfo) {
    const colon = userInfo.indexOf(':');
    username = percentDecode(colon < 0 ? userInfo : userInfo.slice(0, colon));
    password = colon < 0 ? null : percentDecode(userInfo.slice(colon + 1));
  }

  if (hostInfoText.startsWith('[')) {
    const close = hostInfoText.indexOf(']');
    if (close < 0) return {hostname: null, username, password};
    return {
      hostname: hostInfoText.slice(1, close).toLowerCase(),
      username,
      password,
    };
  }
  const colon = hostInfoText.indexOf(':');
  const host = colon < 0 ? hostInfoText : hostInfoText.slice(0, colon);
  return {hostname: host.toLowerCase(), username, password};
}
