// 网页任务的保存契约：URL 规范化、来源元数据、请求与正文的严格校验。
//
// 逐条对齐 `worker/worker_core/web_page_contract.py`。宿主把浏览器抽取的文章正文
// 连同一份已经规范化的 URL 发进来；worker 在这里做最后一道校验——URL 不规范、
// 元数据不自洽、正文为空壳都直接拒绝，不给「半保存」的坏任务进历史列表的机会。
//
// URL 的解析没有用 Node 的 `URL` 类：它按 WHATWG 规则改写输入（百分号解码、
// 空路径补 `/`、默认端口删除的时机都和 Python `urlsplit` 不同）。这里照
// `urllib.parse` 的可见语义手写解析，让「同一个 URL 两侧算出同一个规范形」。
export const WEB_PAGE_CONTRACT_VERSION = 2;
export const MAX_WEB_PAGE_MESSAGE_BYTES = 40 * 1024 * 1024;
export const MAX_ARTICLE_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_ARTICLE_MARKDOWN_BYTES = 4 * 1024 * 1024;

/** 与 Python 的 `ValueError` 对应：调用方把它收敛成一个失败码。 */
export class WebPageContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebPageContractError';
  }
}

function invalid(message: string): WebPageContractError {
  return new WebPageContractError(message);
}

const WEB_TASK_ID_PATTERN = /^[0-9]{8}-[0-9]{6}-web-[0-9a-f]{16}$/u;
const HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const EXTRACTED_AT_PATTERN =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$/u;
/** Python `str.isspace()` ∪ 控制字符：URL 里出现任何一个都视为不可信输入。 */
const WHITESPACE_OR_CONTROL = /[\p{Cc}\p{Zs}\p{Zl}\p{Zp}]/u;
const FORBIDDEN_HOST_SUFFIXES = new Set([
  'localhost', 'local', 'internal', 'invalid', 'test', 'example', 'onion', 'home', 'arpa',
]);

// ---------------------------------------------------------------------------
// URL 解析：`urllib.parse.urlsplit` 的可见语义
// ---------------------------------------------------------------------------

export interface SplitUrl {
  readonly scheme: string;
  readonly username: string | null;
  readonly password: string | null;
  readonly hostname: string | null;
  readonly port: number | null;
  readonly path: string;
  readonly query: string;
}

/**
 * 拆 URL。不做任何改写（路径原样、查询原样），只抽出 Python 语义下的字段：
 * scheme 小写、hostname 小写、`@` 前是用户信息、方括号里是 IPv6 字面量。
 */
