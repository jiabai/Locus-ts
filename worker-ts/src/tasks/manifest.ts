// `task.json` 清单的序列化与校验。
//
// 对齐 `worker/worker_core/task_store.py` 的 `serialize_task_manifest`：字段、取值、
// 相对路径与 JSON 排版都按同一份规则生成。清单是跨语言共享的状态——Rust 读它、Python 读它，
// 因此字段名（snake_case）、`schema_version`、`artifacts` 闭集都不能各有各的写法。
import {readFile} from 'node:fs/promises';

import {ARTIFACT_KEY_BY_RELATIVE_PATH} from '../artifacts/task-transaction.ts';
import {
  canonicalUrlForPersistence,
  sourceIdentityToManifestDict,
} from '../sources/source-identity.ts';
import {parseNoteTitleMetadata} from './note-title-metadata.ts';
import type {NoteTitleMetadata} from './note-title-metadata.ts';
import type {
  LocalFileTaskSource,
  ProcessResult,
  TaskContext,
  TaskSource,
  UrlTaskSource,
} from './types.ts';
import type {WebPageSource} from '../web/web-page-contract.ts';

export type {NoteTitleMetadata} from './note-title-metadata.ts';

export const TASK_MANIFEST_FILE_NAME = 'task.json';
/** 媒体任务的清单版本；网页任务用 4。 */
export const TASK_SCHEMA_VERSION = 3;
export const WEB_TASK_SCHEMA_VERSION = 4;
/** 与 `worker_core/source_identity.py` 同值，读取方按它判断来源信息是否需要迁移。 */
export const SOURCE_PRIVACY_MIGRATION_VERSION = 2;

/**
 * 固定相对路径的产物键。
 *
 * 直接从事务闭集取反表，而不是再抄一份：两处各写一份，迟早会出现
 * 「写入时按一个路径、校验时按另一个路径」的漂移（`ai/draft.md` 曾经就是这样）。
 */
const FIXED_ARTIFACT_PATHS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(ARTIFACT_KEY_BY_RELATIVE_PATH).map(([relative, key]) => [key, relative]),
);

/** 路径按内容决定的键：扩展名随来源文件变，但位置是固定的。 */
const POSITIONAL_ARTIFACTS: Readonly<Record<string, (relative: string) => boolean>> = {
  video: (relative) => /^media\/video\.[a-z0-9]+$/.test(relative),
  audio: (relative) => relative === 'media/audio.wav',
  preference_snapshot: (relative) => relative === 'ai/preference-snapshot.json',
};

/** 网页任务专属的键：出现在媒体任务的清单里就是矛盾状态。 */
const ARTICLE_KEYS = new Set(['article_txt', 'article_md']);
/** 媒体专属的键：出现在网页任务的清单里就是矛盾状态。 */
const WEB_ONLY_MEDIA_KEYS = new Set(['video', 'audio', 'transcript_txt', 'transcript_md', 'segments']);

/** 旧清单里需要保留的字段：草稿种子 id 与标题都由前端或别的步骤拥有。 */
export interface PriorManifestKeys {
  readonly draftSeedInsightId: number | null;
  readonly noteTitle: NoteTitleMetadata | null;
}

export const NO_PRIOR_MANIFEST: PriorManifestKeys = {draftSeedInsightId: null, noteTitle: null};

export interface SerializeManifestOptions {
  /**
   * 草稿种子洞见 id 的保留规则：`'preserve'` 沿用旧清单（默认），`null` 清空，
   * 数字表示写入该 id。对应 Python 的 `DRAFT_SEED_UNSET` 三态。
   */
  readonly draftSeedInsightId?: number | null | 'preserve';
  /** 缺省取当前时间；单测固定它才能逐字节比对。 */
  readonly now?: () => Date;
  /** 旧清单的保留字段；任务已存在时必须传入，否则会丢标题与草稿种子。 */
  readonly prior?: PriorManifestKeys;
}

/** `YYYY-MM-DDTHH:MM:SSZ`，与 Python `isoformat(timespec="seconds")` 同形。 */
export function isoTimestamp(moment: Date): string {
  return `${moment.toISOString().slice(0, 19)}Z`;
}

/** Python `strip()[:180]`：按码点截断，不把代理对劈成半个字符。 */
function textPreview(text: string): string {
  return [...text.trim()].slice(0, 180).join('');
}

