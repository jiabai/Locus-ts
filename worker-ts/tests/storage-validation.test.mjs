// 存储校验探针的宿主可见契约：stdout 恰好一行紧凑 JSON（成功）、空 stdout +
// 非零退出（失败）、用法错误退出 2。组件状态判定与就绪模型统计是纯文件检查，
// 单测用临时目录逐分支验证；另有一条真实 CLI 冒烟对齐 Python 探针的输出。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  evaluateComponent,
  inspectStorage,
  locateBundledManifest,
  readManifestFingerprint,
  resolveComponentDir,
} from "../src/storage-validation.ts";

const ENTRY = fileURLToPath(new URL("../src/storage-validation-main.ts", import.meta.url));
const FINGERPRINT = "0123456789abcdef0123456789abcdef";

function fixtureRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "locus-storage-validation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "models"), { recursive: true });
  return root;
}

function envFor(root) {
  return {
    APP_MODEL_DIR: join(root, "models"),
    APP_RESOURCE_DIR: join(root, "resources"),
    APP_PYTORCH_RUNTIME_DIR: join(root, "runtime"),
  };
}

function runEntry(root, args = [], { env = {}, omitModelDir = false } = {}) {
  const base = envFor(root);
  if (omitModelDir) delete base.APP_MODEL_DIR;
  return spawnSync(process.execPath, ["--experimental-strip-types", ENTRY, ...args], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, ...base, ...env },
  });
}

function writeManifest(dir, fingerprint = FINGERPRINT) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "runtime-manifest.json"), JSON.stringify({ lock_fingerprint: fingerprint }));
}

function writeTorchModel(modelRoot, layout = "flat") {
  const base = layout === "flat" ? modelRoot : join(modelRoot, "models");
  // 目录名不带 iic/ 前缀：`iic/<id>/model.pt`，与 Python 的拼法一致。
  for (const id of ["SenseVoiceSmall", "speech_fsmn_vad_zh-cn-16k-common-pytorch"]) {
    const dir = join(base, "iic", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "model.pt"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]));
  }
}

test("a bare probe reports ungated with no ready models and touches nothing", async (t) => {
  const root = fixtureRoot(t);
  const result = await inspectStorage({ environ: envFor(root), projectRoot: root });
  assert.deepEqual(result, {
    schema_version: 1,
    ready_models: [],
    component_state: "ungated",
    component_fingerprint: null,
    component_imported: false,
  });
  // 探针是只读的：缺模型的缓存不能被创建、改写或清掉；其他目录也不会凭空出现。
  assert.deepEqual(readdirSync(join(root, "models")), []);
  assert.deepEqual(readdirSync(root), ["models"]);
});

test("component state follows the manifest matrix exactly", async (t) => {
  const root = fixtureRoot(t);
  const env = envFor(root);
  // 包内清单缺失 → ungated，组件目录根本不参与判定。
  writeManifest(join(root, "runtime"));
  assert.equal(evaluateComponent(join(root, "runtime"), null), "ungated");

  // 组件目录不存在或 manifest 损坏 → missing；指纹不一致 → stale；一致 → ready。
  assert.equal(evaluateComponent(null, FINGERPRINT), "missing");
  assert.equal(evaluateComponent(join(root, "runtime"), FINGERPRINT), "ready");
  writeManifest(join(root, "runtime"), "different-fingerprint");
  assert.equal(evaluateComponent(join(root, "runtime"), FINGERPRINT), "stale");
  rmSync(join(root, "runtime", "runtime-manifest.json"));
  writeFileSync(join(root, "runtime", "runtime-manifest.json"), "{broken");
  assert.equal(evaluateComponent(join(root, "runtime"), FINGERPRINT), "missing");

  // 包内 manifest 的查找顺序：显式覆盖 > 资源目录（python/ 优先）> 项目根。
  mkdirSync(join(root, "resources", "python"), { recursive: true });
  writeFileSync(join(root, "resources", "python", "runtime-manifest.json"), JSON.stringify({ lock_fingerprint: "resource" }));
  assert.equal(readManifestFingerprint(locateBundledManifest(root, env)), "resource");
  writeFileSync(join(root, "resources", "runtime-manifest.json"), JSON.stringify({ lock_fingerprint: "resource-root" }));
  assert.equal(readManifestFingerprint(locateBundledManifest(root, env)), "resource");
  writeFileSync(join(root, "runtime-manifest.json"), JSON.stringify({ lock_fingerprint: "project" }));
  assert.equal(readManifestFingerprint(locateBundledManifest(root, env)), "resource");
  const override = join(root, "override.json");
  writeFileSync(override, JSON.stringify({ lock_fingerprint: "override" }));
  assert.equal(readManifestFingerprint(locateBundledManifest(root, { ...env, APP_BUNDLED_RUNTIME_MANIFEST: override })), "override");

  // 指纹读取的容错：缺文件、坏 JSON、空指纹、非对象、非字符串都返回 null。
  assert.equal(readManifestFingerprint(join(root, "missing.json")), null);
  writeFileSync(override, "not json");
  assert.equal(readManifestFingerprint(override), null);
  writeFileSync(override, JSON.stringify({ lock_fingerprint: "  " }));
  assert.equal(readManifestFingerprint(override), null);
  writeFileSync(override, JSON.stringify([1]));
  assert.equal(readManifestFingerprint(override), null);
  writeFileSync(override, JSON.stringify({ lock_fingerprint: 3 }));
  assert.equal(readManifestFingerprint(override), null);

  // 组件目录来自环境变量，未配置视为缺失。
  assert.equal(resolveComponentDir({}), null);
  assert.equal(resolveComponentDir({ APP_PYTORCH_RUNTIME_DIR: "  " }), null);
  assert.equal(resolveComponentDir({ APP_PYTORCH_RUNTIME_DIR: join(root, "runtime") }), join(root, "runtime"));

  // 走 inspectStorage 的完整链路：资源目录 + 一致组件 = ready。
  writeManifest(join(root, "runtime"), "resource");
  const inspected = await inspectStorage({ environ: env, projectRoot: root });
  assert.equal(inspected.component_state, "ready");
  assert.equal(inspected.component_fingerprint, "resource");
});

