import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MODEL_DOWNLOAD_SOURCES } from "../src/asr/model-assets.ts";
import { runAsrModelDownloadOnce } from "../src/worker-service.ts";

// `--download-asr-model` 的宿主可见语义：两种终态、两个固定文案、绝不抛错。
// 成功路径用假 fetch + 假哈希跑通完整下载，失败路径不联网。

const CONTENTS = Object.fromEntries(
  Object.keys(MODEL_DOWNLOAD_SOURCES).map((relativePath) => [relativePath, `bytes:${relativePath}\n`]),
);
const HASHES = Object.fromEntries(
  Object.entries(CONTENTS).map(([relativePath, content]) => [
    relativePath,
    createHash("sha256").update(content).digest("hex"),
  ]),
);

function makeTempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "locus-model-mode-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function serve(contents = CONTENTS, override) {
  return async (url, init = {}) => {
    const parsed = new URL(url);
    const modelId = parsed.pathname.replace("/api/v1/models/", "").replace(/\/repo$/, "");
    const filePath = parsed.searchParams.get("FilePath");
    const key = `${modelId}/${filePath}`;
    const relativePath = Object.keys(MODEL_DOWNLOAD_SOURCES).find((candidate) => {
      const source = MODEL_DOWNLOAD_SOURCES[candidate];
      return `${source.modelId}/${source.repositoryPath}` === key;
    });
    const planned = override?.({ relativePath, init });
    if (planned !== undefined) return planned;
    if (relativePath === undefined) {
      return { status: 404, headers: { get: () => null }, body: null };
    }
    const bytes = Buffer.from(contents[relativePath]);
    return {
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === "content-length" ? String(bytes.length) : null) },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(bytes));
          controller.close();
        },
      }),
    };
  };
}

test("a legacy or unknown model id is refused without touching the network", async (t) => {
  const modelDir = makeTempDir(t);
  for (const model of ["iic/SenseVoiceSmall", "something/else"]) {
    const result = await runAsrModelDownloadOnce({
      model,
      modelDir,
      fetchImpl: async () => {
        throw new Error("不该发请求");
      },
    });
    assert.deepEqual(result, {
      status: "failed",
      code: "ASR_MODEL_UNSUPPORTED",
      message: "ASR model download failed.",
    });
  }
});

test("a successful download reports the contract shape", async (t) => {
  const modelDir = makeTempDir(t);
  const progress = [];
  const result = await runAsrModelDownloadOnce({
    model: "iic/SenseVoiceSmall-onnx",
    modelDir,
    assetHashes: HASHES,
    fetchImpl: serve(),
    onProgress: (event) => progress.push(event.message_code),
  });

  assert.deepEqual(result, { status: "completed", model: "iic/SenseVoiceSmall-onnx" });
  assert.equal(progress[0], "model.download.preparing");
  assert.equal(progress.at(-1), "model.download.completed");
  assert.ok(progress.includes("model.file.completed"));
});

test("the existing cache is reused and still reports completion", async (t) => {
  const modelDir = makeTempDir(t);
  await mkdir(modelDir, { recursive: true });
  await runAsrModelDownloadOnce({
    model: "iic/SenseVoiceSmall-onnx",
    modelDir,
    assetHashes: HASHES,
    fetchImpl: serve(),
  });

  const result = await runAsrModelDownloadOnce({
    model: "iic/SenseVoiceSmall-onnx",
    modelDir,
    assetHashes: HASHES,
    fetchImpl: async () => {
      throw new Error("就绪的缓存不该再发请求");
    },
  });
  assert.deepEqual(result, { status: "completed", model: "iic/SenseVoiceSmall-onnx" });
});

test("a transport failure maps to ASR_MODEL_DOWNLOAD_FAILED", async (t) => {
  const modelDir = makeTempDir(t);
  const result = await runAsrModelDownloadOnce({
    model: "iic/SenseVoiceSmall-onnx",
    modelDir,
    assetHashes: HASHES,
    fetchImpl: async () => {
      throw new Error("ECONNRESET");
    },
  });

  assert.deepEqual(result, {
    status: "failed",
    code: "ASR_MODEL_DOWNLOAD_FAILED",
    message: "ASR model download failed.",
  });
});

test("a corrupted payload maps to ASR_MODEL_ARCHIVE_INVALID", async (t) => {
  const modelDir = makeTempDir(t);
  const result = await runAsrModelDownloadOnce({
    model: "iic/SenseVoiceSmall-onnx",
    modelDir,
    assetHashes: HASHES,
    fetchImpl: serve(CONTENTS, ({ relativePath }) => (
      relativePath === "models/iic/SenseVoiceSmall-onnx/config.yaml"
        ? {
          status: 200,
          headers: { get: (name) => (name.toLowerCase() === "content-length" ? "7" : null) },
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(Buffer.from("garbage")));
              controller.close();
            },
          }),
        }
        : undefined
    )),
  });

  assert.deepEqual(result, {
    status: "failed",
    code: "ASR_MODEL_ARCHIVE_INVALID",
    message: "Downloaded ASR model archive was invalid.",
  });
});

test("APP_MODEL_DIR decides where the cache lands", async (t) => {
  const modelDir = makeTempDir(t);
  const seen = [];
  const result = await runAsrModelDownloadOnce({
    model: "iic/SenseVoiceSmall-onnx",
    environ: { APP_MODEL_DIR: modelDir },
    assetHashes: HASHES,
    fetchImpl: serve(CONTENTS, ({ init }) => {
      seen.push(init);
      return undefined;
    }),
  });

  assert.equal(result.status, "completed");
  assert.ok(seen.length > 0);
  const { validateModelCache } = await import("../src/asr/model-cache.ts");
  const validation = await validateModelCache(join(modelDir, "onnx"), HASHES);
  assert.equal(validation.valid, true, "缓存必须落在 APP_MODEL_DIR/onnx");
});
