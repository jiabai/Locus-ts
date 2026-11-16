#!/usr/bin/env node

import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { chmod, copyFile, cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { buildSystemWebViewHost } from "./build-system-webview-host.mjs";
import {
  WORKER_TS_RESOURCE_DIR,
  prepareWorkerTsRuntime,
} from "./build-worker-ts.mjs";

const validTargets = new Set(["windows-x64", "macos-arm64"]);
const defaultDenoVersion = "v2.9.1";
const defaultYtdlpVersion = "2026.10.26";
const ytdlpSha256ByTarget = {
  "windows-x64": "f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d",
  "macos-arm64": "0f922c15ccc0b83eefa1c8bc9104e434318c4bf16e408e1ee93b7745a6efe0aa",
};

export function assertSupportedTarget(target) {
  if (!validTargets.has(target)) {
    throw new Error(`Unsupported target: ${target}`);
  }
}
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const appRoot = join(repoRoot, "app");
const tauriRoot = join(appRoot, "src-tauri");
const resourcesRoot = join(tauriRoot, "resources");

// 归档一律用 Windows 自带的 bsdtar（System32）：本地 Git Bash 的 GNU tar 会把
// `D:/...` 当成远程主机（"Cannot connect to D: resolve failed"），也不支持
// `-a` 按扩展名打包 zip。CI 与本机都直接给绝对路径，绕开 PATH 差异。
const tarCommand =
  process.platform === "win32"
    ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";

export function parseArgs(argv) {
  const options = {
    target: "windows-x64",
    pythonStandaloneUrl: process.env.APP_PYTHON_STANDALONE_URL ?? "",
    ffmpegArchiveUrl: process.env.APP_FFMPEG_ARCHIVE_URL ?? "",
    ffprobeArchiveUrl: process.env.APP_FFPROBE_ARCHIVE_URL ?? "",
    denoArchiveUrl: process.env.APP_DENO_ARCHIVE_URL ?? "",
    denoVersion: process.env.APP_DENO_VERSION ?? defaultDenoVersion,
    ytdlpUrl: process.env.APP_YTDLP_URL ?? "",
    skipDownloads: false,
    skipTauriBuild: false,
    requireWorkerTs: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const rawArg = argv[index];
    const [flag, inlineValue] = rawArg.includes("=") ? rawArg.split(/=(.*)/s, 2) : [rawArg, undefined];
    const normalized = flag.toLowerCase();
    const readValue = () => {
      if (inlineValue !== undefined) {
        return inlineValue;
      }
      index += 1;
      if (index >= argv.length) {
        throw new Error(`Missing value for ${flag}`);
      }
      return argv[index];
    };

    switch (normalized) {
      case "--target":
      case "-target":
        options.target = readValue();
        break;
      case "--python-standalone-url":
      case "-pythonstandaloneurl":
        options.pythonStandaloneUrl = readValue();
        break;
      case "--ffmpeg-archive-url":
      case "-ffmpegarchiveurl":
        options.ffmpegArchiveUrl = readValue();
        break;
      case "--ffprobe-archive-url":
      case "-ffprobearchiveurl":
        options.ffprobeArchiveUrl = readValue();
        break;
      case "--deno-archive-url":
      case "-denoarchiveurl":
        options.denoArchiveUrl = readValue();
        break;
      case "--deno-version":
      case "-denoversion":
        options.denoVersion = normalizeDenoVersion(readValue());
        break;
      case "--ytdlp-url":
      case "-ytdlpurl":
        options.ytdlpUrl = readValue();
        break;
      case "--skip-downloads":
      case "-skipdownloads":
        options.skipDownloads = true;
        break;
      case "--skip-tauri-build":
      case "-skiptauribuild":
        options.skipTauriBuild = true;
        break;
      case "--require-worker-ts":
      case "-requireworkerts":
        options.requireWorkerTs = true;
        break;
      default:
        throw new Error(`Unknown argument: ${rawArg}`);
    }
  }

  if (!validTargets.has(options.target)) {
    throw new Error(`Unsupported target: ${options.target}`);
  }
  options.denoVersion = normalizeDenoVersion(options.denoVersion);

  return options;
}

const pythonRoot = join(resourcesRoot, "python");
const workerRoot = join(resourcesRoot, "worker");
const binRoot = join(resourcesRoot, "bin");

async function resetDirectory(path) {
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
}

function requireFileOrUrl(value, name) {
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is required. Pass the parameter or set the matching APP_* environment variable.`);
  }
}

function normalizeDenoVersion(version) {
  const trimmed = version.trim();
  if (!trimmed) {
    throw new Error("DenoVersion is required.");
  }
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

function commandName(name) {
  if (process.platform === "win32" && name === "npm") {
    return `${name}.cmd`;
  }
  return name;
}

function run(command, args, description, extraOptions = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, ...(extraOptions.env ?? {}) },
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${description} failed with exit code ${result.status}.`);
  }
}

