// 权威源文本的读取。
//
// 对齐 `worker/worker_core/source_text.py` 的 `read_source_text`：先读清单确认
// 「哪份文件才是权威源」，再由底层 `readSourceFile` 按严格规则读它。
import path from 'node:path';

import {loadTaskManifest} from './load.ts';
import type {TaskStore} from './index.ts';
import {readSourceFile, SourceTextUnavailableError} from './source-file.ts';

export {readSourceFile, SourceTextUnavailableError};
export const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
export const MAX_ARTICLE_BYTES = 2 * 1024 * 1024;
export const MAX_ARTICLE_MARKDOWN_BYTES = 4 * 1024 * 1024;

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    throw new SourceTextUnavailableError();
  }
}

export interface TaskSourceText {
  readonly kind: 'transcript' | 'article';
  readonly artifactKey: 'transcript_txt' | 'article_txt';
  /** 绝对路径；调用方只读，不要写。 */
  readonly path: string;
  /** 解码后的原文（未裁剪）；生成前由管线自己 `trim()`。 */
  readonly text: string;
  readonly bytes: Uint8Array;
}

/**
 * 读任务的权威源文本。
 *
 * 清单必须声明权威产物键并指向固定路径——这一条把「清单说哪份算数」和「实际读哪份」
 * 绑在一起，缺了它就可能生成基于旧稿的摘要。网页任务读 `article/article.txt`
 * （上限 2 MiB），媒体任务读 `transcript/transcript.txt`（上限 32 MiB）。
 */
export async function readTaskSourceText(
  store: TaskStore,
  taskId: string,
): Promise<TaskSourceText> {
  const manifest = await loadTaskManifest(store, taskId);
  const artifacts = manifest.artifacts as Record<string, unknown>;
  const article = manifest.source_kind === 'web_page';
  if (article) {
    if (artifacts.article_txt !== 'article/article.txt') throw new SourceTextUnavailableError();
    const taskDir = path.join(store.outputRoot, 'tasks', taskId);
    const target = path.join(taskDir, 'article', 'article.txt');
    const bytes = await readSourceFile(target, MAX_ARTICLE_BYTES, taskDir);
    const text = decodeUtf8(bytes);
    if (text.trim().length === 0) throw new SourceTextUnavailableError();
    return {kind: 'article', artifactKey: 'article_txt', path: target, text, bytes};
  }
  if (artifacts.transcript_txt !== 'transcript/transcript.txt') throw new SourceTextUnavailableError();

  const taskDir = path.join(store.outputRoot, 'tasks', taskId);
  const target = path.join(taskDir, 'transcript', 'transcript.txt');
  const bytes = await readSourceFile(target, MAX_TRANSCRIPT_BYTES, taskDir);
  const text = decodeUtf8(bytes);
  if (text.trim().length === 0) throw new SourceTextUnavailableError();
  return {kind: 'transcript', artifactKey: 'transcript_txt', path: target, text, bytes};
}
