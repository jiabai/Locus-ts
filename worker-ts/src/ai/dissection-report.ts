// 文字稿解剖报告的数据模型、严格校验与产物渲染。
//
// 对齐 `worker/worker_core/dissection_report.py`：模型只交付语义部分，来源摘要
// （原稿 SHA-256、sourceLanguage、sourceChunks）由 worker 自己根据权威文字稿算出，
// 模型给不了、也不许改。校验是闭集的：多余字段、非顺序的段 id、非法的来源块 id、
// 不是原文逐字子串的 highlights 都要在交付时退回，让模型重新提交一次完整报告。
//
// `parsePersistedDissection` 用磁盘上的当前原稿重算来源摘要并与整份报告比对，
// 因此原稿被改过以后旧报告会被判成过期，界面不会把旧结论当成新稿的分析。
import {createHash} from 'node:crypto';

import {platformTextBytes} from '../artifacts/atomic-file.ts';
import {outputLanguageSemantics, type OutputLanguage} from './output-language.ts';
import {MarkdownSplitter, type MarkdownChunk} from './transcript-chunks.ts';

export type DissectionSourceKind = 'transcript' | 'article';

export interface DissectionSourceChunk {
  readonly id: number;
  readonly startByte: number;
  readonly endByte: number;
  readonly sha256: string;
}

export interface DissectionNarrative {
  readonly openingHook: string | null;
  readonly structureType: string;
  readonly turningPoint: string | null;
  readonly closingType: string | null;
}

export interface DissectionSegment {
  readonly id: number;
  readonly title: string;
  readonly sourceChunkIds: readonly number[];
  readonly coreClaim: string;
  readonly supportingPoints: readonly string[];
  readonly rhetoricalDevices: readonly string[];
  readonly rhythmNote: string;
  readonly reusablePattern: string;
  readonly riskFlags: readonly string[];
}

export interface DissectionTemplate {
  readonly name: string;
  readonly skeleton: readonly string[];
}

export interface DissectionAudienceFit {
  readonly audience: string;
  readonly fit: 'high' | 'medium' | 'low';
  readonly note: string;
}

export interface TranscriptDissection {
  readonly sourceTranscriptSha256: string;
  readonly sourceLanguage: string | null;
  readonly sourceKind: DissectionSourceKind;
  readonly sourceChunks: readonly DissectionSourceChunk[];
  readonly overallNarrative: DissectionNarrative;
  readonly segments: readonly DissectionSegment[];
  readonly highlights: readonly string[];
  readonly reusableTemplate: DissectionTemplate;
  readonly audienceFit: readonly DissectionAudienceFit[];
  readonly strengths: readonly string[];
  readonly weaknesses: readonly string[];
}

export interface DissectionArtifacts {
  readonly report: TranscriptDissection;
  readonly jsonBytes: Uint8Array;
  readonly markdownBytes: Uint8Array;
}

/** 交付校验失败：category 会作为工具反馈文本的一部分交给模型。 */
export class DissectionGenerationError extends Error {
  readonly code: string;
  readonly validationCategory: string | null;

  constructor(code: string, message: string, validationCategory: string | null = null) {
    super(message);
    this.name = 'DissectionGenerationError';
    this.code = code;
    this.validationCategory = validationCategory;
  }
}

/** 内部校验异常：detail 对应 Python `ValueError` 的文本，用来推导 category。 */
class ReportValidationError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(detail);
    this.name = 'ReportValidationError';
    this.detail = detail;
  }
}

function invalid(detail: string): ReportValidationError {
  return new ReportValidationError(detail);
}

const CATEGORY_BY_DETAIL: Readonly<Record<string, string>> = {
  'source references': 'source_references',
  'highlight provenance': 'quotation_provenance',
  'array length': 'collection_limits',
  'audience fit': 'enum_values',
};

function validationCategory(detail: string): string {
  return CATEGORY_BY_DETAIL[detail] ?? 'schema_shape';
}

const VALIDATION_FEEDBACK = 'Submit the complete report with exactly the required fields, '
  + 'valid sourceChunkIds and verbatim transcript quotations. '
  + 'Use only supplied transcript evidence.';

