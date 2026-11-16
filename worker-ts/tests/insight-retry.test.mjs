import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runToolLoop } from "../src/ai/tool-loop.ts";
import { parsePreferenceSnapshot } from "../src/ai/preference-snapshot.ts";
import { InsightGenerationError } from "../src/ai/errors.ts";
import { writeTranscriptFiles } from "../src/artifacts/transcript-artifacts.ts";
import { runInsightRetryPipeline } from "../src/pipeline/insight-retry.ts";
import {
  createLocalTaskContext,
  ensureTaskDirs,
  finalizeTask,
} from "../src/tasks/index.ts";
import { createTaskPaths } from "../src/tasks/paths.ts";

const TRANSCRIPT = "# 采访\n\n第一段内容。\n\n第二段内容。\n";
const TASK_NOW = new Date("2026-11-14T12:00:00Z");

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

const INSIGHT_ITEM = {
  topic: "流程先于工具",
  matchReason: "文字稿强调流程瓶颈",
  followUpQuestions: ["该从哪条流程开始？"],
  suitableUse: "短视频开场",
  sourceChunkId: 1,
};

function workingInsightsLlm() {
  return scriptedRuntime([
    toolCall("call_1", "submit_insights", { insights: [INSIGHT_ITEM] }),
  ]);
}

async function makeTask(t, { body = TRANSCRIPT, extras = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "locus-retry-"));
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
    text: body,
    outputDir: paths.transcriptDir,
    outputStem: "",
    metadata: { source: "asr", language: null, engine: "iic/SenseVoiceSmall-onnx" },
  });
  if (body.trim().length === 0) {
    // 空文字稿由 writeTranscriptFiles 直接拒止，这里手工写一个空文件来测读取侧的判定。
    await writeFile(paths.transcriptTxtPath, "  \n", "utf8");
  }

  const result = await finalizeTask(paths, context, {
    status: "completed",
    taskId: null,
    taskDir: null,
    artifacts: {},
    text: body,
    summary: "",
    insights: [],
    transcript: { source: "asr", language: null, engine: "iic/SenseVoiceSmall-onnx" },
    dissection: null,
    error: null,
    draft: "",
  });

  if (extras) {
    // 已由别的步骤写出的产物：重新生成摘要不能把它们报成「没了」。
    await mkdir(paths.aiDir, { recursive: true });
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
    await writeFile(paths.summaryPath, "# 旧摘要\n旧内容\n", "utf8");
    // 旧解剖报告缺少来源摘要与语义字段，严格校验不通过：stdout 不能把坏结构塞回界面。
    await writeFile(paths.dissectionJsonPath, `${JSON.stringify({ schemaVersion: 1, segments: [] }, null, 2)}\n`, "utf8");
  }

  return { root, store, context, paths, taskId: result.taskId };
}

function request(taskId, overrides = {}) {
  return { task_id: taskId, target: "summary", output_language: "zh-CN", ...overrides };
}

