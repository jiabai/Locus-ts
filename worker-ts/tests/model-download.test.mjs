import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  MODEL_DOWNLOAD_SOURCES,
  MODEL_VERSION_FILE_NAME,
  modelVersionMarker,
  pinnedAssetHashes,
} from "../src/asr/model-assets.ts";
import { validateModelCache } from "../src/asr/model-cache.ts";
import { buildDownloadUrl, prepareModelCache } from "../src/asr/model-download.ts";
import { isModelDownloadCancelled } from "../src/asr/errors.ts";

// 这些用例不需要真实模型，也不联网：用假 fetch 驱动完整的「staging → 自校验 →
// 整目录替换」流程，把下载语义（重试、续传、取消、磁盘空间、崩溃恢复）固定下来。
// 资产的 SHA-256 通过 `assetHashes` 覆盖，生产路径仍用 model-assets.ts 的固定值。

const RELATIVE_PATHS = Object.keys(MODEL_DOWNLOAD_SOURCES);

/** 每条资产一份短内容：分块后能产生多次读，进度事件才会真的发出来。 */
const CONTENTS = Object.fromEntries(
  RELATIVE_PATHS.map((relativePath) => [relativePath, `bytes:${relativePath}\n`]),
);
const HASHES = Object.fromEntries(
  Object.entries(CONTENTS).map(([relativePath, content]) => [
    relativePath,
    createHash("sha256").update(content).digest("hex"),
  ]),
);
const TOTAL_BYTES = Object.values(CONTENTS)
  .reduce((sum, content) => sum + Buffer.byteLength(content), 0);

function makeTempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "locus-asr-download-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function abortError() {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function streamOf(bytes, signal, chunkSize = 3) {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (signal?.aborted) {
        controller.error(abortError());
        return;
      }
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

function response({ status = 200, bytes, headers = {}, signal }) {
  const merged = { "content-length": String(bytes.length), ...headers };
  return {
    status,
    headers: { get: (name) => merged[name.toLowerCase()] ?? null },
    body: streamOf(bytes, signal),
  };
}

function parseRequestUrl(url) {
  const parsed = new URL(url);
  const modelId = parsed.pathname.replace("/api/v1/models/", "").replace(/\/repo$/, "");
  return { modelId, filePath: parsed.searchParams.get("FilePath"), revision: parsed.searchParams.get("Revision") };
}

/**
 * 假服务端。`override` 拿到 `{modelId, filePath, range, signal}` 后返回
 * `{status, bytes, headers}`、`"network-error"` 或自定义 Response。
 */
function createServer(contents = CONTENTS, override) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const { modelId, filePath, revision } = parseRequestUrl(url);
    const key = `${modelId}/${filePath}`;
    const relativePath = RELATIVE_PATHS.find(
      (candidate) => `${MODEL_DOWNLOAD_SOURCES[candidate].modelId}/${MODEL_DOWNLOAD_SOURCES[candidate].repositoryPath}` === key,
    );
    const signal = init.signal;
    const range = init.headers?.Range;
    requests.push({ key, relativePath, range, revision });

    const planned = override?.({ modelId, filePath, key, relativePath, range, signal, requests });
    if (planned === "network-error") {
      const error = new Error("socket hang up");
      error.code = "ECONNRESET";
      throw error;
    }
    if (planned === "abort") throw abortError();
    if (planned !== undefined) {
      return response({ ...planned, signal });
    }
    if (relativePath === undefined) {
      return response({ status: 404, bytes: Buffer.from("not found"), signal });
    }
    const bytes = Buffer.from(contents[relativePath]);
    if (range === undefined) return response({ bytes, signal });

    const offset = Number(/bytes=(\d+)-/.exec(range)[1]);
    return response({
      status: 206,
      bytes: bytes.subarray(offset),
      headers: { "content-range": `bytes ${offset}-${bytes.length - 1}/${bytes.length}` },
      signal,
    });
  };
  return { fetchImpl, requests };
}

