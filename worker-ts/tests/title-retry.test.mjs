import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InsightGenerationError } from "../src/ai/errors.ts";
import { LLM_CHECKOUT_REQUEST_ID_ENV } from "../src/ai/config.ts";
import { writeTranscriptFiles } from "../src/artifacts/transcript-artifacts.ts";
import { runInsightRetryPipeline } from "../src/pipeline/insight-retry.ts";
import {
  createLocalTaskContext,
  ensureTaskDirs,
  finalizeTask,
} from "../src/tasks/index.ts";
import { resultToPayload } from "../src/tasks/types.ts";

const TRANSCRIPT = "# 采访\n\n第一段内容。\n\n第二段内容。\n";
const TASK_NOW = new Date("2026-11-15T00:00:00Z");
const TITLE = "理解人工智能时代的沟通能力";

function titleLlm(reply) {
  return {
    async chat(messages, tools, options) {
      assert.deepEqual(tools, []);
      assert.deepEqual(options, { responseFormat: "json_object" });
      assert.equal(messages.length, 2);
      return { text: reply, toolCalls: [] };
    },
  };
}

function failingLlm(error) {
  return {
    async chat() {
      throw error;
    },
  };
}

async function makeTask(t, { extras = false, keepUnknownField = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "locus-title-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = { outputRoot: join(root, "outputs"), cacheRoot: join(root, "cache") };
  const { context, paths } = createLocalTaskContext({
    store,
    request: {
      safeDisplayName: "采访.wav",
      mediaKind: "audio",
      sourceExtension: "wav",
      asrModel: "iic/SenseVoiceSmall-onnx",
    },
    now: TASK_NOW,
    randomId: "abcdef0123456789",
  });
  await ensureTaskDirs(paths);
  await writeTranscriptFiles({
    text: TRANSCRIPT,
    outputDir: paths.transcriptDir,
    outputStem: "",
    metadata: { source: "asr", language: null, engine: "iic/SenseVoiceSmall-onnx" },
  });
  const result = await finalizeTask(paths, context, {
    status: "completed",
    taskId: null,
    taskDir: null,
    artifacts: {},
    text: TRANSCRIPT,
    summary: "",
    insights: [],
    transcript: { source: "asr", language: null, engine: "iic/SenseVoiceSmall-onnx" },
    dissection: null,
    error: null,
    draft: "",
  });

  if (extras) {
    await mkdir(paths.aiDir, { recursive: true });
    await writeFile(paths.summaryPath, "# 旧摘要\n", "utf8");
    await writeFile(paths.insightsPath, `${JSON.stringify({
      schemaVersion: 1,
      insights: [{
        id: 9,
        topic: "一个话题",
        matchReason: "与选题相关",
        followUpQuestions: ["还能说什么？"],
        suitableUse: "短视频开场",
        sourceChunkId: null,
      }],
    }, null, 2)}\n`, "utf8");
  }
  if (keepUnknownField) {
    const manifest = JSON.parse(await readFile(paths.manifestPath, "utf8"));
    manifest.custom_local_field = { keep: true };
    await writeFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
  return { root, store, context, paths, taskId: result.taskId };
}

function request(taskId, overrides = {}) {
  return { task_id: taskId, target: "title", output_language: "zh-CN", ...overrides };
}

async function run(store, taskId, options = {}) {
  return runInsightRetryPipeline(request(taskId, options.request), {
    projectRoot: store.outputRoot,
    store,
    ...options.pipeline,
  });
}

test("a successful title retry writes generating then completed, and keeps the rest of the task", async (t) => {
  const { store, paths, taskId } = await makeTask(t, { extras: true, keepUnknownField: true });
  const events = [];
  const seenEnviron = [];
  const before = await readFile(paths.transcriptTxtPath);

  const result = await run(store, taskId, {
    pipeline: {
      environ: { [LLM_CHECKOUT_REQUEST_ID_ENV]: "checkout-seed" },
      onProgress: (event) => events.push(event),
      titleLlmFactory: async (environ) => {
        seenEnviron.push({ ...environ });
        return titleLlm(JSON.stringify({ title: TITLE }));
      },
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.taskId, taskId);
  assert.equal(result.artifacts.transcript_txt, "transcript/transcript.txt");
  assert.equal(result.error, null);
  assert.equal(result.summary.trim(), "# 旧摘要");
  assert.equal(result.insights.length, 1);
  assert.deepEqual(result.noteTitle, {
    text: TITLE, status: "completed", output_language: "zh-CN", error_code: null,
  });
  assert.deepEqual(resultToPayload(result).note_title, result.noteTitle);
  assert.equal(result.text, await readFile(paths.transcriptTxtPath, "utf8"));

  const manifest = JSON.parse(await readFile(paths.manifestPath, "utf8"));
  assert.deepEqual(manifest.note_title, result.noteTitle);
  assert.deepEqual(manifest.custom_local_field, { keep: true });
  // 标题分支不重写整份清单：状态与正文预览保持原样。
  assert.equal(manifest.status, "completed");
  assert.equal(manifest.insights_count, 0);
  assert.deepEqual(await readFile(paths.transcriptTxtPath), before);

  assert.deepEqual(events, [
    { stage: "title_generating", progress: 5, message_code: "title.generation.running" },
    { stage: "title_generating", progress: 100, message_code: "title.generation.completed" },
  ]);
  assert.equal(seenEnviron.length, 1);
  assert.equal(seenEnviron[0][LLM_CHECKOUT_REQUEST_ID_ENV], "checkout-seed-title");
});

test("an invalid model reply leaves a failed state and preserves the previous title", async (t) => {
  const { store, paths, taskId } = await makeTask(t);
  const previous = {
    text: "旧标题", status: "completed", output_language: "zh-CN", error_code: null,
  };
  const manifest = JSON.parse(await readFile(paths.manifestPath, "utf8"));
  manifest.note_title = previous;
  await writeFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const events = [];
  const result = await run(store, taskId, {
    pipeline: {
      onProgress: (event) => events.push(event),
      titleLlmFactory: async () => titleLlm('{"title":"a","title":"b"}'),
    },
  });

  assert.equal(result.status, "partial_completed");
  assert.deepEqual(result.error, {
    code: "TITLE_OUTPUT_INVALID",
    message: "The note title could not be generated or saved.",
    stage: "title_generating",
  });
  assert.deepEqual(result.noteTitle, {
    text: "旧标题", status: "failed", output_language: "zh-CN", error_code: "TITLE_OUTPUT_INVALID",
  });
  const saved = JSON.parse(await readFile(paths.manifestPath, "utf8"));
  assert.deepEqual(saved.note_title, result.noteTitle);
  assert.equal(saved.status, "completed");
  assert.deepEqual(events.map((event) => event.message_code), ["title.generation.running"]);
});

test("provider failures keep their stable code in the title state", async (t) => {
  const { store, paths, taskId } = await makeTask(t);
  const result = await run(store, taskId, {
    pipeline: {
      titleLlmFactory: async () => failingLlm(new InsightGenerationError(
        "AI_LLM_NETWORK_FAILED", "Could not reach the model provider.",
      )),
    },
  });
  assert.equal(result.noteTitle.error_code, "AI_LLM_NETWORK_FAILED");
  assert.equal(result.noteTitle.status, "failed");
  const saved = JSON.parse(await readFile(paths.manifestPath, "utf8"));
  assert.equal(saved.note_title.error_code, "AI_LLM_NETWORK_FAILED");
});

test("a missing LLM configuration is reported without any network call", async (t) => {
  const { store, paths, taskId } = await makeTask(t);
  const result = await run(store, taskId, { pipeline: { environ: {} } });
  assert.equal(result.status, "partial_completed");
  assert.equal(result.noteTitle.error_code, "AI_CONFIG_MISSING");
  assert.equal(result.noteTitle.output_language, "zh-CN");
  const saved = JSON.parse(await readFile(paths.manifestPath, "utf8"));
  assert.equal(saved.note_title.status, "failed");
});

test("an unavailable authoritative transcript cannot put the title into generating", async (t) => {
  const { store, paths, taskId } = await makeTask(t);
  await rm(paths.transcriptTxtPath);
  const before = await readFile(paths.manifestPath, "utf8");

  const result = await run(store, taskId, {
    pipeline: { titleLlmFactory: async () => titleLlm(JSON.stringify({ title: TITLE })) },
  });
  assert.equal(result.status, "partial_completed");
  assert.equal(result.error.code, "TITLE_TRANSCRIPT_UNAVAILABLE");
  assert.equal(result.text, "");
  assert.equal(result.noteTitle, null);
  assert.equal(await readFile(paths.manifestPath, "utf8"), before);
});

test("a failed final publication keeps the generating state and reports TITLE_SAVE_FAILED", async (t) => {
  const { store, paths, taskId } = await makeTask(t);
  const events = [];
  const result = await run(store, taskId, {
    pipeline: {
      onProgress: (event) => {
        events.push(event);
        // 第一次进度回调发生在 generating 已落盘、最终状态尚未写入之前；
        // 在这里破坏清单，模拟第二次事务提交失败。
        if (event.message_code === "title.generation.running") {
          writeFileSync(paths.manifestPath, "{ broken", "utf8");
        }
      },
      titleLlmFactory: async () => titleLlm(JSON.stringify({ title: TITLE })),
    },
  });
  assert.equal(result.status, "partial_completed");
  assert.equal(result.error.code, "TITLE_SAVE_FAILED");
  assert.deepEqual(result.noteTitle, {
    text: null, status: "generating", output_language: "zh-CN", error_code: null,
  });
  assert.deepEqual(events.map((event) => event.message_code), ["title.generation.running"]);
});

test("title requests reject extra fields", async (t) => {
  const { store, taskId } = await makeTask(t);
  const invalid = await runInsightRetryPipeline(
    { ...request(taskId), platform: "douyin" },
    { projectRoot: store.outputRoot, store },
  );
  assert.equal(invalid.error.code, "INVALID_RETRY_PAYLOAD");
});