export function serializeTaskManifest(
  context: TaskContext,
  result: ProcessResult,
  options: SerializeManifestOptions = {},
): Uint8Array {
  const prior = options.prior ?? NO_PRIOR_MANIFEST;
  // 三态必须靠「有没有这个键」区分：`??` 会把显式的 null（清空）当成缺省（沿用）。
  const requestedSeed = 'draftSeedInsightId' in options
    ? (options.draftSeedInsightId as number | null | 'preserve')
    : 'preserve';
  const draftSeed = requestedSeed === 'preserve' ? prior.draftSeedInsightId : requestedSeed;
  // Python 按产物映射 / 磁盘上的成稿文件判定 `draft_path` 与 `has_draft`：
  // 只重算摘要不会把已有成稿报成「没了」，删除成稿也不会留下悬空路径。
  const draftPath = typeof result.artifacts.draft === 'string' ? result.artifacts.draft : null;
  const webPage = context.source.kind === 'web_page';

  const payload: Record<string, unknown> = {
    schema_version: webPage ? WEB_TASK_SCHEMA_VERSION : TASK_SCHEMA_VERSION,
    source_privacy_migration_version: SOURCE_PRIVACY_MIGRATION_VERSION,
    source_privacy_quarantined: false,
    task_id: context.taskId,
    created_at: context.createdAt,
    updated_at: isoTimestamp((options.now ?? (() => new Date()))()),
    ...manifestSourceFields(context.source),
    status: result.status,
    app_version: 'app',
    worker_version: 'app',
    model: context.model,
    transcript: result.transcript === null
      ? null
      : {
        source: result.transcript.source,
        language: result.transcript.language,
        engine: result.transcript.engine,
      },
    artifacts: result.artifacts,
    error: result.error === null
      ? null
      : {code: result.error.code, message: result.error.message, stage: result.error.stage},
    text_preview: textPreview(result.text),
    insights_count: result.insights.length,
    draft_path: draftPath,
    has_draft: draftPath !== null,
    draft_seed_insight_id: draftSeed,
  };
  // Python `result.note_title=None` 表示「沿用旧清单」，不是「清空」；`??` 正好是这套语义。
  // 只有标题生成路径会显式带上新的元数据，其余重算路径都靠 prior 保住它；
  // 网页任务永远不写 `note_title`——它的标题就是文章标题。
  const title = result.noteTitle ?? prior.noteTitle;
  if (title !== null && !webPage) payload.note_title = {...title};

  validateManifestArtifacts(payload, webPage);
  // 与 Python 一样用 LF：清单是机器读的，不跟随平台换行。
  return Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

/** 按来源种类分派，键序与 Python `_manifest_source_fields` 一致。 */
function manifestSourceFields(source: TaskSource): Record<string, unknown> {
  if (source.kind === 'web_page') return webManifestSourceFields(source);
  if (source.kind === 'url') return urlManifestSourceFields(source);
  return localManifestSourceFields(source);
}

/** `_manifest_source_fields` 的本地文件分支。 */
function localManifestSourceFields(source: LocalFileTaskSource): Record<string, unknown> {
  return {
    source_kind: 'local_file',
    source_url: '',
    source_identity: null,
    local_source: {
      display_name: source.displayName,
      media_kind: source.mediaKind,
      extension: source.extension,
    },
    platform: 'local',
  };
}

/**
 * `_manifest_source_fields` 的 URL 分支。
 *
 * 这里刻意不写 `source_kind`：Python 的 URL 清单没有这个键，历史清单里显式写 `"url"`
 * 也能读回。规范 URL 经 `canonicalUrlForPersistence` 重新验算，避免把带 token 的分享链接
 * 或拼错的身份写进持久化状态。
 */
function urlManifestSourceFields(source: UrlTaskSource): Record<string, unknown> {
  return {
    source_url: canonicalUrlForPersistence(source.identity) ?? '',
    source_identity: sourceIdentityToManifestDict(source.identity),
    platform: source.identity.platform,
  };
}

/** `_manifest_source_fields` 的网页分支。 */
function webManifestSourceFields(source: WebPageSource): Record<string, unknown> {
  return {
    source_kind: 'web_page',
    source_url: source.url,
    source_identity: null,
    platform: 'web',
    web_source: {title: source.title, extracted_at: source.extractedAt},
  };
}

/** 清单里的 `artifacts` 必须落在闭集内：写进去就代表「这个键对应这个文件」。 */
export function validateManifestArtifacts(
  manifest: Record<string, unknown>,
  article: boolean = false,
): void {
  const artifacts = manifest.artifacts;
  if (artifacts === null || typeof artifacts !== 'object' || Array.isArray(artifacts)) {
    throw new Error('Task artifacts are invalid.');
  }
  if (article) {
    const fixedArtifacts = artifacts as Record<string, unknown>;
    if (fixedArtifacts.article_txt !== 'article/article.txt'
      || fixedArtifacts.article_md !== 'article/article.md') {
      throw new Error('Web page body artifacts are required.');
    }
    if (Object.keys(fixedArtifacts).some((key) => WEB_ONLY_MEDIA_KEYS.has(key))) {
      throw new Error('Web page artifacts contain media.');
    }
  }
  for (const [key, relative] of Object.entries(artifacts as Record<string, unknown>)) {
    if (typeof relative !== 'string' || relative.length === 0) {
      throw new Error('Task artifact path is invalid.');
    }
    if (!article && ARTICLE_KEYS.has(key)) throw new Error('Media artifacts contain a web page.');
    const fixed = FIXED_ARTIFACT_PATHS[key];
    if (fixed !== undefined) {
      if (relative !== fixed) throw new Error('Task artifact path is invalid.');
      continue;
    }
    const positional = POSITIONAL_ARTIFACTS[key];
    if (positional === undefined) throw new Error('Task artifact kind is invalid.');
    if (!positional(relative)) throw new Error('Task artifact path is invalid.');
  }
}

/**
 * 读旧清单里需要保留的字段。
 *
 * 与 Python 的差别：Python 读不动旧清单时会直接抛（`load_task_manifest` 的严格校验），
 * 这里降级成「没有可保留字段」。清单是重写前的一次尽力读取，为它让整个任务失败不划算；
 * 代价是旧清单损坏时标题会丢，而内容仍然正确。
 */
export async function readPriorManifestKeys(manifestPath: string): Promise<PriorManifestKeys> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch {
    return NO_PRIOR_MANIFEST;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NO_PRIOR_MANIFEST;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return NO_PRIOR_MANIFEST;
  }
  const manifest = parsed as Record<string, unknown>;
  return {
    draftSeedInsightId: readDraftSeed(manifest.draft_seed_insight_id),
    noteTitle: readNoteTitle(manifest.note_title),
  };
}

function readDraftSeed(value: unknown): number | null {
  // `boolean` 在 Python 里是 `int` 的子类，必须显式排除，否则 True 会变成 1。
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function readNoteTitle(value: unknown): NoteTitleMetadata | null {
  try {
    return parseNoteTitleMetadata(value);
  } catch {
    return null;
  }
}