export function splitUrl(value: string): SplitUrl {
  let rest = value;
  let scheme = '';
  const colon = rest.indexOf(':');
  if (
    colon > 0
    && /^[a-zA-Z]/u.test(rest.charAt(0))
    && /^[a-zA-Z0-9+.-]*$/u.test(rest.slice(0, colon))
  ) {
    scheme = rest.slice(0, colon).toLowerCase();
    rest = rest.slice(colon + 1);
  }

  let netloc = '';
  if (rest.startsWith('//')) {
    // `_splitnetloc`：分隔符必须出现在起始位置之后，`///` 不算空 netloc 的边界。
    let end = rest.length;
    for (const delimiter of ['/', '?', '#']) {
      const index = rest.indexOf(delimiter, 2);
      if (index > 2 && index < end) end = index;
    }
    netloc = rest.slice(2, end);
    rest = rest.slice(end);
  }

  let fragmentless = rest;
  let query = '';
  const hash = fragmentless.indexOf('#');
  if (hash >= 0) fragmentless = fragmentless.slice(0, hash);
  const question = fragmentless.indexOf('?');
  if (question >= 0) {
    query = fragmentless.slice(question + 1);
    fragmentless = fragmentless.slice(0, question);
  }

  // 用户信息：最后一个 `@` 之前整段都是；存在用户信息就一定有用户名。
  let username: string | null = null;
  let password: string | null = null;
  let hostinfo = netloc;
  const at = netloc.lastIndexOf('@');
  if (at >= 0) {
    const userinfo = netloc.slice(0, at);
    hostinfo = netloc.slice(at + 1);
    const first = userinfo.indexOf(':');
    username = first >= 0 ? userinfo.slice(0, first) : userinfo;
    password = first >= 0 ? userinfo.slice(first + 1) : null;
  }

  let hostname: string | null = null;
  let port: number | null = null;
  const openBracket = hostinfo.indexOf('[');
  if (openBracket >= 0) {
    // `_check_bracketed_netloc`：`[` 前不允许有数据，`]` 之后只允许 `:端口`。
    if (openBracket > 0) throw invalid('Invalid IPv6 URL.');
    const bracketed = hostinfo.slice(1);
    const close = bracketed.indexOf(']');
    if (close < 0) throw invalid('Invalid IPv6 URL.');
    hostname = bracketed.slice(0, close);
    const afterBracket = bracketed.slice(close + 1);
    if (afterBracket.length > 0 && !afterBracket.startsWith(':')) {
      throw invalid('Invalid IPv6 URL.');
    }
    port = afterBracket.startsWith(':') ? parsePort(afterBracket.slice(1)) : null;
    // `_check_bracketed_host`：IPvFuture 或 IPv6 字面量；IPv4 不许进方括号。
    if (hostname.startsWith('v')) {
      if (!/^v[a-fA-F0-9]+\..+$/u.test(hostname)) throw invalid('IPvFuture address is invalid');
    } else {
      const address = parseIpLiteral(hostname);
      if (address === null || address === 4) throw invalid('An IPv4 address cannot be in brackets');
    }
    // 区域标识（`%zone`）跟在主机名后面，大小写原样保留。
    const zone = hostname.indexOf('%');
    if (zone >= 0) hostname = `${hostname.slice(0, zone).toLowerCase()}${hostname.slice(zone)}`;
    else hostname = hostname.toLowerCase();
  } else {
    const firstColon = hostinfo.indexOf(':');
    const host = firstColon >= 0 ? hostinfo.slice(0, firstColon) : hostinfo;
    hostname = host.toLowerCase();
    if (firstColon >= 0) port = parsePort(hostinfo.slice(firstColon + 1));
  }

  return {scheme, username, password, hostname: hostname ?? '', port, path: fragmentless, query};
}

function parsePort(raw: string): number | null {
  if (raw.length === 0) return null;
  if (!/^[0-9]+$/u.test(raw)) throw invalid('Port could not be parsed.');
  const port = Number(raw);
  if (port > 65535) throw invalid('Port out of range.');
  return port;
}

// ---------------------------------------------------------------------------
// IDNA：`host.encode("idna")` 的可见语义
// ---------------------------------------------------------------------------

/** Python `encodings.idna.ToASCII`：三段式——纯 ASCII 直通、nameprep 后 ASCII 直通、punycode。 */
function toAsciiLabel(label: string): string {
  if (isAscii(label)) {
    if (label.length === 0 || label.length >= 64) throw invalid('label empty or too long');
    return label;
  }
  const prepped = nameprepLite(label);
  if (isAscii(prepped)) {
    if (prepped.length === 0 || prepped.length >= 64) throw invalid('label empty or too long');
    return prepped;
  }
  if (prepped.startsWith('xn--')) throw invalid('Label starts with ACE prefix');
  const encoded = `xn--${punycodeEncode(prepped)}`;
  if (encoded.length >= 64) throw invalid('label too long');
  return encoded;
}

function isAscii(label: string): boolean {
  return /^[\x00-\x7f]*$/u.test(label);
}

