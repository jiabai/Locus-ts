import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  assertModelCacheReady,
  resolveModelCacheDir,
  validateModelCache,
} from "../src/asr/model-cache.ts";
import {
  ADDITIONAL_ASSET_HASHES,
  MODEL_VERSION_FILE_NAME,
  ONNX_REQUIRED_ASSET_HASHES,
} from "../src/asr/model-assets.ts";

// 这些用例不需要真实模型：把一份结构正确但内容错误的缓存放到临时目录，
// 验证「损坏缓存不得视为可用」的失败语义与错误码。

const MODEL = "iic/SenseVoiceSmall-onnx";

function createCacheDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "locus-asr-cache-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeFiles(cacheDir, entries) {
  for (const [relativePath, content] of Object.entries(entries)) {
    const filePath = join(cacheDir, relativePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
}

const ALL_PINNED = { ...ONNX_REQUIRED_ASSET_HASHES, ...ADDITIONAL_ASSET_HASHES };

test("cache dir resolves to <root>/models/onnx", () => {
  assert.equal(
    resolveModelCacheDir(join("D:", "LOCUS")),
    join("D:", "LOCUS", "models", "onnx"),
  );
});

test("missing files report every pinned path as missing", async (t) => {
  const cacheDir = createCacheDir(t);
  const validation = await validateModelCache(cacheDir);

  assert.equal(validation.valid, false);
  assert.equal(validation.problems.length, Object.keys(ALL_PINNED).length);
  assert.ok(validation.problems.every((problem) => problem.reason === "missing"));
});

test("content that does not match the pin is rejected and surfaces the actual hash", async (t) => {
  const cacheDir = createCacheDir(t);
  await writeFiles(cacheDir, Object.fromEntries(
    Object.keys(ALL_PINNED).map((relativePath) => [relativePath, "not the real model file"]),
  ));
  await writeFile(join(cacheDir, MODEL_VERSION_FILE_NAME), `iic/SenseVoiceSmall-onnx\niic/speech_fsmn_vad_zh-cn-16k-common-onnx\n`);

  const validation = await validateModelCache(cacheDir);
  assert.equal(validation.markerValid, true);
  assert.equal(validation.valid, false, "哈希不符的缓存不能算就绪");
  assert.ok(validation.problems.every((problem) => problem.reason === "sha256_mismatch"));

  await assert.rejects(
    () => assertModelCacheReady(cacheDir, MODEL),
    (error) => {
      assert.equal(error.code, "ASR_MODEL_NOT_DOWNLOADED");
      assert.match(error.detail, /sha256_mismatch|SHA-256/);
      return true;
    },
  );
});

test("a ready marker without both model ids is not enough", async (t) => {
  const cacheDir = createCacheDir(t);
  await writeFiles(cacheDir, { [MODEL_VERSION_FILE_NAME]: "iic/SenseVoiceSmall-onnx\n" });

  const validation = await validateModelCache(cacheDir);
  assert.equal(validation.markerValid, false);
  assert.equal(validation.valid, false);
});

test("missing cache directory is reported as an environment problem", async () => {
  const missing = join(tmpdir(), `locus-asr-absent-${Date.now()}`);
  await assert.rejects(
    () => assertModelCacheReady(missing, MODEL),
    // 目录不存在时所有文件都算 missing，仍然是「未下载」而不是崩溃。
    (error) => error.code === "ASR_MODEL_NOT_DOWNLOADED",
  );
});
