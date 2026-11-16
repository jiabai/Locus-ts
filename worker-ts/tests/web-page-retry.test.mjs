// 网页任务的重算入口：title / transcript 拒止、summary 以保存的文章为权威源、
// 草稿分支按 `source_kind=article` 生成。清单形状与失败码都对齐 Python 的
// `insight_retry.py` 网页分支。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runToolLoop } from "../src/ai/tool-loop.ts";
import { runInsightRetryPipeline } from "../src/pipeline/insight-retry.ts";
import { saveWebPage } from "../src/pipeline/web-page-save.ts";
import { createTaskPaths } from "../src/tasks/paths.ts";

const TASK_NOW = new Date("2026-11-14T12:00:00Z");
const WEB_TASK_ID = "20261114-120000-web-abcdef0123456789";
const SOURCE_URL = "https://example.io/articles/a1";
const TITLE = "The blank slate review";
const TEXT = "A long-form article body with more than fifty solid characters of prose. ";
const MARKDOWN = "# The blank slate review\n\nIntro paragraph.\n";
const EXTRACTED_AT = "2026-11-14T12:00:00Z";

function text(raw) {
  return raw.replaceAll("\r\n", "\n");
}

function scriptedRuntime(replies) {
  return {
    async complete(options) {
      return runToolLoop({
        ...options,
        chat: async () => {
          const reply = replies.shift();
          if (reply === undefined) throw new Error("模型回复用完了");
          return reply;
        },
      });
    },
  };
}

function toolCall(id, name, args) {
  return { text: null, toolCalls: [{ id, name, arguments: JSON.stringify(args) }] };
}

function workingLlm() {
  return scriptedRuntime([
    toolCall("call_1", "submit_mindmap", { mermaid: "mindmap\n  root((主题))\n    分支" }),
    toolCall("call_2", "submit_summary", { markdown: "总览\n\n- 一条要点" }),
  ]);
}

