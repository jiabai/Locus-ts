// 本地来源字段的判定。
//
// 显示名会出现在界面、日志与清单里，因此必须是「单层、干净、后缀与扩展名一致」的
// basename：路径分隔符能把一个文件名变成别的路径，控制字符与双向控制符
// （`U+202E` 之类）能让 `.mp4` 显示成 `.pdf`。
//
// 这里同时被请求解析（`protocol/requests.ts`）与清单校验（`tasks/load.ts`）使用：
// 两处判定必须一致，否则「建任务时能过、重新打开时不能过」会让任务变成孤儿。
import {AUDIO_EXTENSIONS, VIDEO_EXTENSIONS} from '../protocol/contract.ts';

export const MAX_DISPLAY_NAME_LENGTH = 160;

export type LocalMediaKind = 'video' | 'audio';

export function isUnsafeBasenameCharacter(value: string): boolean {
  const codePoint = value.codePointAt(0) as number;
  return value === '/'
    || value === '\\'
    || /^\p{Cc}$/u.test(value)
    || codePoint === 0x061c || codePoint === 0x200e || codePoint === 0x200f
    || (codePoint >= 0x202a && codePoint <= 0x202e)
    || (codePoint >= 0x2066 && codePoint <= 0x2069);
}

export function isSafeLocalDisplayName(value: unknown, extension: string): boolean {
  if (typeof value !== 'string') return false;
  if (value.trim().length === 0 || value === '.' || value === '..') return false;
  const characters = [...value];
  if (characters.length > MAX_DISPLAY_NAME_LENGTH) return false;
  if (!value.toLowerCase().endsWith(`.${extension}`)) return false;
  return !characters.some(isUnsafeBasenameCharacter);
}

/** 三处必须同时成立：媒体类型、扩展名在白名单内、显示名与扩展名一致。 */
export function isValidLocalSourceFields(
  displayName: unknown,
  mediaKind: unknown,
  extension: unknown,
): boolean {
  if (mediaKind !== 'video' && mediaKind !== 'audio') return false;
  if (typeof extension !== 'string') return false;
  const allowed = mediaKind === 'video' ? VIDEO_EXTENSIONS : AUDIO_EXTENSIONS;
  if (!allowed.has(extension)) return false;
  return isSafeLocalDisplayName(displayName, extension);
}
