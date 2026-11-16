// 任务级公共类型：阶段、错误、结果与本地来源。
//
// 字段形状对齐 `worker/worker_core/models.py` 与 `worker/worker_core/task_store.py`：
// stdout 的终态结果与 `task.json` 清单都由这些字段拼出，宿主按同一套键读取。
// 名字改成 camelCase 只影响进程内调用，序列化时一律还原成契约里的 snake_case。

import type {NoteTitleMetadata} from './note-title-metadata.ts';
import type {WebPageSource} from '../web/web-page-contract.ts';
import type {SourceIdentity} from '../sources/source-identity.ts';

export const JOB_STAGES = [
  'waiting_input',
  'video_extracting',
  'video_transcribing',
  'web_loading',
  'web_extracting',
  'web_saving',
  'insights_generating',
  'title_generating',
  'draft_generating',
  'completed',
  'partial_completed',
  'failed',
] as const;

export type JobStage = (typeof JOB_STAGES)[number];

/** 媒体任务的阶段只有这几个：本地文件不经网页与 AI 生成阶段。 */
export type MediaJobStage = 'waiting_input' | 'video_extracting' | 'video_transcribing' | 'completed' | 'failed';

export interface WorkerError {
  readonly code: string;
  readonly message: string;
  readonly stage: JobStage;
}

export interface TranscriptMetadata {
  /** `asr` 走本地识别，`subtitle` 用平台字幕。 */
  readonly source: 'asr' | 'subtitle';
  readonly language: string | null;
  readonly engine: string | null;
}

export interface ProcessResult {
  readonly status: JobStage;
  readonly taskId: string | null;
  readonly taskDir: string | null;
  readonly artifacts: Readonly<Record<string, string>>;
  readonly text: string;
  readonly summary: string;
  readonly insights: readonly unknown[];
  readonly transcript: TranscriptMetadata | null;
  readonly dissection: Record<string, unknown> | null;
  readonly error: WorkerError | null;
  readonly draft: string;
  /**
   * 标题元数据：只有标题生成路径会带。Python 的 `ProcessResult.note_title` 默认 None
   * （表示「沿用旧清单」），所以这里 undefined / null 都按「不输出、清单沿用」处理。
   */
  readonly noteTitle?: NoteTitleMetadata | null;
  /** 只有「新建任务」的路径会带；重算路径不写这个键。 */
  readonly taskCreated?: boolean;
  /** 网页任务的结果附带来源与保存用 Markdown；媒体任务两者都缺省。 */
  readonly source?: WebPageSource | null;
  readonly markdown?: string;
}

/** 新建失败结果时用得最多的形状：其余字段取 Python 的默认值。 */
export function failedResult(error: WorkerError): ProcessResult {
  return {
    status: 'failed',
    taskId: null,
    taskDir: null,
    artifacts: {},
    text: '',
    summary: '',
    insights: [],
    transcript: null,
    dissection: null,
    error,
    draft: '',
  };
}

/** 契约 `terminalResults.schemas.task` 的键集合；`task_created`/`source` 等按需附加。 */
export function resultToPayload(result: ProcessResult): Record<string, unknown> {
  return {
    status: result.status,
    task_id: result.taskId,
    task_dir: result.taskDir,
    artifacts: result.artifacts,
    text: result.text,
    summary: result.summary,
    insights: result.insights,
    transcript: result.transcript === null
      ? null
      : {
        source: result.transcript.source,
        language: result.transcript.language,
        engine: result.transcript.engine,
      },
    dissection: result.dissection,
    error: result.error === null
      ? null
      : {code: result.error.code, message: result.error.message, stage: result.error.stage},
    draft: result.draft,
    ...(result.noteTitle === undefined || result.noteTitle === null
      ? {}
      : {note_title: {...result.noteTitle}}),
    ...(result.taskCreated === true ? {task_created: true} : {}),
    ...(result.source == null
      ? {}
      : {
        source: {
          kind: 'web_page',
          url: result.source.url,
          title: result.source.title,
          extractedAt: result.source.extractedAt,
        },
        markdown: result.markdown ?? '',
      }),
  };
}

export interface LocalFileTaskSource {
  readonly kind: 'local_file';
  /** 用户可见的原始文件名，只允许安全 basename。 */
  readonly displayName: string;
  readonly mediaKind: 'video' | 'audio';
  readonly extension: string;
}

/**
 * URL 任务来源。清单里**不写 `source_kind`**（Python `_manifest_source_fields` 的 URL 分支
 * 只写 `source_url` / `source_identity` / `platform`），读回时缺失与显式 `"url"` 都按它处理。
 */
export interface UrlTaskSource {
  readonly kind: 'url';
  readonly identity: SourceIdentity;
}

export type TaskSource = LocalFileTaskSource | WebPageSource | UrlTaskSource;

/** 任务存储的两棵树：产物（长期保留）与缓存（可清理）。 */
export interface TaskStore {
  readonly outputRoot: string;
  readonly cacheRoot: string;
}

/**
 * 洞察条目。
 *
 * 字段名用 camelCase 只因为进程内传递；落盘与 stdout 的形状由
 * `contracts/desktop-worker-contract.json` 的 `insightResult.itemKeys` 决定。
 */
export interface Insight {
  readonly id: number;
  readonly topic: string;
  readonly matchReason: string;
  readonly followUpQuestions: readonly string[];
  readonly suitableUse: string;
  readonly sourceChunkId: number | null;
}

export interface TaskContext {
  readonly taskId: string;
  readonly createdAt: string;
  /** 网页任务没有模型（不经 ASR）；本地与 URL 媒体任务是 ASR 模型 id。 */
  readonly model: string | null;
  readonly source: TaskSource;
}
