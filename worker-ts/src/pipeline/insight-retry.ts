// 重新生成洞察：六个 target 已全部实现。
//
// 对齐 `worker/worker_core/worker_application/insight_retry.py`：
// 打开任务 → 读权威源文本 → 生成产物 → 与已有产物合并 → 一次事务提交产物与清单。
// 每一步的失败码与阶段都按 Python，宿主只需要一套映射。
// 标题分支是例外：它自己读稿、自己维护 `note_title` 状态、不重写整份清单。
// 整理稿分支也是例外：两份产物不在事务闭集里，逐个原子写，清单另走 `finalize`。
// 草稿分支只读 `ai/` 下的种子、快照与摘要，在读取权威源文本之前就派发。
// 网页任务（`source_kind=web_page`）共用同一条管线：摘要 / 洞察 / 解剖 / 草稿
// 以 `article/article.txt` 为权威源、提示词按 `source_kind=article` 生成，
// 而 title / transcript 两个 target 直接拒绝（`WEB_PAGE_RETRY_TARGET_INVALID`）。
//
// 与 Python 的已知差异只剩 `validateInsightsDelivery` 用 `toLowerCase()` 近似 `casefold()`。
import {readFile} from 'node:fs/promises';

import {
  createInsightLlm,
  buildDissectionArtifacts,
  dissectionToDict,
  generateDissection,
  generateInsights,
  generateNoteTitle,
  generateSummary,
  parsePersistedDissection,
  serializePreferenceSnapshot,
  writeInsightFiles,
  writeSummaryFiles,
  DISSECTION_JSON_DESTINATION,
  DISSECTION_MARKDOWN_DESTINATION,
  DissectionGenerationError,
  InsightGenerationError,
  TitleOutputInvalidError,
} from '../ai/index.ts';
import type {OutputLanguage} from '../ai/output-language.ts';
import type {ChatFetch} from '../ai/chat.ts';
import type {Transport} from '../ai/config.ts';
import type {NoteTitleLlm, PolishLlmFactory} from '../ai/index.ts';
import type {SummaryAgentRuntime} from '../ai/summary-agent.ts';
import {LLM_CHECKOUT_REQUEST_ID_ENV} from '../ai/config.ts';
import type {PolishRunner} from './transcript-polish-step.ts';
import {runTranscriptPolishStep} from './transcript-polish-step.ts';
import type {DraftRunner, McpSessionFactory} from './draft-step.ts';
import {runDraftStep} from './draft-step.ts';
import type {DraftLlmFactory} from '../ai/draft-agent.ts';
import {AtomicFileCommitError, atomicWriteBytes} from '../artifacts/atomic-file.ts';
import {
  TaskArtifactCommitError,
  TaskArtifactRecoveryError,
  recoverTaskArtifacts,
} from '../artifacts/task-transaction.ts';
import {buildWorkerProgressEvent} from '../protocol/events.ts';
import type {WorkerProgressEvent} from '../protocol/events.ts';
import {
  InvalidRetryRequestError,
  INVALID_RETRY_PAYLOAD_CODE,
  parseRetryInsightsRequest,
} from '../protocol/retry-request.ts';
import type {RetryInsightsRequest} from '../protocol/retry-request.ts';
import {ensureTaskDirs, finalizeTask, finalizeTaskWithPayloads, resultWithTask} from '../tasks/index.ts';
import type {SerializeManifestOptions, TaskStore} from '../tasks/index.ts';
import {
  loadTaskManifest,
  taskContextFromLoadedManifest,
  TaskManifestUnavailableError,
  transcriptMetadataFromManifest,
} from '../tasks/load.ts';
import {
  readExistingInsights,
  readExistingSummary,
} from '../tasks/existing-artifacts.ts';
import {resolveTaskStore} from '../tasks/paths.ts';
import type {TaskPaths} from '../tasks/paths.ts';
import {
  noteTitleFromManifest,
  readNoteTitleTranscript,
  saveNoteTitle,
} from '../tasks/note-title-store.ts';
import type {NoteTitleMetadata} from '../tasks/note-title-metadata.ts';
import {
  MAX_ARTICLE_BYTES,
  MAX_TRANSCRIPT_BYTES,
  readSourceFile,
  readTaskSourceText,
  SourceTextUnavailableError,
} from '../tasks/source-text.ts';
import {failedResult} from '../tasks/types.ts';
import type {
  Insight,
  ProcessResult,
  TaskContext,
  TranscriptMetadata,
} from '../tasks/types.ts';

