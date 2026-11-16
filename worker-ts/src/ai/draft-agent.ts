// 成稿 agent：一次 checkout、40 轮工具循环、唯一的 `submit_draft` 交付槽。
//
// 对应 `worker/worker_core/draft_agent.py`。Python 侧把检索 MCP、技能、计划与交付工具
// 一起交给 `ToolLoopAgentRunner`；这里用本包已有的工具循环装配同一套工具与提示词注入。
// 模型可以先用检索工具查资料、用 `write_todos` 维护计划，正文只能经 `submit_draft` 交付。
import {chatCompletion} from './chat.ts';
import type {ChatCompletion, ChatFetch, ChatMessage, ToolSpec} from './chat.ts';
import {
  checkoutManagedLlm,
  LLM_MAX_TOKENS_ENV,
  resolveInsightLlmConfig,
} from './config.ts';
import type {ModelEndpoint, Transport} from './config.ts';
import {buildDraftSystemPrompt, buildDraftUserPrompt} from './draft-prompt.ts';
import type {DraftSeedInsight} from './draft-prompt.ts';
import {outputLanguageSemantics} from './output-language.ts';
import type {OutputLanguage} from './output-language.ts';
import {sourcePromptInstruction} from './prompts.ts';
import type {SourceKind} from './prompts.ts';
import type {PreferenceSnapshot} from './preference-snapshot.ts';
import {runToolLoop} from './tool-loop.ts';
import type {Tool} from './tool-loop.ts';
import {
  buildPlanningPrompt,
  createPlanningState,
  createWriteTodosTool,
  PLANNING_REMINDER,
  TODO_STATE_CLOSE,
  TODO_STATE_OPEN,
} from './workspace/planning.ts';
import {buildSkillsInventory, createSkillTool} from './workspace/skills.ts';
import type {SkillInfo} from './workspace/skills.ts';
import {injectSystemBlock} from './workspace/system-block.ts';

export const DRAFT_AGENT_MAX_TURNS = 40;
export const PLANNING_OFF_VALUES: readonly string[] = ['0', 'false', 'False', ''];
const SKILLS_INVENTORY_OPEN = '<!-- skills-inventory -->';
const SKILLS_INVENTORY_CLOSE = '<!-- /skills-inventory -->';

export const SUBMIT_DRAFT_TOOL_SPEC: ToolSpec = {
  name: 'submit_draft',
  description: '提交成稿的完整正文。整篇可直接发布的 Markdown 稿子必须且只能经此工具提交，'
    + '禁止把正文写在普通回复里。调用一次即可，调用后任务即结束。',
  parameters: {
    type: 'object',
    properties: {
      markdown: {
        type: 'string',
        description: '稿子的完整 Markdown 正文（含标题与正文，可直接发布）',
      },
    },
    required: ['markdown'],
  },
};

const SUBMIT_ACCEPTED = '已接收稿子完整正文，任务可结束（无需任何 recap 或总结）。';
const SUBMIT_REJECTED = 'submit_draft 收到空或纯空白内容，未写入；'
  + '请把整篇可直接发布的稿子正文作为 markdown 参数提交。';
const INCOMPLETE_NUDGE = 'Delivery is incomplete. Call `submit_draft` with the complete '
  + 'publishable Markdown article. Do not finish with a plain reply.';

/** 正文接收槽：空 / 纯空白不写入、不覆盖既有非空提交。 */
export class DraftSink {
  private stored = '';

  set(markdown: string): boolean {
    if (markdown.length > 0 && markdown.trim().length > 0) {
      this.stored = markdown;
      return true;
    }
    return false;
  }

  get value(): string {
    return this.stored;
  }
}

export function createSubmitDraftTool(sink: DraftSink): Tool {
  return {
    ...SUBMIT_DRAFT_TOOL_SPEC,
    handler: ({args}) => {
      const markdown = args.markdown;
      if (typeof markdown === 'string' && sink.set(markdown)) return SUBMIT_ACCEPTED;
      return SUBMIT_REJECTED;
    },
  };
}

export interface DraftLlm {
  chat(messages: readonly ChatMessage[], tools: readonly ToolSpec[]): Promise<ChatCompletion>;
}

export type DraftLlmFactory = (
  environ: Readonly<Record<string, string | undefined>>,
) => Promise<DraftLlm>;

export interface CreateDraftLlmOptions {
  readonly transport?: Transport;
  readonly fetchImpl?: ChatFetch;
  readonly signal?: AbortSignal;
}

/**
 * 整次成稿只换一次临时凭证。
 *
 * Python 的 `resolve_draft_credentials` 在调用 `build_llm_provider` 之前 checkout 一次，
 * 之后 40 轮共用同一个 provider；若每次模型请求都 checkout，计费会随轮数放大。
 */