/**
 * RFC 3454 nameprep 的常用子集：B.2 折叠大小写（JS `toLowerCase` 与 Python 表几乎一致，
 * 仅 `İ` 两侧同样折成 `i` + 组合点）、`ß` → `ss`、再 NFKC。
 * 覆盖不了整个 prohibited/bidi 表——那些字符在 URL 值里本就被控制字符与空白检查拦下。
 */
function nameprepLite(label: string): string {
  return label.toLowerCase().replaceAll('ß', 'ss').normalize('NFKC');
}

/** RFC 3492 punycode 编码（返回 `xn--` 之后的部分）。 */
function punycodeEncode(input: string): string {
  const BASE = 36, TMIN = 1, TMAX = 26, SKEW = 38, DAMP = 700, INITIAL_BIAS = 72, INITIAL_N = 128;
  const encodeDigit = (digit: number): string =>
    String.fromCharCode(digit < 26 ? 97 + digit : 22 + digit);

  const codePoints = [...input].map((character) => character.codePointAt(0) as number);
  const output: string[] = [];
  let handled = 0;
  const basicCount = codePoints.filter((code) => code < 128).length;
  for (const code of codePoints) {
    if (code < 128) output.push(String.fromCharCode(code));
  }
  let basicLength = basicCount;
  if (basicLength > 0) output.push('-');
  let index = basicLength;
  let nextCodePoint = INITIAL_N;
  let delta = 0;
  let bias = INITIAL_BIAS;

  while (index < codePoints.length) {
    let smallest = Number.POSITIVE_INFINITY;
    for (const code of codePoints) {
      if (code >= nextCodePoint && code < smallest) smallest = code;
    }
    delta += (smallest - nextCodePoint) * (index + 1);
    nextCodePoint = smallest;
    for (const code of codePoints) {
      if (code < nextCodePoint) delta += 1;
      if (code !== nextCodePoint) continue;
      let remainder = delta;
      for (let k = BASE; ; k += BASE) {
        const threshold = k <= bias ? TMIN : (k >= bias + TMAX ? TMAX : k - bias);
        if (remainder < threshold) break;
        const digit = threshold + ((remainder - threshold) % (BASE - threshold));
        output.push(encodeDigit(digit));
        remainder = Math.floor((remainder - threshold) / (BASE - threshold));
      }
      output.push(encodeDigit(remainder));
      bias = adapt(delta, index + 1, index === basicLength);
      delta = 0;
      index += 1;
    }
    delta += 1;
    nextCodePoint += 1;
    handled += 1;
  }
  void handled;
  return output.join('');

  function adapt(delta: number, points: number, first: boolean): number {
    let value = first ? Math.floor(delta / DAMP) : Math.floor(delta / 2);
    value += Math.floor(value / points);
    let k = 0;
    while (value > Math.floor(((BASE - TMIN) * TMAX) / 2)) {
      value = Math.floor(value / (BASE - TMIN));
      k += BASE;
    }
    return k + Math.floor(((BASE - TMIN + 1) * value) / (value + SKEW));
  }
}

/** `host.encode("idna").decode("ascii")`：保留尾点、按点拆标签逐个转 ASCII。 */
/** `host.encode("idna")`：ASCII 快速路径整段直通；非 ASCII 才逐标签转换（含 Unicode 点号拆分）。 */
export function encodeIdna(host: string): string {
  if (host.length === 0) return '';
  if (isAscii(host)) {
    // Codec.encode 的快速路径：除最后一个标签外必须 0 < len < 64，最后一个 < 64 即可。
    const labels = host.split('.');
    for (const label of labels.slice(0, -1)) {
      if (label.length === 0 || label.length >= 64) throw invalid('label empty or too long');
    }
    const last = labels[labels.length - 1];
    if (last.length >= 64) throw invalid('label too long');
    return host;
  }
  const labels = host.split(/[.\u3002\uff0e\uff61]/);
  let trailing = '';
  let body = labels;
  if (labels.length > 0 && labels[labels.length - 1] === '') {
    trailing = '.';
    body = labels.slice(0, -1);
  }
  return body.map(toAsciiLabel).join('.') + trailing;
}

