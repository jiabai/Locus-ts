import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadTaskManifest,
  parseNoteTitleMetadata,
  taskContextFromLoadedManifest,
  transcriptMetadataFromManifest,
  validateTaskManifest,
} from "../src/tasks/load.ts";
import { serializeTaskManifest } from "../src/tasks/manifest.ts";
import { createLocalTaskContext } from "../src/tasks/index.ts";
import { createTaskPaths } from "../src/tasks/paths.ts";
import { readTaskSourceText, readSourceFile } from "../src/tasks/source-text.ts";
import { writeTranscriptFiles } from "../src/artifacts/transcript-artifacts.ts";
import { failedResult } from "../src/tasks/types.ts";

const TASK_NOW = new Date("2026-11-14T12:00:00Z");
const RANDOM_ID = "abcdef0123456789";

function makeContext(store) {
  return createLocalTaskContext({
    store,
    request: {
      safeDisplayName: "采访 01.wav",
      mediaKind: "audio",
      sourceExtension: "wav",
      asrModel: "iic/SenseVoiceSmall-onnx",
    },
    now: TASK_NOW,
    randomId: RANDOM_ID,
  });
}

function makeManifest(overrides = {}) {
  const { context } = makeContext({ outputRoot: "/data/outputs", cacheRoot: "/data/cache" });
  const result = {
    ...failedResult({ code: "X", message: "X", stage: "completed" }),
    status: "completed",
    artifacts: { transcript_txt: "transcript/transcript.txt" },
    text: "一段文字稿",
    transcript: { source: "asr", language: null, engine: "iic/SenseVoiceSmall-onnx" },
    error: null,
  };
  const raw = Buffer.from(serializeTaskManifest(context, result, { now: () => TASK_NOW })).toString("utf8");
  return { taskId: context.taskId, manifest: { ...JSON.parse(raw), ...overrides } };
}

function makeRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "locus-load-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function tryMakeLink(target, linkPath) {
  // Windows 上普通符号链接要开发者模式；目录联接不需要，而 Node 的 lstat 同样报
  // isSymbolicLink()，正好覆盖同一条拒绝路径。文件链接在没有权限时只能跳过断言，
  // 不能让整组测试因为环境权限假失败。
  const types = process.platform === "win32" ? ["file", "junction"] : ["file"];
  for (const type of types) {
    try {
      await symlink(target, linkPath, type);
      return true;
    } catch (error) {
      if (!["EPERM", "EACCES", "EINVAL"].includes(error.code)) throw error;
    }
  }
  return false;
}

test("manifest validation rejects the ways a task history can be untrustworthy", () => {
  const { taskId, manifest } = makeManifest();
  assert.doesNotThrow(() => validateTaskManifest(manifest, taskId));

  for (const broken of [
    { task_id: "someone-else" },
    { schema_version: 2 },
    { schema_version: "3" },
    { source_privacy_migration_version: 1 },
    { source_privacy_quarantined: true },
    { source_kind: "web_page" },
    { source_url: "https://example.invalid" },
    { source_identity: { platform: "douyin" } },
    { platform: "web" },
    { local_source: { display_name: "a.wav", media_kind: "audio" } },
    { local_source: { display_name: "../a.wav", media_kind: "audio", extension: "wav" } },
    { artifacts: { transcript_txt: "somewhere/else.txt" } },
    { artifacts: { article_txt: "article/article.txt" } },
    { artifacts: { draft: "ai/original/draft.md" } },
    { note_title: { text: "标题", status: "completed" } },
  ]) {
    assert.throws(
      () => validateTaskManifest({ ...manifest, ...broken }, taskId),
      `应当拒止：${JSON.stringify(broken).slice(0, 90)}`,
    );
  }
  assert.throws(() => validateTaskManifest([], taskId));
  assert.throws(() => validateTaskManifest(null, taskId));
});

test("note-title metadata is parsed strictly, including status-dependent fields", () => {
  const good = {
    text: "一段标题",
    status: "completed",
    output_language: "zh-CN",
    error_code: null,
  };
  assert.deepEqual(parseNoteTitleMetadata(good), good);
  assert.deepEqual(parseNoteTitleMetadata({
    text: null, status: "failed", output_language: "en-US", error_code: "TITLE_SAVE_FAILED",
  }), { text: null, status: "failed", output_language: "en-US", error_code: "TITLE_SAVE_FAILED" });

  for (const broken of [
    { text: "标题", status: "completed", output_language: "zh-CN" },
    { ...good, extra: 1 },
    { ...good, status: "generating", error_code: "TITLE_SAVE_FAILED" },
    { ...good, error_code: "LOWER_CASE" },
    { ...good, text: " 标题 " },
    { ...good, text: "标题\u202e" },
    { ...good, output_language: "fr-FR" },
    { text: null, status: "failed", output_language: "zh-CN", error_code: null },
  ]) {
    assert.throws(() => parseNoteTitleMetadata(broken), `应当拒止：${JSON.stringify(broken)}`);
  }
});

