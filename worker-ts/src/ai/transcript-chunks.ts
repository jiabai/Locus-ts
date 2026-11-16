// 文字稿分块：给长文做「按语义边界切」的分段。
//
// 对齐 `worker/worker_core/transcript_chunks.py`：优先在空行处切，其次在句号处切，
// 都没有才硬切。字节偏移与 sha256 一并给出，因为下游（洞察、解剖）用它们把结论
// 指回原文位置——偏移算错会让「来源片段」指到别的段落。
//
// 长度一律按码点算（`Array.from`），与 Python 的 `len(str)` 同口径：按 UTF-16 单元算
// 会让含 emoji 的文字稿在两侧切出不同的块边界。
import {createHash} from 'node:crypto';

export interface MarkdownChunk {
  /** 从 1 开始，跨整个文字稿递增。 */
  readonly id: number;
  /** 该块所属的最近一级标题文本；没有标题时是「内容摘要」。 */
  readonly summary: string;
  readonly content: string;
  readonly startByte: number;
  readonly endByte: number;
  readonly sha256: string;
}

const DEFAULT_MAX_LENGTH = 2000;
const DEFAULT_SUMMARY = '内容摘要';
const HEADING_PATTERN = /^(#{1,6})\s+(.+)$/;

export class MarkdownSplitter {
  private readonly maxLength: number;

  constructor(maxLength: number = DEFAULT_MAX_LENGTH) {
    this.maxLength = maxLength;
  }

  split(markdown: string): MarkdownChunk[] {
    if (markdown.length === 0 || this.maxLength <= 0) return [];
    const points = Array.from(markdown);

    const chunks: MarkdownChunk[] = [];
    let start = 0;
    let startByte = 0;
    while (start < points.length) {
      const end = this.findChunkEnd(points, start);
      const content = points.slice(start, end).join('');
      const contentBytes = Buffer.from(content, 'utf8');
      const endByte = startByte + contentBytes.length;
      chunks.push({
        id: chunks.length + 1,
        summary: headingAt(points, start),
        content,
        startByte,
        endByte,
        sha256: createHash('sha256').update(contentBytes).digest('hex'),
      });
      start = end;
      startByte = endByte;
    }
    return chunks;
  }

  private findChunkEnd(points: readonly string[], start: number): number {
    const hardEnd = Math.min(start + this.maxLength, points.length);
    if (hardEnd === points.length) return hardEnd;

    // 与 Python `rfind(sub, start, hard_end)` 同范围：整个匹配必须落在 [start, hard_end) 内，
    // 所以 `\n\n` 的起点最多是 hard_end - 2。
    const paragraphEnd = lastIndexOfSequence(points, ['\n', '\n'], hardEnd - 2, start);
    if (paragraphEnd >= start) return paragraphEnd + 2;

    for (let index = hardEnd - 1; index >= start; index -= 1) {
      if (points[index] === '。') return index + 1;
    }
    return hardEnd;
  }
}

function lastIndexOfSequence(
  points: readonly string[],
  sequence: readonly string[],
  from: number,
  minimum: number,
): number {
  for (let index = Math.min(from, points.length - sequence.length); index >= minimum; index -= 1) {
    if (sequence.every((value, offset) => points[index + offset] === value)) return index;
  }
  return -1;
}

/**
 * 起点之前最近的一级标题。
 *
 * 只看起点之前的文本（含起点那个字符）：起点落在标题行中间时，那个标题也算「当前」的，
 * 块摘要才不会是上一节的标题。
 */
function headingAt(points: readonly string[], start: number): string {
  const prefix = points.slice(0, start + 1).join('');
  let last: string | null = null;
  for (const line of prefix.split('\n')) {
    const match = HEADING_PATTERN.exec(line);
    if (match !== null) last = match[2].trim();
  }
  return last ?? DEFAULT_SUMMARY;
}

export function splitMarkdown(markdown: string, maxLength?: number): MarkdownChunk[] {
  return new MarkdownSplitter(maxLength).split(markdown);
}