// ---------------------------------------------------------------------------
// IP 地址：`ipaddress.ip_address` + `is_global` 的分类表
// ---------------------------------------------------------------------------

const IPV4_PRIVATE: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 0x00ffffff], // 0.0.0.0/8
  [0x0a000000, 0x0affffff], // 10.0.0.0/8
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16
  [0xac100000, 0xac1fffff], // 172.16.0.0/12
  [0xc0000000, 0xc0000007], // 192.0.0.0/29
  [0xc00000aa, 0xc00000ab], // 192.0.0.170/31
  [0xc0000200, 0xc00002ff], // 192.0.2.0/24
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16
  [0xc6120000, 0xc613ffff], // 198.18.0.0/15
  [0xc6336400, 0xc63364ff], // 198.51.100.0/24
  [0xcb007100, 0xcb0071ff], // 203.0.113.0/24
  [0xf0000000, 0xffffffff], // 240.0.0.0/4
  [0xffffffff, 0xffffffff], // 255.255.255.255/32
];

export interface ParsedIpAddress {
  readonly version: 4 | 6;
  /** IPv4 地址（v6 时为映射出的 IPv4，其余为 null）。 */
  readonly ipv4: number | null;
  readonly isGlobal: boolean;
}

/** 解析点分十进制或 IPv6 字面量；不合形状按 Python 一样抛错。 */
export function parseIpAddress(host: string): ParsedIpAddress {
  // 带区域标识（`%zone`）的作用域地址：主体可解析但一律按不可全局路由处理。
  const scope = host.indexOf('%');
  const body = scope >= 0 ? host.slice(0, scope) : host;
  const scoped = scope >= 0;
  const ipv4 = parseIpv4(body);
  if (ipv4 !== null) {
    const inShared = ipv4 >= 0x64400000 && ipv4 <= 0x647fffff; // 100.64.0.0/10
    const isPrivate = IPV4_PRIVATE.some(([start, end]) => ipv4 >= start && ipv4 <= end);
    return {version: 4, ipv4, isGlobal: !inShared && !isPrivate};
  }
  const ipv6 = parseIpv6(body);
  const mapped = ipv6.mapped;
  if (mapped !== null) {
    const inShared = mapped >= 0x64400000 && mapped <= 0x647fffff;
    const isPrivate = IPV4_PRIVATE.some(([start, end]) => mapped >= start && mapped <= end);
    return {version: 6, ipv4: mapped, isGlobal: !inShared && !isPrivate};
  }
  if (scoped) return {version: 6, ipv4: null, isGlobal: false};
  const value = ipv6.value;
  // `_private_networks`：::/128、::1/128、100::/64、2001::/23（覆盖 2001:2::/48 与
  // 2001:10::/28）、2001:db8::/32、fc00::/7、fe80::/10；::ffff:0:0/96 走映射分支。
  const isPrivate = inV6Range(value, 0n, 1n)
    || inV6Range(value, 0x100n << 112n, (0x100n << 112n) + ((1n << 64n) - 1n))
    || inV6Range(value, 0x2001n << 112n, (0x2001n << 112n) + ((0x200n << 96n) - 1n))
    || inV6Range(value, 0x2001_0db8n << 96n, (0x2001_0db8n << 96n) + ((1n << 96n) - 1n))
    || inV6Range(value, 0xfc00n << 112n, 0xfdff_ffff_ffff_ffff_ffff_ffff_ffff_ffffn)
    || inV6Range(value, 0xfe80n << 112n, 0xfebf_ffff_ffff_ffff_ffff_ffff_ffff_ffffn);
  return {version: 6, ipv4: null, isGlobal: !isPrivate};
}

function inV6Range(value: bigint, start: bigint, end: bigint): boolean {
  return value >= start && value <= end;
}

