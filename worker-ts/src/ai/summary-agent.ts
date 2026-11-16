// 要点总结 agent：先交导图，再交摘要。
//
// 对齐 `worker/worker_core/summary_agent.py`：一次运行里两段交付——
// 模型先调 `submit_mindmap` 交 Mermaid 源，工具返回后我们换掉工具集并追加摘要任务，
// 模型再调 `submit_summary` 交 Markdown 摘要；成功后工具返回「完成」信号，不再多要一轮。
// 归一化规则（补标题、补换行、校验 mindmap 根行）也必须一致，否则同一份模型输出
// 在两侧会落成不同的文件。
import {buildMindmapPrompt, buildSummaryPrompt, type SourceKind} from './prompts.ts';
import {commitInsightPayloads} from './artifacts.ts';
import {InsightGenerationError} from './errors.ts';
import {outputLanguageSemantics, type OutputLanguage} from './output-language.ts';
import type {ChatMessage} from './chat.ts';
import type {Tool, ToolLoopOutcome} from './tool-loop.ts';
import {platformTextBytes} from '../artifacts/atomic-file.ts';
import path from 'node:path';

export const SUMMARY_AGENT_MAX_TURNS = 6;

const SUMMARY_SYSTEM_PROMPT = 'You are the key summary agent. First call submit_mindmap to deliver the '
  + 'mindmap; after the follow-up summary task arrives, call submit_summary to '
  + 'deliver the summary. Deliver artifacts only through the currently provided '
  + 'tool. Do not put artifacts in a plain reply or finish early.';

export interface SummaryDelivery {
  mindmap: string;
  summary: string;
}

/** `InsightLlm.complete` 需要的东西；单独列出来是为了不让本模块依赖整个工厂。 */
export interface SummaryAgentRuntime {
  complete(options: {
    readonly messages: ChatMessage[];
    readonly tools: Tool[];
    readonly maxTurns: number;
    /** 每次模型请求之前调用；解剖 agent 用它发进度事件。 */
    readonly onChatRequest?: () => void | Promise<void>;
    readonly onToolEnd?: (event: {
      readonly tool: Tool;
      readonly tools: Tool[];
      readonly messages: ChatMessage[];
    }) => void | Promise<void>;
    readonly onBeforeComplete?: (event: {
      readonly tools: Tool[];
      readonly messages: ChatMessage[];
    }) => boolean | Promise<boolean>;
    readonly incompleteNudge?: (event: {
      readonly tools: readonly Tool[];
      readonly messages: readonly ChatMessage[];
    }) => string;
  }): Promise<ToolLoopOutcome>;
}

/** 去掉 Markdown 代码围栏；模型经常把整段内容裹在 ``` 里。 */
function stripCodeFence(text: string): string {
  const stripped = text.trim();
  if (!stripped.startsWith('```')) return stripped;
  const lines = stripped.split('\n');
  if (lines.length >= 2 && lines[lines.length - 1].trim() === '```') {
    return lines.slice(1, -1).join('\n').trim();
  }
  return stripped;
}

/**
 * 摘要归一化：必须有 `#` 开头的标题，缺了就按语言补一个；结尾统一一个换行。
 * 没有标题的摘要直接显示会出现「正文从二级标题开始」的断头文档。
 */
export function normalizeSummaryMarkdown(
  rawSummary: string,
  outputLanguage: OutputLanguage,
): string {
  let summary = stripCodeFence(rawSummary).trim();
  if (summary.length === 0) return '';
  if (!summary.startsWith('#')) {
    summary = `# ${outputLanguageSemantics(outputLanguage).summaryTitle}\n\n${summary}`;
  }
  return `${summary.replace(/\s+$/, '')}\n`;
}

/** 导图归一化：必须有独立的 `mindmap` 根行，之前的解释文字一律丢掉。 */
export function normalizeMermaidMindmap(rawMindmap: string): string {
  const mindmap = stripCodeFence(rawMindmap).replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim();
  if (mindmap.length === 0) return '';

  const lines = mindmap.split('\n').filter((line) => line.trim().length > 0).map((line) => line.replace(/\s+$/, ''));
  const startIndex = lines.findIndex((line) => line.trim() === 'mindmap');
  if (startIndex === -1) return '';
  const normalized = lines.slice(startIndex).join('\n').trim();
  return normalized.length === 0 ? '' : `${normalized}\n`;
}

export interface SummaryArtifacts {
  readonly summary: string;
  readonly mindmap: string;
  readonly summaryPath: string;
  readonly mindmapPath: string;
  readonly summaryBytes: Uint8Array;
  readonly mindmapBytes: Uint8Array;
}

export interface WriteSummaryOptions {
  readonly summary: string;
  readonly mindmap: string;
  readonly outputDir: string;
  readonly outputStem: string;
  readonly outputLanguage: OutputLanguage;
  /** false 时只归一化并返回字节，不落盘（诊断与预览用）。 */
  readonly persist?: boolean;
}

export async function writeSummaryFiles(options: WriteSummaryOptions): Promise<SummaryArtifacts> {
  const summary = normalizeSummaryMarkdown(options.summary, options.outputLanguage);
  const mindmap = normalizeMermaidMindmap(options.mindmap);
  if (summary.length === 0) {
    throw new InsightGenerationError('AI_EMPTY_SUMMARY', 'Summary agent returned an empty summary.');
  }
  if (mindmap.length === 0) {
    throw new InsightGenerationError('AI_INVALID_MINDMAP', 'Summary agent returned an invalid Mermaid mindmap.');
  }

  const stem = options.outputStem;
  const summaryPath = path.join(options.outputDir, stem === '' ? 'summary.md' : `${stem}_summary.md`);
  const mindmapPath = path.join(options.outputDir, stem === '' ? 'mindmap.mmd' : `${stem}_mindmap.mmd`);
  const summaryBytes = platformTextBytes(summary);
  const mindmapBytes = platformTextBytes(mindmap);

  if (options.persist !== false) {
    await commitInsightPayloads({
      outputDir: options.outputDir,
      outputStem: stem,
      payloads: [
        {path: summaryPath, bytes: summaryBytes},
        {path: mindmapPath, bytes: mindmapBytes},
      ],
    });
  }

  return {summary, mindmap, summaryPath, mindmapPath, summaryBytes, mindmapBytes};
}

