// 文字稿整理 agent：逐段单次文本补全，不用工具循环。
//
// 对齐 `worker/worker_core/transcript_polish.py`：按 MarkdownSplitter 切块，每段带
// 上一段的结尾做衔接上下文，模型只回这一段的整理正文。空回复退回原片段；
// 所有段都空才算失败。原 ASR 稿保持只读，整理稿是另一份文件。
//
// 这里与要点总结 / 启发灵感有一个关键差别：Python 用的是草稿 agent 的
// `build_llm_provider`，整次整理只 checkout 一次凭据、所有分段共享同一份 provider；
// 而 `createInsightLlm` 是每次 chat 都换一次临时凭证。若直接复用，24 段会扣 24 次额度，
// 所以下面单独实现 `createPolishLlm`。
import {createHash} from 'node:crypto';

import {chatCompletion} from './chat.ts';
import type {ChatFetch, ChatMessage} from './chat.ts';
import {
  checkoutManagedLlm,
  LLM_MAX_TOKENS_ENV,
  resolveInsightLlmConfig,
} from './config.ts';
import type {ModelEndpoint, Transport} from './config.ts';
import {MarkdownSplitter} from './transcript-chunks.ts';
import {buildWorkerProgressEvent} from '../protocol/events.ts';
import type {WorkerProgressEvent} from '../protocol/events.ts';

export const POLISH_CHUNK_CHARS = 2000;
export const POLISH_MAX_CHUNKS = 24;
export const POLISH_CONTEXT_CHARS = 200;
export const POLISH_META_SCHEMA_VERSION = 1;

/**
 * Python `POLISH_SYSTEM_PROMPT`；逐字复制。
 * 破折号与一字线的禁令是给下游排版 / 朗读用的，不能顺手改成连字符。
 */
export const POLISH_SYSTEM_PROMPT = '你是语音识别文字稿的整理助手。你会拿到一段由语音识别生成的文字稿片段。'
  + '请把它整理成忠实原意、读起来顺畅的文稿。'
  + '一、先修正语音识别造成的失真：同音与近音错字、漏字、多字重复、断句错误和标点错误。'
  + '二、删除不影响原意的口头语与填充词，比如「啊、呢、吧、嗯、就是说、对吧、这个、那个」，'
  + '以及重复啰嗦、没有信息量的表达。'
  + '三、按语义把内容划分成自然段落，每段围绕一个意思；不添加小标题、序号或任何标记。'
  + '四、不得改变原意，不得增删事实内容，不得推测并补写没说过的词句。'
  + '五、保留说话人的用词与专有名词、术语，不换成书面同义词，不润色，不升华。'
  + '六、保持原本的语言，不要翻译。'
  + '七、禁止使用破折号和一字线；并列用顿号，范围用「至」字连接。'
  + '八、只输出这一片段整理后的正文，不要加引号，也不要加任何解释。';

/** 原稿摘要：桌面端据此判断整理稿是否已过期。hash 的输入是 strip 后的正文，不含末尾换行。 */
export function sourceTranscriptSha256(body: string): string {
  return createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex');
}

/** Python `json.dumps(..., ensure_ascii=False, indent=2)` + 换行；值都是数字与 ASCII hex。 */
export function serializePolishMeta(body: string): string {
  return `${JSON.stringify({
    schemaVersion: POLISH_META_SCHEMA_VERSION,
    sourceTranscriptSha256: sourceTranscriptSha256(body),
  }, null, 2)}\n`;
}

export function chunkTranscript(body: string, maxChars: number = POLISH_CHUNK_CHARS): string[] {
  return new MarkdownSplitter(maxChars).split(body).map((chunk) => chunk.content);
}

/** Python 的 `str[-200:]` 按码点切片；JS 的 `slice()` 按 UTF-16 码元，含 emoji 时会切错。 */
function codePointTail(text: string, width: number): string {
  const points = Array.from(text);
  return points.slice(Math.max(0, points.length - width)).join('');
}

/** 每段提示词：上一段的结尾只作衔接，不要求模型修正或输出它。 */
export function buildPolishPrompt(index: number, chunks: readonly string[]): string {
  const preceding = index > 0 ? codePointTail(chunks[index - 1], POLISH_CONTEXT_CHARS) : '';
  const sections: string[] = [];
  if (preceding.length > 0) {
    sections.push(`以下是上一段的结尾，只用来衔接语气与专有名词，不要修正它，也不要输出它：\n${preceding}`);
  }
  sections.push(`以下是需要修正的第 ${index + 1} 段（共 ${chunks.length} 段）：\n${chunks[index]}`);
  return sections.join('\n\n');
}