export function dissectionRejectionFeedback(error: DissectionGenerationError): string {
  const category = error.validationCategory ?? 'schema_shape';
  return `Report rejected. Validation category: ${category}. ${VALIDATION_FEEDBACK}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function closedObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(value)) throw invalid('closed object');
  const actual = Object.keys(value);
  if (actual.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) {
    throw invalid('closed object');
  }
  return value;
}

function arrayOf(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw invalid('array');
  return value;
}

/** Python `len(str)` 按码点计长；文本一律返回 strip 后的值。 */
function text(value: unknown): string {
  if (typeof value !== 'string' || Array.from(value).length > 4000) throw invalid('text');
  const normalized = value.trim();
  if (normalized.length === 0) throw invalid('text');
  const lowered = normalized.toLowerCase();
  if (lowered.includes('<script') || lowered.includes('javascript:')) throw invalid('text');
  return normalized;
}

function optionalText(value: unknown): string | null {
  return value === null ? null : text(value);
}

function textList(
  value: unknown,
  options: {readonly minimum?: number; readonly maximum?: number} = {},
): string[] {
  const values = arrayOf(value);
  if (values.length < (options.minimum ?? 0)) throw invalid('array length');
  if (options.maximum !== undefined && values.length > options.maximum) throw invalid('array length');
  return values.map((item) => text(item));
}

function integerList(value: unknown): number[] {
  const values = arrayOf(value);
  return values.map((item) => {
    // Python `type(item) is int` 会排除 bool；JS 的 typeof 判断天然排除了它。
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 1) {
      throw invalid('integer array');
    }
    return item;
  });
}

const SEMANTIC_KEYS = [
  'overallNarrative', 'segments', 'highlights', 'reusableTemplate',
  'audienceFit', 'strengths', 'weaknesses',
] as const;

const NARRATIVE_KEYS = ['openingHook', 'structureType', 'turningPoint', 'closingType'] as const;
const SEGMENT_KEYS = [
  'id', 'title', 'sourceChunkIds', 'coreClaim', 'supportingPoints',
  'rhetoricalDevices', 'rhythmNote', 'reusablePattern', 'riskFlags',
] as const;
const TEMPLATE_KEYS = ['name', 'skeleton'] as const;
const AUDIENCE_KEYS = ['audience', 'fit', 'note'] as const;

interface SemanticReport {
  readonly overallNarrative: DissectionNarrative;
  readonly segments: DissectionSegment[];
  readonly highlights: string[];
  readonly reusableTemplate: DissectionTemplate;
  readonly audienceFit: DissectionAudienceFit[];
  readonly strengths: string[];
  readonly weaknesses: string[];
}

/** 校验模型交付的语义报告；返回已裁剪、已归一化的结构。 */
function parseSemanticReport(
  payload: unknown,
  transcript: string,
  validChunkIds: ReadonlySet<number>,
): SemanticReport {
  const root = closedObject(payload, SEMANTIC_KEYS);
  const narrativeRaw = closedObject(root.overallNarrative, NARRATIVE_KEYS);
  const overallNarrative: DissectionNarrative = {
    openingHook: optionalText(narrativeRaw.openingHook),
    structureType: text(narrativeRaw.structureType),
    turningPoint: optionalText(narrativeRaw.turningPoint),
    closingType: optionalText(narrativeRaw.closingType),
  };

  const segmentValues = arrayOf(root.segments);
  if (segmentValues.length === 0) throw invalid('segments');
  const segments = segmentValues.map((value, position) => {
    const item = closedObject(value, SEGMENT_KEYS);
    const id = position + 1;
    if (typeof item.id !== 'number' || !Number.isInteger(item.id) || item.id !== id) {
      throw invalid('segment id');
    }
    const references = integerList(item.sourceChunkIds);
    const ascending = references.every((reference, index) => index === 0 || reference > references[index - 1]);
    if (references.length === 0 || !ascending
      || references.some((reference) => !validChunkIds.has(reference))) {
      throw invalid('source references');
    }
    return {
      id,
      title: text(item.title),
      sourceChunkIds: references,
      coreClaim: text(item.coreClaim),
      supportingPoints: textList(item.supportingPoints),
      rhetoricalDevices: textList(item.rhetoricalDevices),
      rhythmNote: text(item.rhythmNote),
      reusablePattern: text(item.reusablePattern),
      riskFlags: textList(item.riskFlags),
    } satisfies DissectionSegment;
  });

  const highlights = textList(root.highlights, {maximum: 8});
  if (highlights.some((highlight) => !transcript.includes(highlight))) {
    throw invalid('highlight provenance');
  }

  const templateRaw = closedObject(root.reusableTemplate, TEMPLATE_KEYS);
  const reusableTemplate: DissectionTemplate = {
    name: text(templateRaw.name),
    skeleton: textList(templateRaw.skeleton, {minimum: 3, maximum: 7}),
  };

  const audienceFit = arrayOf(root.audienceFit).map((value) => {
    const item = closedObject(value, AUDIENCE_KEYS);
    const fit = text(item.fit);
    if (fit !== 'high' && fit !== 'medium' && fit !== 'low') throw invalid('audience fit');
    return {
      audience: text(item.audience),
      fit,
      note: text(item.note),
    } satisfies DissectionAudienceFit;
  });

  return {
    overallNarrative,
    segments,
    highlights,
    reusableTemplate,
    audienceFit,
    strengths: textList(root.strengths, {maximum: 6}),
    weaknesses: textList(root.weaknesses, {maximum: 6}),
  };
}

export function dissectionToDict(report: TranscriptDissection): Record<string, unknown> {
  return {
    schemaVersion: report.sourceKind === 'article' ? 2 : 1,
    ...(report.sourceKind === 'article'
      ? {sourceKind: 'article', sourceTextSha256: report.sourceTranscriptSha256}
      : {sourceTranscriptSha256: report.sourceTranscriptSha256}),
    sourceLanguage: report.sourceLanguage,
    sourceChunks: report.sourceChunks.map((chunk) => ({
      id: chunk.id,
      startByte: chunk.startByte,
      endByte: chunk.endByte,
      sha256: chunk.sha256,
    })),
    overallNarrative: {
      openingHook: report.overallNarrative.openingHook,
      structureType: report.overallNarrative.structureType,
      turningPoint: report.overallNarrative.turningPoint,
      closingType: report.overallNarrative.closingType,
    },
    segments: report.segments.map((segment) => ({
      id: segment.id,
      title: segment.title,
      sourceChunkIds: [...segment.sourceChunkIds],
      coreClaim: segment.coreClaim,
      supportingPoints: [...segment.supportingPoints],
      rhetoricalDevices: [...segment.rhetoricalDevices],
      rhythmNote: segment.rhythmNote,
      reusablePattern: segment.reusablePattern,
      riskFlags: [...segment.riskFlags],
    })),
    highlights: [...report.highlights],
    reusableTemplate: {
      name: report.reusableTemplate.name,
      skeleton: [...report.reusableTemplate.skeleton],
    },
    audienceFit: report.audienceFit.map((item) => ({
      audience: item.audience,
      fit: item.fit,
      note: item.note,
    })),
    strengths: [...report.strengths],
    weaknesses: [...report.weaknesses],
  };
}

/** 来源摘要只从权威文字稿推导：模型给的 provenance 一律不接受。 */
export function parseDissectionReport(options: {
  readonly payload: unknown;
  readonly transcript: string;
  readonly chunks: readonly MarkdownChunk[];
  readonly sourceLanguage: string | null;
  readonly sourceKind?: DissectionSourceKind;
}): TranscriptDissection {
  const sourceKind = options.sourceKind ?? 'transcript';
  if (sourceKind !== 'transcript' && sourceKind !== 'article') {
    throw new Error('Dissection source kind is invalid.');
  }
  let semantic: SemanticReport;
  try {
    semantic = parseSemanticReport(
      options.payload,
      options.transcript,
      new Set(options.chunks.map((chunk) => chunk.id)),
    );
  } catch (error) {
    if (!(error instanceof ReportValidationError)) throw error;
    throw new DissectionGenerationError(
      'DISSECTION_INVALID_RESULT',
      'The dissection response did not match the required structure.',
      validationCategory(error.detail),
    );
  }
  return {
    sourceTranscriptSha256: createHash('sha256')
      .update(Buffer.from(options.transcript, 'utf8')).digest('hex'),
    sourceLanguage: options.sourceLanguage,
    sourceKind,
    sourceChunks: options.chunks.map((chunk) => ({
      id: chunk.id,
      startByte: chunk.startByte,
      endByte: chunk.endByte,
      sha256: chunk.sha256,
    })),
    ...semantic,
  };
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => deepEqual(value, right[index]));
  }
  if (isPlainObject(left) || isPlainObject(right)) {
    if (!isPlainObject(left) || !isPlainObject(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    // Python 的 dict 比较与键顺序无关，磁盘文件被手工重排过也仍然算同一份报告。
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
  }
  return false;
}

/**
 * 读回磁盘上的报告：用当前原稿重新切块、重算来源摘要，再与整份文件比对。
 * 任何字段被改过、原稿被换过都判成「没有可用报告」。
 */
export function parsePersistedDissection(options: {
  readonly payload: unknown;
  readonly transcript: string;
  readonly sourceKind?: DissectionSourceKind;
}): Record<string, unknown> {
  const sourceKind = options.sourceKind ?? 'transcript';
  try {
    const keys = [
      'schemaVersion',
      ...(sourceKind === 'article' ? ['sourceKind', 'sourceTextSha256'] : ['sourceTranscriptSha256']),
      'sourceLanguage', 'sourceChunks', ...SEMANTIC_KEYS,
    ];
    const root = closedObject(options.payload, keys);
    if (typeof root.schemaVersion !== 'number' || !Number.isInteger(root.schemaVersion)
      || root.schemaVersion !== (sourceKind === 'article' ? 2 : 1)) {
      throw invalid('schema version');
    }
    const sourceLanguage = root.sourceLanguage;
    if (sourceLanguage !== null
      && (typeof sourceLanguage !== 'string' || sourceLanguage.trim().length === 0)) {
      throw invalid('source language');
    }
    const semanticPayload: Record<string, unknown> = {};
    for (const key of SEMANTIC_KEYS) semanticPayload[key] = root[key];

    const report = parseDissectionReport({
      payload: semanticPayload,
      transcript: options.transcript,
      chunks: new MarkdownSplitter().split(options.transcript),
      sourceLanguage: sourceLanguage as string | null,
      sourceKind,
    });
    const rebuilt = dissectionToDict(report);
    if (!deepEqual(rebuilt, root)) throw invalid('provenance');
    return rebuilt;
  } catch (error) {
    if (error instanceof DissectionGenerationError) throw error;
    throw new DissectionGenerationError(
      'DISSECTION_INVALID_RESULT',
      'The saved dissection artifact is invalid.',
    );
  }
}

interface MarkdownLabels {
  readonly title: string;
  readonly narrative: string;
  readonly openingHook: string;
  readonly structureType: string;
  readonly turningPoint: string;
  readonly closingType: string;
  readonly segments: string;
  readonly coreClaim: string;
  readonly supportingPoints: string;
  readonly rhetoricalDevices: string;
  readonly rhythm: string;
  readonly reusablePattern: string;
  readonly riskFlags: string;
  readonly sourceChunks: string;
  readonly template: string;
  readonly highlights: string;
  readonly audienceFit: string;
  readonly fit: string;
  readonly note: string;
  readonly strengths: string;
  readonly weaknesses: string;
  readonly fitHigh: string;
  readonly fitMedium: string;
  readonly fitLow: string;
  readonly separator: string;
}

const LABELS: Readonly<Record<OutputLanguage, MarkdownLabels>> = {
  'zh-CN': {
    title: '文字稿解剖', narrative: '整体叙事', openingHook: '开头钩子',
    structureType: '推进结构', turningPoint: '转折', closingType: '收尾',
    segments: '分段结构', coreClaim: '核心论点', supportingPoints: '支撑点',
    rhetoricalDevices: '表达手法', rhythm: '节奏', reusablePattern: '可复用模式',
    riskFlags: '风险标记', sourceChunks: '引用片段', template: '可复用骨架',
    highlights: '亮点', audienceFit: '受众适配', fit: '适配度', note: '说明',
    strengths: '优势', weaknesses: '不足', fitHigh: '高', fitMedium: '中', fitLow: '低',
    separator: '：',
  },
  'zh-TW': {
    title: '逐字稿解剖', narrative: '整體敘事', openingHook: '開頭鉤子',
    structureType: '推進結構', turningPoint: '轉折', closingType: '收尾',
    segments: '分段結構', coreClaim: '核心論點', supportingPoints: '支持點',
    rhetoricalDevices: '表達手法', rhythm: '節奏', reusablePattern: '可重用模式',
    riskFlags: '風險標記', sourceChunks: '引用片段', template: '可重用骨架',
    highlights: '亮點', audienceFit: '受眾適配', fit: '適配度', note: '說明',
    strengths: '優勢', weaknesses: '不足', fitHigh: '高', fitMedium: '中', fitLow: '低',
    separator: '：',
  },
  'en-US': {
    title: 'Transcript Dissection', narrative: 'Overall Narrative', openingHook: 'Opening hook',
    structureType: 'Structure', turningPoint: 'Turning point', closingType: 'Closing',
    segments: 'Segments', coreClaim: 'Core claim', supportingPoints: 'Supporting points',
    rhetoricalDevices: 'Rhetorical devices', rhythm: 'Rhythm', reusablePattern: 'Reusable pattern',
    riskFlags: 'Risk flags', sourceChunks: 'Source chunks', template: 'Reusable template',
    highlights: 'Highlights', audienceFit: 'Audience fit', fit: 'Fit', note: 'Note',
    strengths: 'Strengths', weaknesses: 'Weaknesses', fitHigh: 'High', fitMedium: 'Medium',
    fitLow: 'Low', separator: ': ',
  },
};

function appendField(lines: string[], label: string, value: string | null | undefined, separator: string): void {
  if (value !== null && value !== undefined) lines.push(`- ${label}${separator}${value}`);
}

function appendList(lines: string[], heading: string, values: readonly string[], level: number): void {
  if (values.length === 0) return;
  lines.push(`${'#'.repeat(level)} ${heading}`, '', ...values.map((value) => `- ${value}`), '');
}

/** 三语 Markdown 渲染：标签与换行都按 Python `format_dissection_markdown`。 */
export function formatDissectionMarkdown(
  report: TranscriptDissection,
  outputLanguage: OutputLanguage,
): string {
  // 语义表在这里只用于校验语言取值；标签表是解剖报告自己的一份。
  outputLanguageSemantics(outputLanguage);
  const base = LABELS[outputLanguage];
  const labels: MarkdownLabels = {
    ...base,
    ...(report.sourceKind === 'article'
      ? {
        title: {
          'zh-CN': '正文解剖', 'zh-TW': '正文解剖', 'en-US': 'Article Dissection',
        }[outputLanguage],
      }
      : {}),
  };
  const narrative = report.overallNarrative;
  const lines = [`# ${labels.title}`, '', `## ${labels.narrative}`, ''];
  appendField(lines, labels.openingHook, narrative.openingHook, labels.separator);
  appendField(lines, labels.structureType, narrative.structureType, labels.separator);
  appendField(lines, labels.turningPoint, narrative.turningPoint, labels.separator);
  appendField(lines, labels.closingType, narrative.closingType, labels.separator);
  lines.push('', `## ${labels.segments}`, '');
  for (const segment of report.segments) {
    lines.push(`### ${segment.id}. ${segment.title}`, '');
    appendField(lines, labels.coreClaim, segment.coreClaim, labels.separator);
    appendList(lines, labels.supportingPoints, segment.supportingPoints, 4);
    appendList(lines, labels.rhetoricalDevices, segment.rhetoricalDevices, 4);
    appendField(lines, labels.rhythm, segment.rhythmNote, labels.separator);
    appendField(lines, labels.reusablePattern, segment.reusablePattern, labels.separator);
    appendList(lines, labels.riskFlags, segment.riskFlags, 4);
    appendField(lines, labels.sourceChunks, segment.sourceChunkIds.join(', '), labels.separator);
    lines.push('');
  }
  lines.push(
    `## ${labels.template}`, '', `**${report.reusableTemplate.name}**`, '',
    ...report.reusableTemplate.skeleton.map((step, index) => `${index + 1}. ${step}`), '',
  );
  appendList(lines, labels.highlights, report.highlights, 2);
  if (report.audienceFit.length > 0) {
    lines.push(`## ${labels.audienceFit}`, '');
    const fitLabels = {high: labels.fitHigh, medium: labels.fitMedium, low: labels.fitLow};
    for (const item of report.audienceFit) {
      lines.push(
        `### ${item.audience}`, '',
        `- ${labels.fit}${labels.separator}${fitLabels[item.fit]}`,
        `- ${labels.note}${labels.separator}${item.note}`, '',
      );
    }
  }
  appendList(lines, labels.strengths, report.strengths, 2);
  appendList(lines, labels.weaknesses, report.weaknesses, 2);
  return `${lines.join('\n').trimEnd()}\n`;
}

/** 两个产物文件：`ai/dissection.json` 与 `ai/dissection.md`，字节与 Python 相同。 */
export function buildDissectionArtifacts(
  report: TranscriptDissection,
  outputLanguage: OutputLanguage,
): DissectionArtifacts {
  return {
    report,
    // Python 的 `json.dumps(indent=2)` 不带末尾换行；Markdown 渲染自带一个换行。
    jsonBytes: platformTextBytes(JSON.stringify(dissectionToDict(report), null, 2)),
    markdownBytes: platformTextBytes(formatDissectionMarkdown(report, outputLanguage)),
  };
}

export const DISSECTION_JSON_DESTINATION = 'ai/dissection.json';
export const DISSECTION_MARKDOWN_DESTINATION = 'ai/dissection.md';
