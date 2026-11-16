import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// 存储校验探针的跨语言守卫：环境变量名、组件状态闭集、输出 JSON 的键集合、
// 模型标识与失败文案在 Python 与 TypeScript 两侧各有一份用途——Rust 宿主按
// 这份形状解析探针输出并对比迁移基线，任何一侧单独改动都会让迁移校验失真。

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function read(relative) {
  return readFile(resolve(repositoryRoot, relative), "utf8");
}

test("the probe entry, output schema and state enum are pinned on both sides", async () => {
  const [python, component, typescript, rust, baseline] = await Promise.all([
    read("worker/worker_core/storage_validation.py"),
    read("worker/worker_core/runtime_component.py"),
    read("worker-ts/src/storage-validation.ts"),
    read("app/src-tauri/src/worker_runtime/result_protocol.rs"),
    read("app/src-tauri/src/data_storage_validation.rs"),
  ]);
  // 探针输出的键集合与顺序：Python 的 dict 插入序 = TS 的构造序 = Rust 的反序列化字段
  // （Rust 结构体保持 snake_case 字段名，探针 JSON 就是线协议形状）。
  for (const key of ["schema_version", "ready_models", "component_state",
    "component_fingerprint", "component_imported"]) {
    assert.ok(python.includes(`"${key}"`), `Python 输出缺少 ${key}`);
    assert.ok(typescript.includes(key), `TypeScript 输出缺少 ${key}`);
    assert.ok(rust.includes(`pub(crate) ${key}`), `Rust 结果结构缺少 ${key}`);
  }
  assert.ok(python.includes('"schema_version": 1'));
  for (const state of ["ready", "missing", "stale", "ungated"]) {
    assert.ok(component.includes(`RUNTIME_COMPONENT_${state.toUpperCase()} = "${state}"`),
      `Python 状态闭集缺少 ${state}`);
    assert.ok(typescript.includes(`'${state}'`), `TypeScript 状态闭集缺少 ${state}`);
  }
  // Rust 侧额外接受宿主自己派生的 unavailable（基线校验的状态闭集）。
  assert.ok(baseline.includes('"unavailable"'));
});

test("component environment names, manifest name and fingerprint key match", async () => {
  const [component, typescript, command] = await Promise.all([
    read("worker/worker_core/runtime_component.py"),
    read("worker-ts/src/storage-validation.ts"),
    read("app/src-tauri/src/worker_runtime/command.rs"),
  ]);
  // APP_BUNDLED_RUNTIME_MANIFEST 是测试与本地 dev 的覆盖入口，生产装配只用
  // APP_RESOURCE_DIR 与 APP_PYTORCH_RUNTIME_DIR，所以只在两侧源码里钉住。
  for (const name of ["APP_PYTORCH_RUNTIME_DIR", "APP_BUNDLED_RUNTIME_MANIFEST", "APP_RESOURCE_DIR"]) {
    assert.ok(component.includes(`"${name}"`), `Python 缺少 ${name}`);
    assert.ok(typescript.includes(`'${name}'`), `TypeScript 缺少 ${name}`);
  }
  for (const name of ["APP_PYTORCH_RUNTIME_DIR", "APP_RESOURCE_DIR", "APP_MODEL_DIR"]) {
    assert.ok(command.includes(name), `Rust 命令装配缺少 ${name}`);
  }
  assert.ok(component.includes('BUNDLED_MANIFEST_NAME = "runtime-manifest.json"'));
  assert.ok(typescript.includes("BUNDLED_MANIFEST_NAME = 'runtime-manifest.json'"));
  assert.ok(component.includes('"lock_fingerprint"'));
  assert.ok(typescript.includes("lock_fingerprint"));
  // Python 经 `python -m worker_core.storage_validation` 调用，Rust 装配同一入口；
  // TypeScript 入口是独立脚本而不是 cli.ts 的模式（探针不走线协议结果形状）。
  assert.ok(command.includes('"worker_core.storage_validation"'));
});

test("model identifiers, torch magic and the failure message match python", async () => {
  const [modelDownload, typescript] = await Promise.all([
    read("worker/worker_core/model_download.py"),
    read("worker-ts/src/storage-validation.ts"),
  ]);
  for (const id of ["iic/SenseVoiceSmall", "iic/SenseVoiceSmall-onnx",
    "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch"]) {
    assert.ok(modelDownload.includes(`"${id}"`), `Python 模型标识缺少 ${id}`);
    assert.ok(typescript.includes(`'${id}'`), `TypeScript 模型标识缺少 ${id}`);
  }
  assert.ok(typescript.includes("0x50, 0x4b, 0x03, 0x04"), "TS 缺少 torch zip 魔数");
  assert.ok(typescript.includes("'Storage component is unavailable'"));
  // --import-component 在 TS 侧按计划第 6 条始终失败，文案与 Python 失败路径一致。
  const pythonStorage = await read("worker/worker_core/storage_validation.py");
  assert.ok(pythonStorage.includes("Storage component is unavailable"));
});
