// 下载目录里的字幕解析：复现 `worker/worker_core/subtitles.py`。
//
// 字幕是 yt-dlp 落盘的产物，文件名的语言标记决定优先级；解析结果直接成为
// 任务文字稿，因此时间戳、滚动去重、标签清洗与 HTML 实体解码都要按同一套规则。
// HTML5 实体表交给成熟库（`entities`），不在仓库内再抄一份。
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';

import {decodeHTML} from 'entities';

import {stripPythonSpace} from '../protocol/process-request.ts';

export const PREFERRED_SUBTITLE_LANGUAGES: readonly string[] = [
  'zh-Hans', 'zh-CN', 'zh-Hant', 'zh', 'en-US', 'en', 'ja', 'ko',
];
export const SUPPORTED_SUBTITLE_SUFFIXES: readonly string[] = ['.srt', '.vtt'];

// Python `re` 的 `\s` 闭集（含 U+001C..U+001F 与 U+0085，不含 U+FEFF）。
const PY_SPACE = '\\u0009-\\u000d\\u001c-\\u001f\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const TIMESTAMP_PATTERN = new RegExp(
  `(?<start>(?:\\d{2}:)?\\d{2}:\\d{2}[.,]\\d{3})[${PY_SPACE}]*-->[${PY_SPACE}]*`
  + `(?<end>(?:\\d{2}:)?\\d{2}:\\d{2}[.,]\\d{3})`,
  'u',
);
const TAG_PATTERN = /<[^>]+>/gu;
const INLINE_TIMESTAMP_TAG_PATTERN = /<\d{2}:\d{2}:\d{2}[.,]\d{3}>/gu;
const PYTHON_WHITESPACE_RUN = new RegExp(`[${PY_SPACE}]+`, 'gu');
const BLOCK_SEPARATOR = new RegExp(`\\n[${PY_SPACE}]*\\n`, 'u');
// Python `str.splitlines()` 的换行闭集。
const LINE_BREAK = /\r\n|[\n\r\u000b\u000c\u001c-\u001e\u0085\u2028\u2029]/u;