const STAGE = 'insights_generating' as const;
const INVALID_RETRY_JSON_MESSAGE = 'Retry payload must be valid JSON.';
const TASK_MANIFEST_NOT_FOUND_MESSAGE = 'A safe task manifest is required to regenerate insights.';
const SOURCE_TEXT_INVALID_MESSAGE = 'Authoritative source text is unavailable.';
const ARTIFACT_COMMIT_FAILED_MESSAGE = 'Task artifacts could not be stored safely.';
const ARTIFACT_RECOVERY_FAILED_MESSAGE = 'Task artifacts could not be recovered safely.';
/** 标题分支的失败文案与阶段固定，Python `note_title.py::_result` 用的就是这一句。 */
const TITLE_FAILURE_MESSAGE = 'The note title could not be generated or saved.';
const TITLE_STAGE = 'title_generating' as const;

/** 摘要与导图在任务目录下的相对路径；闭集见 `contracts/task-artifact-transaction-v1.json`。 */
const SUMMARY_DESTINATION = 'ai/summary.md';
const MINDMAP_DESTINATION = 'ai/mindmap.mmd';
const INSIGHTS_JSON_DESTINATION = 'ai/insights.json';
const INSIGHTS_MD_DESTINATION = 'ai/insights.md';

export interface InsightRetryOptions {
  readonly projectRoot: string;
  readonly environ?: Readonly<Record<string, string | undefined>>;
  /** 测试注入：替换输出/缓存根目录，省掉环境变量。 */
  readonly store?: TaskStore;
  /** 测试注入：替换真实 LLM 工厂（BYOK 或托管），用于摘要、洞察与解剖。 */
  readonly llmFactory?: (environ: Readonly<Record<string, string | undefined>>) => Promise<SummaryAgentRuntime>;
  /** 测试注入：标题分支只需一次文本补全，单独注入以免把工具循环强加给它。 */
  readonly titleLlmFactory?: (environ: Readonly<Record<string, string | undefined>>) => Promise<NoteTitleLlm>;
  /** 测试注入：整理稿分支整段替换（Python `polish_runner`）。 */
  readonly polishRunner?: PolishRunner;
  /** 测试注入：只替换整理稿的模型层，保留切块 / 进度 / 空段回退逻辑。 */
  readonly polishLlmFactory?: PolishLlmFactory;
  /** 测试注入：整段替换成稿运行器（Python `draft_runner`）。 */
  readonly draftRunner?: DraftRunner;
  /** 测试注入：只替换成稿的模型层，保留工具装配与提示词。 */
  readonly draftLlmFactory?: DraftLlmFactory;
  /** 测试注入：替换真实检索 MCP 会话。 */
  readonly mcpSessionFactory?: McpSessionFactory;
  /** 测试注入：替换随包分发的技能目录。 */
  readonly skillsRoot?: string;
  /** 测试注入：替换模型 HTTP 传输（整理稿与其它 target 共用）。 */
  readonly fetchImpl?: ChatFetch;
  /** 测试注入：替换托管 checkout 的传输。 */
  readonly transport?: Transport;
  /** stderr 进度通道：标题与整理稿都会发事件，其余 target 暂不发。 */
  readonly onProgress?: (event: WorkerProgressEvent) => void;
  readonly signal?: AbortSignal;
}