/** 方括号里的主机字面量：返回 4 / 6，解析失败返回 null（不抛）。 */
function parseIpLiteral(host: string): 4 | 6 | null {
  const scope = host.indexOf('%');
  const body = scope >= 0 ? host.slice(0, scope) : host;
  if (parseIpv4(body) !== null) return 4;
  try {
    parseIpv6(body);
    return 6;
  } catch {
    return null;
  }
}

function parseIpv4(host: string): number | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^[0-9]+$/u.test(part) || (part.length > 1 && part.startsWith('0'))) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

function parseIpv6(host: string): {readonly value: bigint; readonly mapped: number | null} {
  let text = host;
  let embeddedIpv4: number | null = null;
  const lastColon = text.lastIndexOf(':');
  if (lastColon >= 0) {
    const tail = text.slice(lastColon + 1);
    if (tail.includes('.')) {
      embeddedIpv4 = parseIpv4(tail);
      if (embeddedIpv4 === null) throw invalid('Invalid IPv6 address.');
      const high = Math.floor(embeddedIpv4 / 65536);
      const low = embeddedIpv4 % 65536;
      text = `${text.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`;
    }
  }
  const sections = text.split('::');
  if (sections.length > 2) throw invalid('Invalid IPv6 address.');
  const head = sections[0].length > 0 ? sections[0].split(':') : [];
  const tail = sections.length === 2 ? (sections[1].length > 0 ? sections[1].split(':') : []) : [];
  if (sections.length === 1 && head.length !== 8) throw invalid('Invalid IPv6 address.');
  if (sections.length === 2 && head.length + tail.length > 7) throw invalid('Invalid IPv6 address.');
  const missing = sections.length === 2 ? 8 - head.length - tail.length : 0;
  if (sections.length === 2 && missing < 1) throw invalid('Invalid IPv6 address.');
  const groups = [...head, ...Array(missing).fill('0'), ...tail];
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/u.test(group)) throw invalid('Invalid IPv6 address.');
    value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  }
  const mapped = value >> 32n === 0xffffn ? Number(value & 0xffffffffn) : null;
  return {value, mapped};
}

// ---------------------------------------------------------------------------
// 百分号编码 / 解码：`urllib.parse` 的可见语义
// ---------------------------------------------------------------------------

/** `quote`：字母数字与 `_.-~` 永不转义；safe 里的字符保留；其余 UTF-8 大写十六进制。 */
function quotePath(path: string, safe: string): string {
  const alwaysSafe = /^[A-Za-z0-9_.~-]$/u;
  let out = '';
  for (const character of path) {
    if (alwaysSafe.test(character) || safe.includes(character)) {
      out += character;
    } else {
      for (const byte of Buffer.from(character, 'utf8')) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      }
    }
  }
  return out;
}

