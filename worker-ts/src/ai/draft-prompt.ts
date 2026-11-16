// 草稿生成的两份提示词。
//
// 对应 `worker/worker_core/draft_agent.py` 的 `_build_system_prompt` 与
// `worker/worker_core/ai_prompts.py` 的 `build_draft_from_inspiration_prompt`。
// 换行、空行、标点、反引号都算内容，改动必须重新生成 Python 基准并评审差异。
import {draftPlatformLabel} from './draft-platform.ts';
import {formatPreferenceSnapshotForPrompt} from './preference-snapshot.ts';
import type {PreferenceSnapshot} from './preference-snapshot.ts';
import {outputLanguageSemantics} from './output-language.ts';
import type {OutputLanguage} from './output-language.ts';
import {sourcePromptInstruction} from './prompts.ts';
import type {SourceKind} from './prompts.ts';

export interface DraftSeedInsight {
  readonly id: number;
  readonly topic: string;
  readonly matchReason: string;
  readonly followUpQuestions: readonly string[];
  readonly suitableUse: string;
  readonly sourceChunkId: number | null;
}

const SYSTEM_PROMPT_HEAD = '你是一名内容成稿助手。任务：根据给定的一条灵感，先做必要的资料检索，'
  + '再按目标平台文体写出一份完整、可直接发布的稿子。\n';

export const RETRIEVAL_FALLBACK_PHRASE = '直接基于灵感 + 要点总结（若有）继续成稿';

/** 摘要「在场」判定：非 null 且裁剪后非空；纯空白按缺失处理。 */
function summaryIsPresent(summary: string | null): boolean {
  return summary !== null && summary.trim().length > 0;
}

function summaryGroundingClause(summary: string | null, sourceKind: SourceKind): string {
  if (!summaryIsPresent(summary)) return '';
  const label = sourceKind === 'article' ? '网页正文' : '原视频';
  return `（必要时可参考附带的要点总结作为${label}观点 grounding）`;
}

function planningGuidance(summary: string | null, sourceKind: SourceKind): string {
  const groundingClause = summaryGroundingClause(summary, sourceKind);
  const summaryClause = summaryIsPresent(summary) ? ' + 要点总结（若有）' : '';
  return '\n交付方式（硬性契约，优先于任何 skill 指令）：\n'
    + '- 稿子的完整正文必须且只能经一次 `submit_draft` 工具提交：把整篇可直接发布的 '
    + 'Markdown 正文作为 `markdown` 参数传入。\n'
    + '- 禁止把稿子正文写在普通回复里。调用 `submit_draft` 后任务即结束，无需任何 '
    + 'recap / 总结 / 收尾。\n'
    + '- 调用 `submit_draft` 前先勾完所有 todo（若提供了 `write_todos`）。\n'
    + `- 本任务为一次性成稿：灵感${summaryClause}`
    + '、目标平台均已给出——不向用户确认需求，'
    + `也不要自行把稿子保存为文件（系统会落盘）。${groundingClause}\n`
    + '\n工作方式：\n'
    + '- 若提供了 `write_todos` 工具，先用它建立成稿计划（建议覆盖：结构构思 / 资料检索 / '
    + '按平台文体写作），再逐条执行，并在推进时更新各条状态（保持恰好一条 in_progress）。\n'
    + '- 检索时自主决定搜索 query 和搜索的问题数量；若某次搜索失败或无结果，'
    + `不要无限重试同一条 query，${RETRIEVAL_FALLBACK_PHRASE}。\n`;
}

export function buildDraftSystemPrompt(
  platform: string,
  summary: string | null = null,
  sourceKind: SourceKind = 'transcript',
): string {
  return `${SYSTEM_PROMPT_HEAD}目标平台：${draftPlatformLabel(platform)}。\n`
    + planningGuidance(summary, sourceKind);
}

