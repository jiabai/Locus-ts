// 存储校验探针：宿主在数据位置迁移前后各跑一次，用它对比「基线里的数据」与
// 「当前磁盘上的数据」是否一致。
//
// 对齐 `worker/worker_core/storage_validation.py` + `runtime_component.py`：
// 定位包内运行时清单 → 读 lock 指纹 → 判定 PyTorch 组件状态 → 数一遍就绪模型，
// 输出一行紧凑 JSON（`schema_version`/`ready_models`/`component_state`/
// `component_fingerprint`/`component_imported`），成功退出 0；失败写 stderr、
// 退出 1 且 stdout 必须为空；未知参数按用法错误退出 2。
//
// 与 Python 的唯一行为差异（计划第 6 条）：TypeScript 运行时不再导入 PyTorch，
// `--import-component` 一律按「组件对本运行时不可用」失败——宿主据此把基线里的
// 组件记为 unavailable，后续 verify 不再要求导入。
import path from 'node:path';
import {openSync, readSync, closeSync, statSync, readFileSync} from 'node:fs';

import {validateModelCache} from './asr/model-cache.ts';
import {
  MODEL_VERSION_FILE_NAME,
  ONNX_CACHE_DIR_NAME,
} from './asr/model-assets.ts';
import {MODEL_DIR_ENV} from './protocol/contract.ts';

/** PyTorch 组件目录与包内清单的环境变量，与 `runtime_component.py` 同值。 */
const COMPONENT_DIR_ENV = 'APP_PYTORCH_RUNTIME_DIR';
const BUNDLED_MANIFEST_ENV = 'APP_BUNDLED_RUNTIME_MANIFEST';
const RESOURCE_DIR_ENV = 'APP_RESOURCE_DIR';
const BUNDLED_MANIFEST_NAME = 'runtime-manifest.json';

/** PyTorch 时代的模型标识：探针仍要如实报告旧缓存是否就绪。 */
const PYTORCH_SENSEVOICE_MODEL_ID = 'iic/SenseVoiceSmall';
const PYTORCH_VAD_MODEL_ID = 'iic/speech_fsmn_vad_zh-cn-16k-common-pytorch';
/** 缓存目录里的 VAD 子目录名（不带 `iic/` 前缀），与 Python `_has_required_model_files_in_root` 一致。 */
const PYTORCH_VAD_DIR_NAME = 'speech_fsmn_vad_zh-cn-16k-common-pytorch';

/** torch 序列化文件的 zip 魔数，Python `_TORCH_MODEL_MAGIC` 同值。 */
const TORCH_MODEL_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export interface StorageInspection {
  readonly schema_version: 1;
  readonly ready_models: readonly string[];
  readonly component_state: 'ready' | 'missing' | 'stale' | 'ungated';
  readonly component_fingerprint: string | null;
  readonly component_imported: boolean;
}

export class StorageComponentUnavailableError extends Error {}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/** `runtime_component.resolve_component_dir`：未配置视为缺失。 */
export function resolveComponentDir(
  environ: Readonly<Record<string, string | undefined>>,
): string | null {
  const configured = (environ[COMPONENT_DIR_ENV] ?? '').trim();
  if (configured === '') return null;
  return configured;
}

/**
 * `runtime_component.locate_bundled_manifest`：显式覆盖 → 资源目录
 * （`python/` 子目录优先，构建脚本写在 resources/python/ 下）→ 项目根。
 * 找不到视为「未裁剪」，组件门禁不生效。
 */
export function locateBundledManifest(
  projectRoot: string,
  environ: Readonly<Record<string, string | undefined>>,
): string | null {
  const override = (environ[BUNDLED_MANIFEST_ENV] ?? '').trim();
  if (override !== '') return isFile(override) ? override : null;
  const resourceDir = (environ[RESOURCE_DIR_ENV] ?? '').trim();
  if (resourceDir !== '') {
    for (const candidate of [
      path.join(resourceDir, 'python', BUNDLED_MANIFEST_NAME),
      path.join(resourceDir, BUNDLED_MANIFEST_NAME),
    ]) {
      if (isFile(candidate)) return candidate;
    }
  }
  const candidate = path.join(projectRoot, BUNDLED_MANIFEST_NAME);
  return isFile(candidate) ? candidate : null;
}

/** `runtime_component.read_manifest_fingerprint`：损坏或字段异常一律 null。 */
export function readManifestFingerprint(manifestPath: string): string | null {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const fingerprint = (data as Record<string, unknown>).lock_fingerprint;
  if (typeof fingerprint !== 'string' || fingerprint.trim() === '') return null;
  return fingerprint;
}

/** `runtime_component.evaluate_component`：ungated / missing / stale / ready。 */
export function evaluateComponent(
  componentDir: string | null,
  bundledFingerprint: string | null,
): StorageInspection['component_state'] {
  if (bundledFingerprint === null) return 'ungated';
  if (componentDir === null || !isDirectory(componentDir)) return 'missing';
  const componentFingerprint = readManifestFingerprint(
    path.join(componentDir, BUNDLED_MANIFEST_NAME),
  );
  if (componentFingerprint === null) return 'missing';
  if (componentFingerprint !== bundledFingerprint) return 'stale';
  return 'ready';
}

