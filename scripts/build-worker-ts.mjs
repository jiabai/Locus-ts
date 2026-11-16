#!/usr/bin/env node

// 把 `worker-ts/` 组装成发行包里的运行时目录：`resources/worker-ts/`。
//
// 已确认的产品决定是「随包 `deno.exe` + 外置 `node_modules`」，不做 `deno compile`
// 单文件（编译产物内嵌的 `.node` 定位不到同目录的 `onnxruntime.dll`，会回退到系统旧版）。
// 因此这里要保证三件事：源码树完整可跑、`node_modules` 只留目标平台的原生二进制、
// 组装结果真的能被随包 Deno 启动并产出与协议一致的那一行结果。
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const WORKER_TS_RESOURCE_DIR = "worker-ts";
export const WORKER_TS_ENTRY = join("src", "cli.ts");
export const DENO_CONFIG_NAME = "deno.json";

const ONNX_RUNTIME_PACKAGE = "onnxruntime-node";
const ONNX_NATIVE_ROOT = join("bin", "napi-v6");

/** 与 `build-installer.mjs` 的 target 闭集一致；平台目录按 onnxruntime-node 的布局对齐。 */
export function onnxRuntimeTargetLayout(target) {
  switch (target) {
    case "windows-x64":
      return { platform: ["win32", "x64"], dialect: "windows" };
    case "macos-arm64":
      return { platform: ["darwin", "arm64"], dialect: "darwin" };
    default:
      throw new Error(`Unsupported target for the worker-ts runtime: ${target}`);
  }
}

/**
 * Windows 只留 CPU 推理真正加载的两个文件；`DirectML.dll`、`dxcompiler.dll` 与
 * `dxil.dll` 是 DirectML 路径的依赖，CPU 会话不需要，删掉可省约 60 MB。
 * macOS 只留 binding 与 `libonnxruntime.*.dylib`（版本号随包升级变化，不写死）。
 */
export function keepsOnnxNativeFile(target, name) {
  if (name === "onnxruntime_binding.node") {
    return true;
  }
  const { dialect } = onnxRuntimeTargetLayout(target);
  if (dialect === "windows") {
    return name === "onnxruntime.dll";
  }
  return /^libonnxruntime\..*\.dylib$/.test(name);
}

/**
 * 把 `node_modules/onnxruntime-node/bin/napi-v6` 裁到只剩目标平台。
 *
 * 源码安装的 `node_modules` 带着多个平台的原生二进制（约 283 MB），而每个安装包
 * 只需要其中一个。目标平台目录缺失时直接失败，避免出一个到用户机器上才报
 * `ASR_DEPENDENCY_MISSING` 的包。
 */
export async function pruneOnnxRuntimeBinaries(nodeModulesRoot, target) {
  const { platform } = onnxRuntimeTargetLayout(target);
  const nativeRoot = join(nodeModulesRoot, ONNX_RUNTIME_PACKAGE, ONNX_NATIVE_ROOT);
  if (!existsSync(nativeRoot)) {
    return { pruned: false, kept: undefined };
  }
  const platformRoot = join(nativeRoot, platform[0]);
  const platformDir = join(platformRoot, platform[1]);
  if (!existsSync(platformDir)) {
    const available = existsSync(platformRoot)
      ? (await readdir(platformRoot)).join(", ")
      : `missing ${platform[0]}`;
    throw new Error(
      `${ONNX_RUNTIME_PACKAGE} does not ship ${platform.join("/")} (available: ${available}); ` +
        `${target} cannot run ASR with the pinned onnxruntime version`,
    );
  }

  for (const entry of await readdir(nativeRoot)) {
    if (entry !== platform[0]) {
      await rm(join(nativeRoot, entry), { recursive: true, force: true });
    }
  }
  for (const entry of await readdir(platformRoot)) {
    if (entry !== platform[1]) {
      await rm(join(platformRoot, entry), { recursive: true, force: true });
    }
  }
  for (const entry of await readdir(platformDir)) {
    if (!keepsOnnxNativeFile(target, entry)) {
      await rm(join(platformDir, entry), { recursive: true, force: true });
    }
  }
  return { pruned: true, kept: platformDir };
}

