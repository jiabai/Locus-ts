import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runToolLoop } from "../src/ai/tool-loop.ts";
import { dissectionToDict, parseDissectionReport } from "../src/ai/dissection-report.ts";
import { MarkdownSplitter } from "../src/ai/transcript-chunks.ts";
import { writeTranscriptFiles } from "../src/artifacts/transcript-artifacts.ts";
import { runInsightRetryPipeline } from "../src/pipeline/insight-retry.ts";
import {
  createLocalTaskContext,
  ensureTaskDirs,
  finalizeTask,
} from "../src/tasks/index.ts";

const golden = JSON.parse(await readFile(
  new URL("./fixtures/dissection-golden.json", import.meta.url), "utf8",
));
const VALID = golden.reports.find((item) => item.label === "valid-short").payload;
const TRANSCRIPT = "# 采访\n\n第一段内容。\n\n第二段内容。\n";
const TASK_NOW = new Date("2026-11-15T00:00:00Z");

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

function dissectionLlm() {
  return scriptedRuntime([toolCall("call_1", "submit_dissection", { report: VALID })]);
}

function summaryLlm() {
  return scriptedRuntime([
    toolCall("call_1", "submit_mindmap", { mermaid: "mindmap\n  root((主题))\n    分支" }),
    toolCall("call_2", "submit_summary", { markdown: "总览\n\n- 一条要点" }),
  ]);
}

