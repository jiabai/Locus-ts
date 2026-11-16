// 重新生成时从磁盘读回已有 AI 产物。
//
// 这些读操作都是「宽松读」：文件缺失、结构不合规一律按「没有这份产物」处理，
// 不让整个重新生成失败。它们被多个 target 共用，所以放在 tasks 层，避免管线互相导入。
import {readFile} from 'node:fs/promises';

import {InvalidPreferenceSnapshotError, parsePreferenceSnapshot} from '../ai/preference-snapshot.ts';
import type {PreferenceSnapshot} from '../ai/preference-snapshot.ts';
import type {TaskPaths} from './paths.ts';
import type {Insight} from './types.ts';

export const MAX_INSIGHTS_BYTES = 8 * 1024 * 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readExistingSummary(paths: TaskPaths): Promise<string> {
  return readFile(paths.summaryPath, 'utf8')
    .then((text) => text.trim())
    .catch(() => '');
}

/** 偏好快照按写入时的同一套闭集严格解析；读不懂就退化成不做个性化。 */
export async function readExistingPreferenceSnapshot(
  paths: TaskPaths,
): Promise<PreferenceSnapshot | null> {
  let raw: string;
  try {
    raw = await readFile(paths.preferenceSnapshotPath, 'utf8');
  } catch {
    return null;
  }
  try {
    return parsePreferenceSnapshot(JSON.parse(raw));
  } catch (error) {
    if (error instanceof InvalidPreferenceSnapshotError) return null;
    return null;
  }
}

export async function readExistingInsights(paths: TaskPaths): Promise<Insight[]> {
  let raw: string;
  try {
    const bytes = await readFile(paths.insightsPath);
    if (bytes.byteLength > MAX_INSIGHTS_BYTES) return [];
    raw = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isPlainObject(parsed) || parsed.schemaVersion !== 1) return [];
  const rawInsights = parsed.insights;
  if (!Array.isArray(rawInsights)) return [];

  const insights: Insight[] = [];
  for (const item of rawInsights) {
    if (!isPlainObject(item)) return [];
    const id = item.id;
    const topic = typeof item.topic === 'string' ? item.topic.trim() : '';
    const matchReason = typeof item.matchReason === 'string' ? item.matchReason.trim() : '';
    const suitableUse = typeof item.suitableUse === 'string' ? item.suitableUse.trim() : '';
    const rawQuestions = item.followUpQuestions;
    if (typeof id !== 'number' || !Number.isInteger(id)) return [];
    if (typeof item.topic !== 'string' || typeof item.matchReason !== 'string') return [];
    if (typeof item.suitableUse !== 'string' || !Array.isArray(rawQuestions)) return [];
    const followUpQuestions = rawQuestions
      .filter((question): question is string => typeof question === 'string' && question.trim().length > 0)
      .map((question) => question.trim());
    const rawChunkId = item.sourceChunkId;
    if (rawChunkId !== null && rawChunkId !== undefined && typeof rawChunkId !== 'number') return [];
    if (topic.length === 0 || matchReason.length === 0 || followUpQuestions.length === 0) return [];
    if (suitableUse.length === 0) return [];
    insights.push({
      id,
      topic,
      matchReason,
      followUpQuestions,
      suitableUse,
      sourceChunkId: typeof rawChunkId === 'number' ? rawChunkId : null,
    });
  }
  return insights;
}
