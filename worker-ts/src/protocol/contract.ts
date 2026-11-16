// worker 与桌面宿主之间的线协议常量与序列化。
//
// 全部来自 `contracts/desktop-worker-contract.json` 与 `worker/worker_core/desktop_contract.py`：
// 前缀、契约版本、环境变量名、stdin 上限。宿主按前缀分流 stderr，按单行 JSON 读 stdout，
// 任何一处改动都必须先改契约再改这里。
export const PROGRESS_EVENT_PREFIX = 'APP_PROGRESS ';
export const MODEL_DOWNLOAD_EVENT_PREFIX = 'APP_MODEL_DOWNLOAD ';
export const DIAGNOSTIC_EVENT_PREFIX = 'APP_DIAGNOSTIC ';

export const DESKTOP_WORKER_CONTRACT_VERSION = 12;
export const LOCAL_MEDIA_CONTRACT_VERSION = 4;
export const PROCESS_VIDEO_CONTRACT_VERSION = 3;

/** 一次 stdin 请求的上限。超过即视为非法请求，不去尝试部分解析。 */
export const MAX_STDIN_REQUEST_BYTES = 1024 * 1024;

export const OUTPUT_DIR_ENV = 'APP_OUTPUT_DIR';
export const CACHE_DIR_ENV = 'APP_CACHE_DIR';
export const ASR_MODEL_ENV = 'APP_ASR_MODEL';
export const MODEL_DIR_ENV = 'APP_MODEL_DIR';
/** 宿主注入的官方独立 yt-dlp 可执行文件路径；未注入时回落 `<projectRoot>/bin/<资产名>`。 */
export const YTDLP_PATH_ENV = 'APP_YTDLP_PATH';

/** 契约 `localMedia.extensionsByKind`；扩展名与媒体类型的匹配规则以此为准。 */
export const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  'mp4', 'm4v', 'mov', 'mkv', 'avi', 'wmv', 'webm',
]);
export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma',
]);

/** 契约 `localMedia.workerRequest.asr_model` 的闭集。 */
export const DESKTOP_ASR_MODELS: ReadonlySet<string> = new Set([
  'iic/SenseVoiceSmall',
  'iic/SenseVoiceSmall-onnx',
]);

/** 错误码要能安全地进日志与界面：`^[A-Z][A-Z0-9_]{0,63}$`。 */
const SAFE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export function isSafeErrorCode(code: string): boolean {
  return SAFE_ERROR_CODE_PATTERN.test(code);
}

/**
 * 单行 JSON。Python 侧用 `json.dumps(..., ensure_ascii=True)`，这里把非 ASCII 一并转义，
 * 让 stdout 的字节形状与旧 worker 一致，宿主不需要区分两代输出。
 */
export function jsonLine(payload: unknown): string {
  return JSON.stringify(payload).replace(
    /[\u007f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