test("pytorch and onnx readiness follow the python cache rules read-only", async (t) => {
  const root = fixtureRoot(t);
  const modelRoot = join(root, "models");
  // 无效标记不被规范化：字节原样保留，模型也不算就绪。
  const marker = join(modelRoot, "MODEL_VERSION.txt");
  writeFileSync(marker, "incomplete-existing-model\n");
  const before = readFileSync(marker);
  const nothingReady = await inspectStorage({ environ: envFor(root), projectRoot: root });
  assert.deepEqual(nothingReady.ready_models, []);
  assert.deepEqual(readFileSync(marker), before);
  assert.deepEqual(readdirSync(modelRoot), ["MODEL_VERSION.txt"]);

  // PyTorch 缓存就绪：两个 model.pt（zip 魔数）+ 标记含两个模型标识。
  writeTorchModel(modelRoot);
  writeFileSync(marker, "model=iic/SenseVoiceSmall\nvad=iic/speech_fsmn_vad_zh-cn-16k-common-pytorch\n");
  const pytorchReady = await inspectStorage({ environ: envFor(root), projectRoot: root });
  assert.deepEqual(pytorchReady.ready_models, ["iic/SenseVoiceSmall"]);

  // 标记缺 VAD 标识 → 不就绪；文件在 models/ 子层也接受；坏魔数不就绪。
  writeFileSync(marker, "model=iic/SenseVoiceSmall\n");
  assert.deepEqual((await inspectStorage({ environ: envFor(root), projectRoot: root })).ready_models, []);
  rmSync(join(modelRoot, "iic"), { recursive: true, force: true });
  writeTorchModel(modelRoot, "nested");
  writeFileSync(marker, "model=iic/SenseVoiceSmall\nvad=iic/speech_fsmn_vad_zh-cn-16k-common-pytorch\n");
  assert.deepEqual((await inspectStorage({ environ: envFor(root), projectRoot: root })).ready_models, ["iic/SenseVoiceSmall"]);
  writeFileSync(join(modelRoot, "models", "iic", "SenseVoiceSmall", "model.pt"), "plain text");
  assert.deepEqual((await inspectStorage({ environ: envFor(root), projectRoot: root })).ready_models, []);

  // ONNX 缓存为空 → 不就绪；空的 onnx 目录不得被探针创建或填充。
  mkdirSync(join(modelRoot, "onnx"), { recursive: true });
  const withEmptyOnnx = await inspectStorage({ environ: envFor(root), projectRoot: root });
  assert.deepEqual(withEmptyOnnx.ready_models, []);
  assert.deepEqual(readdirSync(join(modelRoot, "onnx")), []);
});

test("the real CLI writes one compact json line and follows python exit semantics", (t) => {
  const root = fixtureRoot(t);
  const run = runEntry(root);
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(lines[0], JSON.stringify({
    schema_version: 1,
    ready_models: [],
    component_state: "ungated",
    component_fingerprint: null,
    component_imported: false,
  }), "键序与紧凑度必须与 Python 的 json.dumps 一致");

  // --import-component：组件对本运行时不可用 → 非零退出、stdout 为空、stderr 带文案。
  const imported = runEntry(root, ["--import-component"]);
  assert.notEqual(imported.status, 0);
  assert.equal(imported.stdout.trim(), "");
  assert.ok(imported.stderr.includes("Storage component is unavailable"), imported.stderr);

  // 缺 APP_MODEL_DIR 等价 Python 的 KeyError：非零退出、无 stdout。
  const noModel = runEntry(root, [], { omitModelDir: true });
  assert.notEqual(noModel.status, 0);
  assert.equal(noModel.stdout.trim(), "");

  // 未知参数按用法错误退出 2、无结果行。
  const unknown = runEntry(root, ["--unknown"]);
  assert.equal(unknown.status, 2);
  assert.equal(unknown.stdout.trim(), "");
});
