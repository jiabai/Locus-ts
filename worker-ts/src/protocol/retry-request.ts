// 重新生成请求的解析。
//
// 对齐 `worker/worker_core/requests.py` 的 `parse_retry_insights_request`：字段集合、
// target 闭集、标题与草稿任务的额外约束、以及「哪个目标允许带哪些字段」都按同一套规则。
// 这里只做**形状**校验——真伪由后面的步骤判断（种子洞见是否存在、文字稿是否还在）。
import {isDraftPlatform} from '../ai/draft-platform.ts';
import type {DraftPlatform} from '../ai/draft-platform.ts';
import {isOutputLanguage} from '../ai/output-language.ts';
import {
  InvalidPreferenceSnapshotError,
  parsePreferenceSnapshot,
} from '../ai/preference-snapshot.ts';
import type {PreferenceSnapshot} from '../ai/preference-snapshot.ts';
import type {OutputLanguage} from '../ai/output-language.ts';

const RETRY_REQUEST_FIELDS = new Set([
  'task_id',
  'target',
  'output_language',
  'preference_snapshot',
  'insight_id',
  'platform',
]);

const TITLE_REQUEST_FIELDS = new Set(['task_id', 'target', 'output_language']);

/** 与 Python 的 `TASK_ID_PATTERN` 同一条正则：只允许字母数字与 `_`/`-`。 */
const TASK_ID_PATTERN = /^[0-9A-Za-z_-]+$/;

export const RETRY_TARGETS = [
  'summary',
  'insights',
  'dissection',
  'draft',
  'transcript',
  'title',
] as const;

export type RetryTarget = (typeof RETRY_TARGETS)[number];

/**
 * 本 worker 已实现的 target。六个契约 target 都有对应的生成链，解析与执行不再分叉。
 */
export const IMPLEMENTED_RETRY_TARGETS: readonly RetryTarget[] = RETRY_TARGETS;

export const INVALID_RETRY_PAYLOAD_CODE = 'INVALID_RETRY_PAYLOAD';
export const INVALID_RETRY_PAYLOAD_MESSAGE = 'Retry request payload was invalid.';

export interface RetryInsightsRequest {
  readonly taskId: string;
  readonly target: RetryTarget;
  readonly outputLanguage: OutputLanguage;
  /** 已按 Python `parse_preference_snapshot` 逐字段校验。 */
  readonly preferenceSnapshot?: PreferenceSnapshot;
  readonly insightId?: number;
  readonly platform?: DraftPlatform;
}

export class InvalidRetryRequestError extends Error {
  readonly code = INVALID_RETRY_PAYLOAD_CODE;

  constructor() {
    super(INVALID_RETRY_PAYLOAD_MESSAGE);
    this.name = 'InvalidRetryRequestError';
  }
}

function invalid(): InvalidRetryRequestError {
  return new InvalidRetryRequestError();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseRetryInsightsRequest(payload: unknown): RetryInsightsRequest {
  if (!isPlainObject(payload)) throw invalid();
  for (const key of Object.keys(payload)) {
    if (!RETRY_REQUEST_FIELDS.has(key)) throw invalid();
  }

  const rawTaskId = payload.task_id;
  if (typeof rawTaskId !== 'string') throw invalid();
  const taskId = rawTaskId.trim();
  if (taskId.length === 0 || !TASK_ID_PATTERN.test(taskId)) throw invalid();

  const target = payload.target;
  if (typeof target !== 'string' || !(RETRY_TARGETS as readonly string[]).includes(target)) {
    throw invalid();
  }
  if (target === 'title' && Object.keys(payload).length !== TITLE_REQUEST_FIELDS.size) throw invalid();

  const outputLanguage = payload.output_language;
  if (!isOutputLanguage(outputLanguage)) throw invalid();

  let preferenceSnapshot: PreferenceSnapshot | undefined;
  let insightId: number | undefined;
  let platform: DraftPlatform | undefined;

  if ('preference_snapshot' in payload) {
    // 只有启发灵感受个性化偏好影响；其它 target 带它说明调用方搞错了请求。
    if (target !== 'insights' || !isPlainObject(payload.preference_snapshot)) throw invalid();
    try {
      preferenceSnapshot = parsePreferenceSnapshot(payload.preference_snapshot);
    } catch (error) {
      if (!(error instanceof InvalidPreferenceSnapshotError)) throw error;
      // Python 把偏好快照的 ValueError 一并包成 INVALID_RETRY_PAYLOAD：
      // 不消耗任何额度，界面显示「请求不合法」而不是「生成失败」。
      throw invalid();
    }
  }

  if (target !== 'draft' && payload.platform !== undefined && payload.platform !== null) {
    throw invalid();
  }

  if (target === 'draft') {
    const rawInsightId = payload.insight_id;
    // `boolean` 在 Python 里是 `int` 的子类，必须显式排除，否则 true 会变成 1。
    if (typeof rawInsightId !== 'number' || !Number.isInteger(rawInsightId)) throw invalid();
    insightId = rawInsightId;

    const rawPlatform = payload.platform;
    if (typeof rawPlatform !== 'string') throw invalid();
    const normalized = rawPlatform.trim();
    // Python 在 checkout 之前用 DRAFT_PLATFORM_IDS 闭集校验，非法 id 不消耗额度。
    if (!isDraftPlatform(normalized)) throw invalid();
    platform = normalized;
  }

  return {
    taskId,
    target: target as RetryTarget,
    outputLanguage,
    ...(preferenceSnapshot === undefined ? {} : {preferenceSnapshot}),
    ...(insightId === undefined ? {} : {insightId}),
    ...(platform === undefined ? {} : {platform}),
  };
}