test("a summary retry commits the two artifacts and the manifest as one version", async (t) => {
  const { store, paths, taskId } = await makeTask(t, { extras: true });

  const result = await runInsightRetryPipeline(request(taskId), {
    projectRoot: store.outputRoot,
    store,
    llmFactory: async () => workingLlm(),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.taskId, taskId);
  assert.equal(result.artifacts.summary, "ai/summary.md");
  assert.equal(result.artifacts.mindmap, "ai/mindmap.mmd");
  assert.equal(result.artifacts.transcript_txt, "transcript/transcript.txt");
  assert.equal(text(result.summary), "# 要点总结\n\n总览\n\n- 一条要点\n");
  assert.equal(result.error, null);
  assert.deepEqual(result.transcript, {
    source: "asr", language: null, engine: "iic/SenseVoiceSmall-onnx",
  });
  // 已有洞察要按磁盘读回：否则只重算摘要会把 insights_count 清零。
  assert.equal(result.insights.length, 1);
  assert.equal(result.insights[0].id, 9);
  // 旧报告结构不合规，按 Python `read_existing_dissection` 的严格校验退化为 null。
  assert.equal(result.dissection, null);

  assert.equal(text(await readFile(paths.summaryPath, "utf8")), "# 要点总结\n\n总览\n\n- 一条要点\n");
  assert.equal(text(await readFile(paths.mindmapPath, "utf8")), "mindmap\n  root((主题))\n    分支\n");
  const manifest = JSON.parse(await readFile(paths.manifestPath, "utf8"));
  assert.equal(manifest.status, "completed");
  assert.equal(manifest.artifacts.summary, "ai/summary.md");
  assert.equal(manifest.artifacts.mindmap, "ai/mindmap.mmd");
  assert.equal(manifest.insights_count, 1);
  assert.equal(manifest.error, null);

  // 事务材料必须清干净：留下 journal 会让下次打开任务时多一次恢复。
  const residue = (await readdir(paths.taskDir)).filter((name) => name.startsWith(".artifact"));
  assert.deepEqual(residue, []);
  assert.deepEqual((await readdir(paths.aiDir)).filter((name) => name.includes("staging") || name.includes("rollback")), []);
});

test("title and draft seed are preserved when only the summary is regenerated", async (t) => {
  const { store, paths, taskId } = await makeTask(t);
  const manifest = JSON.parse(await readFile(paths.manifestPath, "utf8"));
  manifest.note_title = {
    text: "我的标题", status: "completed", output_language: "zh-CN", error_code: null,
  };
  manifest.draft_seed_insight_id = 9;
  await writeFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const result = await runInsightRetryPipeline(request(taskId), {
    projectRoot: store.outputRoot,
    store,
    llmFactory: async () => workingLlm(),
  });
  assert.equal(result.status, "completed");
  const updated = JSON.parse(await readFile(paths.manifestPath, "utf8"));
  assert.deepEqual(updated.note_title, manifest.note_title);
  assert.equal(updated.draft_seed_insight_id, 9);
});

test("a generation failure leaves a partial_completed manifest and keeps the old artifacts", async (t) => {
  const { store, paths, taskId } = await makeTask(t, { extras: true });

  const result = await runInsightRetryPipeline(request(taskId), {
    projectRoot: store.outputRoot,
    store,
    llmFactory: async () => {
      throw new InsightGenerationError("AI_LLM_RATE_LIMITED", "The model provider temporarily rate-limited the request.");
    },
  });

  assert.equal(result.status, "partial_completed");
  assert.equal(result.error.code, "AI_LLM_RATE_LIMITED");
  assert.equal(result.error.stage, "insights_generating");
  assert.equal(result.taskId, taskId);
  assert.equal(result.summary, "# 旧摘要\n旧内容");
  assert.equal(text(await readFile(paths.summaryPath, "utf8")), "# 旧摘要\n旧内容\n");
  const manifest = JSON.parse(await readFile(paths.manifestPath, "utf8"));
  assert.equal(manifest.status, "partial_completed");
  assert.equal(manifest.error.code, "AI_LLM_RATE_LIMITED");
  assert.equal(manifest.artifacts.summary, "ai/summary.md");
});

test("request and task failures use documented codes without touching the task", async (t) => {
  const { store, paths, taskId } = await makeTask(t);
  const before = await readFile(paths.manifestPath, "utf8");

  const badPayload = await runInsightRetryPipeline({ task_id: "../escape", target: "summary", output_language: "zh-CN" }, {
    projectRoot: store.outputRoot, store,
  });
  assert.equal(badPayload.status, "partial_completed");
  assert.equal(badPayload.error.code, "INVALID_RETRY_PAYLOAD");
  assert.equal(badPayload.taskId, null);

  const nonJson = await runInsightRetryPipeline([], { projectRoot: store.outputRoot, store });
  assert.equal(nonJson.status, "failed");
  assert.equal(nonJson.error.code, "INVALID_RETRY_JSON");

  const missing = await runInsightRetryPipeline(request("20261114-120000-local-0000000000000000"), {
    projectRoot: store.outputRoot, store,
  });
  assert.equal(missing.error.code, "TASK_MANIFEST_NOT_FOUND");
  assert.equal(await readFile(paths.manifestPath, "utf8"), before, "请求或任务失败不该改写清单");

  // 草稿分支在种子校验前不碰模型、不换凭证；校验失败会把 partial_completed 写进清单。
  const draftSeed = await runInsightRetryPipeline(
    request(taskId, { target: "draft", insight_id: 1, platform: "douyin" }),
    {
      projectRoot: store.outputRoot, store,
      draftRunner: async () => { throw new Error("seed validation must run first"); },
    },
  );
  assert.equal(draftSeed.status, "partial_completed");
  assert.equal(draftSeed.error.code, "DRAFT_SEED_INVALID");
  assert.equal(draftSeed.error.stage, "draft_generating");
  assert.equal(JSON.parse(await readFile(paths.manifestPath, "utf8")).error.code, "DRAFT_SEED_INVALID");
});

test("an unusable authoritative transcript stops before any model call", async (t) => {
  const { store, paths, taskId } = await makeTask(t);
  await writeFile(paths.transcriptTxtPath, "   \n", "utf8");

  const result = await runInsightRetryPipeline(request(taskId), {
    projectRoot: store.outputRoot,
    store,
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
  assert.equal(manifest.artifacts.transcript_txt, "transcript/transcript.txt");
});

test("the store roots come from the environment when not injected", async (t) => {
  const { store, taskId } = await makeTask(t);
  const result = await runInsightRetryPipeline(request(taskId), {
    projectRoot: "D:/unused",
    environ: { APP_OUTPUT_DIR: store.outputRoot, APP_CACHE_DIR: store.cacheRoot },
    llmFactory: async () => workingLlm(),
  });
  assert.equal(result.status, "completed");
  const paths = createTaskPaths({ ...store, taskId });
  assert.equal(text(await readFile(paths.summaryPath, "utf8")), "# 要点总结\n\n总览\n\n- 一条要点\n");
});

test("an insights retry commits both insight files and clears the old draft seed", async (t) => {
  const { store, paths, taskId } = await makeTask(t, { extras: true });
  const manifest = JSON.parse(await readFile(paths.manifestPath, "utf8"));
  manifest.draft_seed_insight_id = 9;
  await writeFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const result = await runInsightRetryPipeline(request(taskId, { target: "insights" }), {
    projectRoot: store.outputRoot,
    store,
    llmFactory: async () => workingInsightsLlm(),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.insights.length, 1);
  assert.equal(result.insights[0].topic, "流程先于工具");
  assert.equal(result.artifacts.insights, "ai/insights.json");
  assert.equal(result.artifacts.insights_md, "ai/insights.md");
  // 只重算洞察不动摘要，旧摘要要按磁盘读回。
  assert.equal(result.summary, "# 旧摘要\n旧内容");

  const persisted = JSON.parse(text(await readFile(paths.insightsPath, "utf8")));
  assert.equal(persisted.schemaVersion, 1);
  assert.deepEqual(persisted.insights[0], { id: 1, ...INSIGHT_ITEM });
  assert.match(text(await readFile(paths.insightsMdPath, "utf8")), /^# 启发灵感\n\n## 灵感 1/);

  const updated = JSON.parse(await readFile(paths.manifestPath, "utf8"));
  assert.equal(updated.status, "completed");
  assert.equal(updated.insights_count, 1);
  assert.equal(updated.artifacts.insights, "ai/insights.json");
  assert.equal(updated.draft_seed_insight_id, null, "洞察换 id 后旧草稿种子必须清空");
  assert.equal(updated.artifacts.summary, "ai/summary.md");
  assert.deepEqual((await readdir(paths.taskDir)).filter((name) => name.startsWith(".artifact")), []);
});

test("an insights retry persists the preference snapshot before calling the model", async (t) => {
  const { store, paths, taskId } = await makeTask(t);
  const fixture = JSON.parse(await readFile(
    new URL("./fixtures/insights-prompts-golden.json", import.meta.url), "utf8",
  ));
  let sawSnapshotFile = null;
  const result = await runInsightRetryPipeline(
    request(taskId, { target: "insights", preference_snapshot: fixture.snapshot }),
    {
      projectRoot: store.outputRoot,
      store,
      llmFactory: async () => {
        sawSnapshotFile = await readFile(paths.preferenceSnapshotPath, "utf8").catch(() => null);
        return workingInsightsLlm();
      },
    },
  );
  assert.equal(result.status, "completed");
  assert.equal(sawSnapshotFile, fixture.snapshot_file, "模型调用前快照必须已落盘且字节一致");
  assert.equal(result.artifacts.preference_snapshot, "ai/preference-snapshot.json");
  assert.deepEqual(
    JSON.parse(await readFile(paths.preferenceSnapshotPath, "utf8")),
    fixture.snapshot,
  );
  // 落盘形状还要能被严格解析器原样读回。
  assert.ok(parsePreferenceSnapshot(JSON.parse(await readFile(paths.preferenceSnapshotPath, "utf8"))));
});

test("a failed insights retry keeps the old draft seed and writes a partial manifest", async (t) => {
  const { store, paths, taskId } = await makeTask(t);
  const manifest = JSON.parse(await readFile(paths.manifestPath, "utf8"));
  manifest.draft_seed_insight_id = 9;
  await writeFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const result = await runInsightRetryPipeline(request(taskId, { target: "insights" }), {
    projectRoot: store.outputRoot,
    store,
    llmFactory: async () => { throw new InsightGenerationError("AI_EMPTY_RESULT", "No inspiration was delivered."); },
  });
  assert.equal(result.status, "partial_completed");
  assert.equal(result.error.code, "AI_EMPTY_RESULT");
  const updated = JSON.parse(await readFile(paths.manifestPath, "utf8"));
  assert.equal(updated.draft_seed_insight_id, 9, "没有新洞察就不该让旧种子失效");
  assert.equal(updated.status, "partial_completed");
});

test("managed checkout request ids carry the retry target", async (t) => {
  const { store, taskId } = await makeTask(t);
  const seen = [];
  for (const [target, llm] of [["summary", workingLlm], ["insights", workingInsightsLlm]]) {
    await runInsightRetryPipeline(request(taskId, { target }), {
      projectRoot: store.outputRoot,
      store,
      environ: { APP_LLM_CHECKOUT_REQUEST_ID: "req-1" },
      llmFactory: async (env) => {
        seen.push([target, env.APP_LLM_CHECKOUT_REQUEST_ID]);
        return llm();
      },
    });
  }
  assert.deepEqual(seen, [
    ["summary", "req-1-summary"],
    ["insights", "req-1-insights"],
  ]);
});
