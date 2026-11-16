// 两个 hook 共用的 system 消息注入。
//
// `SkillsPromptHook` 与 `PlanningHook` 都在每次模型请求前，用各自的注释哨兵把一整段
// 文本替换进最前面的 system 消息。整段替换保证不会随轮数累积，两个哨兵互不干扰。
import type {ChatMessage} from '../chat.ts';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function injectSystemBlock(
  messages: ChatMessage[],
  open: string,
  close: string,
  block: string,
): void {
  if (messages.length === 0 || messages[0].role !== 'system') return;
  const system = messages[0];
  const original = system.content;
  const segment = block ? `${open}\n${block}\n${close}` : '';
  const pattern = new RegExp(`${escapeRegExp(open)}[\\s\\S]*?${escapeRegExp(close)}`, 'u');
  let updated: string;
  if (pattern.test(original)) {
    updated = original.replace(pattern, () => segment);
  } else if (!segment) {
    return;
  } else {
    const body = original.replace(/\s+$/u, '');
    updated = body ? `${body}\n\n${segment}` : segment;
  }
  messages[0] = {role: 'system', content: updated};
}
