// 文字稿产物：`transcript.txt` / `transcript.md` / `segments.json`。
//
// 对齐 `worker/worker_core/asr_runtime/artifacts.py`：文件名、Markdown 结构、平台换行
// 与「没有分段就删掉旧 segments.json」都保持一致，否则同一任务在两侧会得到不同的文件。
// 当目标就是任务目录下的 `transcript/` 时，改走多文件事务，让三份产物与清单同生共死；
// 其他输出目录（导出、诊断）逐文件原子写。
import path from 'node:path';

import {ASREmptyTranscriptError} from '../asr/errors.ts';
import {
  AtomicFileCommitError,
  atomicRemoveFile,
  atomicWriteBytes,
  platformTextBytes,
} from './atomic-file.ts';
import {commitTaskArtifacts} from './task-transaction.ts';

export interface TranscriptSegmentArtifact {
  readonly id: string;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly text: string;
  readonly speaker?: string;
}

export interface TranscriptMetadata {
  /** `asr` 走本地识别，`subtitle` 用平台字幕；决定 Markdown 里写哪几行。 */
  readonly source: 'asr' | 'subtitle';
  readonly language: string | null;
  readonly engine: string | null;
  /** 已经规范化过的来源地址；规范化由来源标识模块负责，这里只负责落盘。 */
  readonly canonicalSourceUrl?: string | null;
}

export interface TranscriptArtifacts {
  /** 去掉首尾空白后的正文，与写进文件的内容一致。 */
  readonly text: string;
  readonly txtPath: string;
  readonly mdPath: string;
  /** 没有分段时为 null，且对应的旧文件会被删掉。 */
  readonly segmentsPath: string | null;
}

export interface WriteTranscriptOptions {
  readonly text: string;
  readonly outputDir: string;
  /** 空字符串表示任务的标准 `transcript/` 目录，此时文件名不带前缀。 */
  readonly outputStem: string;
  readonly metadata?: TranscriptMetadata;
  readonly segments?: readonly TranscriptSegmentArtifact[];
}

export async function writeTranscriptFiles(
  options: WriteTranscriptOptions,
): Promise<TranscriptArtifacts> {
  const text = options.text.trim();
  if (text.length === 0) {
    throw new ASREmptyTranscriptError('ASR returned an empty transcript.');
  }

  const metadata = options.metadata
    ?? {source: 'asr' as const, language: null, engine: null, canonicalSourceUrl: null};
  const segments = options.segments ?? [];
  const stem = options.outputStem;
  const txtPath = path.join(options.outputDir, stem === '' ? 'transcript.txt' : `${stem}_transcript.txt`);
  const mdPath = path.join(options.outputDir, stem === '' ? 'transcript.md' : `${stem}_transcript.md`);
  const segmentsPath = path.join(
    options.outputDir,
    stem === '' ? 'segments.json' : `${stem}_transcript_segments.json`,
  );

  const txtBytes = platformTextBytes(`${text}\n`);
  const markdownBytes = platformTextBytes(formatTranscriptMarkdown(text, metadata));
  const segmentsBytes = segments.length === 0
    ? null
    : platformTextBytes(`${JSON.stringify({segments}, null, 2)}\n`);

  if (stem === '' && path.basename(options.outputDir) === 'transcript') {
    try {
      await commitTaskArtifacts(path.dirname(options.outputDir), {
        'transcript/transcript.txt': txtBytes,
        'transcript/transcript.md': markdownBytes,
        'transcript/segments.json': segmentsBytes,
      });
    } catch {
      // 事务层的两种错误都收敛成「产物没能安全落盘」，不把内部路径抛给上层。
      throw new AtomicFileCommitError();
    }
    return {
      text,
      txtPath,
      mdPath,
      segmentsPath: segmentsBytes === null ? null : segmentsPath,
    };
  }

  await atomicWriteBytes(txtPath, txtBytes);
  await atomicWriteBytes(mdPath, markdownBytes);
  if (segmentsBytes === null) {
    await atomicRemoveFile(segmentsPath);
  } else {
    await atomicWriteBytes(segmentsPath, segmentsBytes);
  }

  return {
    text,
    txtPath,
    mdPath,
    segmentsPath: segmentsBytes === null ? null : segmentsPath,
  };
}

export function formatTranscriptMarkdown(text: string, metadata: TranscriptMetadata): string {
  const sourceLines: string[] = [];
  if (metadata.source === 'subtitle') {
    sourceLines.push('- Transcript Source: Platform subtitle');
    if (metadata.language) sourceLines.push(`- Subtitle Language: ${metadata.language}`);
  } else {
    sourceLines.push('- Transcript Source: Local ASR');
    if (metadata.engine) {
      sourceLines.push(`- ASR Engine: ${metadata.engine}`);
      sourceLines.push(`- Model: ${metadata.engine}`);
    }
  }
  if (metadata.canonicalSourceUrl) {
    sourceLines.push(`- Source URL: ${metadata.canonicalSourceUrl}`);
  }

  return [
    '# 视频文字稿',
    '',
    '## Metadata',
    '',
    sourceLines.join('\n'),
    '',
    '## Transcript',
    '',
    text,
    '',
  ].join('\n');
}
