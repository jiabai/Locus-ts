// 草稿分支：从一条灵感生成可直接发布的稿子。
//
// 对应 `worker_core/worker_application/insight_retry.py::run_draft_generation_step`：
// 先按 insight_id 在 `ai/insights.json` 里找到种子（找不到就不消耗任何额度），
// 再读回偏好快照与要点总结，最后把 `ai/draft.md` 与清单放进同一个事务提交。
import {fileURLToPath} from 'node:url';

import {
  createDraftLlm,
  generateDraft,
  planningEnabled,
  resolveDraftMaxTurns,
} from '../ai/draft-agent.ts';
import type {DraftLlmFactory} from '../ai/draft-agent.ts';
import type {DraftSeedInsight} from '../ai/draft-prompt.ts';
import type {ChatFetch} from '../ai/chat.ts';
import type {Transport} from '../ai/config.ts';
import type {PreferenceSnapshot} from '../ai/preference-snapshot.ts';
import type {OutputLanguage} from '../ai/output-language.ts';
import type {SourceKind} from '../ai/prompts.ts';
import {connectAnysearch, resolveAnysearchConfig} from '../ai/workspace/mcp-client.ts';
import type {AnysearchConfig, McpSession} from '../ai/workspace/mcp-client.ts';
import {loadSkills} from '../ai/workspace/skills.ts';
import {
  readExistingInsights,
  readExistingPreferenceSnapshot,
  readExistingSummary,
} from '../tasks/existing-artifacts.ts';
import type {TaskPaths} from '../tasks/paths.ts';
import type {Insight, ProcessResult} from '../tasks/types.ts';

const DRAFT_DESTINATION = 'ai/draft.md';
const ORIGINAL_DRAFT_DESTINATION = 'ai/original/draft.md';
const DRAFT_STAGE = 'draft_generating' as const;
const SKILLS_ROOT = fileURLToPath(new URL('../../skills/', import.meta.url));

export type McpSessionFactory = (config: AnysearchConfig) => Promise<McpSession>;

export interface DraftRunnerInput {
  readonly seed: DraftSeedInsight;
  readonly preferenceSnapshot: PreferenceSnapshot | null;
  readonly summary: string | null;
  readonly platform: string;
  readonly outputLanguage: OutputLanguage;
  readonly sourceKind: SourceKind;
  readonly environ: Readonly<Record<string, string | undefined>>;
}

export type DraftRunner = (input: DraftRunnerInput) => Promise<string>;

export interface DraftStepOptions {
  readonly paths: TaskPaths;
  readonly request: {
    readonly insightId: number;
    readonly platform: string;
    readonly outputLanguage: OutputLanguage;
  };
  readonly environ: Readonly<Record<string, string | undefined>>;
  /** 测试注入：整段替换成稿运行器（Python `draft_runner`）。 */
  readonly draftRunner?: DraftRunner;
  /** 测试注入：只替换模型层，保留工具装配与提示词。 */
  readonly draftLlmFactory?: DraftLlmFactory;
  /** 测试注入：替换真实 MCP 会话（Python `FunctionToolManager`）。 */
  readonly mcpSessionFactory?: McpSessionFactory;
  readonly skillsRoot?: string;
  readonly fetchImpl?: ChatFetch;
  readonly transport?: Transport;
  readonly signal?: AbortSignal;
}

export interface DraftStepOutcome {
  readonly result: ProcessResult;
  /** 成功时的产物；`ai/original/draft.md` 传 null 表示在事务里删除旧稿。 */
  readonly payloads: Readonly<Record<string, Uint8Array | null>> | null;
}

function failed(code: string, message: string): DraftStepOutcome {
  return {
    result: {
      status: 'partial_completed',
      taskId: null,
      taskDir: null,
      artifacts: {},
      text: '',
      summary: '',
      insights: [],
      transcript: null,
      dissection: null,
      error: {code, message, stage: DRAFT_STAGE},
      draft: '',
    },
    payloads: null,
  };
}