async function ensureGitKeep(path) {
  await writeFile(join(path, ".gitkeep"), "\n");
}

async function downloadArchive(url, destination) {
  console.log(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

function getArchiveLeafName(value, fallbackName) {
  if (existsSync(value)) {
    return basename(value);
  }

  try {
    const leaf = basename(new URL(value).pathname);
    return leaf || fallbackName;
  } catch {
    return fallbackName;
  }
}

async function prepareArchiveInput(value, destinationDirectory, fallbackName) {
  // Isolate each archive in its own directory keyed by the (unique) fallback
  // name. URLs can share a leaf name — for example evermeet's .../ffmpeg/zip and
  // .../ffprobe/zip both end in "zip" — and without isolation the second
  // download would overwrite the first, silently swapping ffmpeg for ffprobe.
  const isolatedDirectory = join(destinationDirectory, basename(fallbackName, ".archive"));
  await mkdir(isolatedDirectory, { recursive: true });
  const archivePath = join(isolatedDirectory, getArchiveLeafName(value, fallbackName));
  if (existsSync(value)) {
    await copyFile(value, archivePath);
  } else {
    await downloadArchive(value, archivePath);
  }
  return archivePath;
}

async function expandArchiveFile(archive, destination) {
  await mkdir(destination, { recursive: true });
  run(tarCommand, ["-xf", archive, "-C", destination], `Extract archive ${archive}`);
}

async function copyDirectoryContents(source, destination) {
  if (!existsSync(source)) {
    throw new Error(`Source directory not found: ${source}`);
  }

  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  await Promise.all(
    entries.map((entry) => cp(join(source, entry.name), join(destination, entry.name), { recursive: true, force: true })),
  );
}

async function walkFiles(root) {
  const files = [];
  if (!existsSync(root)) {
    return files;
  }

  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(entryPath)));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(entryPath);
    }
  }
  return files;
}

async function walkDirectories(root) {
  const directories = [];
  if (!existsSync(root)) {
    return directories;
  }

  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) {
      directories.push(entryPath, ...(await walkDirectories(entryPath)));
    }
  }
  return directories;
}

async function findFirstFile(root, names) {
  const wanted = new Set(names);
  for (const file of await walkFiles(root)) {
    if (wanted.has(basename(file))) {
      return file;
    }
  }
  return undefined;
}

