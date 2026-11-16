import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LLM_CHECKOUT_REQUEST_ID_ENV } from "../src/ai/config.ts";
import { sourceTranscriptSha256 } from "../src/ai/index.ts";
import { writeTranscriptFiles } from "../src/artifacts/transcript-artifacts.ts";
import { runTranscriptPolishStep } from "../src/pipeline/transcript-polish-step.ts";
import { runInsightRetryPipeline } from "../src/pipeline/insight-retry.ts";
import {
  createLocalTaskContext,
  ensureTaskDirs,
  finalizeTask,
} from "../src/tasks/index.ts";

const TRANSCRIPT = "# 采访\n\n第一段内容，有一个同音错误。\n\n第二段内容。\n";
const POLISHED = "第一段内容，有一个同音错别字。\n\n第二段内容。";
const TASK_NOW = new Date("2026-11-15T00:00:00Z");

async function makeTask(t, { extras = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "locus-polish-"));
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
    const manifest = JSON.parse(await readFile(paths.manifestPath, "utf8"));
    manifest.draft_seed_insight_id = 9;
    manifest.note_title = {
      text: "旧标题", status: "completed", output_language: "zh-CN", error_code: null,
    };
    await writeFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
  // `writeTranscriptFiles` 在 Windows 用平台换行（CRLF），正式稿以磁盘读回的内容为准。
  const officialBody = (await readFile(paths.transcriptTxtPath, "utf8")).trim();
  return { root, store, context, paths, taskId: result.taskId, officialBody };
}

const request = (taskId, overrides = {}) => ({
  task_id: taskId, target: "transcript", output_language: "zh-CN", ...overrides,
});