/** `unquote`：无效转义按字面保留；连续的转义字节成批用 UTF-8 解码（坏序列替换字符）。 */
function unquote(value: string): string {
  if (!value.includes('%')) return value;
  let out = '';
  let bytes: number[] = [];
  const flush = (): void => {
    if (bytes.length > 0) {
      out += new TextDecoder('utf-8').decode(Buffer.from(bytes));
      bytes = [];
    }
  };
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charAt(index);
    if (character === '%'
      && /^[0-9a-fA-F]{2}$/u.test(value.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(value.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      flush();
      out += character;
    }
  }
  flush();
  return out;
}

export interface QueryItem {
  readonly key: string;
  readonly value: string;
}

/** `parse_qsl(keep_blank_values=True, max_num_fields=512)`：`+` 折成空格、只按 `&` 切、空段跳过。 */
export function parseQsl(query: string, maxFields: number): QueryItem[] {
  if (query.length === 0) return [];
  const pairs = query.split('&');
  if (pairs.length > maxFields) throw invalid('Max number of fields exceeded');
  const items: QueryItem[] = [];
  for (const pair of pairs) {
    if (pair.length === 0) continue;
    const equals = pair.indexOf('=');
    const name = equals >= 0 ? pair.slice(0, equals) : pair;
    const value = equals >= 0 ? pair.slice(equals + 1) : '';
    items.push({key: unquote(name.replaceAll('+', ' ')), value: unquote(value.replaceAll('+', ' '))});
  }
  return items;
}

/** `urlencode`（quote_plus 语义）：空格折成 `+`，其余 UTF-8 大写十六进制。 */
function urlencode(items: readonly QueryItem[]): string {
  return items.map(({key, value}) =>
    [quotePlus(key), quotePlus(value)].join('='),
  ).join('&');
}

function quotePlus(value: string): string {
  const alwaysSafe = /^[A-Za-z0-9_.~-]$/u;
  let out = '';
  for (const character of value) {
    if (character === ' ') {
      out += '+';
    } else if (alwaysSafe.test(character)) {
      out += character;
    } else {
      for (const byte of Buffer.from(character, 'utf8')) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 校验入口
// ---------------------------------------------------------------------------

export function validateWebUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16384) {
    throw invalid('Web page URL is invalid.');
  }
  for (const character of value) {
    if (WHITESPACE_OR_CONTROL.test(character)) throw invalid('Web page URL is invalid.');
  }
  const parsed = splitUrl(value);
  if (parsed.scheme !== 'http' && parsed.scheme !== 'https') throw invalid('Web page URL is invalid.');
  if (parsed.hostname === null || parsed.hostname.length === 0) {
    throw invalid('Web page URL is invalid.');
  }
  if (parsed.username !== null || parsed.password !== null) throw invalid('Web page URL is invalid.');
  if (value.includes('\\')) throw invalid('Web page URL is invalid.');
  if (parsed.port !== null && parsed.port !== 80 && parsed.port !== 443) {
    throw invalid('Web page URL is invalid.');
  }

  const host = encodeIdna(parsed.hostname).toLowerCase();
  if (host.endsWith('.')) throw invalid('Web page host is invalid.');
  const lastLabel = host.split('.').pop() ?? '';
  if (FORBIDDEN_HOST_SUFFIXES.has(lastLabel)) throw invalid('Web page host is invalid.');
  // DNS 连接的实际地址仍须由原生代理逐次验证。
  if (host.includes(':') || /^[0-9.]+$/u.test(host)) {
    const address = parseIpAddress(host);
    if (!address.isGlobal || (address.version === 6 && address.ipv4 !== null)) {
      throw invalid('Web page address is unavailable.');
    }
  } else if (
    host.length > 253
    || !host.includes('.')
    || !host.split('.').every((label) => HOST_LABEL_PATTERN.test(label))
    || host.endsWith('.local')
    || host.endsWith('.localhost')
    || host.endsWith('.internal')
    || host.endsWith('.test')
    || host.endsWith('.invalid')
    || /^[0-9]+$/u.test(lastLabel)
  ) {
    throw invalid('Web page host is invalid.');
  }
  return value;
}

/** `(?:^|/)(?:\.|%2e){1,2}(?:/|$)`，大小写不敏感。 */
const DOT_SEGMENT_PATTERN = /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/iu;

/** RFC 3986 §5.2.4 remove_dot_segments——`urljoin` 对绝对路径做的就是这一套。 */
function removeDotSegments(path: string): string {
  const output: string[] = [];
  let input = path;
  while (input.length > 0) {
    if (input.startsWith('../')) {
      input = input.slice(3);
    } else if (input.startsWith('./')) {
      input = input.slice(2);
    } else if (input.startsWith('/./')) {
      input = input.slice(2);
    } else if (input === '/.') {
      input = '/';
    } else if (input.startsWith('/../')) {
      input = input.slice(3);
      output.pop();
    } else if (input === '/..') {
      input = '/';
      output.pop();
    } else if (input === '.' || input === '..') {
      input = '';
    } else {
      const next = input.indexOf('/', 1);
      if (next === -1) {
        output.push(input);
        input = '';
      } else {
        output.push(input.slice(0, next));
        input = input.slice(next);
      }
    }
  }
  return output.join('');
}

export function canonicalWebUrl(value: unknown): string {
  const original = validateWebUrl(value);
  const parsed = splitUrl(original);
  const host = encodeIdna(parsed.hostname as string).toLowerCase();
  const authorityHost = host.includes(':') ? `[${host}]` : host;
  const defaultPort = parsed.scheme === 'http' ? 80 : 443;
  const authority = parsed.port === null || parsed.port === defaultPort
    ? authorityHost
    : `${authorityHost}:${parsed.port}`;

  const items = parseQsl(parsed.query, 512);
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.key, (counts.get(item.key) ?? 0) + 1);
  const kept = items.filter((item) => {
    if (counts.get(item.key) !== 1) return false;
    if (['id', 'article_id', 'post_id', 'story_id'].includes(item.key)) {
      return /^[0-9]{1,20}$/u.test(item.value);
    }
    if (item.key === 'page' || item.key === 'p') {
      return /^[1-9][0-9]{0,5}$/u.test(item.value);
    }
    return false;
  });

  let path = quotePath(parsed.path.length === 0 ? '/' : parsed.path, "/%:@!$&'()*+,;=-._~");
  // 已保存页面由浏览器 URL 解析器消除点路径；该形式不进入正式来源。
  if (DOT_SEGMENT_PATTERN.test(path)) {
    path = removeDotSegments(path);
    if (DOT_SEGMENT_PATTERN.test(path)) throw invalid('Saved web page URL path is invalid.');
  }

  const sorted = [...kept].sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1
      : left.value < right.value ? -1 : left.value > right.value ? 1 : 0,
  );
  const query = urlencode(sorted);
  return `${parsed.scheme}://${authority}${path}${query.length > 0 ? `?${query}` : ''}`;
}

