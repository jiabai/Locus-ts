// 最小的工具调用循环。
//
// 三个 agent（要点总结、启发灵感、文字稿解剖）在 Python 侧跑在 `agent_runtime` 的
// `ToolLoopAgentRunner` 上，用的能力其实只有四样：多轮对话、function 工具调用、
// 「工具返回 None 即交付完成」、以及每轮之间可以替换工具集（先交导图、再交摘要）。
// 这里只实现这四样，不移植 SDK 的图片上下文、溢出文件、模型回退等未使用的特性。
import type {ChatCompletion, ChatMessage, ToolCall, ToolSpec} from './chat.ts';

export interface ToolHandlerContext {
  readonly toolName: string;
  /** 已经解析好的参数对象；模型给的参数不是 JSON 对象时不会走到这里。 */
  readonly args: Record<string, unknown>;
  readonly call: ToolCall;
}

/**
 * 工具处理器。返回 `null` 表示「交付完成」——对应 Python 里 handler 返回 `None`
 * 让运行器立刻收尾；返回字符串则作为工具结果回填给模型。
 */
export type ToolHandler = (
  context: ToolHandlerContext,
) => Promise<string | null> | string | null;

export interface Tool extends ToolSpec {
  readonly handler: ToolHandler;
}

export interface ToolEndEvent {
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly args: Record<string, unknown> | null;
  readonly result: string | null;
  /** 可变：钩子可以在这里换掉下一轮要提供的工具集。 */
  readonly tools: Tool[];
  readonly messages: ChatMessage[];
}

export interface BeforeCompleteEvent {
  readonly completion: ChatCompletion;
  readonly tools: Tool[];
  readonly messages: ChatMessage[];
}

export interface ToolLoopOptions {
  readonly chat: (messages: readonly ChatMessage[], tools: readonly ToolSpec[]) => Promise<ChatCompletion>;
  /** 起始消息（system + user）；循环会在同一个数组上追加。 */
  readonly messages: ChatMessage[];
  readonly tools: Tool[];
  readonly maxTurns: number;
  /**
   * 每次向模型发起请求之前调用（含空回复的重试）。解剖 agent 用它发
   * `ai.generation.running`，草稿 agent 用它注入技能清单与计划状态。
   */
  readonly onChatRequest?: (event: {
    readonly messages: ChatMessage[];
    readonly tools: Tool[];
  }) => void | Promise<void>;
  /** 空回复（既没有文本也没有工具调用）的重试次数；Python 侧 `StrictInsightRunner` 是 1。 */
  readonly emptyOutputRetries?: number;
  /** 每次工具执行后调用。 */
  readonly onToolEnd?: (event: ToolEndEvent) => void | Promise<void>;
  /**
   * 模型只回文本、没有调用工具时调用。返回 true 表示「这一轮可以结束」，
   * 返回 false 则追加一条催促消息继续下一轮（Python 的 `on_before_complete`）。
   */
  readonly onBeforeComplete?: (event: BeforeCompleteEvent) => boolean | Promise<boolean>;
  /**
   * 催促语。各 agent 会指名还差哪个工具，所以允许覆盖；默认是一个不含工具名的通用句。
   */
  readonly incompleteNudge?: (event: {readonly tools: readonly Tool[]; readonly messages: readonly ChatMessage[]}) => string;
}

export interface ToolLoopOutcome {
  /** 是否有工具把结果标记成「交付完成」。 */
  readonly delivered: boolean;
  readonly turns: number;
  readonly messages: readonly ChatMessage[];
  readonly lastCompletion: ChatCompletion | null;
}

const INCOMPLETE_NUDGE =
  'Delivery is incomplete. Call the required tool to submit the artifact. '
  + 'Do not finish with a plain reply.';

export async function runToolLoop(options: ToolLoopOptions): Promise<ToolLoopOutcome> {
  if (!Number.isInteger(options.maxTurns) || options.maxTurns < 1) {
    throw new Error('Tool loop max turns must be a positive integer.');
  }
  const emptyOutputRetries = options.emptyOutputRetries ?? 1;
  const messages = options.messages;
  const tools = [...options.tools];
  let lastCompletion: ChatCompletion | null = null;

  for (let turn = 1; turn <= options.maxTurns; turn += 1) {
    await options.onChatRequest?.({messages, tools});
    let completion = await options.chat(messages, tools);
    // 空回复只重试不追加上下文：模型没有产出，加上去也只会污染后续对话。
    for (let retry = 0; retry < emptyOutputRetries && isEmpty(completion); retry += 1) {
      await options.onChatRequest?.({messages, tools});
      completion = await options.chat(messages, tools);
    }
    lastCompletion = completion;

    if (isEmpty(completion)) {
      // 重试完仍然空：与 Python 一致，最终由调用方按「请求失败」处理。
      return {delivered: false, turns: turn, messages, lastCompletion};
    }

    messages.push({
      role: 'assistant',
      content: completion.text,
      toolCalls: completion.toolCalls,
    });

    if (completion.toolCalls.length === 0) {
      const finished = options.onBeforeComplete === undefined
        ? false
        : await options.onBeforeComplete({completion, tools, messages});
      if (finished) return {delivered: true, turns: turn, messages, lastCompletion};
      const nudge = options.incompleteNudge?.({tools, messages}) ?? INCOMPLETE_NUDGE;
      messages.push({role: 'user', content: nudge});
      continue;
    }

    for (const call of completion.toolCalls) {
      const tool = tools.find((candidate) => candidate.name === call.name);
      if (tool === undefined) {
        // 模型编了个工具名：告诉它没有这个工具，让它自己纠正，不中断循环。
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: `Unknown tool: ${call.name}. Use only the provided tools.`,
        });
        continue;
      }

      const args = parseArguments(call.arguments);
      if (args === null) {
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: 'Invalid tool arguments: expected a JSON object matching the tool schema.',
        });
        continue;
      }

      const result = await tool.handler({toolName: call.name, args, call});
      await options.onToolEnd?.({tool, call, args, result, tools, messages});
      if (result === null) {
        // 交付完成：不再回填工具结果，也不再发起下一次模型调用。
        return {delivered: true, turns: turn, messages, lastCompletion};
      }
      messages.push({role: 'tool', toolCallId: call.id, content: result});
    }
  }

  return {delivered: false, turns: options.maxTurns, messages, lastCompletion};
}

function isEmpty(completion: ChatCompletion): boolean {
  const text = completion.text ?? '';
  return text.trim().length === 0 && completion.toolCalls.length === 0;
}

function parseArguments(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
