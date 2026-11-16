// 三语输出的语义表。
//
// 对齐 `worker/worker_core/output_language.py`：每一处用户可见文本（标题、章节名、
// 示例、约束句）都从这里取，提示词与 Markdown 产物才不会是「中文模板 + 英文内容」的混搭。
// 这张表是数据不是逻辑，改动等于改产品文案，必须与 Python 同值。
export const SUPPORTED_OUTPUT_LANGUAGES = ['zh-CN', 'zh-TW', 'en-US'] as const;

export type OutputLanguage = (typeof SUPPORTED_OUTPUT_LANGUAGES)[number];

export function isOutputLanguage(value: unknown): value is OutputLanguage {
  return typeof value === 'string'
    && (SUPPORTED_OUTPUT_LANGUAGES as readonly string[]).includes(value);
}

export interface OutputLanguageSemantics {
  readonly promptInstruction: string;
  readonly summaryTitle: string;
  readonly summaryOverviewTitle: string;
  readonly topicSummaryHeading: string;
  readonly transcriptExcerptHeading: string;
  readonly topicQuestionConstraint: string;
  readonly defaultMatchReason: string;
  readonly defaultSuitableUse: string;
  readonly insightsTitle: string;
  readonly insightItemLabel: string;
  readonly insightTopicHeading: string;
  readonly matchReasonHeading: string;
  readonly followUpHeading: string;
  readonly suitableUseHeading: string;
  readonly sourceChunkLabel: string;
  readonly topicExampleTitle: string;
  readonly topicExampleSummary: string;
  readonly topicExampleExcerpt: string;
  readonly questionExampleTopic: string;
  readonly questionExampleReason: string;
  readonly questionExampleFollowUp: string;
  readonly questionExampleUse: string;
  readonly mindmapExampleRoot: string;
  readonly mindmapExampleBranch: string;
  readonly mindmapExamplePoint: string;
}

const ZH_CN: OutputLanguageSemantics = {
  promptInstruction: 'Use Simplified Chinese for every user-visible generated value, Markdown '
    + 'heading/body, and Mermaid node label. Do not change JSON keys, artifact '
    + 'schemas, or Mermaid syntax.',
  summaryTitle: '要点总结',
  summaryOverviewTitle: '总览',
  topicSummaryHeading: '话题摘要',
  transcriptExcerptHeading: '原文片段',
  topicQuestionConstraint: '只围绕当前话题段生成问题，不要扩展到其他话题段。',
  defaultMatchReason: '来自文字稿相关片段。',
  defaultSuitableUse: '灵感延展',
  insightsTitle: '启发灵感',
  insightItemLabel: '灵感',
  insightTopicHeading: '灵感',
  matchReasonHeading: '匹配理由',
  followUpHeading: '启发问题',
  suitableUseHeading: '适合用途',
  sourceChunkLabel: '来源片段',
  topicExampleTitle: '企业 AI 落地',
  topicExampleSummary: '讨论企业 AI 落地与流程编排的关系。',
  topicExampleExcerpt: '企业 AI 落地时，流程编排比单点能力更关键。',
  questionExampleTopic: '为什么流程编排可能比单点模型能力更关键？',
  questionExampleReason: '这条灵感与文字稿和偏好相符。',
  questionExampleFollowUp: '团队应该先改造哪条流程？',
  questionExampleUse: '内容选题',
  mindmapExampleRoot: '核心主题',
  mindmapExampleBranch: '主要分支',
  mindmapExamplePoint: '关键要点',
};

const ZH_TW: OutputLanguageSemantics = {
  promptInstruction: 'Use Traditional Chinese (Taiwan) for every user-visible generated value, '
    + 'Markdown heading/body, and Mermaid node label; never convert it to '
    + 'Simplified Chinese. Do not change JSON keys, artifact schemas, or Mermaid syntax.',
  summaryTitle: '重點摘要',
  summaryOverviewTitle: '總覽',
  topicSummaryHeading: '話題摘要',
  transcriptExcerptHeading: '逐字稿片段',
  topicQuestionConstraint: '只圍繞目前話題段產生問題，不要擴展到其他話題段。',
  defaultMatchReason: '來自逐字稿的相關片段。',
  defaultSuitableUse: '靈感延伸',
  insightsTitle: '靈感啟發',
  insightItemLabel: '靈感',
  insightTopicHeading: '靈感',
  matchReasonHeading: '匹配理由',
  followUpHeading: '啟發問題',
  suitableUseHeading: '適合用途',
  sourceChunkLabel: '來源片段',
  topicExampleTitle: '企業 AI 落地',
  topicExampleSummary: '討論企業 AI 落地與流程編排的關係。',
  topicExampleExcerpt: '企業 AI 落地時，流程編排比單點能力更關鍵。',
  questionExampleTopic: '為什麼流程編排可能比單點模型能力更關鍵？',
  questionExampleReason: '這則靈感符合逐字稿與偏好。',
  questionExampleFollowUp: '團隊應該先改造哪一條流程？',
  questionExampleUse: '內容選題',
  mindmapExampleRoot: '核心主題',
  mindmapExampleBranch: '主要分支',
  mindmapExamplePoint: '關鍵要點',
};

const EN_US: OutputLanguageSemantics = {
  promptInstruction: 'Use clear US English for every user-visible generated value, Markdown '
    + 'heading/body, and Mermaid node label. Do not change JSON keys, artifact '
    + 'schemas, or Mermaid syntax.',
  summaryTitle: 'Key Summary',
  summaryOverviewTitle: 'Overview',
  topicSummaryHeading: 'Topic Summary',
  transcriptExcerptHeading: 'Transcript Passage',
  topicQuestionConstraint: 'Generate questions only about this topic segment; do not expand into other topics.',
  defaultMatchReason: 'Based on a relevant transcript passage.',
  defaultSuitableUse: 'Idea development',
  insightsTitle: 'Inspiration',
  insightItemLabel: 'Inspiration',
  insightTopicHeading: 'Inspiration',
  matchReasonHeading: 'Match Reason',
  followUpHeading: 'Follow-up Questions',
  suitableUseHeading: 'Suitable Use',
  sourceChunkLabel: 'Source Segment',
  topicExampleTitle: 'Enterprise AI Adoption',
  topicExampleSummary: 'How orchestration supports enterprise AI adoption.',
  topicExampleExcerpt: 'Workflow orchestration can matter more than one model capability.',
  questionExampleTopic: 'Why can workflow orchestration matter more than model capability?',
  questionExampleReason: 'This idea matches the transcript and selected preferences.',
  questionExampleFollowUp: 'Which workflow should the team improve first?',
  questionExampleUse: 'Content planning',
  mindmapExampleRoot: 'Core Topic',
  mindmapExampleBranch: 'Main Branch',
  mindmapExamplePoint: 'Key Point',
};

const SEMANTICS: Readonly<Record<OutputLanguage, OutputLanguageSemantics>> = {
  'zh-CN': ZH_CN,
  'zh-TW': ZH_TW,
  'en-US': EN_US,
};

/** 与 Python 的 `output_language_semantics` 等价：非法语言在这里就炸，不静默回落。 */
export function outputLanguageSemantics(language: OutputLanguage): OutputLanguageSemantics {
  return SEMANTICS[language];
}
