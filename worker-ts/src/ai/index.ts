// AI 生成的公共入口。
//
// 对外只有一个工厂：按环境变量决定 BYOK 还是托管，托管模式下每次模型调用前换一次
// 临时凭证。上层（各 agent）只依赖 `InsightLlm.chat` 与 `complete`，不关心凭证从哪来。
import {chatCompletion} from './chat.ts';
import type {ChatCompletion, ChatFetch, ChatMessage, ToolSpec} from './chat.ts';
import {
  checkoutManagedLlm,
  resolveInsightLlmConfig,
} from './config.ts';
import type {InsightLlmConfig, ModelEndpoint, Transport} from './config.ts';
import {
  CHECKOUT_ERROR_MESSAGES,
  GENERATION_ERROR_MESSAGES,
  InsightGenerationError,
} from './errors.ts';
import {runToolLoop} from './tool-loop.ts';
import type {BeforeCompleteEvent, Tool, ToolEndEvent, ToolLoopOutcome} from './tool-loop.ts';

export interface InsightLlmOptions {
  /** 测试注入：替换 HTTP 传输（托管 checkout 与模型调用各有一个）。 */
  readonly transport?: Transport;
  readonly fetchImpl?: ChatFetch;
  readonly signal?: AbortSignal;
}

export interface InsightLlm {
  /** 原始模型信息：诊断与日志只读，不要把它当成可依赖的配置。 */
  readonly mode: InsightLlmConfig['mode'];
  chat(
    messages: readonly ChatMessage[],
    tools?: readonly ToolSpec[],
    options?: {readonly responseFormat?: 'json_object'},
  ): Promise<ChatCompletion>;
  complete(options: {
    readonly messages: ChatMessage[];
    readonly tools: Tool[];
    readonly maxTurns: number;
    readonly onChatRequest?: (event: {
      readonly messages: ChatMessage[];
      readonly tools: Tool[];
    }) => void | Promise<void>;
    readonly onToolEnd?: (event: ToolEndEvent) => void | Promise<void>;
    readonly onBeforeComplete?: (event: BeforeCompleteEvent) => boolean | Promise<boolean>;
    /** 各 agent 会点名还差哪个工具，所以催促语必须能随循环状态变化。 */
    readonly incompleteNudge?: (event: {
      readonly tools: readonly Tool[];
      readonly messages: readonly ChatMessage[];
    }) => string;
  }): Promise<ToolLoopOutcome>;
}

export async function createInsightLlm(
  environ: Readonly<Record<string, string | undefined>>,
  options: InsightLlmOptions = {},
): Promise<InsightLlm> {
  const config = resolveInsightLlmConfig(environ);
  let callIndex = 0;

  const endpointForCall = async (): Promise<ModelEndpoint> => {
    if (config.mode === 'byok') return config;
    callIndex += 1;
    return checkoutManagedLlm(config, {
      ...(options.transport === undefined ? {} : {transport: options.transport}),
      callIndex,
    });
  };

  const chat: InsightLlm['chat'] = async (messages, tools = [], callOptions = {}) => {
    const endpoint = await endpointForCall();
    return chatCompletion({
      endpoint,
      messages,
      tools,
      ...(callOptions.responseFormat === undefined
        ? {}
        : {responseFormat: callOptions.responseFormat}),
      ...(options.fetchImpl === undefined ? {} : {fetchImpl: options.fetchImpl}),
      ...(options.signal === undefined ? {} : {signal: options.signal}),
    });
  };

  return {
    mode: config.mode,
    chat,
    complete: (loopOptions) => runToolLoop({chat, ...loopOptions}),
  };
}