async function makeTask(t, { body = TRANSCRIPT, extras = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "locus-dissection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = { outputRoot: join(root, "outputs"), cacheRoot: join(root, "cache") };
  const { context, paths } = createLocalTaskContext({
    store,
    request: {
      safeDisplayName: "采访.wav", mediaKind: "audio", sourceExtension: "wav",
      asrModel: "iic/SenseVoiceSmall-onnx",
    },
    now: TASK_NOW,
    randomId: "abcdef0123456789",
  });
  await ensureTaskDirs(paths);
  if (body.trim().length === 0) {
    // 空文字稿由 writeTranscriptFiles 直接拒止，这里手工写一个空文件来测读取侧的判定。
    await writeFile(paths.transcriptTxtPath, "  \n", "utf8");
  } else {
    await writeTranscriptFiles({
      text: body,
      outputDir: paths.transcriptDir,
      outputStem: "",
      metadata: { source: "asr", language: null, engine: "iic/SenseVoiceSmall-onnx" },
    });
  }
  await finalizeTask(paths, context, {
    status: "completed", taskId: null, taskDir: null, artifacts: {},
    text: body, summary: "", insights: [],
    transcript: { source: "asr", language: null, engine: "iic/SenseVoiceSmall-onnx" },
    dissection: null, error: null, draft: "",
  });
  if (extras) {
    await mkdir(paths.aiDir, { recursive: true });
    await writeFile(paths.summaryPath, "# 旧摘要\n", "utf8");
    const manifest = JSON.parse(await readFile(paths.manifestPath, "utf8"));
    manifest.draft_seed_insight_id = 9;
    manifest.note_title = {
      text: "旧标题", status: "completed", output_language: "zh-CN", error_code: null,
    };
    await writeFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
  const officialBody = await readFile(paths.transcriptTxtPath, "utf8");
  return { root, store, context, paths, taskId: context.taskId, officialBody };
}

const request = (taskId, overrides = {}) => ({
  task_id: taskId, target: "dissection", output_language: "zh-CN", ...overrides,
});

test("a dissection retry commits both artifacts and the manifest as one version", async (t) => {
  const { store, paths, taskId, officialBody } = await makeTask(t, { extras: true });
  const before = await readFile(paths.transcriptTxtPath);
  const events = [];
  const result = await runInsightRetryPipeline(request(taskId), {
    projectRoot: store.outputRoot,
    store,
    llmFactory: async () => dissectionLlm(),
    onProgress: (event) => events.push(event),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.taskId, taskId);
  assert.equal(result.error, null);
  assert.equal(result.text, officialBody.trim());
  assert.equal(result.summary.trim(), "# 旧摘要");
  assert.equal(result.artifacts.dissection, "ai/dissection.json");
  assert.equal(result.artifacts.dissection_md, "ai/dissection.md");
  assert.equal(result.artifacts.transcript_txt, "transcript/transcript.txt");
  assert.deepEqual(await readFile(paths.transcriptTxtPath), before, "原稿字节不变");

  const expected = dissectionToDict(parseDissectionReport({
    payload: VALID,
    transcript: officialBody,
    chunks: new MarkdownSplitter().split(officialBody),
    sourceLanguage: null,
  }));
  assert.deepEqual(result.dissection, expected);
  assert.deepEqual(
    JSON.parse(await readFile(paths.dissectionJsonPath, "utf8")),
    expected,
  );
  const markdown = (await readFile(paths.dissectionMarkdownPath, "utf8")).replaceAll("\r\n", "\n");
  assert.ok(markdown.startsWith("# 文字稿解剖\n"));
  assert.ok(markdown.includes("## 整体叙事"));
  assert.ok(markdown.includes("第一段"));
  assert.ok(!markdown.includes("sourceTranscriptSha256"));

  const manifest = JSON.parse(await readFile(paths.manifestPath, "utf8"));
  assert.equal(manifest.status, "completed");
  assert.equal(manifest.error, null);
  assert.equal(manifest.artifacts.dissection, "ai/dissection.json");
  assert.equal(manifest.artifacts.dissection_md, "ai/dissection.md");
  assert.equal(manifest.draft_seed_insight_id, 9);
  assert.equal(manifest.note_title.text, "旧标题");
  assert.equal(manifest.text_preview, officialBody.trim().slice(0, 180));

  assert.deepEqual(events, [{
    stage: "insights_generating", progress: 70,
    message_code: "ai.generation.running", message_args: { attempt: 1, total: 6 },
  }]);
});

test("an existing report is read back only when provenance matches the current transcript", async (t) => {
  const { store, paths, taskId, officialBody } = await makeTask(t);
  const valid = dissectionToDict(parseDissectionReport({
    payload: VALID,
    transcript: officialBody,
    chunks: new MarkdownSplitter().split(officialBody),
    sourceLanguage: null,
  }));
  await writeFile(paths.dissectionJsonPath, `${JSON.stringify(valid, null, 2)}\n`, "utf8");

  const kept = await runInsightRetryPipeline(request(taskId, { target: "summary" }), {
    projectRoot: store.outputRoot, store,
    llmFactory: async () => summaryLlm(),
  });
  assert.equal(kept.status, "completed");
  assert.deepEqual(kept.dissection, valid);

  const tampered = structuredClone(valid);
  tampered.sourceChunks[0].endByte += 1;
  await writeFile(paths.dissectionJsonPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
  const rejected = await runInsightRetryPipeline(request(taskId, { target: "summary" }), {
    projectRoot: store.outputRoot, store,
    llmFactory: async () => summaryLlm(),
  });
  assert.equal(rejected.dissection, null);

  await writeFile(paths.dissectionJsonPath, `${JSON.stringify(valid, null, 2)}\n`, "utf8");
  await writeFile(paths.transcriptTxtPath, `${officialBody}追加的新内容。\n`, "utf8");
  const stale = await runInsightRetryPipeline(request(taskId, { target: "summary" }), {
    projectRoot: store.outputRoot, store,
    llmFactory: async () => summaryLlm(),
  });
  assert.equal(stale.dissection, null, "原稿改过以后旧报告不能继续显示");
});

test("failure codes keep their Python values and leave a partial_completed manifest", async (t) => {
  const emptyTask = await makeTask(t, { body: "   " });
  const empty = await runInsightRetryPipeline(request(emptyTask.taskId), {
    projectRoot: emptyTask.store.outputRoot, store: emptyTask.store,
    llmFactory: async () => dissectionLlm(),
  });
  // 清单存在时 Python 先走 read_source_text，空稿在读取层就判成 SOURCE_TEXT_INVALID；
  // DISSECTION_EMPTY_TRANSCRIPT 属于 agent 的直接调用路径，由 dissection-agent 单测覆盖。
  assert.equal(empty.status, "partial_completed");
  assert.equal(empty.error.code, "SOURCE_TEXT_INVALID");
  assert.equal(
    JSON.parse(await readFile(emptyTask.paths.manifestPath, "utf8")).error.code,
    "SOURCE_TEXT_INVALID",
  );

  const { store, paths, taskId } = await makeTask(t);
  const noDelivery = await runInsightRetryPipeline(request(taskId), {
    projectRoot: store.outputRoot, store,
    llmFactory: async () => scriptedRuntime(
      Array.from({ length: 6 }, (_, index) => ({ text: `未交付 ${index}`, toolCalls: [] })),
    ),
  });
  assert.equal(noDelivery.status, "partial_completed");
  assert.equal(noDelivery.error.code, "DISSECTION_INVALID_RESULT");
  assert.equal(noDelivery.dissection, null);
  assert.equal(await readFile(paths.dissectionJsonPath, "utf8").catch(() => null), null);
  const manifest = JSON.parse(await readFile(paths.manifestPath, "utf8"));
  assert.equal(manifest.status, "partial_completed");
  assert.equal(manifest.error.code, "DISSECTION_INVALID_RESULT");
});

test("provider configuration failures keep their own code", async (t) => {
  const { store, taskId } = await makeTask(t);
  const result = await runInsightRetryPipeline(request(taskId), {
    projectRoot: store.outputRoot, store, environ: {},
  });
  assert.equal(result.status, "partial_completed");
  assert.equal(result.error.code, "AI_CONFIG_MISSING");
});

