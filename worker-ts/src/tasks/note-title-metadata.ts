// 笔记标题元数据：唯一一份校验规则。
//
// 对齐 `worker/worker_core/note_title_metadata.py` 的 `validate_note_title` /
// `parse_note_title_metadata`。生成侧要判断模型给的标题能不能用，存储侧要判断清单里的
// `note_title` 自不自洽——两边必须读同一份规则，否则会出现「写进去、下次打不开」的任务。
//
// 与 Python 的一处有意近似：`str.strip()` 用 `String.prototype.trim()`，Unicode 空白集合
// 有极小差异；标题同时禁止控制/格式字符，差异落不到正常输入上。
import {isOutputLanguage, type OutputLanguage} from '../ai/output-language.ts';

export type NoteTitleStatus = 'generating' | 'completed' | 'failed' | 'cancelled';

export interface NoteTitleMetadata {
  readonly text: string | null;
  readonly status: NoteTitleStatus;
  readonly output_language: OutputLanguage;
  readonly error_code: string | null;
}

const STATUSES = new Set(['generating', 'completed', 'failed', 'cancelled']);
const FIELDS = new Set(['text', 'status', 'output_language', 'error_code']);
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** `Cc` 控制、`Cf` 格式、`Cs` 代理、`Zl`/`Zp` 行/段分隔符（Python `unicodedata.category`）。 */
const FORBIDDEN_CHARACTER = /^[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]$/u;

export class InvalidNoteTitleMetadataError extends Error {
  constructor() {
    super('Note title metadata is invalid.');
    this.name = 'InvalidNoteTitleMetadataError';
  }
}

function invalid(): InvalidNoteTitleMetadataError {
  return new InvalidNoteTitleMetadataError();
}

/** 模型回复里的原始字符串也要查：裁剪后消失的控制字符同样不能被接受。 */
export function containsForbiddenTitleCharacter(text: string): boolean {
  for (const character of text) {
    if (FORBIDDEN_CHARACTER.test(character)) return true;
  }
  return false;
}

/** 标题正文：非空、已裁剪、≤60 码点、无控制/格式/分隔符类字符。 */
export function validateNoteTitleText(text: unknown): string {
  if (typeof text !== 'string' || text.length === 0) throw invalid();
  if (text !== text.trim()) throw invalid();
  if ([...text].length > 60) throw invalid();
  if (containsForbiddenTitleCharacter(text)) throw invalid();
  return text;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 严格解析：字段闭集、状态与错误码必须自洽。生成、落盘、读清单都走这里。 */
export function parseNoteTitleMetadata(value: unknown): NoteTitleMetadata {
  if (!isPlainObject(value)) throw invalid();
  const keys = Object.keys(value);
  if (keys.length !== FIELDS.size || !keys.every((key) => FIELDS.has(key))) throw invalid();

  const status = value.status;
  if (typeof status !== 'string' || !STATUSES.has(status)) throw invalid();
  const language = value.output_language;
  if (!isOutputLanguage(language)) throw invalid();
  const text = value.text === null ? null : validateNoteTitleText(value.text);
  const errorCode = value.error_code;

  if (status === 'generating' || status === 'completed') {
    if (errorCode !== null) throw invalid();
    if (status === 'completed' && text === null) throw invalid();
  } else if (typeof errorCode !== 'string' || !SAFE_CODE.test(errorCode)) {
    throw invalid();
  }
  return {
    text,
    status: status as NoteTitleStatus,
    output_language: language,
    error_code: errorCode as string | null,
  };
}