export {chatCompletion, buildChatRequestBody, chatCompletionsUrl} from './chat.ts';
export type {ChatCompletion, ChatMessage, ChatFetch, ToolCall, ToolSpec} from './chat.ts';
export {runToolLoop} from './tool-loop.ts';
export {
  SUMMARY_AGENT_MAX_TURNS,
  generateSummary,
  normalizeMermaidMindmap,
  normalizeSummaryMarkdown,
  writeSummaryFiles,
} from './summary-agent.ts';
export type {GenerateSummaryOptions, SummaryArtifacts, SummaryDelivery, WriteSummaryOptions} from './summary-agent.ts';
export {buildMindmapPrompt, buildSummaryPrompt, sourcePromptInstruction} from './prompts.ts';
export type {SourceKind} from './prompts.ts';
export {MarkdownSplitter, splitMarkdown} from './transcript-chunks.ts';
export type {MarkdownChunk} from './transcript-chunks.ts';
export {
  SUPPORTED_OUTPUT_LANGUAGES,
  isOutputLanguage,
  outputLanguageSemantics,
} from './output-language.ts';
export type {OutputLanguage, OutputLanguageSemantics} from './output-language.ts';
export {commitInsightPayloads} from './artifacts.ts';
export type {CommitInsightPayloadsOptions, InsightPayload} from './artifacts.ts';
export {buildInsightsAgentPrompt} from './prompts.ts';
export type {InsightPromptChunk} from './prompts.ts';
export {
  TITLE_SAMPLE_CHARACTERS,
  TITLE_SYSTEM_PROMPT,
  TitleOutputInvalidError,
  buildTitlePrompt,
  generateNoteTitle,
  parseTitleResponse,
  sampleTranscript,
} from './note-title.ts';
export type {NoteTitleLlm} from './note-title.ts';
export {
  POLISH_CHUNK_CHARS,
  POLISH_CONTEXT_CHARS,
  POLISH_MAX_CHUNKS,
  POLISH_META_SCHEMA_VERSION,
  POLISH_SYSTEM_PROMPT,
  buildPolishPrompt,
  chunkTranscript,
  createPolishLlm,
  polishTranscriptChunks,
  polishTranscriptWithLlm,
  serializePolishMeta,
  sourceTranscriptSha256,
} from './transcript-polish.ts';
export type {
  CreatePolishLlmOptions,
  PolishChunksResult,
  PolishLlm,
  PolishLlmFactory,
} from './transcript-polish.ts';
export {buildDissectionAgentPrompt} from './prompts.ts';
export {
  DRAFT_PLATFORM_IDS,
  DRAFT_PLATFORM_LABELS,
  DRAFT_PLATFORM_PASSTHROUGH_LABELS,
  draftPlatformLabel,
  isDraftPlatform,
} from './draft-platform.ts';
export type {DraftPlatform} from './draft-platform.ts';
export {
  buildDraftSystemPrompt,
  buildDraftUserPrompt,
  RETRIEVAL_FALLBACK_PHRASE,
} from './draft-prompt.ts';
export type {BuildDraftUserPromptOptions, DraftSeedInsight} from './draft-prompt.ts';
export {
  DRAFT_AGENT_MAX_TURNS,
  PLANNING_OFF_VALUES,
  SUBMIT_DRAFT_TOOL_SPEC,
  createDraftLlm,
  createSubmitDraftTool,
  DraftSink,
  generateDraft,
  planningEnabled,
  resolveDraftMaxTurns,
} from './draft-agent.ts';
export type {DraftLlm, DraftLlmFactory, GenerateDraftOptions} from './draft-agent.ts';
export {
  DISSECTION_JSON_DESTINATION,
  DISSECTION_MARKDOWN_DESTINATION,
  DissectionGenerationError,
  buildDissectionArtifacts,
  dissectionRejectionFeedback,
  dissectionToDict,
  formatDissectionMarkdown,
  parseDissectionReport,
  parsePersistedDissection,
} from './dissection-report.ts';
export type {
  DissectionArtifacts,
  DissectionAudienceFit,
  DissectionNarrative,
  DissectionSegment,
  DissectionSourceChunk,
  DissectionSourceKind,
  DissectionTemplate,
  TranscriptDissection,
} from './dissection-report.ts';
export {
  DISSECTION_AGENT_MAX_TURNS,
  MAX_DISSECTION_CHUNKS,
  SUBMIT_DISSECTION_TOOL_SPEC,
  generateDissection,
} from './dissection-agent.ts';
export type {GenerateDissectionOptions} from './dissection-agent.ts';
export {
  INSIGHTS_AGENT_MAX_TURNS,
  MAX_INSIGHTS,
  formatInsightsMarkdown,
  generateInsights,
  insightToDict,
  validateInsightsDelivery,
  writeInsightFiles,
} from './insights-agent.ts';
export type {
  GenerateInsightsOptions,
  InsightArtifacts,
  WriteInsightOptions,
} from './insights-agent.ts';
export {
  InvalidPreferenceSnapshotError,
  formatPreferenceSnapshotForPrompt,
  parsePreferenceSnapshot,
  preferenceSnapshotPayload,
  serializePreferenceSnapshot,
} from './preference-snapshot.ts';
export type {
  GenerationPreferences,
  InspirationProfile,
  PreferenceLabelSnapshot,
  PreferenceLabelSnapshotItem,
  PreferenceLabelValue,
  PreferenceSnapshot,
} from './preference-snapshot.ts';
export {
  GENERATION_FIELD_OPTIONS,
  MULTI_OPTION_LIMITS,
  PROFILE_FIELD_OPTIONS,
} from './preference-options.ts';
export type {
  BeforeCompleteEvent,
  Tool,
  ToolEndEvent,
  ToolHandler,
  ToolLoopOutcome,
} from './tool-loop.ts';
export {
  checkoutManagedLlm,
  derivePerCallRequestId,
  parseManagedCheckoutResponse,
  parseTimeoutSeconds,
  readMaxOutputTokens,
  resolveInsightLlmConfig,
} from './config.ts';
export type {InsightLlmConfig, ManagedConfig, ModelEndpoint, ByokConfig, Transport} from './config.ts';
export {
  CHECKOUT_ERROR_MESSAGES,
  GENERATION_ERROR_MESSAGES,
  InsightGenerationError,
  generationErrorCodeFor,
} from './errors.ts';
export type {InsightGenerationCode, ProviderFailureCategory} from './errors.ts';
