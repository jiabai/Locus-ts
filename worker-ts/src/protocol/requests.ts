// 宿主请求的解析。
//
// 对齐 `worker/worker_core/requests.py` 的 `parse_process_local_media_request`：
// 字段集合必须完全一致（多一个键也算非法），路径必须绝对，扩展名三处必须自洽。
// 这里不做任何「猜测用户意图」的修正——请求非法就是非法，让宿主收到明确失败。
import path from 'node:path';

import {DESKTOP_ASR_MODELS, VIDEO_EXTENSIONS, AUDIO_EXTENSIONS} from './contract.ts';
import {LOCAL_MEDIA_CONTRACT_VERSION} from './contract.ts';
import {isSafeLocalDisplayName} from '../tasks/local-source.ts';
import type {ProcessLocalMediaRequest} from '../pipeline/local-media.ts';

const LOCAL_MEDIA_REQUEST_FIELDS = new Set([
  'contract_version',
  'source_path',
  'media_kind',
  'safe_display_name',
  'source_extension',
  'asr_model',
]);

export class InvalidRequestError extends Error {
  constructor() {
    super('Local media request payload was invalid.');
    this.name = 'InvalidRequestError';
  }
}

function invalid(): InvalidRequestError {
  return new InvalidRequestError();
}

export function parseProcessLocalMediaRequest(payload: unknown): ProcessLocalMediaRequest {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw invalid();
  const fields = payload as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    if (!LOCAL_MEDIA_REQUEST_FIELDS.has(key)) throw invalid();
  }
  for (const key of LOCAL_MEDIA_REQUEST_FIELDS) {
    if (!(key in fields)) throw invalid();
  }

  // `typeof` 排除字符串版本号；`Number.isInteger` 排除 NaN 与小数。
  const contractVersion = fields.contract_version;
  if (typeof contractVersion !== 'number' || contractVersion !== LOCAL_MEDIA_CONTRACT_VERSION) {
    throw invalid();
  }

  const sourcePathValue = fields.source_path;
  if (typeof sourcePathValue !== 'string' || sourcePathValue.length === 0) throw invalid();
  if (!path.isAbsolute(sourcePathValue)) throw invalid();

  const mediaKind = fields.media_kind;
  if (mediaKind !== 'video' && mediaKind !== 'audio') throw invalid();

  const sourceExtension = fields.source_extension;
  if (typeof sourceExtension !== 'string') throw invalid();
  const allowedExtensions = mediaKind === 'video' ? VIDEO_EXTENSIONS : AUDIO_EXTENSIONS;
  if (!allowedExtensions.has(sourceExtension)) throw invalid();
  // 路径后缀与声明的扩展名不一致：宿主与 worker 对同一个文件的认知不同，必须拒止。
  if (path.extname(sourcePathValue).toLowerCase() !== `.${sourceExtension}`) throw invalid();

  const safeDisplayName = fields.safe_display_name;
  if (!isSafeDisplayName(safeDisplayName, sourceExtension)) throw invalid();

  const asrModel = fields.asr_model;
  if (typeof asrModel !== 'string' || !DESKTOP_ASR_MODELS.has(asrModel)) throw invalid();

  return {
    sourcePath: sourcePathValue,
    mediaKind,
    safeDisplayName: safeDisplayName as string,
    sourceExtension,
    asrModel,
  };
}

/**
 * 显示名要能安全地出现在界面、日志与清单里：单层 basename、无控制字符、
 * 无双向控制符（`U+202E` 之类能把 `.mp4` 显示成 `.pdf`）、后缀与扩展名一致。
 *
 * 判定实体在 `tasks/local-source.ts`：建任务与重新打开任务必须用同一套规则。
 */
export const isSafeDisplayName = isSafeLocalDisplayName;
