// 文字稿整理这一步：读正式稿 → 逐段整理 → 写两份独立产物。
//
// 对齐 `worker/worker_core/transcript_polish.py::run_transcript_polish_step` 与
// `worker_application/insight_retry.py` 的 `target=transcript` 分支。两个产物
// `transcript/polished.txt` 与 `transcript/polished.meta.json` 不在事务闭集里，
// Python 用 `atomic_write_text` 各写一次；这里同样逐个原子写，清单由管线另行提交。
// 原 `transcript/transcript.txt` 全程只读，字节不变。
import {lstat} from 'node:fs/promises';
import path from 'node:path';

import {
  POLISH_MAX_CHUNKS,
  chunkTranscript,
  createPolishLlm,
  polishTranscriptWithLlm,
  serializePolishMeta,
} from '../ai/index.ts';
import type {ChatFetch} from '../ai/chat.ts';
import type {Transport} from '../ai/config.ts';
import type {PolishLlmFactory} from '../ai/index.ts';
import {InsightGenerationError} from '../ai/index.ts';
import {atomicWriteBytes} from '../artifacts/atomic-file.ts';
import type {WorkerProgressEvent} from '../protocol/events.ts';
import {MAX_TRANSCRIPT_BYTES, readSourceFile} from '../tasks/source-text.ts';
import type {TaskPaths} from '../tasks/paths.ts';

const STAGE = 'insights_generating' as const;

/** 与 Python 的七条失败文案逐字一致；供应商异常正文不会进结果行。 */
const PATH_INVALID_MESSAGE = 'Official transcript.txt is required for transcript polishing.';
const NOT_FOUND_MESSAGE = 'Official transcript text could not be read.';
const EMPTY_TRANSCRIPT_MESSAGE = 'Official transcript text is empty.';
const EMPTY_RESULT_MESSAGE = 'Transcript polishing returned an empty result.';
const WRITE_FAILED_MESSAGE = 'Polished transcript could not be stored safely.';
const POLISH_FAILED_MESSAGE = 'Transcript polishing failed.';

export interface PolishStepError {
  readonly code: string;
  readonly message: string;
  readonly stage: typeof STAGE;
}

export interface PolishStepResult {
  readonly status: 'completed' | 'partial_completed';
  /** 成功与大多数失败都带原稿正文：清单的 `text_preview` 不能被清空。 */
  readonly text: string;
  readonly error: PolishStepError | null;
}

/** 测试注入：替换整段模型调用（Python `polish_runner`）。 */
export type PolishRunner = (options: {
  readonly body: string;
  readonly chunks: readonly string[];
  readonly environ: Readonly<Record<string, string | undefined>>;
  readonly onProgress?: (event: WorkerProgressEvent) => void;
  readonly llmFactory?: PolishLlmFactory;
  readonly fetchImpl?: ChatFetch;
  readonly transport?: Transport;
  readonly signal?: AbortSignal;
}) => Promise<string>;

export interface TranscriptPolishStepOptions {
  readonly paths: TaskPaths;
  readonly environ: Readonly<Record<string, string | undefined>>;
  readonly onProgress?: (event: WorkerProgressEvent) => void;
  readonly polishRunner?: PolishRunner;
  readonly llmFactory?: PolishLlmFactory;
  readonly fetchImpl?: ChatFetch;
  readonly transport?: Transport;
  readonly signal?: AbortSignal;
}

function failed(code: string, message: string, body: string = ''): PolishStepResult {
  return {status: 'partial_completed', text: body, error: {code, message, stage: STAGE}};
}

async function defaultPolishRunner(options: Parameters<PolishRunner>[0]): Promise<string> {
  const factory: PolishLlmFactory = options.llmFactory
    ?? ((environ) => createPolishLlm(environ, {
      ...(options.fetchImpl === undefined ? {} : {fetchImpl: options.fetchImpl}),
      ...(options.transport === undefined ? {} : {transport: options.transport}),
      ...(options.signal === undefined ? {} : {signal: options.signal}),
    }));
  const llm = await factory(options.environ);
  return polishTranscriptWithLlm({
    chunks: options.chunks,
    llm,
    ...(options.onProgress === undefined ? {} : {onProgress: options.onProgress}),
  });
}

