use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub(crate) const OUTPUT_DIR_ENV: &str = "APP_OUTPUT_DIR";
pub(crate) const CACHE_DIR_ENV: &str = "APP_CACHE_DIR";
pub(crate) const MODEL_DIR_ENV: &str = "APP_MODEL_DIR";
pub(crate) const RESOURCE_DIR_ENV: &str = "APP_RESOURCE_DIR";
pub(crate) const YTDLP_PATH_ENV: &str = "APP_YTDLP_PATH";
pub(crate) const USER_DATA_DIR_ENV: &str = "APP_USER_DATA_DIR";
pub(crate) const PYTORCH_RUNTIME_DIR_ENV: &str = "APP_PYTORCH_RUNTIME_DIR";
pub(crate) const ALLOW_REAL_ASR_ENV: &str = "APP_ALLOW_REAL_ASR";
pub(crate) const MODELSCOPE_OFFLINE_ENV: &str = "MODELSCOPE_OFFLINE";
pub(crate) const AUDIO_REVIEW_CACHE_DIR_NAME: &str = ".app-audio-review";
#[cfg(test)]
pub(crate) const LEGACY_TEMP_DIR_NAME: &str = "work";
pub(crate) const DESKTOP_LOG_DIR_NAME: &str = "logs";
#[allow(dead_code)] // Consumed by the Task 3 facade before Task 4 runner wiring lands.
pub(crate) const ASR_DIAGNOSTIC_LOG_FILE_NAME: &str = "asr-model-download.log";

#[derive(Debug, Clone)]
pub(crate) struct RuntimePaths {
    pub(crate) resource_dir: PathBuf,
    pub(crate) user_data_dir: PathBuf,
}

pub(crate) fn resolve_runtime_paths(app: &AppHandle) -> Result<RuntimePaths, String> {
    resolve_fixed_paths(app)
}

pub(crate) fn resolve_fixed_paths(app: &AppHandle) -> Result<RuntimePaths, String> {
    let raw_resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    Ok(RuntimePaths {
        resource_dir: normalize_resource_dir(raw_resource_dir),
        user_data_dir: app
            .path()
            .app_local_data_dir()
            .map_err(|error| error.to_string())?,
    })
}

impl RuntimePaths {
    pub(crate) fn data_paths(&self) -> Result<crate::data_storage::DataPaths, String> {
        crate::data_storage::paths_for_config(&self.user_data_dir)
            .map_err(|error| error.to_string())
    }

    pub(crate) fn output_root(&self) -> Result<PathBuf, String> {
        Ok(self.data_paths()?.output_root)
    }

    pub(crate) fn cache_root(&self) -> Result<PathBuf, String> {
        Ok(self.data_paths()?.cache_root)
    }

    pub(crate) fn models_root(&self) -> Result<PathBuf, String> {
        Ok(self.data_paths()?.models_root)
    }

    pub(crate) fn runtime_root(&self) -> Result<PathBuf, String> {
        Ok(self.data_paths()?.runtime_root)
    }

    pub(crate) fn collections_path(&self) -> Result<PathBuf, String> {
        Ok(self.data_paths()?.collections_path)
    }
}

pub(crate) fn normalize_resource_dir(resource_dir: PathBuf) -> PathBuf {
    if resource_dir_has_runtime(&resource_dir) {
        return resource_dir;
    }

    let nested_resources = resource_dir.join("resources");
    if resource_dir_has_runtime(&nested_resources) {
        return nested_resources;
    }

    resource_dir
}

fn resource_dir_has_runtime(resource_dir: &Path) -> bool {
    bundled_python_path(resource_dir).is_file()
        || resource_dir.join("worker").is_dir()
        || resource_dir.join("bin").is_dir()
}