export async function createDraftLlm(
  environ: Readonly<Record<string, string | undefined>>,
  options: CreateDraftLlmOptions = {},
): Promise<DraftLlm> {
  const config = resolveInsightLlmConfig(environ);
  let endpoint: ModelEndpoint;
  if (config.mode === 'byok') {
    endpoint = config;
  } else {
    endpoint = await checkoutManagedLlm(config, {
      callIndex: 1,
      ...(options.transport === undefined ? {} : {transport: options.transport}),
    });
  }
  const omitMaxTokens = (environ[LLM_MAX_TOKENS_ENV]?.trim() ?? '') === '';
  return {
    chat: (messages, tools) => chatCompletion({
      endpoint,
      messages,
      tools,
      ...(omitMaxTokens ? {omitMaxTokens: true} : {}),
      ...(options.fetchImpl === undefined ? {} : {fetchImpl: options.fetchImpl}),
      ...(options.signal === undefined ? {} : {signal: options.signal}),
    }),
  };
}

/** `APP_DRAFT_MAX_TURNS`：非整数、非正数、无法解析一律回落到 40。 */
export function resolveDraftMaxTurns(
  environ: Readonly<Record<string, string | undefined>>,
): number {
  const raw = (environ.APP_DRAFT_MAX_TURNS ?? '').trim();
  if (raw === '' || !/^[+-]?\d+$/u.test(raw)) return DRAFT_AGENT_MAX_TURNS;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : DRAFT_AGENT_MAX_TURNS;
}

/** `APP_DRAFT_PLANNING` 默认开启；0 / false / False / 空串关闭。 */
export function planningEnabled(
  environ: Readonly<Record<string, string | undefined>>,
): boolean {
  return !PLANNING_OFF_VALUES.includes(environ.APP_DRAFT_PLANNING ?? '1');
}

export interface GenerateDraftOptions {
  readonly seed: DraftSeedInsight;
  readonly preferenceSnapshot: PreferenceSnapshot | null;
  readonly summary: string | null;
  readonly platform: string;
  readonly outputLanguage: OutputLanguage;
  readonly sourceKind: SourceKind;
  readonly llm: DraftLlm;
  /** `tools/list` 返回的检索工具，按服务端顺序放在工具集最前面。 */
  readonly mcpTools: readonly Tool[];
  readonly skills: readonly SkillInfo[];
  readonly planningEnabled: boolean;
  readonly maxTurns: number;
}

/**
 * 跑完成稿循环，返回最后一次非空提交（没有交付则返回空串，由上层判成空结果）。
 */
export async function generateDraft(options: GenerateDraftOptions): Promise<string> {
  // 与 Python 一样，先校验语言与来源类型，再构造提示词。
  outputLanguageSemantics(options.outputLanguage);
  sourcePromptInstruction(options.sourceKind);

  const sink = new DraftSink();
  const planning = createPlanningState();
  const activeSkills = options.skills.filter((skill) => skill.active);
  const tools: Tool[] = [
    ...options.mcpTools,
    createSkillTool(activeSkills),
    createSubmitDraftTool(sink),
  ];
  if (options.planningEnabled) tools.push(createWriteTodosTool(planning));

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: buildDraftSystemPrompt(options.platform, options.summary, options.sourceKind),
    },
    {
      role: 'user',
      content: buildDraftUserPrompt({
        seed: options.seed,
        preferenceSnapshot: options.preferenceSnapshot,
        outputLanguage: options.outputLanguage,
        summary: options.summary,
        platform: options.platform,
        sourceKind: options.sourceKind,
      }),
    },
  ];

  let reminderPending = false;
  await runToolLoop({
    chat: (currentMessages, currentTools) => options.llm.chat(currentMessages, currentTools),
    messages,
    tools,
    maxTurns: options.maxTurns,
    emptyOutputRetries: 3,
    onChatRequest: ({messages: live}) => {
      injectSystemBlock(
        live,
        SKILLS_INVENTORY_OPEN,
        SKILLS_INVENTORY_CLOSE,
        buildSkillsInventory(activeSkills),
      );
      if (options.planningEnabled) {
        injectSystemBlock(
          live,
          TODO_STATE_OPEN,
          TODO_STATE_CLOSE,
          buildPlanningPrompt(planning.todos),
        );
      }
    },
    onBeforeComplete: () => {
      reminderPending = options.planningEnabled && planning.veto();
      return !reminderPending;
    },
    incompleteNudge: () => (reminderPending ? PLANNING_REMINDER : INCOMPLETE_NUDGE),
  });
  return sink.value;
}
