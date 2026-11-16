// 抖音分享页解析：对齐 `worker/worker_core/douyin/page.py`。
//
// 分享页把 SSR 数据塞在 `window._ROUTER_DATA = {...};` 里，真实内容藏在
// `loaderData` 下的任意页面键里，所以按深度优先找第一个 `videoInfoRes`。
// 页面偶尔会退化（没有 `videoInfoRes`），由调用方重试，不在这里补救。
import {DouyinFallbackError} from './types.ts';

export function parseSharePageRouterData(html: string): Record<string, unknown> {
  const markerIndex = html.indexOf('window._ROUTER_DATA');
  if (markerIndex < 0) {
    throw new DouyinFallbackError(
      'DOUYIN_ROUTER_DATA_MISSING',
      'Douyin share page did not include router data.',
    );
  }

  const equalsIndex = html.indexOf('=', markerIndex);
  const jsonStart = equalsIndex < 0 ? -1 : html.indexOf('{', equalsIndex);
  if (equalsIndex < 0 || jsonStart < 0) {
    throw new DouyinFallbackError(
      'DOUYIN_ROUTER_DATA_MISSING',
      'Douyin share page router data was not parseable.',
    );
  }

  const routerData = decodeLeadingJson(html.slice(jsonStart));
  const videoInfo = findVideoInfoRes(routerData);
  if (videoInfo === null) {
    throw new DouyinFallbackError(
      'DOUYIN_ROUTER_DATA_MISSING',
      'Douyin share page did not include videoInfoRes.',
    );
  }
  const itemList = videoInfo['item_list'];
  if (!Array.isArray(itemList) || itemList.length === 0
    || !isPlainObject(itemList[0])) {
    throw new DouyinFallbackError(
      'DOUYIN_ROUTER_DATA_MISSING',
      'Douyin share page did not include a playable item.',
    );
  }
  return itemList[0];
}

/**
 * 解析开头的 JSON 值并忽略尾随内容，对应 Python `JSONDecoder.raw_decode`。
 * 只支持对象开头（分享页数据必然是对象），结尾按字符串感知的括号配对定位。
 */
function decodeLeadingJson(text: string): unknown {
  const start = text.search(/\S/u);
  if (start < 0 || text[start] !== '{') {
    throw new DouyinFallbackError(
      'DOUYIN_ROUTER_DATA_MALFORMED',
      'Douyin share page router data was malformed.',
    );
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1));
        } catch {
          break;
        }
      }
    }
  }
  throw new DouyinFallbackError(
    'DOUYIN_ROUTER_DATA_MALFORMED',
    'Douyin share page router data was malformed.',
  );
}

function findVideoInfoRes(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findVideoInfoRes(child);
      if (found !== null) return found;
    }
    return null;
  }
  if (!isPlainObject(value)) return null;
  const maybeVideoInfo = value['videoInfoRes'];
  if (isPlainObject(maybeVideoInfo)) return maybeVideoInfo;
  for (const child of Object.values(value)) {
    const found = findVideoInfoRes(child);
    if (found !== null) return found;
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