async function writeCacheFiles(dir, contents) {
  for (const [relativePath, content] of Object.entries(contents)) {
    const filePath = join(dir, relativePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
  await writeFile(join(dir, MODEL_VERSION_FILE_NAME), modelVersionMarker());
}

async function listSiblings(dir) {
  return (await readdir(dir)).filter((name) => name.startsWith("."));
}

test("downloads every asset into staging, validates it, then promotes it", async (t) => {
  const root = makeTempDir(t);
  const cacheDir = join(root, "models", "onnx");
  const { fetchImpl, requests } = createServer();
  const events = [];

  const result = await prepareModelCache({
    cacheDir,
    assetHashes: HASHES,
    fetchImpl,
    retryDelayMs: () => 0,
    freeBytes: async () => 4 * 1024 ** 3,
    onProgress: (event) => events.push(event),
  });

  assert.equal(result.downloaded, true);
  assert.equal(result.cacheDir, cacheDir);
  assert.equal(result.bytesDownloaded, TOTAL_BYTES);
  assert.equal(requests.length, RELATIVE_PATHS.length);
  assert.ok(requests.every((request) => request.revision === "master"));

  const validation = await validateModelCache(cacheDir, HASHES);
  assert.equal(validation.valid, true, "提交后必须通过完整性校验");
  assert.equal(
    await readFile(join(cacheDir, MODEL_VERSION_FILE_NAME), "utf8"),
    modelVersionMarker(),
  );
  assert.deepEqual(await listSiblings(join(root, "models")), [], "不得留下 staging 或 backup");

  assert.equal(events[0].message_code, "model.download.preparing");
  assert.equal(events[0].progress, 0);
  assert.deepEqual(events.at(-1), {
    message_code: "model.download.completed",
    status: "completed",
    progress: 100,
    message_args: { model: "iic/SenseVoiceSmall-onnx" },
  });

  const progress = events.map((event) => event.progress);
  assert.deepEqual(progress, [...progress].sort((a, b) => a - b), "进度必须单调不减");

  const codes = events.map((event) => event.message_code);
  for (const code of ["model.primary.downloading", "model.vad.downloading", "model.bpe.downloading"]) {
    assert.ok(codes.includes(code), `缺少分组事件 ${code}`);
  }
  const completed = events.filter((event) => event.message_code === "model.file.completed");
  assert.equal(completed.length, RELATIVE_PATHS.length);
  assert.ok(completed.every((event) => !event.current_file.includes("/")));
  assert.ok(
    events.filter((event) => event.message_code === "model.file.downloading")
      .every((event) => event.current_file !== undefined && event.status === "downloading"),
  );
});

test("a ready cache is reused without a single request", async (t) => {
  const root = makeTempDir(t);
  const cacheDir = join(root, "models", "onnx");
  const server = createServer();

  await prepareModelCache({
    cacheDir,
    assetHashes: HASHES,
    fetchImpl: server.fetchImpl,
    retryDelayMs: () => 0,
    freeBytes: async () => 4 * 1024 ** 3,
  });

  const second = await prepareModelCache({
    cacheDir,
    assetHashes: HASHES,
    retryDelayMs: () => 0,
    freeBytes: async () => 4 * 1024 ** 3,
    fetchImpl: async () => {
      throw new Error("就绪的缓存不该再发请求");
    },
  });

  assert.equal(second.downloaded, false);
  assert.equal(second.bytesDownloaded, 0);
});

test("a corrupt cache is replaced rather than trusted", async (t) => {
  const root = makeTempDir(t);
  const cacheDir = join(root, "models", "onnx");
  await writeCacheFiles(cacheDir, CONTENTS);
  await writeFile(join(cacheDir, "models/iic/SenseVoiceSmall-onnx/tokens.json"), "corrupted");

  const server = createServer();
  const result = await prepareModelCache({
    cacheDir,
    assetHashes: HASHES,
    fetchImpl: server.fetchImpl,
    retryDelayMs: () => 0,
    freeBytes: async () => 4 * 1024 ** 3,
  });

  assert.equal(result.downloaded, true);
  assert.equal((await validateModelCache(cacheDir, HASHES)).valid, true);
  assert.equal(
    await readFile(join(cacheDir, "models/iic/SenseVoiceSmall-onnx/tokens.json"), "utf8"),
    CONTENTS["models/iic/SenseVoiceSmall-onnx/tokens.json"],
  );
});

test("a bad payload surfaces as ASR_MODEL_ARCHIVE_INVALID and leaves no cache", async (t) => {
  const root = makeTempDir(t);
  const cacheDir = join(root, "models", "onnx");
  const server = createServer(CONTENTS, ({ relativePath }) =>
    relativePath === "models/iic/SenseVoiceSmall-onnx/am.mvn"
      ? { bytes: Buffer.from("wrong bytes") }
      : undefined);

  await assert.rejects(
    () => prepareModelCache({
      cacheDir,
      assetHashes: HASHES,
      fetchImpl: server.fetchImpl,
      retryDelayMs: () => 0,
      freeBytes: async () => 4 * 1024 ** 3,
    }),
    (error) => {
      assert.equal(error.code, "ASR_MODEL_ARCHIVE_INVALID");
      assert.match(error.detail, /am\.mvn/);
      return true;
    },
  );

  assert.deepEqual(await listSiblings(join(root, "models")), [], "失败不得留下 staging");
  await assert.rejects(() => readFile(join(cacheDir, MODEL_VERSION_FILE_NAME)), "损坏的下载不能变成就绪缓存");
});

test("server errors are retried and the partial file is resumed", async (t) => {
  const root = makeTempDir(t);
  const cacheDir = join(root, "models", "onnx");
  const target = "models/iic/SenseVoiceSmall-onnx/config.yaml";
  const full = Buffer.from(CONTENTS[target]);
  let truncatedOnce = false;

  const server = createServer(CONTENTS, ({ relativePath, range, signal }) => {
    if (relativePath !== target) return undefined;
    if (!truncatedOnce) {
      // 第一次只给一半就断流：留下残片，验证下一次是续传而不是重下。
      truncatedOnce = true;
      return { bytes: full.subarray(0, 5), headers: { "content-length": String(full.length) }, signal };
    }
    return undefined;
  });

  const result = await prepareModelCache({
    cacheDir,
    assetHashes: HASHES,
    fetchImpl: server.fetchImpl,
    retryDelayMs: () => 0,
    freeBytes: async () => 4 * 1024 ** 3,
  });

  assert.equal(result.downloaded, true);
  const attempts = server.requests.filter((request) => request.relativePath === target);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].range, undefined);
  assert.equal(attempts[1].range, "bytes=5-", "第二次必须从残片末尾续传");
  assert.equal((await validateModelCache(cacheDir, HASHES)).valid, true);
});