// ---------------------------------------------------------------------------
// 来源元数据与请求
// ---------------------------------------------------------------------------

export interface WebPageSource {
  readonly kind: 'web_page';
  readonly url: string;
  readonly title: string;
  readonly extractedAt: string;
}

const TITLE_MARKDOWN_ESCAPE = '\\`*_{}[]<>()#+-.!|';

export function isWebPageSource(value: unknown): value is WebPageSource {
  return value !== null && typeof value === 'object'
    && (value as {kind?: unknown}).kind === 'web_page';
}

export function validateWebPageSource(url: unknown, title: unknown, extractedAt: unknown): WebPageSource {
  if (typeof url !== 'string' || canonicalWebUrl(url) !== url) {
    throw invalid('Saved web page URL is invalid.');
  }
  if (typeof title !== 'string') throw invalid('Web page title is invalid.');
  if (title.trim().length === 0 || title !== title.trim() || [...title].length > 512) {
    throw invalid('Web page title is invalid.');
  }
  for (const character of title) {
    if (/\p{Cc}/u.test(character)) throw invalid('Web page title is invalid.');
  }
  if (typeof extractedAt !== 'string' || !EXTRACTED_AT_PATTERN.test(extractedAt)) {
    throw invalid('Web page extraction time is invalid.');
  }
  if (!isValidTimestamp(extractedAt)) throw invalid('Web page extraction time is invalid.');
  return {kind: 'web_page', url, title, extractedAt};
}