async function removePythonCaches(root) {
  for (const file of await walkFiles(root)) {
    if (file.endsWith(".pyc") || file.endsWith(".pyo")) {
      await rm(file, { force: true });
    }
  }

  const directories = await walkDirectories(root);
  await Promise.all(
    directories
      .filter((directory) => basename(directory) === "__pycache__")
      .sort((left, right) => right.length - left.length)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
}

async function copyWorkerRuntime(destination) {
  await resetDirectory(destination);
  await ensureGitKeep(destination);
  await copyDirectoryContents(join(repoRoot, "worker", "worker_core"), join(destination, "worker_core"));
  await removePythonCaches(destination);
}

async function findVersionedUnixPythonLauncher(binDirectory) {
  if (!existsSync(binDirectory)) {
    return undefined;
  }

  // python-build-standalone ships the real interpreter as python3.<minor>
  // (for example python3.12) with python/python3 as symlinks to it. Match the
  // minor-version launcher without pinning a specific CPython minor, so bumping
  // the bundled standalone does not silently break launcher normalization here.
  const entries = await readdir(binDirectory);
  return entries
    .filter((name) => /^python3\.\d+$/.test(name))
    .sort()
    .at(-1);
}

async function findPythonExecutable(root) {
  const windowsPython = join(root, "python.exe");
  if (existsSync(windowsPython)) {
    return windowsPython;
  }

  const binDirectory = join(root, "bin");
  const unixPython = join(binDirectory, "python3");
  if (existsSync(unixPython)) {
    return unixPython;
  }

  const versionedLauncher = await findVersionedUnixPythonLauncher(binDirectory);
  if (versionedLauncher) {
    return join(binDirectory, versionedLauncher);
  }

  throw new Error(`Could not find bundled Python executable under ${root}`);
}

export async function normalizeUnixPythonLaunchers(root) {
  const binDirectory = join(root, "bin");
  const versionedLauncher = await findVersionedUnixPythonLauncher(binDirectory);
  if (!versionedLauncher) {
    return;
  }

  for (const launcherName of ["python", "python3"]) {
    const launcherPath = join(binDirectory, launcherName);
    await rm(launcherPath, { force: true });
    // 标准入口保留在同一bin目录，使用独立普通文件满足原生进程身份校验。
    await copyFile(join(binDirectory, versionedLauncher), launcherPath);
  }
}

function requiredFfmpegBinaries(target) {
  return target === "windows-x64" ? ["ffmpeg.exe", "ffprobe.exe"] : ["ffmpeg", "ffprobe"];
}

function requireBundledFfmpeg(root, target) {
  const missingBinaries = requiredFfmpegBinaries(target).filter((binaryName) => !existsSync(join(root, binaryName)));
  if (missingBinaries.length > 0) {
    throw new Error(`Could not find bundled media binaries under ${root}: ${missingBinaries.join(", ")}`);
  }
}

export function requiredDenoBinary(target) {
  assertSupportedTarget(target);
  return target === "windows-x64" ? "deno.exe" : "deno";
}

export function requiredYtdlpBinary(target) {
  assertSupportedTarget(target);
  return target === "windows-x64" ? "yt-dlp.exe" : "yt-dlp_macos";
}

export function defaultYtdlpAssetUrl(target, version = defaultYtdlpVersion) {
  return `https://github.com/yt-dlp/yt-dlp/releases/download/${version}/${requiredYtdlpBinary(target)}`;
}

export function ytdlpSha256(target) {
  const digest = ytdlpSha256ByTarget[target];
  if (!digest) {
    throw new Error(`Unsupported target for the bundled yt-dlp asset: ${target}`);
  }
  return digest;
}

function requireBundledYtdlp(root, target) {
  const binaryName = requiredYtdlpBinary(target);
  if (!existsSync(join(root, binaryName))) {
    throw new Error(`Could not find the bundled yt-dlp asset under ${root}: ${binaryName}`);
  }
}

export function verifyFileSha256(file, expected, label) {
  const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (actual !== expected) {
    throw new Error(`${label} SHA-256 mismatch: expected ${expected}, got ${actual}`);
  }
}

// python-build-standalone ships vcruntime140.dll so python.exe itself can
// start on a clean machine, but third-party C extensions (numpy, onnxruntime,
// pycryptodome, ...) link against the system-level msvcp140.dll and
// vcruntime140_1.dll from the Microsoft Visual C++ 2015-2022 Redistributable.
// Bundling them app-local (Microsoft allows app-local deployment) removes the
// clean-Windows dependency without UAC or a redist install.
export const WINDOWS_VC_RUNTIME_DLLS = ["msvcp140.dll", "vcruntime140_1.dll", "vcruntime140.dll"];

function defaultWindowsSystemRoot() {
  return process.env.SystemRoot ?? "C:\\Windows";
}

export async function bundleWindowsVcRuntimeDlls(pythonRoot, systemRoot = defaultWindowsSystemRoot()) {
  const system32 = join(systemRoot, "System32");
  const copied = [];
  for (const dllName of WINDOWS_VC_RUNTIME_DLLS) {
    const destinationPath = join(pythonRoot, dllName);
    if (dllName === "vcruntime140.dll" && existsSync(destinationPath)) {
      continue;
    }
    const sourcePath = join(system32, dllName);
    if (!existsSync(sourcePath)) {
      throw new Error(
        `Could not find VC++ runtime DLL under ${system32}: ${dllName}. ` +
          "Install the Microsoft Visual C++ 2015-2022 Redistributable (x64) on the build machine.",
      );
    }
    await copyFile(sourcePath, destinationPath);
    copied.push(dllName);
  }
  assertBundledWindowsVcRuntimeDlls(pythonRoot);
  return copied;
}

export function assertBundledWindowsVcRuntimeDlls(pythonRoot) {
  const missing = WINDOWS_VC_RUNTIME_DLLS.filter((dllName) => !existsSync(join(pythonRoot, dllName)));
  if (missing.length > 0) {
    throw new Error(`Could not find bundled VC++ runtime DLLs under ${pythonRoot}: ${missing.join(", ")}`);
  }
}

function denoArchiveAssetName(target) {
  switch (target) {
    case "windows-x64":
      return "deno-x86_64-pc-windows-msvc.zip";
    case "macos-arm64":
      return "deno-aarch64-apple-darwin.zip";
    default:
      throw new Error(`Unsupported target: ${target}`);
  }
}

export function defaultDenoArchiveUrl(target, version = defaultDenoVersion) {
  const normalizedVersion = normalizeDenoVersion(version);
  return `https://github.com/denoland/deno/releases/download/${normalizedVersion}/${denoArchiveAssetName(target)}`;
}

export function requireBundledDeno(root, target) {
  const binaryName = requiredDenoBinary(target);
  if (!existsSync(join(root, binaryName))) {
    throw new Error(`Could not find bundled Deno runtime under ${root}: ${binaryName}`);
  }
}

export async function copyDenoFromArchive(archive, destination, target) {
  const binaryName = requiredDenoBinary(target);
  const extractRoot = join(dirname(archive), "deno");
  await resetDirectory(extractRoot);
  await expandArchiveFile(archive, extractRoot);

  const binary = await findFirstFile(extractRoot, [binaryName]);
  if (!binary) {
    const extractedNames = (await walkFiles(extractRoot)).map((file) => basename(file));
    const preview =
      extractedNames.length > 0 ? [...new Set(extractedNames)].slice(0, 40).join(", ") : "(archive extracted no files)";
    throw new Error(`${binaryName} was not found in the Deno archive (${basename(archive)}). Extracted files: ${preview}`);
  }

  await mkdir(destination, { recursive: true });
  const destinationPath = join(destination, binaryName);
  await copyFile(binary, destinationPath);
  if (target !== "windows-x64") {
    await chmod(destinationPath, 0o755);
  }
}

export async function copyYtdlpAsset(options, destination, buildRoot) {
  const source = await prepareArchiveInput(
    options.ytdlpUrl || defaultYtdlpAssetUrl(options.target),
    buildRoot,
    `ytdlp-${options.target}.bin`,
  );
  const binaryName = requiredYtdlpBinary(options.target);
  // 固定版本与固定哈希：镜像或本地文件可以替换来源，但不能替换内容。
  // 先校验来源再落到 `resources/bin`，避免坏的下载覆盖上一份可用资产。
  verifyFileSha256(source, ytdlpSha256(options.target), `yt-dlp (${options.target})`);
  const destinationPath = join(destination, binaryName);
  await copyFile(source, destinationPath);
  if (options.target !== "windows-x64") {
    await chmod(destinationPath, 0o755);
  }
}

function smokeTestDenoRuntime(root, target, cacheRoot) {
  const deno = join(root, requiredDenoBinary(target));
  run(deno, ["eval", "console.log('deno runtime OK')"], "Deno runtime smoke test", {
    env: {
      DENO_DIR: join(cacheRoot, "deno-cache"),
      DENO_NO_UPDATE_CHECK: "1",
    },
  });
}

function isMacTarget(target) {
  return target === "macos-arm64";
}

async function verifyMacRuntimeSelfContained(pythonRoot) {
  // The macOS runtime relies on upstream-delocated wheels, and torch and
  // friends bundle their own libraries. Fail the build if any bundled library
  // still references a path outside the app bundle. This is static analysis
  // (delocate-listdeps), so it catches leaks even on the Homebrew-rich runner
  // where an import smoke test would pass.
  run(
    "node",
    [join(scriptDir, "verify-macos-self-contained.mjs"), pythonRoot],
    "Verify macOS runtime is self-contained",
  );
}

function resolveTauriTargetTriple(target) {
  switch (target) {
    case "windows-x64":
      return "x86_64-pc-windows-msvc";
    case "macos-arm64":
      return "aarch64-apple-darwin";
    default:
      throw new Error(`Unsupported target: ${target}`);
  }
}

function hasStandalonePythonRuntimeLandmark(root) {
  return existsSync(join(root, "Lib")) || existsSync(join(root, "lib")) || existsSync(join(root, "pyvenv.cfg"));
}

export async function findStandalonePythonRuntimeRoot(root) {
  const candidates = [];
  const executableNames = [];

  for (const executable of await walkFiles(root)) {
    const executableName = basename(executable);
    if (executableName !== "python.exe" && executableName !== "python3" && !/^python3\.\d+$/.test(executableName)) {
      continue;
    }

    executableNames.push(executable);
    const executableParent = dirname(executable);
    const runtimeRoot = basename(executableParent) === "bin" ? dirname(executableParent) : executableParent;
    if (hasStandalonePythonRuntimeLandmark(runtimeRoot)) {
      candidates.push({ executable, runtimeRoot });
    }
  }

  if (candidates.length === 0) {
    const preview =
      executableNames.length > 0 ? executableNames.slice(0, 20).join(", ") : "(archive contained no Python executable)";
    throw new Error(`Python standalone runtime root was not found in the archive. Candidate executables: ${preview}`);
  }

  candidates.sort(
    (left, right) => left.runtimeRoot.length - right.runtimeRoot.length || left.executable.localeCompare(right.executable),
  );
  return candidates[0];
}

async function copyStandalonePythonFromArchive(archive, destination) {
  const extractRoot = join(dirname(archive), "python-extract");
  await resetDirectory(extractRoot);
  await expandArchiveFile(archive, extractRoot);

  const { runtimeRoot } = await findStandalonePythonRuntimeRoot(extractRoot);
  await copyDirectoryContents(runtimeRoot, destination);
  await normalizeUnixPythonLaunchers(destination);
}

async function copyMediaBinariesFromArchive(archive, destination, target, binaryNames, extractDirectoryName) {
  const extractRoot = join(dirname(archive), extractDirectoryName);
  await resetDirectory(extractRoot);
  await expandArchiveFile(archive, extractRoot);

  for (const binaryName of binaryNames) {
    const binary = await findFirstFile(extractRoot, [binaryName]);
    if (!binary) {
      const extractedNames = (await walkFiles(extractRoot)).map((file) => basename(file));
      const preview =
        extractedNames.length > 0
          ? [...new Set(extractedNames)].slice(0, 40).join(", ")
          : "(archive extracted no files)";
      throw new Error(
        `${binaryName} was not found in the media archive (${basename(archive)}). Extracted files: ${preview}`,
      );
    }
    const destinationPath = join(destination, binaryName);
    await copyFile(binary, destinationPath);
    if (target !== "windows-x64") {
      await chmod(destinationPath, 0o755);
    }
  }
}

async function copyFfmpegFromArchive(ffmpegArchive, ffprobeArchive, destination, target) {
  const [ffmpegBinary, ffprobeBinary] = requiredFfmpegBinaries(target);
  await copyMediaBinariesFromArchive(ffmpegArchive, destination, target, [ffmpegBinary], "ffmpeg");
  await copyMediaBinariesFromArchive(ffprobeArchive, destination, target, [ffprobeBinary], "ffprobe");
}

async function findSitePackagesDirectories(root) {
  // Standalone Python uses different site-packages layouts per platform: Windows
  // keeps Lib/site-packages, while python-build-standalone on macOS/Linux nests it
  // under lib/python3.<minor>/site-packages. Resolve both so runtime pruning (for
  // example torch include/share) works regardless of the bundled OS and minor.
  const directories = [];

  const windowsSitePackages = join(root, "Lib", "site-packages");
  if (existsSync(windowsSitePackages)) {
    directories.push(windowsSitePackages);
  }

  const unixLib = join(root, "lib");
  if (existsSync(unixLib)) {
    for (const entry of await readdir(unixLib, { withFileTypes: true })) {
      if (entry.isDirectory() && /^python3\.\d+$/.test(entry.name)) {
        const sitePackages = join(unixLib, entry.name, "site-packages");
        if (existsSync(sitePackages)) {
          directories.push(sitePackages);
        }
      }
    }
  }

  return directories;
}

const BUNDLED_MANIFEST_NAME = "runtime-manifest.json";

// uv.lock 的 SHA256 作为运行时指纹：包内写一份 runtime-manifest.json，
// worker 比对指纹，不一致按缺失处理。锁文件里任何影响解析的改动都会换指纹。
function computeLockFingerprint() {
  return createHash("sha256").update(readFileSync(join(repoRoot, "uv.lock"))).digest("hex");
}

export { computeLockFingerprint };

function runtimeManifestPayload(fingerprint, runtimeKind, target) {
  return `${JSON.stringify(
    {
      lock_fingerprint: fingerprint,
      runtime_kind: runtimeKind,
      target,
    },
    null,
    2,
  )}\n`;
}

async function pruneBundledPythonRuntime(root) {  const prunedFilePatterns = ["*.pdb", "*.lib", "*.pyc", "*.pyo", "*.h", "*.hpp"];
  const prunedExtensions = new Set(prunedFilePatterns.map((pattern) => pattern.slice(1)));
  const prunedDirectoryNames = new Set(["__pycache__", "tests", "test"]);

  for (const file of await walkFiles(root)) {
    if (prunedExtensions.has(file.slice(file.lastIndexOf(".")))) {
      await rm(file, { force: true });
    }
  }

  const directories = await walkDirectories(root);
  await Promise.all(
    directories
      .filter((directory) => prunedDirectoryNames.has(basename(directory)))
      .sort((left, right) => right.length - left.length)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );

  const prunedSitePackageSubdirectories = [join("torch", "include"), join("torch", "share")];
  const sitePackagesDirectories = await findSitePackagesDirectories(root);

  for (const sitePackages of sitePackagesDirectories) {
    for (const relativePath of prunedSitePackageSubdirectories) {
      const fullPath = join(sitePackages, relativePath);
      if (existsSync(fullPath) && (await stat(fullPath)).isDirectory()) {
        await rm(fullPath, { recursive: true, force: true });
      }
    }
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const buildRoot = join(repoRoot, "build", "installer-runtime", options.target);
  const articleReadme = readFileSync(join(resourcesRoot, "web", "README.txt"));

  if (!options.skipDownloads) {
    requireFileOrUrl(options.pythonStandaloneUrl, "PythonStandaloneUrl");
    requireFileOrUrl(options.ffmpegArchiveUrl, "FfmpegArchiveUrl");
  } else {
    await findPythonExecutable(pythonRoot);
    requireBundledFfmpeg(binRoot, options.target);
    requireBundledDeno(binRoot, options.target);
    requireBundledYtdlp(binRoot, options.target);
    await normalizeUnixPythonLaunchers(pythonRoot);
  }

  await resetDirectory(buildRoot);
  if (!options.skipDownloads) {
    await resetDirectory(resourcesRoot);
  }
  await mkdir(pythonRoot, { recursive: true });
  await mkdir(workerRoot, { recursive: true });
  await mkdir(binRoot, { recursive: true });
  await mkdir(join(resourcesRoot, "web"), { recursive: true });
  await writeFile(join(resourcesRoot, "web", "README.txt"), articleReadme);
  await ensureGitKeep(resourcesRoot);
  await ensureGitKeep(pythonRoot);
  await ensureGitKeep(workerRoot);
  await ensureGitKeep(binRoot);

  if (!options.skipDownloads) {
    requireFileOrUrl(options.pythonStandaloneUrl, "PythonStandaloneUrl");
    const pythonArchive = await prepareArchiveInput(options.pythonStandaloneUrl, buildRoot, "python-standalone.archive");
    await copyStandalonePythonFromArchive(pythonArchive, pythonRoot);

    requireFileOrUrl(options.ffmpegArchiveUrl, "FfmpegArchiveUrl");
    const ffmpegArchive = await prepareArchiveInput(options.ffmpegArchiveUrl, buildRoot, "ffmpeg.archive");
    const ffprobeArchive = options.ffprobeArchiveUrl
      ? await prepareArchiveInput(options.ffprobeArchiveUrl, buildRoot, "ffprobe.archive")
      : ffmpegArchive;
    await copyFfmpegFromArchive(ffmpegArchive, ffprobeArchive, binRoot, options.target);

    const denoArchiveUrl = options.denoArchiveUrl || defaultDenoArchiveUrl(options.target, options.denoVersion);
    const denoArchive = await prepareArchiveInput(denoArchiveUrl, buildRoot, "deno.archive");
    await copyDenoFromArchive(denoArchive, binRoot, options.target);
    await copyYtdlpAsset(options, binRoot, buildRoot);
  }

  await copyWorkerRuntime(workerRoot);
  // TypeScript worker 的随包运行时：源码树 + 外置 node_modules（已按目标平台裁剪）。
  // 组装完立刻用随包 Deno 真跑一次 `--resolve-source-stdin`，把「Deno 能启动、
  // node_modules 能解析、协议结果一致」三件事固定成构建期失败而不是用户机上失败。
  // 过渡期开关：仓库里没有 `worker-ts/node_modules` 时（CI 未安装依赖、老分支），
  // 装进去也跑不起来，于是明确跳过并让宿主回落 Python；`--require-worker-ts` 用来在
  // 正式切换到 TS worker 的发布任务里把「必须装进去」变成硬失败。
  const workerTsDependencies = join(repoRoot, "worker-ts", "node_modules");
  if (options.requireWorkerTs && !existsSync(workerTsDependencies)) {
    throw new Error(
      "worker-ts/node_modules is missing but --require-worker-ts was requested; run npm ci --prefix worker-ts first",
    );
  }
  if (options.requireWorkerTs || existsSync(workerTsDependencies)) {
    const workerTsRuntime = await prepareWorkerTsRuntime({
      repoRoot,
      destination: join(resourcesRoot, WORKER_TS_RESOURCE_DIR),
      target: options.target,
      denoBinary: join(binRoot, requiredDenoBinary(options.target)),
      cacheRoot: buildRoot,
    });
    console.log(
      `worker-ts runtime prepared (${(workerTsRuntime.bytes / 1024 / 1024).toFixed(1)} MB)`,
    );
  } else {
    console.log(
      "worker-ts runtime skipped (worker-ts/node_modules is missing); this package will use the Python worker",
    );
  }
  await copyFile(join(repoRoot, "pyproject.toml"), join(resourcesRoot, "pyproject.toml"));
  await copyFile(join(repoRoot, ".env.example"), join(resourcesRoot, ".env.template"));

  const pythonExe = await findPythonExecutable(pythonRoot);
  const requirementsPath = join(buildRoot, "requirements.txt");
  run(commandName("uv"), ["export", "--no-dev", "--no-hashes", "--format", "requirements-txt", "--output-file", requirementsPath], "Export Python requirements");
  run(pythonExe, ["-m", "ensurepip", "--upgrade"], "Install bundled Python pip");
  run(pythonExe, ["-m", "pip", "install", "--upgrade", "pip"], "Upgrade bundled Python pip");
  // Force wheels for packages that leak Homebrew libraries when source-built on
  // the runner: llvmlite needs a matching LLVM (opaque CMake failure otherwise),
  // and cryptography links Homebrew OpenSSL. Failing loudly here beats shipping a
  // bundle that breaks on clean Macs.
  run(
    pythonExe,
    ["-m", "pip", "install", "--only-binary=llvmlite,cryptography", "-r", requirementsPath],
    "Install bundled Python dependencies",
  );
  await pruneBundledPythonRuntime(pythonRoot);
  if (options.target === "windows-x64") {
    await bundleWindowsVcRuntimeDlls(pythonRoot);
  }
  // PyTorch 族已外置：包内只保 ONNX 路径，funasr 与 torch 由按需组件提供。
  run(pythonExe, ["-c", "import funasr_onnx, modelscope, onnxruntime, yt_dlp; import worker_core"], "Python runtime smoke test", {
    env: { PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: workerRoot },
  });
  const lockFingerprint = computeLockFingerprint();
  // 包内 manifest 放进 resources/python（本身是产物目录，已被 tauri 的
  // `resources/python/**/*` 打进去），避免仓库里出现一个每次构建都会变脏的文件。
  await writeFile(
    join(pythonRoot, BUNDLED_MANIFEST_NAME),
    runtimeManifestPayload(lockFingerprint, "bundled", options.target),
  );
  run(process.execPath, [join(repoRoot, "scripts", "build-article-extractor.mjs")], "Build article extraction bundle");
  buildSystemWebViewHost({ target: options.target });
  smokeTestDenoRuntime(binRoot, options.target, buildRoot);
  await removePythonCaches(pythonRoot);
  await removePythonCaches(workerRoot);

  if (isMacTarget(options.target)) {
    await verifyMacRuntimeSelfContained(pythonRoot);
  }

  if (!options.skipTauriBuild) {
    const tauriTarget = resolveTauriTargetTriple(options.target);
    run(commandName("npm"), ["--prefix", appRoot, "run", "tauri", "--", "build", "--target", tauriTarget], "Build Tauri installer");
  }

  console.log(`Installer resources prepared at ${resourcesRoot}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