async function makeWebTask(t) {
  const root = mkdtempSync(join(tmpdir(), "locus-web-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = { outputRoot: join(root, "outputs"), cacheRoot: join(root, "cache") };
  const saved = await saveWebPage(store, {
    title: TITLE,
    text: TEXT,
    markdown: MARKDOWN,
    sourceUrl: SOURCE_URL,
  }, { now: TASK_NOW, taskId: WEB_TASK_ID });
  const paths = createTaskPaths({ ...store, taskId: saved.taskId });
  return { root, store, saved, paths, taskId: saved.taskId };
}

function request(taskId, overrides = {}) {
  return { task_id: taskId, target: "summary", output_language: "zh-CN", ...overrides };
}

test("web tasks reject title and transcript retry targets with task identity", async (t) => {
  const { store, saved, paths, taskId } = await makeWebTask(t);
  const before = await readFile(paths.manifestPath, "utf8");

  for (const target of ["title", "transcript"]) {
    const result = await runInsightRetryPipeline(request(taskId, { target }), {
      projectRoot: store.outputRoot,
      store,
      environ: {},
    });
    assert.equal(result.status, "partial_completed");
    assert.equal(result.error.code, "WEB_PAGE_RETRY_TARGET_INVALID");
    assert.equal(result.error.message, "This retry target is unavailable for web pages.");
    assert.equal(result.error.stage, "insights_generating");
    // 结果行仍带任务标识与磁盘现状：正文与 Markdown 从 `article/` 读回。
    assert.equal(result.taskId, taskId);
    assert.equal(
      result.taskDir.replaceAll("\\", "/"),
      paths.taskDir.replaceAll("\\", "/"),
    );
    assert.equal(result.text, TEXT);
    assert.equal(result.markdown, saved.markdown);
    assert.deepEqual(result.source, {
      kind: "web_page", url: SOURCE_URL, title: TITLE, extractedAt: EXTRACTED_AT,
    });
    assert.equal(result.transcript, null);
    assert.equal(result.artifacts.article_txt, "article/article.txt");
    assert.equal(result.artifacts.article_md, "article/article.md");
    // 拒止不写清单：文件一个字节都不能动。
    assert.equal(await readFile(paths.manifestPath, "utf8"), before);
  }
});

test("a summary retry on a web task uses the saved article and article prompts", async (t) => {
  const { store, saved, paths, taskId } = await makeWebTask(t);
  const seenKinds = [];

  const result = await runInsightRetryPipeline(request(taskId), {
    projectRoot: store.outputRoot,
    store,
    environ: {},
    llmFactory: async (env) => {
      seenKinds.push(env.APP_AI_SOURCE_KIND);
      return workingLlm();
    },
  });

  // Python 在打开任务后统一注入 `APP_AI_SOURCE_KIND=article`，摘要提示词按文章生成。
  assert.deepEqual(seenKinds, ["article"]);
  assert.equal(result.status, "completed");
  assert.equal(result.error, null);
  assert.equal(text(result.summary), "# 要点总结\n\n总览\n\n- 一条要点\n");
  // 网页分支的 text / markdown / source 一律从磁盘读回，生成结果不覆盖它们。
  assert.equal(result.text, TEXT);
  assert.equal(result.markdown, saved.markdown);
  assert.deepEqual(result.source, {
    kind: "web_page", url: SOURCE_URL, title: TITLE, extractedAt: EXTRACTED_AT,
  });
  assert.equal(result.transcript, null);
  assert.equal(result.artifacts.summary, "ai/summary.md");
  assert.equal(result.artifacts.mindmap, "ai/mindmap.mmd");
  assert.equal(result.artifacts.article_txt, "article/article.txt");

  assert.equal(text(await readFile(paths.summaryPath, "utf8")), "# 要点总结\n\n总览\n\n- 一条要点\n");
  assert.equal(text(await readFile(paths.mindmapPath, "utf8")), "mindmap\n  root((主题))\n    分支\n");
  const manifest = JSON.parse(await readFile(paths.manifestPath, "utf8"));
  assert.equal(manifest.status, "completed");
  assert.equal(manifest.source_kind, "web_page");
  assert.equal(manifest.platform, "web");
  assert.equal(manifest.model, null);
  assert.equal(manifest.transcript, null);
  assert.equal(manifest.artifacts.summary, "ai/summary.md");
  assert.equal(manifest.artifacts.mindmap, "ai/mindmap.mmd");
  assert.equal(manifest.artifacts.article_txt, "article/article.txt");
  assert.equal("note_title" in manifest, false);
  assert.equal("transcript_txt" in manifest.artifacts, false);
  assert.deepEqual(manifest.web_source, { title: TITLE, extracted_at: EXTRACTED_AT });

  // 事务材料必须清干净。
  const residue = (await readdir(paths.taskDir)).filter((name) => name.startsWith(".artifact"));
  assert.deepEqual(residue, []);
});

test("an unusable saved article stops before any model call", async (t) => {
  const { store, paths, taskId } = await makeWebTask(t);
  await writeFile(paths.articleTxtPath, "   \n", "utf8");

  const result = await runInsightRetryPipeline(request(taskId), {
    projectRoot: store.outputRoot,
    store,
    environ: {},
    llmFactory: async () => {
      throw new Error("不该调用模型");
    },
  });
  assert.equal(result.status, "partial_completed");
  assert.equal(result.error.code, "SOURCE_TEXT_INVALID");
  assert.equal(result.taskId, taskId);
  const manifest = JSON.parse(await readFile(paths.manifestPath, "utf8"));
  assert.equal(manifest.status, "partial_completed");
  assert.equal(manifest.error.code, "SOURCE_TEXT_INVALID");
  assert.equal(manifest.artifacts.article_txt, "article/article.txt");
});

test("a draft retry on a web task propagates the article source kind", async (t) => {
  const { store, paths, taskId } = await makeWebTask(t);
  // 种子洞察：草稿分支先校验它再换凭证。
  await mkdir(paths.aiDir, { recursive: true });
  await writeFile(paths.insightsPath, `${JSON.stringify({
    schemaVersion: 1,
    insights: [{
      id: 1,
      topic: "一个话题",
      matchReason: "与选题相关",
      followUpQuestions: ["还能说什么？"],
      suitableUse: "短视频开场",
      sourceChunkId: null,
    }],
  }, null, 2)}\n`, "utf8");

  const seen = [];
  const result = await runInsightRetryPipeline(
    request(taskId, { target: "draft", insight_id: 1, platform: "douyin" }),
    {
      projectRoot: store.outputRoot,
      store,
      environ: {},
      draftRunner: async (input) => {
        seen.push(input.sourceKind);
        return "草稿正文";
      },
    },
  );

  // 草稿的 `sourceKind` 来自 `APP_AI_SOURCE_KIND`：网页任务按 article 装配提示词。
  assert.deepEqual(seen, ["article"]);
  assert.equal(result.status, "completed");
  assert.equal(result.draft, "草稿正文");
  assert.equal(result.text, TEXT);
  assert.equal(result.artifacts.draft, "ai/draft.md");
  const manifest = JSON.parse(await readFile(paths.manifestPath, "utf8"));
  assert.equal(manifest.status, "completed");
  assert.equal(manifest.draft_seed_insight_id, 1);
  assert.equal(manifest.artifacts.draft, "ai/draft.md");
  assert.equal(manifest.source_kind, "web_page");
});