function fakeRunner(result = POLISHED) {
  const calls = [];
  return {
    calls,
    runner: async ({ body, chunks }) => {
      calls.push({ body, chunks });
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

test("a successful retry writes both polished artifacts and never touches the official transcript", async (t) => {
  const { store, paths, taskId, officialBody } = await makeTask(t, { extras: true });
  const before = await readFile(paths.transcriptTxtPath);
  const events = [];
  const seenEnviron = [];
  let factories = 0;
  const llmCalls = [];

  const result = await runInsightRetryPipeline(request(taskId), {
    projectRoot: store.outputRoot,
    store,
    environ: { [LLM_CHECKOUT_REQUEST_ID_ENV]: "checkout-seed" },
    onProgress: (event) => events.push(event),
    polishLlmFactory: async (environ) => {
      factories += 1;
      seenEnviron.push({ ...environ });
      return {
        textChat: async ({ systemPrompt, prompt }) => {
          llmCalls.push({ systemPrompt, prompt });
          return `整理第 ${llmCalls.length} 段。`;
        },
      };
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.taskId, taskId);
  assert.equal(result.error, null);
  assert.equal(result.text, officialBody);
  assert.equal(result.summary.trim(), "# 旧摘要");
  assert.equal(result.insights.length, 1);
  assert.equal(result.artifacts.transcript_txt, "transcript/transcript.txt");
  assert.equal("polished" in result.artifacts, false);
  assert.equal("polished_meta" in result.artifacts, false);
  assert.deepEqual(await readFile(paths.transcriptTxtPath), before);

  const polishedText = await readFile(paths.transcriptPolishedTxtPath, "utf8");
  assert.equal(polishedText, `${llmCalls.map((_, index) => `整理第 ${index + 1} 段。`).join("\n")}\n`);
  const meta = JSON.parse(await readFile(paths.transcriptPolishedMetaPath, "utf8"));
  assert.deepEqual(meta, {
    schemaVersion: 1,
    sourceTranscriptSha256: sourceTranscriptSha256(officialBody),
  });

  const manifest = JSON.parse(await readFile(paths.manifestPath, "utf8"));
  assert.equal(manifest.status, "completed");
  assert.equal(manifest.error, null);
  assert.equal(manifest.text_preview, officialBody.slice(0, 180));
  assert.equal(manifest.insights_count, 1);
  assert.equal(manifest.draft_seed_insight_id, 9);
  assert.equal(manifest.note_title.text, "旧标题");
  assert.equal("polished" in manifest.artifacts, false);

  assert.equal(factories, 1, "整次整理只创建一个 provider / 只 checkout 一次");
  assert.equal(llmCalls.length, events.length);
  assert.ok(llmCalls.length > 0);
  assert.equal(seenEnviron[0][LLM_CHECKOUT_REQUEST_ID_ENV], "checkout-seed-transcript");
  for (const event of events) {
    assert.equal(event.message_code, "ai.generation.running");
    assert.equal(event.stage, "insights_generating");
    assert.ok(event.progress >= 70 && event.progress <= 89);
    assert.ok(event.message_args.attempt <= event.message_args.total);
  }
  assert.deepEqual(events.map((event) => event.message_args.attempt),
    events.map((_, index) => index + 1));
});

test("a failing polish step writes partial_completed into the manifest and keeps the preview", async (t) => {
  const { store, paths, taskId, officialBody } = await makeTask(t);
  const result = await runInsightRetryPipeline(request(taskId), {
    projectRoot: store.outputRoot,
    store,
    polishRunner: async () => { throw new Error("provider exploded"); },
  });
  assert.equal(result.status, "partial_completed");
  assert.equal(result.error.code, "POLISH_FAILED");
  assert.equal(result.error.stage, "insights_generating");
  assert.equal(result.text, officialBody);
  const manifest = JSON.parse(await readFile(paths.manifestPath, "utf8"));
  assert.equal(manifest.status, "partial_completed");
  assert.equal(manifest.error.code, "POLISH_FAILED");
  assert.equal(manifest.text_preview, officialBody.slice(0, 180));
  assert.equal(await readFile(paths.transcriptPolishedTxtPath, "utf8").catch(() => null), null);
});

test("the seven polish failure codes match the Python step", async (t) => {
  const { paths, officialBody } = await makeTask(t);
  const base = { paths, environ: {} };

  const missing = await makeTask(t);
  await rm(missing.paths.transcriptTxtPath);
  assert.equal((await runTranscriptPolishStep({ ...base, paths: missing.paths })).error.code,
    "TRANSCRIPT_TEXT_NOT_FOUND");

  const empty = await makeTask(t);
  await writeFile(empty.paths.transcriptTxtPath, "   \n", "utf8");
  assert.equal((await runTranscriptPolishStep({ ...base, paths: empty.paths })).error.code,
    "POLISH_EMPTY_TRANSCRIPT");

  const linked = await makeTask(t);
  assert.equal((await runTranscriptPolishStep({
    ...base,
    paths: { ...linked.paths, transcriptTxtPath: join(linked.paths.aiDir, "other.txt") },
  })).error.code, "TRANSCRIPT_TEXT_PATH_INVALID");

  const tooLong = await makeTask(t);
  await writeFile(tooLong.paths.transcriptTxtPath, "甲".repeat(50_000), "utf8");
  const longCalls = fakeRunner();
  const longResult = await runTranscriptPolishStep({
    ...base,
    paths: tooLong.paths,
    polishRunner: longCalls.runner,
  });
  assert.equal(longResult.error.code, "POLISH_TRANSCRIPT_TOO_LONG");
  assert.equal(longResult.error.message, "Transcript needs more than 24 polish chunks.");
  assert.equal(longCalls.calls.length, 0, "超长稿不能消耗任何额度");
  assert.equal(longResult.text.length, 50_000);

  const { calls: failedCalls, runner: failingRunner } = fakeRunner(new Error("boom"));
  const failed = await runTranscriptPolishStep({ ...base, polishRunner: failingRunner });
  assert.equal(failed.error.code, "POLISH_FAILED");
  assert.equal(failed.text, officialBody);
  assert.equal(failedCalls.length, 1);

  const emptyResult = await runTranscriptPolishStep({ ...base, polishRunner: fakeRunner("   ").runner });
  assert.equal(emptyResult.error.code, "POLISH_LLM_EMPTY_RESULT");

  const unwritable = await makeTask(t);
  const writeFailed = await runTranscriptPolishStep({
    ...base,
    paths: unwritable.paths,
    polishRunner: async () => {
      await rm(unwritable.paths.transcriptDir, { recursive: true, force: true });
      writeFileSync(unwritable.paths.transcriptDir, "not a directory", "utf8");
      return POLISHED;
    },
  });
  assert.equal(writeFailed.error.code, "POLISH_ARTIFACT_WRITE_FAILED");
});

test("runner receives trimmed body and the same chunks used for the length guard", async (t) => {
  const { paths, officialBody } = await makeTask(t);
  const { calls, runner } = fakeRunner();
  const result = await runTranscriptPolishStep({ paths, environ: {}, polishRunner: runner });
  assert.equal(result.status, "completed");
  assert.equal(result.error, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body, officialBody);
  assert.deepEqual(calls[0].chunks, [officialBody]);
  assert.equal(await readFile(paths.transcriptPolishedTxtPath, "utf8"), `${POLISHED}\n`);
});

test("transcript requests reject insight-only fields", async (t) => {
  const { store, taskId } = await makeTask(t);
  const extraField = await runInsightRetryPipeline(
    request(taskId, { preference_snapshot: { version: 1 } }),
    { projectRoot: store.outputRoot, store },
  );
  assert.equal(extraField.error.code, "INVALID_RETRY_PAYLOAD");
});