function findInsightById(insights: readonly Insight[], insightId: number): DraftSeedInsight | null {
  const found = insights.find((insight) => insight.id === insightId);
  if (found === undefined) return null;
  return {
    id: found.id,
    topic: found.topic,
    matchReason: found.matchReason,
    followUpQuestions: found.followUpQuestions,
    suitableUse: found.suitableUse,
    sourceChunkId: found.sourceChunkId,
  };
}

async function defaultDraftRunner(
  input: DraftRunnerInput,
  options: DraftStepOptions,
): Promise<string> {
  const config = await resolveAnysearchConfig(input.environ, {
    ...(options.transport === undefined ? {} : {transport: options.transport}),
    ...(options.signal === undefined ? {} : {signal: options.signal}),
  });
  const session = await (options.mcpSessionFactory ?? connectAnysearch)(config);
  try {
    const llmFactory = options.draftLlmFactory ?? ((environ) => createDraftLlm(environ, {
      ...(options.fetchImpl === undefined ? {} : {fetchImpl: options.fetchImpl}),
      ...(options.transport === undefined ? {} : {transport: options.transport}),
      ...(options.signal === undefined ? {} : {signal: options.signal}),
    }));
    const [llm, skills] = await Promise.all([
      llmFactory(input.environ),
      loadSkills(options.skillsRoot ?? SKILLS_ROOT),
    ]);
    return await generateDraft({
      seed: input.seed,
      preferenceSnapshot: input.preferenceSnapshot,
      summary: input.summary,
      platform: input.platform,
      outputLanguage: input.outputLanguage,
      sourceKind: input.sourceKind,
      llm,
      mcpTools: session.tools,
      skills,
      planningEnabled: planningEnabled(input.environ),
      maxTurns: resolveDraftMaxTurns(input.environ),
    });
  } finally {
    await session.close();
  }
}

export async function runDraftStep(options: DraftStepOptions): Promise<DraftStepOutcome> {
  const {paths, request, environ} = options;
  // 种子校验必须在任何 checkout 之前：无效的 insight_id 不消耗额度。
  const seed = findInsightById(await readExistingInsights(paths), request.insightId);
  if (seed === null) {
    return failed(
      'DRAFT_SEED_INVALID',
      `insight_id ${request.insightId} is not present in ai/insights.json; re-select an insight and retry.`,
    );
  }

  const [preferenceSnapshot, storedSummary] = await Promise.all([
    readExistingPreferenceSnapshot(paths),
    readExistingSummary(paths),
  ]);
  const summary = storedSummary.length > 0 ? storedSummary : null;
  const sourceKind: SourceKind = environ.APP_AI_SOURCE_KIND?.trim() === 'article'
    ? 'article'
    : 'transcript';
  const input: DraftRunnerInput = {
    seed,
    preferenceSnapshot,
    summary,
    platform: request.platform,
    outputLanguage: request.outputLanguage,
    sourceKind,
    environ,
  };

  let draftText: string;
  try {
    draftText = options.draftRunner !== undefined
      ? await options.draftRunner(input)
      : await defaultDraftRunner(input, options);
  } catch {
    // 模型、MCP、agent 的异常原文可能带密钥前缀，只回一个固定分类。
    return failed('DRAFT_GENERATION_FAILED', 'Draft generation failed.');
  }
  if (draftText.trim().length === 0) {
    return failed('DRAFT_EMPTY_RESULT', 'Draft generation returned an empty result.');
  }

  return {
    result: {
      status: 'completed',
      taskId: null,
      taskDir: null,
      artifacts: {},
      text: '',
      summary: '',
      insights: [],
      transcript: null,
      dissection: null,
      error: null,
      draft: draftText,
    },
    payloads: {
      [DRAFT_DESTINATION]: Buffer.from(draftText, 'utf8'),
      // Python 在成功时把 `ai/original/draft.md` 置为 None，事务会删掉旧稿。
      [ORIGINAL_DRAFT_DESTINATION]: null,
    },
  };
}
