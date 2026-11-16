// 草稿目标平台词表。
//
// 对应 `worker/worker_core/ai_prompts.py` 的 `_DRAFT_PLATFORM_LABELS`、
// `_DRAFT_PLATFORM_PASSTHROUGH_LABELS` 与 `DRAFT_PLATFORM_IDS`。主机在确认页给出
// 平台 id，提示词里用显示名；短视频系共用「抖音」文体，其余按显示名透传。
export const DRAFT_PLATFORM_LABELS: Readonly<Record<string, string>> = Object.freeze({
  wechat_official_account: '微信公众号',
  xiaohongshu: '小红书',
  wechat_channels: '抖音',
  douyin: '抖音',
  tiktok: '抖音',
});

export const DRAFT_PLATFORM_PASSTHROUGH_LABELS: Readonly<Record<string, string>> = Object.freeze({
  twitter: 'X(Twitter)',
  bilibili: 'B站',
  youtube: 'Youtube',
  other: '其他',
});

/** 与 Python 的 frozenset 同一批 id；顺序按映射表、透传表的书写顺序。 */
export const DRAFT_PLATFORM_IDS: readonly string[] = Object.freeze([
  ...Object.keys(DRAFT_PLATFORM_LABELS),
  ...Object.keys(DRAFT_PLATFORM_PASSTHROUGH_LABELS),
]);

export type DraftPlatform = keyof typeof DRAFT_PLATFORM_LABELS
  | keyof typeof DRAFT_PLATFORM_PASSTHROUGH_LABELS;

export function isDraftPlatform(value: unknown): value is DraftPlatform {
  return typeof value === 'string' && DRAFT_PLATFORM_IDS.includes(value);
}

/** 词表外的 id 原样透传；请求解析已在更前面拦住它们。 */
export function draftPlatformLabel(platformId: string): string {
  return DRAFT_PLATFORM_LABELS[platformId]
    ?? DRAFT_PLATFORM_PASSTHROUGH_LABELS[platformId]
    ?? platformId;
}
