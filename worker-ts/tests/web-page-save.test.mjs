// 网页保存入口：请求校验 → 进度事件 → 单事务提交 `article/` 两文件与清单 →
// 失败一律收敛成 `WEB_PAGE_REQUEST_OR_STORAGE_INVALID`。对齐 Python
// `web_page_storage.py::save_web_page_once` 的可观察行为。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runSaveWebPageOnce } from "../src/pipeline/web-page-save.ts";
import { createTaskPaths } from "../src/tasks/paths.ts";

const NOW = new Date("2026-11-14T12:00:00Z");
const TASK_ID = "20261114-120000-web-abcdef0123456789";
const OPERATION_ID = "00000000-0000-0000-0000-000000000001";
const SOURCE_URL = "https://example.io/articles/a1";
const TITLE = "公开文章与本地保存";
const TEXT = "段落保留原始UTF-8字节🙂。\n".repeat(6);
const MARKDOWN = "## 文章\n\n段落保留结构。\n\n- 第一条\n- 第二条\n";
const SAVED_MARKDOWN = `# 公开文章与本地保存\n\n<${SOURCE_URL}>\n\n2026-11-14T12:00:00Z\n\n${MARKDOWN}`;

function request(overrides = {}) {
  return {
    contract_version: 2,
    operation_id: OPERATION_ID,
    task_id: TASK_ID,
    article: {title: TITLE, text: TEXT, markdown: MARKDOWN, sourceUrl: SOURCE_URL},
    ...overrides,
  };
}

async function makeStore(t) {
  const root = mkdtempSync(join(tmpdir(), "locus-web-save-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = { outputRoot: join(root, "outputs"), cacheRoot: join(root, "cache") };
  return { root, store, paths: createTaskPaths({ ...store, taskId: TASK_ID }) };
}

const ENV = (store) => ({ APP_OUTPUT_DIR: store.outputRoot, APP_CACHE_DIR: store.cacheRoot });

test("a valid request saves both article files and the manifest in one transaction", async (t) => {
  const { store, paths } = await makeStore(t);
  const events = [];

  const payload = await runSaveWebPageOnce(request(), {
    environ: ENV(store),
    onProgress: (event) => events.push(event),
    now: NOW,
  });

  assert.equal(payload.status, "completed");
  assert.equal(payload.task_id, TASK_ID);
  assert.equal(payload.task_created, true);
  assert.equal(payload.task_dir.replaceAll("\\", "/"), paths.taskDir.replaceAll("\\", "/"));
  assert.deepEqual(payload.artifacts, {
    article_txt: "article/article.txt", article_md: "article/article.md",
  });
  assert.equal(payload.text, TEXT);
  assert.equal(payload.markdown, SAVED_MARKDOWN);
  assert.deepEqual(payload.source, {
    kind: "web_page", url: SOURCE_URL, title: TITLE, extractedAt: "2026-11-14T12:00:00Z",
  });
  assert.equal(payload.transcript, null);
  assert.equal(payload.error, null);

  // 保存路径只发一个事件：进度 90，阶段固定 web_saving。
  assert.deepEqual(events.map((event) => ({
    code: event.message_code, progress: event.progress, stage: event.stage,
  })), [{ code: "web.page.saving", progress: 90, stage: "web_saving" }]);

  assert.equal(await readFile(paths.articleTxtPath, "utf8"), TEXT);
  assert.equal(await readFile(paths.articleMdPath, "utf8"), SAVED_MARKDOWN);
  const manifest = JSON.parse(await readFile(paths.manifestPath, "utf8"));
  assert.equal(manifest.schema_version, 4);
  assert.equal(manifest.source_kind, "web_page");
  assert.equal(manifest.source_url, SOURCE_URL);
  assert.equal(manifest.source_identity, null);
  assert.equal(manifest.platform, "web");
  assert.equal(manifest.model, null);
  assert.equal(manifest.transcript, null);
  assert.deepEqual(manifest.web_source, { title: TITLE, extracted_at: "2026-11-14T12:00:00Z" });
  assert.deepEqual(manifest.artifacts, {
    article_txt: "article/article.txt", article_md: "article/article.md",
  });
  assert.equal("note_title" in manifest, false);
  assert.equal("local_source" in manifest, false);

  // 事务材料必须清干净：保存后不应留下任何 journal。
  const residue = (await readdir(paths.taskDir)).filter((name) => name.startsWith(".artifact"));
  assert.deepEqual(residue, []);
});

test("request validation, storage roots and duplicate ids collapse into one failure code", async (t) => {
  const { store, paths } = await makeStore(t);

  const failures = [];

  // 文章正文去空白后不足 50 字：契约拒绝。
  failures.push(["薄正文", await runSaveWebPageOnce(request({
    article: {title: TITLE, text: "太短", markdown: MARKDOWN, sourceUrl: SOURCE_URL},
  }), { environ: ENV(store), now: NOW })]);

  // 请求缺 operation_id。
  const missing = request();
  delete missing.operation_id;
  failures.push(["缺操作 id", await runSaveWebPageOnce(missing, { environ: ENV(store), now: NOW })]);

  // 存储根未显式给出。
  failures.push(["缺输出目录", await runSaveWebPageOnce(request(), {
    environ: { APP_CACHE_DIR: store.cacheRoot }, now: NOW,
  })]);

  // 存储根必须是绝对路径。
  failures.push(["相对输出目录", await runSaveWebPageOnce(request(), {
    environ: { APP_OUTPUT_DIR: "relative/outputs", APP_CACHE_DIR: store.cacheRoot }, now: NOW,
  })]);

  // 任务目录已存在：等价于任务 id 被占用。
  await mkdir(paths.taskDir, { recursive: true });
  failures.push(["任务 id 冲突", await runSaveWebPageOnce(request(), {
    environ: ENV(store), now: NOW,
  })]);

  for (const [label, payload] of failures) {
    assert.equal(payload.status, "failed", label);
    assert.equal(payload.error.code, "WEB_PAGE_REQUEST_OR_STORAGE_INVALID", label);
    assert.equal(payload.error.message, "Web page saving failed.", label);
    assert.equal(payload.error.stage, "web_saving", label);
    assert.equal(payload.task_id, null, label);
    assert.equal(payload.task_created, undefined, label);
  }
});