export interface BuildDraftUserPromptOptions {
  readonly seed: DraftSeedInsight;
  readonly preferenceSnapshot: PreferenceSnapshot | null;
  readonly outputLanguage: OutputLanguage;
  readonly summary: string | null;
  readonly platform: string;
  readonly sourceKind?: SourceKind;
}

export function buildDraftUserPrompt(options: BuildDraftUserPromptOptions): string {
  const {
    seed, preferenceSnapshot, outputLanguage, summary, platform,
    sourceKind = 'transcript',
  } = options;
  const semantics = outputLanguageSemantics(outputLanguage);
  // Python 调用它是为了校验 source_kind 的合法性；返回值不进入本提示词。
  sourcePromptInstruction(sourceKind);
  const sourceLabel = sourceKind === 'article' ? '网页正文' : '原视频';
  const bodyLabel = sourceKind === 'article' ? '正文' : '文字稿';
  const platformLabel = draftPlatformLabel(platform);

  const skeletonLines = seed.followUpQuestions.length === 0
    ? '- （灵感未提供章节骨架，请按目标平台文体自行规划）'
    : seed.followUpQuestions.map((question) => `- ${question}`).join('\n');

  const sourceAnnotation = seed.sourceChunkId === null
    ? ''
    : `## 溯源标注\n灵感来源于${sourceLabel}第 ${seed.sourceChunkId} 段；`
      + `本段${bodyLabel}原文不进入本 prompt，请基于检索与上述灵感字段成稿。\n`;

  const preferenceSection = preferenceSnapshot === null
    ? '## 偏好快照（个性化：语气 / 受众 / 角度 / 回避）\n'
      + '本次未提供偏好快照——不进行个性化，也不要臆造任何角色、领域、受众或风格；'
      + '按目标平台通用文体成稿即可。\n'
    : '## 偏好快照（个性化：语气 / 受众 / 角度 / 回避）\n'
      + '以下 JSON 仅用于调整成稿的语气、受众、角度与回避项，不得用来补充灵感之外的'
      + '事实或观点；与灵感事实冲突时以灵感为准。\n'
      + '```json\n'
      + `${formatPreferenceSnapshotForPrompt(preferenceSnapshot)}\n`
      + '```\n';

  const summarySection = !summaryIsPresent(summary)
    ? ''
    : `## ${sourceLabel}要点总结（可选 grounding）\n`
      + `以下要点总结来自${sourceLabel}，可作为观点来源与事实 grounding；`
      + '引用其观点时按原创性规则标注来源，不要原样复制整段。\n'
      + `${summary}\n`;

  return `\n# 角色使命\n`
    + '你是一位内容成稿编辑。你的任务是把一条「灵感」扩展成一篇完整、可直接发布的稿子。\n'
    + '\n## 输出语言（强制）\n'
    + `${semantics.promptInstruction}\n`
    + '成稿正文的每个用户可见值（标题、正文、小节标题）都必须使用上述目标语言；\n'
    + '本 prompt 中的中文指令文本不是成稿内容，不要照抄进正文。\n'
    + '\n## 灵感（中央议题 / 标题方向）\n'
    + `${seed.topic}\n`
    + '\n## 目标感锚点（防跑题）\n'
    + `${seed.matchReason}\n`
    + '\n## 章节骨架 / 子论点（来自灵感的追问方向）\n'
    + `${skeletonLines}\n`
    + '\n## 目标平台与体裁\n'
    + `目标平台：${platformLabel}。请按该平台文体的常规结构与表达密度成稿。\n`
    + `${sourceAnnotation}\n`
    + `${preferenceSection}\n`
    + `${summarySection}\n`
    + '## 成稿要求\n'
    + '- 忠于灵感字段给出的方向与子论点；可基于检索补充论据，但不得替换灵感的核心立场。\n'
    + '- 不得引入灵感之外的虚构人物、公司、数据或事件。\n'
    + '- 输出一份完整、可直接发布的稿子正文（Markdown）。\n';
}