/**
 * Python 会单独检查目标、其父目录与祖父目录是不是链接（含 Windows junction），
 * 链接一律判成路径非法而不是「读不到」。Node 把 junction 也报成 `isSymbolicLink()`，
 * 一条判断覆盖两种。
 */
async function hasLinkedOfficialPath(target: string): Promise<boolean> {
  const chain = [target, path.dirname(target), path.dirname(path.dirname(target))];
  for (const entry of chain) {
    let info;
    try {
      info = await lstat(entry);
    } catch {
      return false; // 读不到的情况交给后面的 readSourceFile 归到 NOT_FOUND。
    }
    if (info.isSymbolicLink()) return true;
  }
  return false;
}

export async function runTranscriptPolishStep(
  options: TranscriptPolishStepOptions,
): Promise<PolishStepResult> {
  const {paths} = options;
  const target = paths.transcriptTxtPath;
  const expected = path.join(paths.taskDir, 'transcript', 'transcript.txt');
  if (path.resolve(target) !== path.resolve(expected) || await hasLinkedOfficialPath(target)) {
    return failed('TRANSCRIPT_TEXT_PATH_INVALID', PATH_INVALID_MESSAGE);
  }

  let raw: string;
  try {
    const bytes = await readSourceFile(target, MAX_TRANSCRIPT_BYTES, paths.taskDir);
    raw = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    return failed('TRANSCRIPT_TEXT_NOT_FOUND', NOT_FOUND_MESSAGE);
  }

  const body = raw.trim();
  if (body.length === 0) return failed('POLISH_EMPTY_TRANSCRIPT', EMPTY_TRANSCRIPT_MESSAGE);

  const chunks = chunkTranscript(body);
  if (chunks.length > POLISH_MAX_CHUNKS) {
    return failed(
      'POLISH_TRANSCRIPT_TOO_LONG',
      `Transcript needs more than ${POLISH_MAX_CHUNKS} polish chunks.`,
      body,
    );
  }

  let polished: string;
  try {
    polished = await (options.polishRunner ?? defaultPolishRunner)({
      body,
      chunks,
      environ: options.environ,
      ...(options.onProgress === undefined ? {} : {onProgress: options.onProgress}),
      ...(options.llmFactory === undefined ? {} : {llmFactory: options.llmFactory}),
      ...(options.fetchImpl === undefined ? {} : {fetchImpl: options.fetchImpl}),
      ...(options.transport === undefined ? {} : {transport: options.transport}),
      ...(options.signal === undefined ? {} : {signal: options.signal}),
    });
  } catch (error) {
    // Python 用 str(exc)；供应商异常可能回显密钥或路径，这里只保留稳定文案，
    // 具体错误码仍由上层按 `POLISH_FAILED` 归类。
    const message = error instanceof InsightGenerationError ? error.message : POLISH_FAILED_MESSAGE;
    return failed('POLISH_FAILED', message, body);
  }

  const polishedText = (polished ?? '').trim();
  if (polishedText.length === 0) return failed('POLISH_LLM_EMPTY_RESULT', EMPTY_RESULT_MESSAGE, body);

  try {
    // 顺序与 Python 一致：先正文，再元数据。第二个写失败时正文可能已经更新，
    // 但清单尚未提交，界面仍以清单为准。
    await atomicWriteBytes(paths.transcriptPolishedTxtPath, Buffer.from(`${polishedText}\n`, 'utf8'));
    await atomicWriteBytes(paths.transcriptPolishedMetaPath, Buffer.from(serializePolishMeta(body), 'utf8'));
  } catch {
    return failed('POLISH_ARTIFACT_WRITE_FAILED', WRITE_FAILED_MESSAGE, body);
  }

  return {status: 'completed', text: body, error: null};
}
