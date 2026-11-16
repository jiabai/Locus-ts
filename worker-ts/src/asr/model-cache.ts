// 模型缓存定位与完整性校验。只读；下载与写入仍由模型准备模块负责。
//
// 目录布局与 <数据根>/models/onnx 完全一致，因此 TypeScript worker 可以直接读取
// 用户已有的缓存，不需要重新下载模型。
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile, stat} from 'node:fs/promises';
import path from 'node:path';

import {ASRModelCacheUnavailableError, ASRModelNotDownloadedError} from './errors.ts';
import {
  ASR_MODEL_DIR,
  MODEL_VERSION_FILE_NAME,
  ONNX_CACHE_DIR_NAME,
  VAD_MODEL_DIR,
  expectedMarkerModels,
  pinnedAssetHashes,
} from './model-assets.ts';
import type {SupportedAsrModel} from './types.ts';

export interface AssetProblem {
  readonly relativePath: string;
  readonly reason: 'missing' | 'not_a_file' | 'sha256_mismatch' | 'unreadable';
  readonly expected: string;
  readonly actual?: string;
}

export interface CacheValidation {
  readonly valid: boolean;
  readonly cacheDir: string;
  /** 就绪标记存在但内容不匹配时为 false。 */
  readonly markerValid: boolean;
  readonly problems: readonly AssetProblem[];
}

/** `<数据根>/models/onnx`，与 Rust 侧 `asr_model_cache_dir` 的拼法一致。 */
export function resolveModelCacheDir(dataRoot: string): string {
  return path.join(dataRoot, 'models', ONNX_CACHE_DIR_NAME);
}

export function requiredAssetPaths(): readonly string[] {
  return Object.keys(pinnedAssetHashes());
}

/**
 * 流式计算 SHA-256。缓存里有 241 MB 的 `model_quant.onnx`，整读进内存没有意义，
 * 启动校验与下载后校验都走这一条。
 */
export async function fileSha256(filePath: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    digest.update(chunk as Buffer);
  }
  return digest.digest('hex');
}

async function readMarker(cacheDir: string): Promise<string | null> {
  try {
    return await readFile(path.join(cacheDir, MODEL_VERSION_FILE_NAME), 'utf8');
  } catch {
    return null;
  }
}

/**
 * 校验缓存是否可直接使用。不抛错：调用方可能只想展示「未下载」状态。
 * 缺文件、哈希不符、标记不匹配都算不可用，与 Python 的 `_validate_onnx_model_cache` 一致。
 */
export async function validateModelCache(
  cacheDir: string,
  assetHashes: Readonly<Record<string, string>> = pinnedAssetHashes(),
): Promise<CacheValidation> {
  const problems: AssetProblem[] = [];
  const pinned = assetHashes;

  for (const [relativePath, expected] of Object.entries(pinned)) {
    const filePath = path.join(cacheDir, relativePath);
    let info;
    try {
      info = await stat(filePath);
    } catch {
      problems.push({relativePath, reason: 'missing', expected});
      continue;
    }
    if (!info.isFile()) {
      problems.push({relativePath, reason: 'not_a_file', expected});
      continue;
    }
    let actual: string;
    try {
      actual = await fileSha256(filePath);
    } catch {
      problems.push({relativePath, reason: 'unreadable', expected});
      continue;
    }
    if (actual !== expected) problems.push({relativePath, reason: 'sha256_mismatch', expected, actual});
  }

  const marker = await readMarker(cacheDir);
  const markerValid = marker !== null
    && expectedMarkerModels().every((model) => marker.includes(model));

  return {valid: problems.length === 0 && markerValid, cacheDir, markerValid, problems};
}

function describeProblems(validation: CacheValidation): string {
  const parts = validation.problems.map((problem) => (problem.reason === 'sha256_mismatch'
    ? `${problem.relativePath} SHA-256 ${problem.actual} != ${problem.expected}`
    : `${problem.relativePath} ${problem.reason}`));
  if (!validation.markerValid) {
    parts.push(`${MODEL_VERSION_FILE_NAME} 缺失或未记录 ${expectedMarkerModels().join(' / ')}`);
  }
  return parts.join('; ');
}

/** 校验失败时抛出与 Python 同码的错误，`detail` 保留具体原因供诊断。 */
export async function assertModelCacheReady(
  cacheDir: string,
  model: SupportedAsrModel,
): Promise<CacheValidation> {
  const validation = await validateModelCache(cacheDir);
  if (validation.valid) return validation;
  throw new ASRModelNotDownloadedError(
    `${model} model is not downloaded yet.`,
    `${cacheDir}: ${describeProblems(validation)}`,
  );
}

/** 缓存目录本身不可读时区分出「环境问题」，不要报成「模型没下载」。 */
export async function assertCacheDirReadable(cacheDir: string): Promise<void> {
  try {
    await stat(cacheDir);
  } catch (error) {
    throw new ASRModelCacheUnavailableError(
      'ASR model cache directory is not readable.',
      `${cacheDir}: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`,
    );
  }
}

export function modelFilePaths(cacheDir: string): {
  asrDir: string;
  vadDir: string;
  asrModel: string;
  vadModel: string;
} {
  const asrDir = path.join(cacheDir, ASR_MODEL_DIR);
  const vadDir = path.join(cacheDir, VAD_MODEL_DIR);
  return {
    asrDir,
    vadDir,
    asrModel: path.join(asrDir, 'model_quant.onnx'),
    vadModel: path.join(vadDir, 'model_quant.onnx'),
  };
}