/** 失败的重新生成：状态是 `partial_completed`，任务本身仍然有效。 */
function failedInsightRetry(
  code: string,
  message: string,
  extra: Partial<ProcessResult> = {},
): ProcessResult {
  return {
    status: 'partial_completed',
    taskId: null,
    taskDir: null,
    artifacts: {},
    text: '',
    summary: '',
    insights: [],
    transcript: null,
    dissection: null,
    error: {code, message, stage: STAGE},
    draft: '',
    ...extra,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 权威源文本的种类：网页任务按 `article` 走提示词与产物变体，其余按 `transcript`。 */
function sourceKindOfContext(context: TaskContext): 'transcript' | 'article' {
  return context.source.kind === 'web_page' ? 'article' : 'transcript';
}

/**
 * 读回已有解剖报告。
 *
 * 与 Python `read_existing_dissection` 一样，用磁盘上的当前权威源文本重算来源摘要，
 * 再逐字段比对整份报告：原稿被改过、字段被篡改或结构不合规都当作「没有可用报告」。
 * 它只影响 stdout 里的 `dissection` 字段，不影响文件与清单。网页任务读
 * `article/article.txt`（上限 2 MiB）并把 `source_kind=article` 传给解析器——
 * article 变体（schemaVersion 2、`sourceTextSha256`）与文字稿变体互不认账。
 */
async function readExistingDissection(
  paths: TaskPaths,
  sourceKind: 'transcript' | 'article',
): Promise<Record<string, unknown> | null> {
  try {
    const bytes = await readFile(paths.dissectionJsonPath);
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
    const article = sourceKind === 'article';
    const sourceBytes = await readSourceFile(
      article ? paths.articleTxtPath : paths.transcriptTxtPath,
      article ? MAX_ARTICLE_BYTES : MAX_TRANSCRIPT_BYTES,
      paths.taskDir,
    );
    const transcript = new TextDecoder('utf-8', {fatal: true}).decode(sourceBytes);
    return parsePersistedDissection({payload: parsed, transcript, sourceKind});
  } catch {
    return null;
  }
}

/** 只重算了一部分产物：其余部分从磁盘读回，避免结果行把别的产物报成「没了」。 */
async function mergeExistingAiArtifacts(
  paths: TaskPaths,
  sourceKind: 'transcript' | 'article',
  result: ProcessResult,
): Promise<ProcessResult> {
  return {
    ...result,
    summary: result.summary.length > 0 ? result.summary : await readExistingSummary(paths),
    insights: result.insights.length > 0 ? result.insights : await readExistingInsights(paths),
    dissection: result.dissection ?? await readExistingDissection(paths, sourceKind),
  };
}

/**
 * 任务已经打开之后的失败也要留痕：Python 会把 `partial_completed` 写进清单，
 * 让界面上的失败卡片与任务历史读同一个文件。只有「连任务都没打开」才不带任务标识。
 */
async function finalizeFailure(
  paths: TaskPaths,
  context: TaskContext,
  code: string,
  message: string,
  transcript: TranscriptMetadata | null,
): Promise<ProcessResult> {
  try {
    return await finalizeTask(paths, context, failedInsightRetry(code, message, {transcript}));
  } catch (error) {
    if (error instanceof TaskArtifactRecoveryError) {
      return failedInsightRetry('TASK_ARTIFACT_RECOVERY_FAILED', ARTIFACT_RECOVERY_FAILED_MESSAGE);
    }
    if (error instanceof TaskArtifactCommitError || error instanceof AtomicFileCommitError) {
      return failedInsightRetry('TASK_ARTIFACT_COMMIT_FAILED', ARTIFACT_COMMIT_FAILED_MESSAGE);
    }
    throw error;
  }
}

/** 托管 checkout 的 request_id 带上 target 后缀，服务端据此计量（Python `insight_target_env`）。 */
function insightTargetEnv(
  environ: Readonly<Record<string, string | undefined>>,
  target: string,
): Readonly<Record<string, string | undefined>> {
  const copy = {...environ};
  const seed = (copy[LLM_CHECKOUT_REQUEST_ID_ENV] ?? '').trim();
  if (seed !== '') copy[LLM_CHECKOUT_REQUEST_ID_ENV] = `${seed.slice(0, 140)}-${target}`;
  return copy;
}

/**
 * 在生成之前把偏好快照落盘。
 *
 * Python 的 `save_preference_snapshot` 先恢复残留事务再原子写：这一步失败会消耗不了额度，
 * 所以必须发生在任何模型调用之前，且失败码与「产物存不下」共用一套。
 */
async function savePreferenceSnapshot(
  paths: TaskPaths,
  snapshot: NonNullable<RetryInsightsRequest['preferenceSnapshot']>,
): Promise<void> {
  await recoverTaskArtifacts(paths.taskDir);
  await atomicWriteBytes(
    paths.preferenceSnapshotPath,
    Buffer.from(serializePreferenceSnapshot(snapshot), 'utf8'),
  );
}

/**
 * 提交合并后的结果：有事务产物就和产品清单一起提交，否则只写清单。
 *
 * 摘要 / 洞察走前者，整理稿走后者（它的两份文件不在事务闭集里，已逐个原子写）。
 * 失败码与文案在两条路径上完全一致——宿主不关心产物是怎么落盘的。
 */
async function finalizeMergedResult(
  paths: TaskPaths,
  context: TaskContext,
  merged: ProcessResult,
  optionsForManifest: Omit<SerializeManifestOptions, 'prior'>,
  payloads: Readonly<Record<string, Uint8Array | null>> | null,
): Promise<ProcessResult> {
  try {
    if (payloads !== null && Object.keys(payloads).length > 0) {
      return await finalizeTaskWithPayloads(paths, context, merged, payloads, optionsForManifest);
    }
    return await finalizeTask(paths, context, merged, optionsForManifest);
  } catch (error) {
    if (error instanceof TaskArtifactRecoveryError) {
      return failedInsightRetry('TASK_ARTIFACT_RECOVERY_FAILED', ARTIFACT_RECOVERY_FAILED_MESSAGE, {
        text: merged.text,
        transcript: merged.transcript,
      });
    }
    if (error instanceof TaskArtifactCommitError || error instanceof AtomicFileCommitError) {
      return failedInsightRetry('TASK_ARTIFACT_COMMIT_FAILED', ARTIFACT_COMMIT_FAILED_MESSAGE, {
        text: merged.text,
        transcript: merged.transcript,
      });
    }
    throw error;
  }
}

interface GeneratedTarget {
  readonly base: ProcessResult;
  readonly payloads: Record<string, Uint8Array>;
  /** 重新生成洞察会让旧的草稿种子失效（Python 显式写 null）；其余情况沿用旧清单。 */
  readonly clearDraftSeed: boolean;
}

async function runGeneration(
  request: RetryInsightsRequest,
  context: TaskContext,
  paths: TaskPaths,
  transcriptBody: string,
  /** 未裁剪的权威原文：解剖报告的 SHA-256 与切块都按它算，Python 传的也是原稿。 */
  officialTranscriptBody: string,
  transcript: TranscriptMetadata | null,
  options: InsightRetryOptions,
  environ: Readonly<Record<string, string | undefined>>,
): Promise<ProcessResult> {
  if (request.target === 'insights' && request.preferenceSnapshot !== undefined) {
    try {
      await savePreferenceSnapshot(paths, request.preferenceSnapshot);
    } catch (error) {
      if (error instanceof TaskArtifactRecoveryError) {
        return failedInsightRetry('TASK_ARTIFACT_RECOVERY_FAILED', ARTIFACT_RECOVERY_FAILED_MESSAGE, {transcript});
      }
      if (error instanceof TaskArtifactCommitError || error instanceof AtomicFileCommitError) {
        return failedInsightRetry('TASK_ARTIFACT_COMMIT_FAILED', ARTIFACT_COMMIT_FAILED_MESSAGE, {transcript});
      }
      throw error;
    }
  }

  let generated: GeneratedTarget | null = null;
  let generationError: {readonly code: string; readonly message: string} | null = null;
  const sourceKind = sourceKindOfContext(context);
  try {
    const llm = await (options.llmFactory ?? ((env) => createInsightLlm(env, {
      ...(options.signal === undefined ? {} : {signal: options.signal}),
    })))(insightTargetEnv(environ, request.target));

    const payloads: Record<string, Uint8Array> = {};
    let summary = '';
    let insights: readonly Insight[] = [];
    let dissection: Record<string, unknown> | null = null;
    if (request.target === 'summary') {
      const delivery = await generateSummary({
        markdown: transcriptBody,
        outputLanguage: request.outputLanguage,
        llm,
        sourceKind,
      });
      const artifacts = await writeSummaryFiles({
        summary: delivery.summary,
        mindmap: delivery.mindmap,
        outputDir: paths.aiDir,
        outputStem: '',
        outputLanguage: request.outputLanguage,
        // 落盘交给下面的单一事务：先写文件再写清单，中间崩掉会留下「文件新、清单旧」。
        persist: false,
      });
      payloads[SUMMARY_DESTINATION] = artifacts.summaryBytes;
      payloads[MINDMAP_DESTINATION] = artifacts.mindmapBytes;
      summary = artifacts.summary;
    } else if (request.target === 'dissection') {
      const report = await generateDissection({
        transcript: officialTranscriptBody,
        outputLanguage: request.outputLanguage,
        sourceLanguage: transcript?.language ?? null,
        llm,
        sourceKind,
        ...(options.onProgress === undefined ? {} : {onProgress: options.onProgress}),
      });
      const artifacts = buildDissectionArtifacts(report, request.outputLanguage);
      payloads[DISSECTION_JSON_DESTINATION] = artifacts.jsonBytes;
      payloads[DISSECTION_MARKDOWN_DESTINATION] = artifacts.markdownBytes;
      dissection = dissectionToDict(report);
    } else {
      const delivered = await generateInsights({
        markdown: transcriptBody,
        outputLanguage: request.outputLanguage,
        llm,
        preferenceSnapshot: request.preferenceSnapshot ?? null,
        sourceKind,
      });
      const artifacts = await writeInsightFiles({
        insights: delivered,
        outputDir: paths.aiDir,
        outputStem: '',
        outputLanguage: request.outputLanguage,
        persist: false,
      });
      payloads[INSIGHTS_JSON_DESTINATION] = artifacts.jsonBytes;
      payloads[INSIGHTS_MD_DESTINATION] = artifacts.markdownBytes;
      insights = artifacts.insights;
    }

    generated = {
      base: {
        status: 'completed',
        taskId: null,
        taskDir: null,
        artifacts: {},
        text: transcriptBody,
        summary,
        insights,
        transcript,
        dissection,
        error: null,
        draft: '',
      },
      payloads,
      clearDraftSeed: request.target === 'insights',
    };
  } catch (error) {
    // 生成失败不抛出：任务本身仍然有效，失败要在结果行与清单里留痕。
    if (!(error instanceof InsightGenerationError)
      && !(error instanceof DissectionGenerationError)) throw error;
    generationError = {code: error.code, message: error.message};
  }

  const base: ProcessResult = generated?.base ?? {
    status: 'partial_completed',
    taskId: null,
    taskDir: null,
    artifacts: {},
    text: transcriptBody,
    summary: '',
    insights: [],
    transcript,
    dissection: null,
    error: generationError === null
      ? null
      : {code: generationError.code, message: generationError.message, stage: STAGE},
    draft: '',
  };
  const merged = await mergeExistingAiArtifacts(paths, sourceKindOfContext(context), base);
  const optionsForManifest = generated?.clearDraftSeed === true ? {draftSeedInsightId: null} : {};
  return finalizeMergedResult(
    paths,
    context,
    merged,
    optionsForManifest,
    generated?.payloads ?? null,
  );
}

/**
 * 整理文字稿：读官方稿 → 逐段整理 → 写 `polished.txt` / `polished.meta.json` → 提交清单。
 *
 * 对齐 Python 的 `run_transcript_polish_step` + `_finalize_retry_result`。它自己读稿，
 * 因此不能走 `readTaskSourceText`：那条路径的错误码属于「源文本不可用」，而这里
 * 「路径被链接 / 读不到 / 空稿 / 超长 / 空结果」各有独立码，界面要给不同文案。
 */
async function runTranscriptRetry(
  context: TaskContext,
  paths: TaskPaths,
  transcript: TranscriptMetadata | null,
  options: InsightRetryOptions,
  environ: Readonly<Record<string, string | undefined>>,
): Promise<ProcessResult> {
  const step = await runTranscriptPolishStep({
    paths,
    environ: insightTargetEnv(environ, 'transcript'),
    ...(options.onProgress === undefined ? {} : {onProgress: options.onProgress}),
    ...(options.polishRunner === undefined ? {} : {polishRunner: options.polishRunner}),
    ...(options.polishLlmFactory === undefined ? {} : {llmFactory: options.polishLlmFactory}),
    ...(options.fetchImpl === undefined ? {} : {fetchImpl: options.fetchImpl}),
    ...(options.transport === undefined ? {} : {transport: options.transport}),
    ...(options.signal === undefined ? {} : {signal: options.signal}),
  });
  const base: ProcessResult = {
    status: step.status,
    taskId: null,
    taskDir: null,
    artifacts: {},
    text: step.text,
    summary: '',
    insights: [],
    transcript,
    dissection: null,
    error: step.error,
    draft: '',
  };
  // 草稿种子沿用旧清单（Python 的 `DRAFT_SEED_UNSET`），只重算整理稿不该动它。
  return finalizeMergedResult(
    paths,
    context,
    await mergeExistingAiArtifacts(paths, sourceKindOfContext(context), base),
    {},
    null,
  );
}

/**
 * 草稿分支：种子校验、快照与摘要读回都在 `runDraftStep` 里完成，这里只负责
 * 把 `draft_seed_insight_id` 写进清单，并把 `ai/draft.md` 与清单一并提交。
 */
async function runDraftRetry(
  request: RetryInsightsRequest,
  context: TaskContext,
  paths: TaskPaths,
  options: InsightRetryOptions,
  environ: Readonly<Record<string, string | undefined>>,
): Promise<ProcessResult> {
  const step = await runDraftStep({
    paths,
    request: {
      insightId: request.insightId as number,
      platform: request.platform as string,
      outputLanguage: request.outputLanguage,
    },
    environ: insightTargetEnv(environ, 'draft'),
    ...(options.draftRunner === undefined ? {} : {draftRunner: options.draftRunner}),
    ...(options.draftLlmFactory === undefined ? {} : {draftLlmFactory: options.draftLlmFactory}),
    ...(options.mcpSessionFactory === undefined ? {} : {mcpSessionFactory: options.mcpSessionFactory}),
    ...(options.skillsRoot === undefined ? {} : {skillsRoot: options.skillsRoot}),
    ...(options.fetchImpl === undefined ? {} : {fetchImpl: options.fetchImpl}),
    ...(options.transport === undefined ? {} : {transport: options.transport}),
    ...(options.signal === undefined ? {} : {signal: options.signal}),
  });
  return finalizeMergedResult(
    paths,
    context,
    await mergeExistingAiArtifacts(paths, sourceKindOfContext(context), step.result),
    {draftSeedInsightId: request.insightId as number},
    step.payloads,
  );
}

interface TitleResultValues {
  readonly text: string;
  readonly noteTitle: NoteTitleMetadata | null;
  readonly errorCode: string | null;
  readonly transcript: TranscriptMetadata | null;
}

/** 标题分支的结果只挂任务标识，不重写清单：清单里的 `note_title` 已由独立事务落盘。 */
async function titleResult(
  paths: TaskPaths,
  context: TaskContext,
  values: TitleResultValues,
): Promise<ProcessResult> {
  const base: ProcessResult = {
    status: values.errorCode === null ? 'completed' : 'partial_completed',
    taskId: null,
    taskDir: null,
    artifacts: {},
    text: values.text,
    summary: '',
    insights: [],
    transcript: values.transcript,
    dissection: null,
    error: values.errorCode === null
      ? null
      : {code: values.errorCode, message: TITLE_FAILURE_MESSAGE, stage: TITLE_STAGE},
    draft: '',
    noteTitle: values.noteTitle,
  };
  return resultWithTask(paths, context, await mergeExistingAiArtifacts(paths, sourceKindOfContext(context), base));
}

/**
 * 标题生成：`generating` → 模型 → `completed` / `failed`，两次都原子写进清单。
 *
 * 对齐 `worker_core/note_title.py::run_note_title_step`。这份状态是给界面看的：
 * 进程被杀掉时清单停在 `generating`，用户看到的是「这次没成」而不是一个假标题；
 * 模型失败也保留 `error_code`，宿主可以按码给文案。清单由 `saveNoteTitle` 就地改，
 * 因此前端写入的其它字段不会丢。
 */
async function runTitleRetry(
  request: RetryInsightsRequest,
  context: TaskContext,
  paths: TaskPaths,
  manifest: Record<string, unknown>,
  store: TaskStore,
  transcript: TranscriptMetadata | null,
  options: InsightRetryOptions,
  environ: Readonly<Record<string, string | undefined>>,
): Promise<ProcessResult> {
  const previous = noteTitleFromManifest(manifest);
  const language: OutputLanguage = request.outputLanguage;
  const metadataOf = (
    text: string | null,
    status: NoteTitleMetadata['status'],
    errorCode: string | null,
  ): NoteTitleMetadata => ({text, status, output_language: language, error_code: errorCode});
  const finish = (values: Omit<TitleResultValues, 'transcript'>): Promise<ProcessResult> =>
    titleResult(paths, context, {...values, transcript});

  let body: string;
  try {
    body = await readNoteTitleTranscript(store, request.taskId, context, paths);
  } catch {
    return finish({text: '', noteTitle: previous, errorCode: 'TITLE_TRANSCRIPT_UNAVAILABLE'});
  }

  // 旧标题要留在 `generating.text`：生成失败时界面还能显示上一版，不至于变成空白。
  const generating = metadataOf(previous?.text ?? null, 'generating', null);
  try {
    await saveNoteTitle({store, taskId: request.taskId, context, paths, metadata: generating});
  } catch {
    return finish({text: '', noteTitle: previous, errorCode: 'TITLE_SAVE_FAILED'});
  }

  options.onProgress?.(buildWorkerProgressEvent('title.generation.running', {
    stage: TITLE_STAGE,
    progress: 5,
  }));

  let metadata: NoteTitleMetadata;
  try {
    const llm = await (options.titleLlmFactory ?? ((env) => createInsightLlm(env, {
      ...(options.signal === undefined ? {} : {signal: options.signal}),
    })))(insightTargetEnv(environ, 'title'));
    const title = await generateNoteTitle({body, outputLanguage: language, llm});
    metadata = metadataOf(title, 'completed', null);
  } catch (error) {
    // 生成失败不是「请求非法」：留下可重试的 failed 状态，任务本身仍然有效。
    const code = error instanceof InsightGenerationError || error instanceof TitleOutputInvalidError
      ? error.code
      : 'TITLE_GENERATION_FAILED';
    metadata = metadataOf(generating.text, 'failed', code);
  }

  try {
    await saveNoteTitle({store, taskId: request.taskId, context, paths, metadata});
  } catch {
    return finish({text: body, noteTitle: generating, errorCode: 'TITLE_SAVE_FAILED'});
  }
  if (metadata.status === 'completed') {
    options.onProgress?.(buildWorkerProgressEvent('title.generation.completed', {
      stage: TITLE_STAGE,
      progress: 100,
    }));
  }
  return finish({text: body, noteTitle: metadata, errorCode: metadata.error_code});
}

/**
 * 跑一次「重新生成」请求。
 *
 * 返回终态结果的载荷，不抛错：请求非法、任务读不出来、生成失败都走结果行。
 * 只有「任务目录都打不开」这一层才没有任务标识——那时没有地方写清单。
 */
export async function runInsightRetryPipeline(
  payload: unknown,
  options: InsightRetryOptions,
): Promise<ProcessResult> {
  if (!isPlainObject(payload)) {
    return {
      ...failedResult({
        code: 'INVALID_RETRY_JSON',
        message: INVALID_RETRY_JSON_MESSAGE,
        stage: STAGE,
      }),
      status: 'failed',
    };
  }

  let request: RetryInsightsRequest;
  try {
    request = parseRetryInsightsRequest(payload);
  } catch (error) {
    if (!(error instanceof InvalidRetryRequestError)) throw error;
    return failedInsightRetry(INVALID_RETRY_PAYLOAD_CODE, error.message);
  }

  const environ = options.environ ?? process.env;
  const store = options.store ?? resolveTaskStore(options.projectRoot, environ);

  let manifest: Record<string, unknown>;
  try {
    manifest = await loadTaskManifest(store, request.taskId);
  } catch (error) {
    if (error instanceof TaskArtifactRecoveryError) {
      return failedInsightRetry('TASK_ARTIFACT_RECOVERY_FAILED', ARTIFACT_RECOVERY_FAILED_MESSAGE);
    }
    if (!(error instanceof TaskManifestUnavailableError)) throw error;
    return failedInsightRetry('TASK_MANIFEST_NOT_FOUND', TASK_MANIFEST_NOT_FOUND_MESSAGE);
  }

  const {context, paths} = taskContextFromLoadedManifest(store, request.taskId, manifest);
  const webPage = context.source.kind === 'web_page';
  // 与 Python `TaskStoreFacade.open` 一致：打开旧任务时也补建目录，偏好快照才有地方落盘；
  // 网页任务跳过——它的目录集合由保存事务一次建齐（`media/`、`transcript/` 等本就不存在）。
  // 目录建不出来等价于「这个任务当前不可用」，不是模型失败。
  try {
    if (!webPage) await ensureTaskDirs(paths);
  } catch {
    return failedInsightRetry('TASK_MANIFEST_NOT_FOUND', TASK_MANIFEST_NOT_FOUND_MESSAGE);
  }
  // Python 在打开任务之后统一注入 `APP_AI_SOURCE_KIND`：摘要 / 洞察 / 解剖的提示词、
  // 草稿分支的 `sourceKind` 都从这份运行环境读；网页任务按 article 走。
  const runtimeEnv: Readonly<Record<string, string | undefined>> = {
    ...environ,
    APP_AI_SOURCE_KIND: webPage ? 'article' : 'transcript',
  };
  // 网页任务没有 `note_title` 状态，也不存在「整理稿」——这两个 target 直接拒绝。
  // 结果行仍带任务标识与磁盘现状（`resultWithTask` 从 `article/` 读回正文与 Markdown）。
  if (webPage && (request.target === 'title' || request.target === 'transcript')) {
    return resultWithTask(paths, context, failedInsightRetry(
      'WEB_PAGE_RETRY_TARGET_INVALID',
      'This retry target is unavailable for web pages.',
    ));
  }
  const transcript = transcriptMetadataFromManifest(manifest);

  // 标题走自己的读写与错误码：它不生成产物文件，也不重写整份清单。
  if (request.target === 'title') {
    return runTitleRetry(request, context, paths, manifest, store, transcript, options, runtimeEnv);
  }
  // 整理稿自己读官方稿，错误码与「源文本不可用」不同，且不碰原稿一个字节。
  if (request.target === 'transcript') {
    return runTranscriptRetry(context, paths, transcript, options, runtimeEnv);
  }
  // 草稿只读 ai/ 下的种子、偏好快照与摘要，种子校验还必须在 checkout 之前。
  if (request.target === 'draft') {
    return runDraftRetry(request, context, paths, options, runtimeEnv);
  }

  let source;
  try {
    source = await readTaskSourceText(store, request.taskId);
  } catch (error) {
    if (error instanceof TaskArtifactRecoveryError) {
      return failedInsightRetry('TASK_ARTIFACT_RECOVERY_FAILED', ARTIFACT_RECOVERY_FAILED_MESSAGE);
    }
    if (!(error instanceof SourceTextUnavailableError)) throw error;
    // Python 在重新生成路径上同样把「读不到 / 为空 / 被链接」都归到这一个码。
    return finalizeFailure(paths, context, 'SOURCE_TEXT_INVALID', SOURCE_TEXT_INVALID_MESSAGE, transcript);
  }

  const transcriptBody = source.text.trim();
  if (transcriptBody.length === 0) {
    // Python 对解剖分支用独立的码：界面据此区分「换一份能解剖的源」与「整条管线空转」。
    return finalizeFailure(
      paths,
      context,
      request.target === 'dissection' ? 'DISSECTION_EMPTY_TRANSCRIPT' : 'AI_EMPTY_TRANSCRIPT',
      'Official transcript text is empty.',
      transcript,
    );
  }

  const outputLanguage: OutputLanguage = request.outputLanguage;
  return runGeneration(
    {...request, outputLanguage},
    context,
    paths,
    transcriptBody,
    source.text,
    transcript,
    options,
    runtimeEnv,
  );
}