/** Python `_is_plausible_torch_model_file`：存在、非空、以 zip 魔数开头。 */
function isPlausibleTorchModelFile(candidate: string): boolean {
  try {
    const info = statSync(candidate);
    if (!info.isFile() || info.size <= 0) return false;
    const handle = openSync(candidate, 'r');
    try {
      const head = Buffer.alloc(TORCH_MODEL_MAGIC.length);
      const read = readSync(handle, head, 0, head.length, 0);
      return head.subarray(0, read).equals(TORCH_MODEL_MAGIC);
    } finally {
      closeSync(handle);
    }
  } catch {
    return false;
  }
}

function hasRequiredTorchModelFilesInRoot(modelRoot: string): boolean {
  return isPlausibleTorchModelFile(path.join(modelRoot, 'iic', 'SenseVoiceSmall', 'model.pt'))
    && isPlausibleTorchModelFile(
      path.join(modelRoot, 'iic', PYTORCH_VAD_DIR_NAME, 'model.pt'),
    );
}

function hasRequiredTorchModelFiles(modelRoot: string): boolean {
  return hasRequiredTorchModelFilesInRoot(modelRoot)
    || hasRequiredTorchModelFilesInRoot(path.join(modelRoot, 'models'));
}

/** Python `validate_asr_model_cache` 的 PyTorch 分支：只读，绝不改写标记。 */
function pytorchModelReady(modelRoot: string): boolean {
  const markerPath = path.join(modelRoot, MODEL_VERSION_FILE_NAME);
  if (!isFile(markerPath) || !hasRequiredTorchModelFiles(modelRoot)) return false;
  let markerText: string;
  try {
    markerText = readFileSync(markerPath, 'utf8');
  } catch {
    return false;
  }
  return markerText.includes(PYTORCH_SENSEVOICE_MODEL_ID)
    && markerText.includes(PYTORCH_VAD_MODEL_ID);
}

/** Python `validate_asr_model_cache` 的 ONNX 分支：`<模型根>/onnx` 的固定哈希校验。 */
async function onnxModelReady(modelRoot: string): Promise<boolean> {
  const validation = await validateModelCache(path.join(modelRoot, ONNX_CACHE_DIR_NAME));
  return validation.valid;
}

export interface InspectStorageOptions {
  readonly importComponent?: boolean;
  /** 缺省读进程环境与 `process.cwd()`；测试注入以省掉环境变量。 */
  readonly environ?: Readonly<Record<string, string | undefined>>;
  readonly projectRoot?: string;
}

/** `storage_validation.inspect_storage`：探针的纯逻辑部分，不打印任何东西。 */
export async function inspectStorage(
  options: InspectStorageOptions = {},
): Promise<StorageInspection> {
  const environ = options.environ ?? process.env;
  const projectRoot = options.projectRoot ?? process.cwd();
  const manifest = locateBundledManifest(projectRoot, environ);
  const fingerprint = manifest === null ? null : readManifestFingerprint(manifest);
  const component = resolveComponentDir(environ);
  const state = evaluateComponent(component, fingerprint);
  if (options.importComponent === true) {
    // 计划第 6 条：TypeScript worker 不导入 PyTorch。组件对本运行时一律不可用；
    // 失败路径与 Python 的 "Storage component is unavailable" 同文案同退出语义。
    throw new StorageComponentUnavailableError('Storage component is unavailable');
  }
  const modelRoot = environ[MODEL_DIR_ENV];
  if (typeof modelRoot !== 'string') {
    // Python 用 os.environ["APP_MODEL_DIR"]：缺环境变量按 KeyError 失败退出。
    throw new Error(`${MODEL_DIR_ENV} is required for storage validation.`);
  }
  const readyModels: string[] = [];
  if (pytorchModelReady(modelRoot)) readyModels.push(PYTORCH_SENSEVOICE_MODEL_ID);
  if (await onnxModelReady(modelRoot)) readyModels.push('iic/SenseVoiceSmall-onnx');
  return {
    schema_version: 1,
    ready_models: readyModels,
    component_state: state,
    component_fingerprint: fingerprint,
    component_imported: false,
  };
}

/**
 * `storage_validation.main`：成功打一行紧凑 JSON 并退出 0；失败写 stderr 退出 1；
 * 未知参数按 argparse 用法错误退出 2。返回进程退出码。
 */
export async function runStorageValidationMain(
  argv: readonly string[],
  stdout: (line: string) => void,
  stderr: (line: string) => void,
): Promise<number> {
  let importComponent = false;
  for (const argument of argv) {
    if (argument === '--import-component') {
      importComponent = true;
    } else {
      stderr("usage: storage-validation [--import-component]");
      return 2;
    }
  }
  try {
    const result = await inspectStorage({importComponent});
    stdout(JSON.stringify(result));
    return 0;
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
