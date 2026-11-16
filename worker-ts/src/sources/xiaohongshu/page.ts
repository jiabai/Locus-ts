// 小红书的公开笔记页解析：对齐 `worker/worker_core/xiaohongshu/page.py`。
//
// 页面是服务端渲染的 HTML，正文里挂着 `window.__INITIAL_STATE__` 那段 JS 对象字面量；
// 它不是合法 JSON（会出现 `undefined`、末尾逗号、`void 0`），所以先做括号配对与
// 文本替换再 `JSON.parse`。状态、状态码与失败码全部照抄 Python，宿主据此分流。
import {gunzipSync, brotliDecompressSync, inflateRawSync, inflateSync} from 'node:zlib';

import {header} from '../../download-reliability.ts';
import {XiaohongshuFallbackError} from './types.ts';
import type {HttpResponse} from './types.ts';

export const XHS_MAX_HTML_BYTES = 10 * 1024 * 1024;

const BLOCKED_MARKER = '当前笔记暂时无法浏览';

export function raiseForPageResponse(response: HttpResponse): void {
  if (response.status === 404) {
    throw new XiaohongshuFallbackError(
      'XHS_NOTE_NOT_FOUND',
      'Xiaohongshu note was not found.',
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new XiaohongshuFallbackError(
      'XHS_NOTE_BLOCKED',
      'Xiaohongshu note requires login or is not public.',
    );
  }
  if (response.status === 429) {
    throw new XiaohongshuFallbackError(
      'XHS_RATE_LIMITED',
      'Xiaohongshu request was rate limited.',
    );
  }
  if (response.status < 200 || response.status >= 300 || response.body.length === 0) {
    throw new XiaohongshuFallbackError(
      'XHS_PAGE_UNAVAILABLE',
      'Xiaohongshu public note page was unavailable.',
    );
  }
}

export function decodeResponseBody(
  response: HttpResponse,
  maxBytes: number = XHS_MAX_HTML_BYTES,
): string {
  let body = response.body;
  const encoding = (header(response.headers, 'Content-Encoding') ?? '')
    .split(',', 1)[0]
    .trim()
    .toLowerCase();
  try {
    body = decompressBody(body, encoding);
  } catch {
    throw new XiaohongshuFallbackError(
      'XHS_RESPONSE_DECODE_FAILED',
      'Xiaohongshu response body could not be decoded.',
    );
  }

  if (body.length > maxBytes) {
    throw new XiaohongshuFallbackError(
      'XHS_RESPONSE_TOO_LARGE',
      'Xiaohongshu page response exceeded the safety limit.',
    );
  }
  return new TextDecoder('utf-8').decode(body);
}

/** `deflate` 先按 zlib 封装解，失败再按裸 deflate 解；两种都失败才算解码失败。 */
function decompressBody(body: Uint8Array, encoding: string): Uint8Array {
  if (encoding === 'gzip') return gunzipSync(body);
  if (encoding === 'br') return brotliDecompressSync(body);
  if (encoding === 'deflate') {
    try {
      return inflateSync(body);
    } catch {
      return inflateRawSync(body);
    }
  }
  return body;
}

export function extractInitialState(body: string): Record<string, unknown> {
  if (body.includes('error_code') || body.includes(BLOCKED_MARKER)) {
    throw new XiaohongshuFallbackError(
      'XHS_NOTE_BLOCKED',
      'Xiaohongshu note requires login or is not public.',
    );
  }

  const markerIndex = body.indexOf('window.__INITIAL_STATE__');
  if (markerIndex < 0) {
    throw new XiaohongshuFallbackError(
      'XHS_INITIAL_STATE_MISSING',
      'Xiaohongshu page did not include initial state.',
    );
  }

  const jsonStart = body.indexOf('{', markerIndex);
  if (jsonStart < 0) {
    throw new XiaohongshuFallbackError(
      'XHS_INITIAL_STATE_MISSING',
      'Xiaohongshu initial state was not parseable.',
    );
  }

  const jsonText = jsToJson(extractBracedObject(body, jsonStart));
  let state: unknown;
  try {
    state = JSON.parse(jsonText);
  } catch {
    throw new XiaohongshuFallbackError(
      'XHS_INITIAL_STATE_MALFORMED',
      'Xiaohongshu initial state was malformed.',
    );
  }
  if (!isPlainObject(state)) {
    throw new XiaohongshuFallbackError(
      'XHS_INITIAL_STATE_MALFORMED',
      'Xiaohongshu initial state was not an object.',
    );
  }
  return state;
}

export function extractBracedObject(text: string, startIndex: number): string {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (char === '\\') {
        escape = true;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(startIndex, index + 1);
    }
  }

  throw new XiaohongshuFallbackError(
    'XHS_INITIAL_STATE_MISSING',
    'Xiaohongshu initial state object was incomplete.',
  );
}

export function jsToJson(raw: string): string {
  // `$` 在 Python 里还能匹配结尾换行之前的位置，这里用前瞻保持同样的边界。
  const withNulls = raw
    .replace(/([:,[{]\s*)(?:undefined|void\s+0)(\s*[,}\]])/gu, '$1null$2')
    .replace(/([:,[{]\s*)(?:undefined|void\s+0)(\s*)(?=\n?$)/gu, '$1null$2');
  return withNulls.replace(/,(\s*[}\]])/gu, '$1');
}

export function lookupNote(
  state: Readonly<Record<string, unknown>>,
  noteId: string,
): Record<string, unknown> {
  const note = asMapping(state.note);
  const detailMap = note === null ? null : asMapping(note.noteDetailMap);
  const entry = detailMap === null ? null : asMapping(detailMap[noteId]);
  const noteObject = entry === null ? null : asMapping(entry.note);
  if (noteObject === null || Object.keys(noteObject).length === 0) {
    throw new XiaohongshuFallbackError(
      'XHS_NOTE_NOT_FOUND',
      'Xiaohongshu note was not found.',
    );
  }
  return noteObject;
}

export function isImageOnlyNote(noteObject: Readonly<Record<string, unknown>>): boolean {
  const noteType = getString(noteObject, 'type').toLowerCase();
  const imageList = noteObject.imageList;
  return noteType === 'image' || noteType === 'album' || noteType === 'image_album'
    || Array.isArray(imageList);
}

/** 只把普通对象当映射；数组与标量都按「没有」处理，与 Python `isinstance(Mapping)` 一致。 */
export function asMapping(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? value : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getString(mapping: Readonly<Record<string, unknown>>, key: string): string {
  const value = mapping[key];
  return typeof value === 'string' ? value.trim() : '';
}