/** `deno.json` 的 `nodeModulesDir` 是外置 `node_modules` 能被解析的前提。 */
export async function assertDenoConfig(configPath) {  const raw = await readFile(configPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${configPath} is not valid JSON`);
  }
  if (parsed.nodeModulesDir !== "manual") {
    throw new Error(
      `${configPath} must set "nodeModulesDir": "manual" so the bundled Deno resolves the external node_modules`,
    );
  }
}

/**
 * `node_modules` 里的开发依赖不进发行包：`typescript` 单个就有 23 MB，而运行期
 * 只需要 `package.json` 里 `dependencies` 那一棵。按声明裁剪比按目录名猜更稳——
 * 顶层目录名与 `devDependencies` 的键一一对应，`@types/*` 整体是类型声明。
 */
export function runtimeNodeModulesFilter(nodeModulesRoot, devDependencies) {
  const devNames = new Set(Object.keys(devDependencies ?? {}));
  return (source) => {
    if (dirname(source) !== nodeModulesRoot) {
      return true;
    }
    const name = basename(source);
    if (name === "@types") {
      return false;
    }
    return !devNames.has(name);
  };
}

/**
 * 组装发行包运行时：源码树 + `deno.json` + `package.json` + 裁剪后的 `node_modules`。
 * `skills/` 是 `src/pipeline/draft-step.ts` 里按 `../../skills/` 定位的随包资产，必须同级。
 */
export async function assembleWorkerTsRuntime({ repoRoot, destination, target, sourceRoot }) {
  const from = sourceRoot ?? join(repoRoot, "worker-ts");
  const configPath = join(from, DENO_CONFIG_NAME);
  if (!existsSync(configPath)) {
    throw new Error(`Could not find ${configPath}`);
  }
  await assertDenoConfig(configPath);

  const nodeModules = join(from, "node_modules");
  if (!existsSync(nodeModules)) {
    throw new Error(`Could not find ${nodeModules}; run npm install before assembling the worker runtime`);
  }
  const manifest = JSON.parse(await readFile(join(from, "package.json"), "utf8"));

  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(join(from, "src"), join(destination, "src"), { recursive: true });
  const skills = join(from, "skills");
  if (existsSync(skills)) {
    await cp(skills, join(destination, "skills"), { recursive: true });
  }
  await copyFile(configPath, join(destination, DENO_CONFIG_NAME));
  await copyFile(join(from, "package.json"), join(destination, "package.json"));
  await cp(nodeModules, join(destination, "node_modules"), {
    recursive: true,
    filter: runtimeNodeModulesFilter(nodeModules, manifest.devDependencies),
  });
  // `.bin` 是 npm 生成的 shell 垫片，随包无用，还会在 Windows 上带来超长路径。
  await rm(join(destination, "node_modules", ".bin"), { recursive: true, force: true });
  await pruneOnnxRuntimeBinaries(join(destination, "node_modules"), target);

  const entry = join(destination, WORKER_TS_ENTRY);
  if (!existsSync(entry)) {
    throw new Error(`Could not find the worker entry after assembly: ${entry}`);
  }
  return { root: destination, entry };
}

export const WORKER_TS_SMOKE_REQUEST = JSON.stringify({
  url: "https://www.bilibili.com/video/BV1GJ411x7h7",
});

/** 与 `--resolve-source-stdin` 的协议结果逐字相同（键序也是协议的一部分）。 */
export const WORKER_TS_SMOKE_EXPECTED =
  '{"status":"completed","source_url":"https://www.bilibili.com/video/BV1GJ411x7h7",' +
  '"source_identity":{"version":1,"platform":"bilibili","stable_id":"BV1GJ411x7h7",' +
  '"effective_part":1,"canonical_url":"https://www.bilibili.com/video/BV1GJ411x7h7"}}\n';

/**
 * 用随包 Deno 从组装好的目录启动一次真实的 worker。
 *
 * 这里跑 `--resolve-source-stdin`：不需要网络、不需要 ffmpeg、不写用户数据，
 * 但会加载 `cli.ts → worker-service → 平台解析` 整条模块图，因此一次就能证明
 * 「随包 Deno + 外置 node_modules + 组装布局」三者接得上。
 */
export function runWorkerTsSmoke({ denoBinary, workerRoot, cacheRoot, env }) {
  const result = spawnSync(
    denoBinary,
    [
      "run",
      "--config",
      join(workerRoot, DENO_CONFIG_NAME),
      "--allow-read",
      join(workerRoot, WORKER_TS_ENTRY),
      "--resolve-source-stdin",
    ],
    {
      input: WORKER_TS_SMOKE_REQUEST,
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        ...(env ?? {}),
        DENO_DIR: join(cacheRoot, "deno-cache"),
        DENO_NO_UPDATE_CHECK: "1",
        NO_COLOR: "1",
      },
    },
  );
  if (result.error) {
    throw new Error(`worker-ts smoke test could not start Deno: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `worker-ts smoke test failed with exit code ${result.status}: ${(result.stderr ?? "").trim()}`,
    );
  }
  if (result.stdout !== WORKER_TS_SMOKE_EXPECTED) {
    throw new Error(
      `worker-ts smoke test produced an unexpected result line: ${JSON.stringify(result.stdout)}`,
    );
  }
  return result.stdout;
}

/** 目录总字节数，构建脚本用它打印与核对发行包体积。 */
export async function directorySize(root) {
  let total = 0;
  for (const entry of await readdir(root)) {
    const full = join(root, entry);
    const metadata = await stat(full);
    total += metadata.isDirectory() ? await directorySize(full) : metadata.size;
  }
  return total;
}

/** 供 `build-installer.mjs` 直接调用：组装 + 真实启动冒烟，一步完成。 */
export async function prepareWorkerTsRuntime({ repoRoot, destination, target, denoBinary, cacheRoot }) {
  const { root, entry } = await assembleWorkerTsRuntime({ repoRoot, destination, target });
  const stdout = runWorkerTsSmoke({ denoBinary, workerRoot: root, cacheRoot });
  return { root, entry, stdout, bytes: await directorySize(root) };
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [destination, denoBinary, cacheRoot, target = "windows-x64"] = process.argv.slice(2);
  if (!destination || !denoBinary || !cacheRoot) {
    console.error("usage: build-worker-ts.mjs <destination> <deno-binary> <cache-root> [target]");
    process.exitCode = 2;
  } else {
    prepareWorkerTsRuntime({
      repoRoot: join(dirname(scriptPath), ".."),
      destination,
      target,
      denoBinary,
      cacheRoot,
    })
      .then(({ bytes }) => {
        console.log(`worker-ts runtime ready (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      });
  }
}