test("a 5xx is retried, a 4xx fails immediately", async (t) => {
  const root = makeTempDir(t);
  const cacheDir = join(root, "models", "onnx");
  const target = "models/iic/speech_fsmn_vad_zh-cn-16k-common-onnx/am.mvn";
  let failures = 2;

  const flaky = createServer(CONTENTS, ({ relativePath }) => {
    if (relativePath !== target) return undefined;
    if (failures > 0) {
      failures -= 1;
      return { status: 503, bytes: Buffer.from("busy") };
    }
    return undefined;
  });
  const ok = await prepareModelCache({
    cacheDir,
    assetHashes: HASHES,
    fetchImpl: flaky.fetchImpl,
    retryDelayMs: () => 0,
    freeBytes: async () => 4 * 1024 ** 3,
  });
  assert.equal(ok.downloaded, true);
  assert.equal(flaky.requests.filter((request) => request.relativePath === target).length, 3);

  const missingRoot = makeTempDir(t);
  const missingCache = join(missingRoot, "models", "onnx");
  const notFound = createServer(CONTENTS, ({ relativePath }) =>
    relativePath === target ? { status: 404, bytes: Buffer.from("nope") } : undefined);

  await assert.rejects(
    () => prepareModelCache({
      cacheDir: missingCache,
      assetHashes: HASHES,
      fetchImpl: notFound.fetchImpl,
      retryDelayMs: () => 0,
      freeBytes: async () => 4 * 1024 ** 3,
    }),
    (error) => {
      assert.equal(error.code, "ASR_MODEL_DOWNLOAD_FAILED");
      assert.match(error.detail, /am\.mvn/);
      return true;
    },
  );
  // 4xx 之后不能继续重试，也不能接着下别的文件。
  assert.equal(notFound.requests.filter((request) => request.relativePath === target).length, 1);
});