/** 只需要「system + user → 文本」；不引入工具、不引入 response_format。 */
export interface PolishLlm {
  readonly textChat: (options: {
    readonly systemPrompt: string;
    readonly prompt: string;
  }) => Promise<string | null>;
}

export type PolishLlmFactory = (
  environ: Readonly<Record<string, string | undefined>>,
) => Promise<PolishLlm>;

export interface CreatePolishLlmOptions {
  readonly transport?: Transport;
  readonly fetchImpl?: ChatFetch;
  readonly signal?: AbortSignal;
}

/**
 * 一次 checkout，多段共享。
 *
 * Python 的 `resolve_draft_credentials` 在 `APP_LLM_SOURCE=server` 时只换一次临时凭据，
 * 然后把合并后的 env 交给 `build_llm_provider`。托管模式下 24 段若各 checkout 一次，
 * 计费会翻 24 倍——这不是模型行为差异，而是计费语义错误。
 */
export async function createPolishLlm(
  environ: Readonly<Record<string, string | undefined>>,
  options: CreatePolishLlmOptions = {},
): Promise<PolishLlm> {
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
  // 草稿 provider 只在显式配置 APP_LLM_MAX_TOKENS 时下发 max_tokens；其余调用仍带默认预算。
  const omitMaxTokens = (environ[LLM_MAX_TOKENS_ENV]?.trim() ?? '') === '';

  return {
    textChat: async ({systemPrompt, prompt}) => {
      const messages: ChatMessage[] = [
        {role: 'system', content: systemPrompt},
        {role: 'user', content: prompt},
      ];
      const completion = await chatCompletion({
        endpoint,
        messages,
        ...(omitMaxTokens ? {omitMaxTokens: true} : {}),
        ...(options.fetchImpl === undefined ? {} : {fetchImpl: options.fetchImpl}),
        ...(options.signal === undefined ? {} : {signal: options.signal}),
      });
      return completion.text;
    },
  };
}

export interface PolishChunksResult {
  readonly text: string;
  readonly emptyChunks: number;
}

/**
 * 逐段修正。
 *
 * 进度事件的 attempt / total 必须在 1 至 100（契约校验会拒止越界值），所以段数超过
 * 100 时归一化到 100，而不是把 index+1 直接写进事件里。
 */
export async function polishTranscriptChunks(options: {
  readonly chunks: readonly string[];
  readonly llm: PolishLlm;
  readonly onProgress?: (event: WorkerProgressEvent) => void;
}): Promise<PolishChunksResult> {
  const {chunks, llm} = options;
  const scale = Math.max(1, Math.min(100, chunks.length));
  const polished: string[] = [];
  let emptyChunks = 0;

  for (let index = 0; index < chunks.length; index += 1) {
    options.onProgress?.(buildWorkerProgressEvent('ai.generation.running', {
      stage: 'insights_generating',
      progress: 70 + Math.floor((index * 20) / chunks.length),
      messageArgs: {
        attempt: Math.max(1, Math.min(scale, index + 1)),
        total: scale,
      },
    }));

    const responseText = await llm.textChat({
      systemPrompt: POLISH_SYSTEM_PROMPT,
      prompt: buildPolishPrompt(index, chunks),
    });
    const text = (responseText ?? '').trim();
    if (text.length === 0) {
      // 单段没产出时退回原片段：宁可不修正，也不能静默丢内容。
      emptyChunks += 1;
      polished.push(chunks[index].trim());
    } else {
      polished.push(text);
    }
  }
  return {text: polished.filter((part) => part.length > 0).join('\n'), emptyChunks};
}

/** 全部段都没产出时返回空串，由上层判成 `POLISH_LLM_EMPTY_RESULT`。 */
export async function polishTranscriptWithLlm(options: {
  readonly chunks: readonly string[];
  readonly llm: PolishLlm;
  readonly onProgress?: (event: WorkerProgressEvent) => void;
}): Promise<string> {
  const {text, emptyChunks} = await polishTranscriptChunks(options);
  if (emptyChunks > 0 && emptyChunks === options.chunks.length) return '';
  return text;
}