export interface TranscriptSegment {
  readonly id: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

export interface SubtitleTranscript {
  readonly text: string;
  readonly language: string;
  readonly segments: readonly TranscriptSegment[];
}

interface RawSegment {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

function subtitleLanguage(fileName: string): string {
  const parts = fileName.split('.');
  return parts.length >= 3 ? parts[parts.length - 2] : 'unknown';
}

async function candidateSubtitleFiles(downloadDir: string): Promise<string[]> {
  const entries = await readdir(downloadDir, {withFileTypes: true});
  const ranked = entries
    .filter((entry) => entry.isFile()
      && SUPPORTED_SUBTITLE_SUFFIXES.includes(path.extname(entry.name).toLowerCase()))
    .map((entry) => {
      const language = subtitleLanguage(entry.name);
      const index = PREFERRED_SUBTITLE_LANGUAGES.indexOf(language);
      return {name: entry.name, rank: index < 0 ? PREFERRED_SUBTITLE_LANGUAGES.length : index};
    });
  // Python `sorted((rank, name.lower(), Path))`：前两项相同才按路径排，这里按名称定序。
  ranked.sort((left, right) => left.rank - right.rank
    || (left.name.toLowerCase() < right.name.toLowerCase() ? -1
      : left.name.toLowerCase() > right.name.toLowerCase() ? 1 : 0)
    || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return ranked.map((entry) => entry.name);
}

function parseTimestampMs(value: string): number | null {
  const normalized = value.replaceAll(',', '.');
  const parts = normalized.split(':');
  let hours = 0;
  let minutesText: string;
  let secondsText: string;
  if (parts.length === 2) {
    minutesText = parts[0];
    secondsText = parts[1];
  } else if (parts.length === 3) {
    hours = Number(parts[0]);
    minutesText = parts[1];
    secondsText = parts[2];
  } else {
    return null;
  }
  const secondsParts = secondsText.split('.');
  if (secondsParts.length !== 2) return null;
  const minutes = Number(minutesText);
  const seconds = Number(secondsParts[0]);
  const millis = Number(secondsParts[1].padEnd(3, '0').slice(0, 3));
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
}

function cleanSubtitleText(value: string): string {
  const withoutInlineTimestamps = value.replaceAll(INLINE_TIMESTAMP_TAG_PATTERN, '');
  const withoutTags = withoutInlineTimestamps.replaceAll(TAG_PATTERN, '');
  const unescaped = decodeHTML(withoutTags);
  return stripPythonSpace(unescaped.replaceAll(PYTHON_WHITESPACE_RUN, ' '));
}

function parseSubtitleBlock(block: string): RawSegment | null {
  const lines = block.split(LINE_BREAK)
    .map((line) => stripPythonSpace(line))
    .filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  if (lines[0] === 'WEBVTT' || /^(?:NOTE|STYLE|REGION)/u.test(lines[0])) return null;

  const timestampIndex = lines.findIndex((line) => TIMESTAMP_PATTERN.test(line));
  if (timestampIndex < 0) return null;
  const match = TIMESTAMP_PATTERN.exec(lines[timestampIndex]);
  if (match?.groups === undefined) return null;
  const startMs = parseTimestampMs(match.groups.start);
  const endMs = parseTimestampMs(match.groups.end);
  if (startMs === null || endMs === null || endMs <= startMs) return null;
  const text = cleanSubtitleText(lines.slice(timestampIndex + 1).join(' '));
  if (text.length === 0) return null;
  return {startMs, endMs, text};
}

function dedupeRollingSegments(raw: readonly RawSegment[]): TranscriptSegment[] {
  const deduped: RawSegment[] = [];
  for (const segment of raw) {
    const previous = deduped[deduped.length - 1];
    if (previous === undefined) {
      deduped.push(segment);
    } else if (segment.text === previous.text) {
      continue;
    } else if (segment.text.startsWith(previous.text)) {
      deduped[deduped.length - 1] = segment;
    } else {
      deduped.push(segment);
    }
  }
  return deduped.map((segment, index) => ({
    id: `subtitle-${index + 1}`,
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: segment.text,
  }));
}

/** `utf-8-sig` 读取：BOM 只在文件开头去掉，非法字节按 replacement character 处理。 */
function decodeSubtitleBytes(bytes: Uint8Array): string {
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  return new TextDecoder('utf-8', {fatal: false}).decode(hasBom ? bytes.subarray(3) : bytes);
}

export function parseSubtitleContent(
  content: string,
  language: string,
): SubtitleTranscript | null {
  const normalized = content.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const raw: RawSegment[] = [];
  for (const block of normalized.split(BLOCK_SEPARATOR)) {
    const parsed = parseSubtitleBlock(block);
    if (parsed !== null) raw.push(parsed);
  }
  const segments = dedupeRollingSegments(raw);
  if (segments.length === 0) return null;
  const text = stripPythonSpace(segments.map((segment) => segment.text).join('\n'));
  if (text.length === 0) return null;
  return {text, language, segments};
}

export async function parseSubtitleFile(
  filePath: string,
  language: string,
): Promise<SubtitleTranscript | null> {
  return parseSubtitleContent(
    decodeSubtitleBytes(await readFile(filePath)),
    language,
  );
}

/** 按语言优先序返回第一份能解析出内容的字幕；目录不存在由调用方处理。 */
export async function findSubtitleTranscript(
  downloadDir: string,
): Promise<SubtitleTranscript | null> {
  for (const name of await candidateSubtitleFiles(downloadDir)) {
    const transcript = await parseSubtitleFile(
      path.join(downloadDir, name),
      subtitleLanguage(name),
    );
    if (transcript !== null) return transcript;
  }
  return null;
}