/** Python `datetime.fromisoformat` 的范围检查：月日时分秒都不得越界。 */
function isValidTimestamp(value: string): boolean {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})/u.exec(value);
  if (match === null) return false;
  const [, year, month, day, hour, minute, second] = match;
  const daysInMonth = [31, isLeap(Number(year)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return Number(month) >= 1 && Number(month) <= 12
    && Number(day) >= 1 && Number(day) <= daysInMonth[Number(month) - 1]
    && Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59;
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function webPageSourceToDict(source: WebPageSource): Record<string, string> {
  return {kind: 'web_page', url: source.url, title: source.title, extractedAt: source.extractedAt};
}

export function validateWebTaskId(value: unknown): string {
  if (typeof value !== 'string' || !WEB_TASK_ID_PATTERN.test(value)) {
    throw invalid('Web page task identity is invalid.');
  }
  return value;
}

export interface WebPageRequest {
  readonly operationId: string;
  readonly taskId: string;
  readonly article: Record<string, string>;
}

const WEB_REQUEST_FIELDS = new Set(['contract_version', 'operation_id', 'task_id', 'article']);
const ARTICLE_FIELDS = new Set(['title', 'text', 'markdown', 'sourceUrl']);

export function parseWebPageRequest(payload: unknown): WebPageRequest {
  if (!isPlainObject(payload) || !hasExactKeys(payload, WEB_REQUEST_FIELDS)) {
    throw invalid('Web page request is invalid.');
  }
  // Python 用 `type(...) is not int`：布尔值在这里必须拒止。
  if (typeof payload.contract_version !== 'number'
    || !Number.isInteger(payload.contract_version)
    || payload.contract_version !== WEB_PAGE_CONTRACT_VERSION) {
    throw invalid('Web page request is invalid.');
  }
  const operation = payload.operation_id;
  if (typeof operation !== 'string' || !OPERATION_ID_PATTERN.test(operation)) {
    throw invalid('Web page operation identity is invalid.');
  }
  return {
    operationId: operation,
    taskId: validateWebTaskId(payload.task_id),
    article: validateArticlePayload(payload.article),
  };
}

export function validateArticlePayload(payload: unknown): Record<string, string> {
  if (!isPlainObject(payload) || !hasExactKeys(payload, ARTICLE_FIELDS)) {
    throw invalid('Web page extraction is invalid.');
  }
  if (Object.values(payload).some((value) => typeof value !== 'string')) {
    throw invalid('Web page extraction is invalid.');
  }
  const {title, text, markdown, sourceUrl} = payload as Record<string, string>;
  if (title.trim().length === 0 || title !== title.trim() || [...title].length > 512) {
    throw invalid('Web page extraction is invalid.');
  }
  if (/\p{Cc}/u.test(title)) throw invalid('Web page extraction is invalid.');
  // Python `"".join(text.split())`：去掉全部空白后至少要剩 50 个实质字符。
  const solid = text.replace(/[\s\u001c-\u001f\p{Zs}\p{Zl}\p{Zp}]/gu, '');
  if (solid.length < 50) throw invalid('Web page extraction is invalid.');
  if (markdown.trim().length === 0) throw invalid('Web page extraction is invalid.');
  if (Buffer.byteLength(text, 'utf8') > MAX_ARTICLE_TEXT_BYTES) {
    throw invalid('Web page extraction is invalid.');
  }
  if (Buffer.byteLength(markdown, 'utf8') > MAX_ARTICLE_MARKDOWN_BYTES) {
    throw invalid('Web page extraction is invalid.');
  }
  if (canonicalWebUrl(sourceUrl) !== sourceUrl) throw invalid('Web page extraction is invalid.');
  return payload as Record<string, string>;
}

/**
 * 标题按 Markdown 标点转义，来源与时间只接受已验证的本机字段——与
 * `web_page_storage.py::save_web_page` 的拼装逐字符一致。
 */
export function buildSavedMarkdown(title: string, url: string, extractedAt: string, markdown: string): string {
  const safeTitle = [...title].map((character) =>
    TITLE_MARKDOWN_ESCAPE.includes(character) ? `\\${character}` : character,
  ).join('');
  return `# ${safeTitle}\n\n<${url}>\n\n${extractedAt}\n\n${markdown}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).length === keys.size && Object.keys(value).every((key) => keys.has(key));
}