test("cancelling stops the download, cleans staging and reports cancellation", async (t) => {
  const root = makeTempDir(t);
  const cacheDir = join(root, "models", "onnx");
  const server = createServer();
  const controller = new AbortController();
  const events = [];

  await assert.rejects(
    () => prepareModelCache({
      cacheDir,
      assetHashes: HASHES,
      fetchImpl: server.fetchImpl,
      signal: controller.signal,
      retryDelayMs: () => 0,
      freeBytes: async () => 4 * 1024 ** 3,
      onProgress: (event) => {
        events.push(event);
        if (event.message_code === "model.file.downloading") controller.abort();
      },
    }),
    (error) => {
      assert.ok(isModelDownloadCancelled(error), `取消应抛 AbortError 形状的错误，实际 ${error}`);
      return true;
    },
  );

  const cancellations = events.filter((event) => event.message_code === "model.download.cancelled");
  assert.equal(cancellations.length, 1);
  assert.equal(cancellations[0].status, "cancelled");
  assert.ok(cancellations[0].progress > 0 && cancellations[0].progress < 100);
  assert.deepEqual(await listSiblings(join(root, "models")), []);
  await assert.rejects(() => readFile(join(cacheDir, MODEL_VERSION_FILE_NAME)));
});

test("an undersized disk fails before any request", async (t) => {
  const root = makeTempDir(t);
  const cacheDir = join(root, "models", "onnx");
  const server = createServer();

  await assert.rejects(
    () => prepareModelCache({
      cacheDir,
      assetHashes: HASHES,
      fetchImpl: server.fetchImpl,
      retryDelayMs: () => 0,
      freeBytes: async () => 1024 * 1024,
    }),
    (error) => {
      assert.equal(error.code, "ASR_MODEL_DOWNLOAD_FAILED");
      assert.equal(error.detail, "ENOSPC");
      return true;
    },
  );
  assert.equal(server.requests.length, 0);
});

test("filesystem failures also land on the download code", async (t) => {
  const root = makeTempDir(t);
  const cacheDir = join(root, "models", "onnx");

  await assert.rejects(
    () => prepareModelCache({
      cacheDir,
      assetHashes: HASHES,
      fetchImpl: async () => {
        throw new Error("不该走到请求");
      },
      retryDelayMs: () => 0,
      freeBytes: async () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
    }),
    (error) => {
      assert.equal(error.code, "ASR_MODEL_DOWNLOAD_FAILED");
      assert.match(error.detail, /EACCES/);
      return true;
    },
  );
});

test("an interrupted promotion is recovered from the backup directory", async (t) => {
  const root = makeTempDir(t);
  const modelsDir = join(root, "models");
  const cacheDir = join(modelsDir, "onnx");
  const backupDir = join(modelsDir, ".onnx-backup-deadbeef");
  await writeCacheFiles(backupDir, CONTENTS);

  const result = await prepareModelCache({
    cacheDir,
    assetHashes: HASHES,
    retryDelayMs: () => 0,
    freeBytes: async () => 4 * 1024 ** 3,
    fetchImpl: async () => {
      throw new Error("备份可复原时不该重新下载");
    },
  });

  assert.equal(result.downloaded, false);
  assert.equal((await validateModelCache(cacheDir, HASHES)).valid, true);
  assert.deepEqual(await listSiblings(modelsDir), [], "复原后不得留下 backup");
});

test("the download table covers exactly the pinned assets", () => {
  assert.deepEqual(RELATIVE_PATHS.slice().sort(), Object.keys(pinnedAssetHashes()).sort());

  for (const [relativePath, source] of Object.entries(MODEL_DOWNLOAD_SOURCES)) {
    const expectedModel = relativePath.endsWith(".bpe.model")
      ? "iic/SenseVoiceSmall"
      : relativePath.startsWith("models/iic/SenseVoiceSmall-onnx/")
        ? "iic/SenseVoiceSmall-onnx"
        : "iic/speech_fsmn_vad_zh-cn-16k-common-onnx";
    assert.equal(source.modelId, expectedModel, `${relativePath} 的来源仓库不对`);
  }

  assert.equal(
    buildDownloadUrl("iic/SenseVoiceSmall-onnx", "model_quant.onnx"),
    "https://www.modelscope.cn/api/v1/models/iic/SenseVoiceSmall-onnx/repo?Revision=master&FilePath=model_quant.onnx",
  );
});
