import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { after } from "node:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assembleWorkerTsRuntime,
  assertDenoConfig,
  directorySize,
  keepsOnnxNativeFile,
  onnxRuntimeTargetLayout,
  prepareWorkerTsRuntime,
  pruneOnnxRuntimeBinaries,
  runtimeNodeModulesFilter,
  WORKER_TS_RESOURCE_DIR,
  WORKER_TS_SMOKE_EXPECTED,
} from "../build-worker-ts.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, "..", "..");
const fixtureRoot = join(repoRoot, "build", "worker-ts-runtime-tests");

after(async () => {
  if (!process.env.APP_KEEP_RUNTIME_FIXTURES) {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

async function scratch(name) {
  await mkdir(fixtureRoot, { recursive: true });
  return mkdtemp(join(fixtureRoot, `${name}-`));
}

async function writeTree(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const target = join(root, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

function onnxFixtureFiles(binary = "dummy-native-binary") {
  const files = {};
  for (const platform of ["win32/x64", "win32/arm64", "darwin/arm64", "linux/x64"]) {
    files[`node_modules/onnxruntime-node/bin/napi-v6/${platform}/onnxruntime_binding.node`] = binary;
  }
  for (const name of ["onnxruntime.dll", "DirectML.dll", "dxcompiler.dll", "dxil.dll"]) {
    files[`node_modules/onnxruntime-node/bin/napi-v6/win32/x64/${name}`] = binary;
    files[`node_modules/onnxruntime-node/bin/napi-v6/win32/arm64/${name}`] = binary;
  }
  for (const name of ["libonnxruntime.1.29.0.dylib", "libonnxruntime.1.dylib"]) {
    files[`node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/${name}`] = binary;
  }
  return files;
}

async function sourceFixture(overrides = {}) {
  const root = await scratch("source");
  const sourceRoot = join(root, "worker-ts");
  await writeTree(sourceRoot, {
    "deno.json": '{"nodeModulesDir": "manual"}\n',
    "package.json": JSON.stringify({
      name: "worker-fixture",
      dependencies: { entities: "6.0.0" },
      devDependencies: { typescript: "5.9.3" },
    }),
    "src/cli.ts": "export {};\n",
    "skills/demo/SKILL.md": "# demo\n",
    "node_modules/entities/package.json": '{"name":"entities"}\n',
    "node_modules/typescript/package.json": '{"name":"typescript"}\n',
    "node_modules/@types/node/package.json": '{"name":"@types/node"}\n',
    ...onnxFixtureFiles(),
    ...overrides,
  });
  return { root, sourceRoot };
}

test("the target layout covers the two release targets and rejects anything else", () => {
  assert.deepEqual(onnxRuntimeTargetLayout("windows-x64").platform, ["win32", "x64"]);
  assert.deepEqual(onnxRuntimeTargetLayout("macos-arm64").platform, ["darwin", "arm64"]);
  assert.throws(() => onnxRuntimeTargetLayout("macos-x64"), /Unsupported target/);
  assert.throws(() => onnxRuntimeTargetLayout("linux-x64"), /Unsupported target/);
});

test("windows keeps only the CPU inference files and macOS keeps the versioned dylibs", () => {
  assert.equal(keepsOnnxNativeFile("windows-x64", "onnxruntime.dll"), true);
  assert.equal(keepsOnnxNativeFile("windows-x64", "onnxruntime_binding.node"), true);
  for (const dropped of ["DirectML.dll", "dxcompiler.dll", "dxil.dll"]) {
    assert.equal(keepsOnnxNativeFile("windows-x64", dropped), false, dropped);
  }
  assert.equal(keepsOnnxNativeFile("macos-arm64", "libonnxruntime.1.29.0.dylib"), true);
  assert.equal(keepsOnnxNativeFile("macos-arm64", "libonnxruntime.1.dylib"), true);
  assert.equal(keepsOnnxNativeFile("macos-arm64", "onnxruntime.dll"), false);
});

test("pruning leaves one platform directory and one set of native files", async () => {
  const root = await scratch("prune-win");
  await writeTree(root, onnxFixtureFiles());

  const result = await pruneOnnxRuntimeBinaries(join(root, "node_modules"), "windows-x64");

  assert.equal(result.pruned, true);
  const nativeRoot = join(root, "node_modules", "onnxruntime-node", "bin", "napi-v6");
  assert.deepEqual(await readdir(nativeRoot), ["win32"]);
  const platformFiles = await readdir(join(nativeRoot, "win32", "x64"));
  assert.deepEqual(platformFiles.sort(), ["onnxruntime.dll", "onnxruntime_binding.node"]);
});

test("pruning macOS keeps the dylibs and the binding", async () => {
  const root = await scratch("prune-mac");
  await writeTree(root, onnxFixtureFiles());

  await pruneOnnxRuntimeBinaries(join(root, "node_modules"), "macos-arm64");

  const platformDir = join(root, "node_modules", "onnxruntime-node", "bin", "napi-v6", "darwin", "arm64");
  const files = await readdir(platformDir);
  assert.deepEqual(files.sort(), [
    "libonnxruntime.1.29.0.dylib",
    "libonnxruntime.1.dylib",
    "onnxruntime_binding.node",
  ]);
});

// 目标平台目录缺失时必须构建期失败，否则包到用户机上才报 ASR_DEPENDENCY_MISSING。
test("pruning fails loudly when the pinned onnxruntime has no binary for the target", async () => {
  const root = await scratch("prune-missing");
  await writeTree(root, {
    "node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node": "dummy-native-binary",
  });

  await assert.rejects(
    () => pruneOnnxRuntimeBinaries(join(root, "node_modules"), "macos-arm64"),
    /does not ship darwin\/arm64/,
  );
});

test("pruning a missing onnxruntime package is a no-op", async () => {
  const root = await scratch("prune-none");
  await mkdir(join(root, "node_modules", "entities"), { recursive: true });
  const result = await pruneOnnxRuntimeBinaries(join(root, "node_modules"), "windows-x64");
  assert.equal(result.pruned, false);
});

test("deno.json must pin nodeModulesDir to manual", async () => {
  const root = await scratch("deno-config");
  const manual = join(root, "manual.json");
  await writeFile(manual, '{"nodeModulesDir": "manual"}\n');
  await assertDenoConfig(manual);

  const auto = join(root, "auto.json");
  await writeFile(auto, '{"nodeModulesDir": "auto"}\n');
  await assert.rejects(() => assertDenoConfig(auto), /nodeModulesDir/);

  const broken = join(root, "broken.json");
  await writeFile(broken, "{");
  await assert.rejects(() => assertDenoConfig(broken), /not valid JSON/);
});

test("the node_modules filter drops declared dev dependencies and keeps everything else", async () => {
  const root = await scratch("nm-filter");
  const nodeModules = join(root, "node_modules");
  await writeTree(nodeModules, {
    "entities/index.js": "",
    "typescript/lib/tsc.js": "",
    "@types/node/index.d.ts": "",
    "zod/index.js": "",
  });
  const filter = runtimeNodeModulesFilter(nodeModules, { typescript: "5.9.3" });
  assert.equal(filter(join(nodeModules, "entities")), true);
  assert.equal(filter(join(nodeModules, "zod")), true);
  assert.equal(filter(join(nodeModules, "typescript")), false);
  assert.equal(filter(join(nodeModules, "@types")), false);
  // 同名包出现在更深层时不受顶层 devDependencies 影响。
  assert.equal(filter(join(nodeModules, "entities", "node_modules", "typescript")), true);
});

test("assembly produces the packaged layout and prunes the native binaries", async () => {
  const { root, sourceRoot } = await sourceFixture();
  const destination = join(root, "resources", WORKER_TS_RESOURCE_DIR);

  const assembled = await assembleWorkerTsRuntime({
    repoRoot,
    destination,
    target: "windows-x64",
    sourceRoot,
  });

  assert.equal(assembled.root, destination);
  assert.equal(assembled.entry, join(destination, "src", "cli.ts"));
  for (const relative of [
    "deno.json",
    "package.json",
    "src/cli.ts",
    "skills/demo/SKILL.md",
    "node_modules/entities/package.json",
  ]) {
    assert.equal(existsSync(join(destination, relative)), true, relative);
  }
  assert.equal(existsSync(join(destination, "node_modules", "typescript")), false);
  assert.equal(existsSync(join(destination, "node_modules", "@types")), false);
  const nativeRoot = join(destination, "node_modules", "onnxruntime-node", "bin", "napi-v6");
  assert.deepEqual(await readdir(nativeRoot), ["win32"]);
  assert.equal((await readFile(join(destination, "deno.json"), "utf8")).includes("manual"), true);
  assert.ok((await directorySize(destination)) > 0);
});

test("assembly is idempotent and replaces a stale destination", async () => {
  const { root, sourceRoot } = await sourceFixture();
  const destination = join(root, "resources", WORKER_TS_RESOURCE_DIR);
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, "stale.txt"), "stale\n");

  await assembleWorkerTsRuntime({ repoRoot, destination, target: "macos-arm64", sourceRoot });

  assert.equal(existsSync(join(destination, "stale.txt")), false);
  const nativeRoot = join(destination, "node_modules", "onnxruntime-node", "bin", "napi-v6");
  assert.deepEqual(await readdir(nativeRoot), ["darwin"]);
});

test("assembly fails when the source tree has no deno.json", async () => {
  const root = await scratch("no-config");
  const sourceRoot = join(root, "worker-ts");
  await writeTree(sourceRoot, {
    "package.json": "{}",
    "src/cli.ts": "",
    "node_modules/entities/package.json": "{}",
  });
  await assert.rejects(
    () =>
      assembleWorkerTsRuntime({
        repoRoot,
        destination: join(root, "out"),
        target: "windows-x64",
        sourceRoot,
      }),
    /deno\.json/,
  );
});

test("the release bundle ships the worker-ts runtime and the repo pins the Deno config", async () => {
  const tauriConfig = JSON.parse(
    await readFile(join(repoRoot, "app", "src-tauri", "tauri.conf.json"), "utf8"),
  );
  assert.ok(
    tauriConfig.bundle.resources.includes("resources/worker-ts/**/*"),
    "tauri bundle resources must include resources/worker-ts/**/*",
  );
  const denoConfig = JSON.parse(await readFile(join(repoRoot, "worker-ts", "deno.json"), "utf8"));
  assert.equal(denoConfig.nodeModulesDir, "manual");

  const installer = await readFile(join(repoRoot, "scripts", "build-installer.mjs"), "utf8");
  assert.ok(installer.includes("prepareWorkerTsRuntime"), "the installer must assemble the worker-ts runtime");
  assert.ok(installer.includes("WORKER_TS_RESOURCE_DIR"), "the installer must use the shared resource dir name");
});

test("the installer only skips the worker-ts runtime when the dependencies are absent", async () => {
  const { parseArgs } = await import("../build-installer.mjs");

  assert.equal(parseArgs(["--target", "windows-x64"]).requireWorkerTs, false);
  assert.equal(parseArgs(["--require-worker-ts"]).requireWorkerTs, true);

  // 过渡期必须有明确提示，否则「跳过组装」会悄悄产出只带 Python 的包。
  const installer = await readFile(join(repoRoot, "scripts", "build-installer.mjs"), "utf8");
  assert.ok(installer.includes("this package will use the Python worker"));
  assert.ok(installer.includes("--require-worker-ts"));
});

test("the Rust host injects the bundled yt-dlp path into the Deno worker environment", async () => {
  const runtime = await readFile(join(repoRoot, "app", "src-tauri", "src", "runtime.rs"), "utf8");

  assert.ok(runtime.includes('pub(crate) const YTDLP_PATH_ENV: &str = "APP_YTDLP_PATH";'));
  assert.ok(runtime.includes("bundled_ytdlp_path(&paths.resource_dir)"));
  assert.ok(runtime.includes("YTDLP_PATH_ENV.to_string()"));
});

const denoBinary = process.env.APP_TEST_DENO ?? join(repoRoot, "work", "asr-spike", "deno", "deno.exe");
const denoAvailable = existsSync(denoBinary) && existsSync(join(repoRoot, "worker-ts", "node_modules"));

// 真实启动：用仓库里的 Deno 组装并启动一次 worker（含复制与裁剪）。没有随包 Deno 的
// 机器（CI、干净检出）跳过；组装与裁剪的逻辑本身由上面的 fixture 用例覆盖。
test(
  "the assembled command line drives a real Deno worker",
  { skip: denoAvailable ? false : "no Deno runtime available for the real launch check" },
  async () => {
    const cacheRoot = await scratch("deno-launch");
    const result = await prepareWorkerTsRuntime({
      repoRoot,
      destination: join(cacheRoot, "worker-ts"),
      target: process.platform === "win32" ? "windows-x64" : "macos-arm64",
      denoBinary,
      cacheRoot,
    });
    assert.equal(result.stdout, WORKER_TS_SMOKE_EXPECTED);
    assert.ok(result.bytes > 0);
  },
);
