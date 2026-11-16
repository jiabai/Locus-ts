// 任务目录布局的唯一事实来源。
//
// 对齐 `worker/worker_core/task_store.py` 的 `TaskPaths`：写出的路径会进 `task.json` 的
// `artifacts` 与宿主返回值，Rust 侧按同一套相对路径找文件，所以这里一个字符都不能改。
// 注意 `outputRoot`（用户数据，长期保留）与 `cacheRoot`（可清理的中间产物）是两棵树：
// 源文件副本落在 cache，换机器或清缓存不会影响已完成任务的产物。
import path from 'node:path';

import {CACHE_DIR_ENV, OUTPUT_DIR_ENV, VIDEO_EXTENSIONS} from '../protocol/contract.ts';
import type {TaskStore} from './types.ts';

export interface TaskPaths {
  readonly outputRoot: string;
  readonly cacheRoot: string;
  readonly taskId: string;
  readonly taskDir: string;
  readonly cacheTaskDir: string;
  readonly downloadDir: string;
  readonly mediaDir: string;
  readonly transcriptDir: string;
  readonly aiDir: string;
  readonly manifestPath: string;
  readonly audioPath: string;
  readonly transcriptTxtPath: string;
  readonly transcriptMdPath: string;
  /** 网页任务的权威正文与保存用 Markdown；媒体任务不触碰这两个路径。 */
  readonly articleTxtPath: string;
  readonly articleMdPath: string;
  /** 整理稿不进 `artifacts` 闭集：Python 用两次独立原子写，清单里没有对应键。 */
  readonly transcriptPolishedTxtPath: string;
  readonly transcriptPolishedMetaPath: string;
  readonly segmentsPath: string;
  readonly summaryPath: string;
  readonly mindmapPath: string;
  readonly insightsPath: string;
  readonly insightsMdPath: string;
  readonly preferenceSnapshotPath: string;
  readonly dissectionJsonPath: string;
  readonly dissectionMarkdownPath: string;
  readonly draftPath: string;
  /** 视频产物按来源扩展名命名，与用户看到的文件名一致。 */
  videoPathForExtension(extension: string): string;
}

export function createTaskPaths(options: {
  readonly outputRoot: string;
  readonly cacheRoot: string;
  readonly taskId: string;
}): TaskPaths {
  const {outputRoot, cacheRoot, taskId} = options;
  const taskDir = path.join(outputRoot, 'tasks', taskId);
  const cacheTaskDir = path.join(cacheRoot, 'tasks', taskId);
  const mediaDir = path.join(taskDir, 'media');
  const transcriptDir = path.join(taskDir, 'transcript');
  const aiDir = path.join(taskDir, 'ai');

  return {
    outputRoot,
    cacheRoot,
    taskId,
    taskDir,
    cacheTaskDir,
    downloadDir: path.join(cacheTaskDir, 'download'),
    mediaDir,
    transcriptDir,
    aiDir,
    manifestPath: path.join(taskDir, 'task.json'),
    audioPath: path.join(mediaDir, 'audio.wav'),
    transcriptTxtPath: path.join(transcriptDir, 'transcript.txt'),
    transcriptMdPath: path.join(transcriptDir, 'transcript.md'),
    articleTxtPath: path.join(taskDir, 'article', 'article.txt'),
    articleMdPath: path.join(taskDir, 'article', 'article.md'),
    transcriptPolishedTxtPath: path.join(transcriptDir, 'polished.txt'),
    transcriptPolishedMetaPath: path.join(transcriptDir, 'polished.meta.json'),
    segmentsPath: path.join(transcriptDir, 'segments.json'),
    summaryPath: path.join(aiDir, 'summary.md'),
    mindmapPath: path.join(aiDir, 'mindmap.mmd'),
    insightsPath: path.join(aiDir, 'insights.json'),
    insightsMdPath: path.join(aiDir, 'insights.md'),
    preferenceSnapshotPath: path.join(aiDir, 'preference-snapshot.json'),
    dissectionJsonPath: path.join(aiDir, 'dissection.json'),
    dissectionMarkdownPath: path.join(aiDir, 'dissection.md'),
    draftPath: path.join(aiDir, 'draft.md'),
    videoPathForExtension(extension: string): string {
      if (!VIDEO_EXTENSIONS.has(extension)) {
        // 与 Python 一致：不支持的扩展名在这里就拒绝，而不是写出一份没人认得的文件。
        throw new Error('Task video extension is unsupported.');
      }
      return path.join(mediaDir, `video.${extension}`);
    },
  };
}

/** 清单与返回值里的路径都是 POSIX 相对路径；Windows 上必须显式转换。 */
export function toPosixPath(target: string): string {
  return target.replaceAll('\\', '/');
}

export function relativePosixPath(root: string, target: string): string {
  return toPosixPath(path.relative(root, target));
}

/**
 * 解析任务存储的两棵树：环境变量给的相对路径按项目目录展开，空值回落到默认目录名。
 *
 * 与 Python 的 `resolve_output_dir` / `resolve_cache_dir` 同一套规则；两条管线共用这里，
 * 免得「本地任务写在 A、重新生成读的是 B」。
 */
export function resolveTaskStore(
  projectRoot: string,
  environ: Readonly<Record<string, string | undefined>>,
): TaskStore {
  const resolve = (configured: string | undefined, fallbackName: string): string => {
    const value = configured?.trim() ?? '';
    if (value === '') return path.join(projectRoot, fallbackName);
    return path.isAbsolute(value) ? value : path.join(projectRoot, value);
  };
  return {
    outputRoot: resolve(environ[OUTPUT_DIR_ENV], 'outputs'),
    cacheRoot: resolve(environ[CACHE_DIR_ENV], 'cache'),
  };
}