pub(crate) fn ensure_runtime_dirs(paths: &RuntimePaths) -> Result<(), String> {
    ensure_config_dirs(paths)?;
    let data = paths.data_paths()?;
    for root in [&data.output_root, &data.cache_root, &data.models_root, &data.runtime_root] {
        fs::create_dir_all(root).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(crate) fn ensure_config_dirs(paths: &RuntimePaths) -> Result<(), String> {
    fs::create_dir_all(paths.user_data_dir.join(DESKTOP_LOG_DIR_NAME))
        .map_err(|error| error.to_string())
}

pub(crate) fn bundled_python_path(resource_dir: &Path) -> PathBuf {
    if cfg!(windows) {
        resource_dir.join("python").join("python.exe")
    } else {
        resource_dir.join("python").join("bin").join("python3")
    }
}

/// 随包 Deno：`resources/bin/deno[.exe]`，与安装包脚本下载的那一份同路径。
pub(crate) fn bundled_deno_path(resource_dir: &Path) -> PathBuf {
    let name = if cfg!(windows) { "deno.exe" } else { "deno" };
    resource_dir.join("bin").join(name)
}

/// 随包官方 yt-dlp：Windows 是 `yt-dlp.exe`，macOS 是 universal 的 `yt-dlp_macos`。
pub(crate) fn bundled_ytdlp_path(resource_dir: &Path) -> PathBuf {
    let name = if cfg!(windows) {
        "yt-dlp.exe"
    } else if cfg!(target_os = "macos") {
        "yt-dlp_macos"
    } else {
        "yt-dlp"
    };
    resource_dir.join("bin").join(name)
}

/// 随包 TypeScript worker 根目录：`resources/worker-ts/`（`scripts/build-worker-ts.mjs` 组装）。
pub(crate) fn worker_ts_root(resource_dir: &Path) -> PathBuf {
    resource_dir.join("worker-ts")
}

pub(crate) const WORKER_TS_ENTRY: &str = "src/cli.ts";
/// 独立的存储校验入口（`python -m worker_core.storage_validation` 的 TS 等价物）。
pub(crate) const WORKER_TS_STORAGE_VALIDATION_ENTRY: &str = "src/storage-validation-main.ts";
pub(crate) const DENO_DIR_ENV: &str = "DENO_DIR";
pub(crate) const DENO_NO_UPDATE_CHECK_ENV: &str = "DENO_NO_UPDATE_CHECK";

/// Deno 运行 TypeScript worker 所需的最小权限集（2026-11-16 在 Windows x64 实测）：
/// 去掉 `--allow-env` 会让任务存储读不到 `APP_*` 而以 `TASK_STORAGE_UNAVAILABLE` 失败；
/// 去掉 `--allow-ffi` 让 ONNX 原生模块加载失败并报 `ASR_DEPENDENCY_MISSING`；
/// 去掉 `--allow-run` 让 ffprobe/ffmpeg 无法启动、媒体校验失败。
/// `--allow-net` 供模型下载与 URL 抓取，`--allow-read/write` 供任务目录与产物落盘。
const WORKER_TS_DENO_PERMISSIONS: &[&str] = &[
    "--allow-read",
    "--allow-write",
    "--allow-ffi",
    "--allow-run",
    "--allow-net",
    "--allow-env",
];

/// 一次 worker 启动所需的程序与前置参数。
///
/// 发行包里同时存在两代 worker：Python（`resources/python` + `resources/worker`）与
/// TypeScript（`resources/bin/deno` + `resources/worker-ts`）。资源齐全时优先用 TypeScript，
/// 缺失时回落到 Python，这样未重新打包的开发环境照旧可用，而发行包不需要两套分支。
#[derive(Clone, Debug)]
pub(crate) struct WorkerLaunch {
    pub(crate) program: PathBuf,
    /// Deno：`run --config <deno.json> <权限> <cli.ts>`；Python：空（`-m <module>` 由调用点拼）。
    pub(crate) runtime_args: Vec<String>,
    pub(crate) uses_deno: bool,
}

impl WorkerLaunch {
    /// 拼出一条完整的 worker 参数序列。
    ///
    /// `python_module` 只在 Python 分支使用，让 `storage_validation` 这类独立入口保持
    /// `-m worker_core.storage_validation`；Deno 分支只追加模式参数。
    pub(crate) fn args(&self, python_module: &str, mode_args: &[&str]) -> Vec<String> {
        let mut args = if self.uses_deno {
            self.runtime_args.clone()
        } else {
            vec!["-m".to_string(), python_module.to_string()]
        };
        args.extend(mode_args.iter().map(|value| (*value).to_string()));
        args
    }
}

/// 随包 TypeScript worker 是否可用：四件必需资产（Deno、`src/cli.ts`、`deno.json`、
/// `node_modules`）齐全才算数，缺一就回落到 Python。
///
/// 只检查存在性、不检查版本，是为了让「打包脚本没跑」与「打包脚本跑失败」都表现为
/// 明确的回落，而不是启动到一半才报一个看不懂的错误。
pub(crate) fn worker_ts_available(resource_dir: &Path) -> bool {
    bundled_deno_path(resource_dir).is_file()
        && worker_ts_root(resource_dir).join(WORKER_TS_ENTRY).is_file()
        && worker_ts_root(resource_dir).join("node_modules").is_dir()
        && worker_ts_root(resource_dir).join("deno.json").is_file()
}

pub(crate) fn python_worker_launch(resource_dir: &Path) -> WorkerLaunch {
    WorkerLaunch {
        program: bundled_python_path(resource_dir),
        runtime_args: Vec::new(),
        uses_deno: false,
    }
}

pub(crate) fn deno_worker_launch(resource_dir: &Path, entry: &str) -> WorkerLaunch {
    let root = worker_ts_root(resource_dir);
    let mut runtime_args = vec![
        "run".to_string(),
        "--config".to_string(),
        path_to_env_string(root.join("deno.json")),
    ];
    runtime_args.extend(WORKER_TS_DENO_PERMISSIONS.iter().map(|value| (*value).to_string()));
    runtime_args.push(path_to_env_string(root.join(entry)));
    WorkerLaunch {
        program: bundled_deno_path(resource_dir),
        runtime_args,
        uses_deno: true,
    }
}

/// 选取本次启动用的 worker。
///
/// `entry` 只对 Deno 分支有意义——Python 分支的入口由 `python_module` 决定，
/// 这样 `storage_validation` 这类独立入口不必为两代 worker 各写一套分支。
pub(crate) fn worker_launch(resource_dir: &Path, entry: &str) -> WorkerLaunch {
    if worker_ts_available(resource_dir) {
        deno_worker_launch(resource_dir, entry)
    } else {
        python_worker_launch(resource_dir)
    }
}

pub(crate) fn prepend_to_path(path: &Path) -> Result<String, String> {
    let existing_path = std::env::var_os("PATH").unwrap_or_default();
    let paths = std::iter::once(path.to_path_buf()).chain(std::env::split_paths(&existing_path));
    std::env::join_paths(paths)
        .map(|value| value.to_string_lossy().to_string())
        .map_err(|error| error.to_string())
}

pub(crate) fn path_to_env_string(path: impl AsRef<Path>) -> String {
    path.as_ref().to_string_lossy().replace('\\', "/")
}

/// Baseline environment every bundled worker Python process needs.
///
/// Real task commands (`worker_runtime::command`) and the BYOK connection
/// probe (`llm_providers::run_probe`) spawn the same bundled interpreter, so
/// these four entries live in one place instead of drifting between builders.
pub(crate) fn worker_python_bootstrap_env(resource_dir: &Path) -> Result<Vec<(String, String)>, String> {
    Ok(vec![
        ("PYTHONPATH".to_string(), path_to_env_string(resource_dir.join("worker"))),
        ("PYTHONUTF8".to_string(), "1".to_string()),
        ("PYTHONIOENCODING".to_string(), "utf-8".to_string()),
        ("PATH".to_string(), prepend_to_path(&resource_dir.join("bin"))?),
    ])
}

/// 两代 worker 的共同基础环境：随包 `bin/` 放在 PATH 最前（ffmpeg、ffprobe、yt-dlp 都在那里）。
///
/// Deno 分支不需要任何 `PYTHON*`；它额外要 `DENO_DIR` 指到用户数据目录下，让模块缓存
/// 落在自己的目录里（默认位置在 macOS/Linux 上是 `$HOME/.cache/deno`，发行包不该写那里），
/// 并关掉更新检查以免启动时多一次网络请求。
pub(crate) fn worker_runtime_bootstrap_env(
    paths: &RuntimePaths,
    uses_deno: bool,
) -> Result<Vec<(String, String)>, String> {
    if !uses_deno {
        return worker_python_bootstrap_env(&paths.resource_dir);
    }
    let mut env = vec![
        (
            "PATH".to_string(),
            prepend_to_path(&paths.resource_dir.join("bin"))?,
        ),
        (
            DENO_DIR_ENV.to_string(),
            path_to_env_string(paths.user_data_dir.join("deno")),
        ),
        (DENO_NO_UPDATE_CHECK_ENV.to_string(), "1".to_string()),
    ];
    // TS worker 不查 PATH，只认 `APP_YTDLP_PATH` 或 `<cwd>/bin/`。打包后用显式路径，
    // 让下载器解析不依赖启动目录；开发环境没有随包资产时保留外部环境变量。
    let ytdlp = bundled_ytdlp_path(&paths.resource_dir);
    if ytdlp.is_file() {
        env.push((YTDLP_PATH_ENV.to_string(), path_to_env_string(ytdlp)));
    }
    Ok(env)
}

#[cfg(test)]
mod tests {
    use super::{
        bundled_python_path, bundled_ytdlp_path, ensure_config_dirs, ensure_runtime_dirs,
        normalize_resource_dir, worker_runtime_bootstrap_env, RuntimePaths, LEGACY_TEMP_DIR_NAME,
        YTDLP_PATH_ENV,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn fixed_configuration_remains_available_when_storage_control_is_invalid() {
        let root = temp_dir("fixed_configuration_without_data");
        let paths = RuntimePaths { resource_dir: root.join("resources"), user_data_dir: root.join("config") };
        fs::create_dir_all(&paths.user_data_dir).expect("config root");
        fs::write(paths.user_data_dir.join("data-storage.json"), b"invalid storage control").expect("damaged control fixture");
        ensure_config_dirs(&paths).expect("fixed config service");
        assert!(paths.user_data_dir.join("logs").is_dir());
        assert!(ensure_runtime_dirs(&paths).is_err());
        for name in ["outputs", "cache", "models", "runtime"] {
            assert!(!paths.user_data_dir.join(name).exists());
        }
    }

    #[test]
    fn ensure_runtime_dirs_creates_app_local_cache_dir() {
        let root = temp_dir("ensure_runtime_dirs_creates_app_local_cache_dir");
        let paths = RuntimePaths {
            resource_dir: root.join("resources"),
            user_data_dir: root.join("user-data"),
        };
        let legacy_temp_dir = paths.user_data_dir.join(LEGACY_TEMP_DIR_NAME);
        fs::create_dir_all(&legacy_temp_dir).expect("create legacy temp dir");
        fs::write(legacy_temp_dir.join("history.json"), "{}").expect("write legacy temp file");

        ensure_runtime_dirs(&paths).expect("ensure runtime dirs");

        assert!(paths.user_data_dir.join("outputs").is_dir());
        assert!(paths.user_data_dir.join("cache").is_dir());
        assert!(paths.user_data_dir.join("logs").is_dir());
        assert!(legacy_temp_dir.join("history.json").is_file());
    }

    #[test]
    fn normalize_resource_dir_uses_packaged_resources_subdir_when_tauri_returns_install_root() {
        let root = temp_dir("normalize_resource_dir_uses_packaged_resources_subdir");
        let install_root = root.join("Locus");
        let resources = install_root.join("resources");
        let python = bundled_python_path(&resources);
        fs::create_dir_all(python.parent().expect("packaged python parent"))
            .expect("create packaged python dir");
        fs::write(python, "python").expect("write python");

        assert_eq!(normalize_resource_dir(install_root), resources);
    }

    #[test]
    fn deno_bootstrap_env_injects_the_bundled_ytdlp_path_when_present() {
        let root = temp_dir("deno_bootstrap_env_injects_ytdlp");
        let paths = RuntimePaths {
            resource_dir: root.join("resources"),
            user_data_dir: root.join("user-data"),
        };
        let ytdlp = bundled_ytdlp_path(&paths.resource_dir);
        fs::create_dir_all(ytdlp.parent().expect("yt-dlp parent")).expect("create bin");
        fs::write(&ytdlp, b"fake yt-dlp").expect("write yt-dlp");

        let env = worker_runtime_bootstrap_env(&paths, true).expect("bootstrap env");
        let value = env
            .iter()
            .find(|(key, _)| key == YTDLP_PATH_ENV)
            .map(|(_, value)| value.as_str());
        let expected = ytdlp.to_string_lossy().replace('\\', "/");

        assert_eq!(value, Some(expected.as_str()));
    }

    #[test]
    fn deno_bootstrap_env_leaves_ytdlp_unset_when_the_bundle_is_missing() {
        let root = temp_dir("deno_bootstrap_env_without_ytdlp");
        let paths = RuntimePaths {
            resource_dir: root.join("resources"),
            user_data_dir: root.join("user-data"),
        };

        let env = worker_runtime_bootstrap_env(&paths, true).expect("bootstrap env");

        assert!(!env.iter().any(|(key, _)| key == YTDLP_PATH_ENV));
    }

    fn temp_dir(test_name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../build/data-storage-acceptance")
            .join(format!("runtime-{test_name}-{unique}"));
        fs::create_dir_all(&dir).expect("create test dir");
        dir.canonicalize().expect("resolve test dir")
    }
}
