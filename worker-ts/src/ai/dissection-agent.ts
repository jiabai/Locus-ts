// 文字稿解剖 agent：单工具交付一份带来源摘要的完整报告。
//
// 对齐 `worker/worker_core/dissection_agent.py`：文字稿按 2000 码点切块（最多 16 块），
// 模型只能用 `submit_dissection` 交付；校验不通过时工具返回带 category 的反馈文本让模型
// 重交，6 轮内没交出合规报告就失败。每次向模型发起请求前发一条
// `ai.generation.running`（attempt/total 固定按轮数归一化），宿主据此判断进程还活着。
import {
  DissectionGenerationError,
  dissectionRejectionFeedback,
  parseDissectionReport,
  type TranscriptDissection,
} from './dissection-report.ts';
import type {DissectionSourceKind} from './dissection-report.ts';
import {isOutputLanguage, type OutputLanguage} from './output-language.ts';
import {buildDissectionAgentPrompt} from './prompts.ts';
import {MarkdownSplitter} from './transcript-chunks.ts';
import type {SummaryAgentRuntime} from './summary-agent.ts';
import type {ChatMessage, ToolSpec} from './chat.ts';
import type {Tool} from './tool-loop.ts';
import {buildWorkerProgressEvent} from '../protocol/events.ts';
import type {WorkerProgressEvent} from '../protocol/events.ts';

export const DISSECTION_AGENT_MAX_TURNS = 6;
export const MAX_DISSECTION_CHUNKS = 16;

const DISSECTION_SYSTEM_PROMPT = 'You are the transcript dissection agent. Analyze the supplied '
  + 'transcript and deliver the complete report using submit_dissection. Resolve any validation '
  + 'feedback using the transcript, then resubmit. Plain replies do not deliver a report.';

const INCOMPLETE_NUDGE = 'Delivery is incomplete. Call submit_dissection with the complete report.';

const REPORT_PROPERTIES = {
  overallNarrative: {type: 'object'},
  segments: {type: 'array', items: {type: 'object'}, minItems: 1},
  highlights: {type: 'array', items: {type: 'string'}, maxItems: 8},
  reusableTemplate: {type: 'object'},
  audienceFit: {type: 'array', items: {type: 'object'}},
  strengths: {type: 'array', items: {type: 'string'}, maxItems: 6},
  weaknesses: {type: 'array', items: {type: 'string'}, maxItems: 6},
};

/** 交给模型的 function schema；闭集在 `parseDissectionReport` 里再严格校验一遍。 */
export const SUBMIT_DISSECTION_TOOL_SPEC: ToolSpec = {
  name: 'submit_dissection',
  description: 'Submit the complete transcript dissection report; acceptance finishes this run.',
  parameters: {
    type: 'object',
    properties: {
      report: {
        type: 'object',
        properties: REPORT_PROPERTIES,
        required: Object.keys(REPORT_PROPERTIES),
        additionalProperties: false,
        description: 'Complete semantic report following the exact prompt schema.',
      },
    },
    required: ['report'],
    additionalProperties: false,
  },
};

export interface GenerateDissectionOptions {
  /** 权威文字稿原文，不裁剪：报告里的来源摘要按它的字节与切块结果算。 */
  readonly transcript: string;
  readonly outputLanguage: OutputLanguage;
  readonly sourceLanguage: string | null;
  readonly llm: SummaryAgentRuntime;
  readonly sourceKind?: DissectionSourceKind;
  readonly maxTurns?: number;
  readonly onProgress?: (event: WorkerProgressEvent) => void;
}

export async function generateDissection(
  options: GenerateDissectionOptions,
): Promise<TranscriptDissection> {
  const maxTurns = options.maxTurns ?? DISSECTION_AGENT_MAX_TURNS;
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > DISSECTION_AGENT_MAX_TURNS) {
    throw new Error('Dissection max turns must be an integer from 1 through 6.');
  }
  if (options.transcript.trim().length === 0) {
    throw new DissectionGenerationError(
      'DISSECTION_EMPTY_TRANSCRIPT', 'The saved transcript is empty.',
    );
  }
  if (!isOutputLanguage(options.outputLanguage)) {
    throw new Error('Dissection output language is invalid.');
  }
  const sourceKind: DissectionSourceKind = options.sourceKind ?? 'transcript';
  const chunks = new MarkdownSplitter().split(options.transcript);
  if (chunks.length > MAX_DISSECTION_CHUNKS) {
    throw new DissectionGenerationError(
      'DISSECTION_TRANSCRIPT_TOO_LARGE', 'The saved transcript exceeds the dissection source limit.',
    );
  }

  let delivered: TranscriptDissection | null = null;
  const tool: Tool = {
    ...SUBMIT_DISSECTION_TOOL_SPEC,
    handler: ({args}) => {
      try {
        delivered = parseDissectionReport({
          payload: args.report,
          transcript: options.transcript,
          chunks,
          sourceLanguage: options.sourceLanguage,
          sourceKind,
        });
        return null;
      } catch (error) {
        if (!(error instanceof DissectionGenerationError)) throw error;
        return dissectionRejectionFeedback(error);
      }
    },
  };

  const messages: ChatMessage[] = [
    {role: 'system', content: DISSECTION_SYSTEM_PROMPT},
    {
      role: 'user',
      content: buildDissectionAgentPrompt(chunks, options.outputLanguage, sourceKind),
    },
  ];

  let calls = 0;
  await options.llm.complete({
    messages,
    tools: [tool],
    maxTurns,
    onChatRequest: () => {
      calls += 1;
      // 6 轮之外还可能因空回复重试再多请求一次；attempt 封顶在上限内，
      // 契约校验要求 attempt <= total <= 100。
      const attempt = Math.min(calls, maxTurns);
      options.onProgress?.(buildWorkerProgressEvent('ai.generation.running', {
        stage: 'insights_generating',
        progress: 70 + Math.floor(((attempt - 1) * 20) / maxTurns),
        messageArgs: {attempt, total: maxTurns},
      }));
    },
    onBeforeComplete: () => delivered !== null,
    incompleteNudge: () => INCOMPLETE_NUDGE,
  });

  if (delivered === null) {
    throw new DissectionGenerationError(
      'DISSECTION_INVALID_RESULT',
      'The transcript dissection agent did not deliver a valid report within its budget.',
    );
  }
  return delivered;
}