export interface GenerateSummaryOptions {
  readonly markdown: string;
  readonly outputLanguage: OutputLanguage;
  readonly llm: SummaryAgentRuntime;
  readonly sourceKind?: SourceKind;
  readonly maxTurns?: number;
}

/** 跑一次「导图 → 摘要」的双段交付，返回归一化后的两份内容。 */
export async function generateSummary(
  options: GenerateSummaryOptions,
): Promise<{readonly summary: string; readonly mindmap: string}> {
  if (options.markdown.trim().length === 0) {
    throw new InsightGenerationError('AI_EMPTY_TRANSCRIPT', 'Transcript is empty.');
  }
  const maxTurns = options.maxTurns ?? SUMMARY_AGENT_MAX_TURNS;
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > SUMMARY_AGENT_MAX_TURNS) {
    throw new Error(`Summary max_turns must be an integer from 1 through ${SUMMARY_AGENT_MAX_TURNS}.`);
  }
  const outputLanguage = options.outputLanguage;
  const sourceKind = options.sourceKind ?? 'transcript';
  const delivery: SummaryDelivery = {mindmap: '', summary: ''};
  const messages: ChatMessage[] = [
    {role: 'system', content: SUMMARY_SYSTEM_PROMPT},
    {
      role: 'user',
      content: buildMindmapPrompt(options.markdown, outputLanguage, sourceKind),
    },
  ];

  const tools: Tool[] = [buildMindmapTool(delivery)];
  await options.llm.complete({
    messages,
    tools,
    maxTurns,
    // 交出导图后就换阶段：工具集换成摘要工具，并追加摘要任务（Python 的 on_tool_end）。
    onToolEnd: ({tool, tools: live, messages: liveMessages}) => {
      if (tool.name !== 'submit_mindmap' || delivery.mindmap.length === 0) return;
      live.splice(0, live.length, buildSummaryTool(delivery, outputLanguage));
      liveMessages.push({
        role: 'user',
        content: buildSummaryPrompt(options.markdown, delivery.mindmap, outputLanguage, sourceKind),
      });
    },
    onBeforeComplete: () => {
      if (delivery.mindmap.length > 0 && delivery.summary.length > 0) return true;
      return false;
    },
    // 催促语要点名还差哪个工具：只说「不完整」模型会继续闲聊。
    incompleteNudge: () => {
      const required = delivery.mindmap.length > 0 ? 'submit_summary' : 'submit_mindmap';
      return `Delivery is incomplete. Call the ${required} tool to submit `
        + 'the artifact. Do not finish with a plain reply.';
    },
  });

  if (!delivery.mindmap) {
    // 循环耗尽仍未交出导图：与 Python 同码同文案。
    throw new InsightGenerationError(
      'AI_INVALID_MINDMAP',
      'Summary agent did not deliver a valid Mermaid mindmap.',
    );
  }
  if (!delivery.summary) {
    throw new InsightGenerationError('AI_EMPTY_SUMMARY', 'Summary agent did not deliver a summary.');
  }
  return {summary: delivery.summary, mindmap: delivery.mindmap};
}

function buildMindmapTool(delivery: SummaryDelivery): Tool {
  return {
    name: 'submit_mindmap',
    description: 'Submit the complete Mermaid mindmap source derived from the transcript.',
    parameters: {
      type: 'object',
      properties: {
        mermaid: {
          type: 'string',
          description: 'Complete Mermaid source beginning with the mindmap root line',
        },
      },
      required: ['mermaid'],
    },
    handler: ({args}) => {
      const mermaid = args.mermaid;
      if (typeof mermaid !== 'string') {
        return 'Invalid mindmap: submit a non-empty Mermaid mindmap string.';
      }
      const normalized = normalizeMermaidMindmap(mermaid);
      if (normalized.length === 0) {
        return 'Invalid mindmap: submit non-empty Mermaid mindmap source containing a '
          + 'standalone mindmap root line.';
      }
      delivery.mindmap = normalized;
      return 'Mindmap accepted. The system will next provide the summary task '
        + 'and submit_summary tool.';
    },
  };
}

function buildSummaryTool(delivery: SummaryDelivery, outputLanguage: OutputLanguage): Tool {
  return {
    name: 'submit_summary',
    description: 'Submit the final Markdown key summary; a valid submission finishes this run.',
    parameters: {
      type: 'object',
      properties: {
        markdown: {
          type: 'string',
          description: 'Complete Markdown key summary ready for direct display',
        },
      },
      required: ['markdown'],
    },
    handler: ({args}) => {
      const markdown = args.markdown;
      if (typeof markdown !== 'string') return 'The summary must be a non-empty Markdown string.';
      const normalized = normalizeSummaryMarkdown(markdown, outputLanguage);
      if (normalized.length === 0) return 'The summary is empty: submit the complete Markdown key summary.';
      delivery.summary = normalized;
      // 返回 null 即「交付完成」：不再多要一轮模型调用。
      return null;
    },
  };
}