test("context and transcript metadata are restored from a loaded manifest", () => {
  const { taskId, manifest } = makeManifest();
  const store = { outputRoot: "/data/outputs", cacheRoot: "/data/cache" };
  const { context, paths } = taskContextFromLoadedManifest(store, taskId, manifest);
  assert.equal(context.taskId, taskId);
  assert.equal(context.model, "iic/SenseVoiceSmall-onnx");
  assert.equal(context.source.displayName, "采访 01.wav");
  assert.equal(paths.manifestPath, createTaskPaths({ ...store, taskId }).manifestPath);
  assert.deepEqual(transcriptMetadataFromManifest(manifest), {
    source: "asr", language: null, engine: "iic/SenseVoiceSmall-onnx",
  });
  assert.equal(transcriptMetadataFromManifest({ transcript: { source: "unknown" } }), null);
  assert.equal(transcriptMetadataFromManifest({}), null);
});

test("loading a task recovers transactions and rejects linked or damaged storage", async (t) => {
  const root = makeRoot(t);
  const store = { outputRoot: join(root, "outputs"), cacheRoot: join(root, "cache") };
  const { taskId, manifest } = makeManifest();
  const paths = createTaskPaths({ ...store, taskId });
  await mkdir(paths.transcriptDir, { recursive: true });
  await writeTranscriptFiles({
    text: "一段文字稿",
    outputDir: paths.transcriptDir,
    outputStem: "",
    metadata: { source: "asr", language: null, engine: "iic/SenseVoiceSmall-onnx" },
  });
  await writeFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const loaded = await loadTaskManifest(store, taskId);
  assert.equal(loaded.task_id, taskId);
  assert.deepEqual(loaded.artifacts, manifest.artifacts);

  await assert.rejects(() => loadTaskManifest(store, "../outside"));
  await assert.rejects(() => loadTaskManifest(store, ".."));
  await assert.rejects(() => loadTaskManifest(store, ""));

  // 清单被换成链接：读到的东西与清单承诺的不是同一份。
  const backup = join(root, "manifest-backup.json");
  await copyFile(paths.manifestPath, backup);
  await rm(paths.manifestPath);
  if (await tryMakeLink(backup, paths.manifestPath)) {
    await assert.rejects(() => loadTaskManifest(store, taskId));
  }
  await rm(paths.manifestPath, { force: true });
  await copyFile(backup, paths.manifestPath);

  // multi-link（nlink>1）也要拒止：文件被别处硬链接时身份不可判定。
  const other = join(root, "manifest-hardlink.json");
  const { link } = await import("node:fs/promises");
  await link(paths.manifestPath, other).catch(() => {});
  if ((await lstat(paths.manifestPath)).nlink > 1) {
    await assert.rejects(() => loadTaskManifest(store, taskId));
  }
});

test("the authoritative source text is the file the manifest points at", async (t) => {
  const root = makeRoot(t);
  const store = { outputRoot: join(root, "outputs"), cacheRoot: join(root, "cache") };
  const { taskId, manifest } = makeManifest();
  const paths = createTaskPaths({ ...store, taskId });
  await mkdir(paths.transcriptDir, { recursive: true });
  await writeFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(paths.transcriptTxtPath, "第一段。\n\n第二段。\n", "utf8");

  const source = await readTaskSourceText(store, taskId);
  assert.equal(source.kind, "transcript");
  assert.equal(source.text, "第一段。\n\n第二段。\n");
  assert.ok((await lstat(source.path)).isFile());

  // 上限按字节算，超限直接判不可用，不「尽力读一点」。
  await assert.rejects(() => readSourceFile(source.path, 4, paths.taskDir));
  // 源文本为空：不允许基于空稿生成摘要。
  await writeFile(paths.transcriptTxtPath, "  \n ", "utf8");
  await assert.rejects(() => readTaskSourceText(store, taskId));
  // 清单里的键与磁盘不一致：权威源不明，拒止。
  await writeFile(paths.transcriptTxtPath, "正文", "utf8");
  const wrong = { ...manifest, artifacts: { transcript_txt: "transcript/old.txt" } };
  await writeFile(paths.manifestPath, `${JSON.stringify(wrong, null, 2)}\n`, "utf8");
  await assert.rejects(() => readTaskSourceText(store, taskId));
});
