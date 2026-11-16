import assert from "node:assert/strict";
import {mkdtempSync} from "node:fs";
import {mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {writeTranscriptFiles} from "../src/artifacts/transcript-artifacts.ts";
import {runInsightRetryPipeline} from "../src/pipeline/insight-retry.ts";
import {createLocalTaskContext, ensureTaskDirs, finalizeTask} from "../src/tasks/index.ts";
import {serializePreferenceSnapshot} from "../src/ai/preference-snapshot.ts";

const TRANSCRIPT = "# 采访\n\n第一段内容。\n\n第二段内容。\n";
const TASK_NOW = new Date("2026-11-15T00:00:00Z");
const ARTICLE = "# 成稿标题\n\n这是可直接发布的正文。\n";
const INSIGHTS = {
  schemaVersion: 1,
  insights: [{
    id: 5,
    topic: "如何把长视频拆成短视频",
    matchReason: "与选题方向一致",
    followUpQuestions: ["先拆哪一段？"],
    suitableUse: "xiaohongshu",
    sourceChunkId: 3,
  }],
};

const request = (taskId, overrides = {}) => ({
  task_id: taskId, target: "draft", output_language: "zh-CN",
  insight_id: 5, platform: "douyin", ...overrides,
});

async function makeTask(t, {withInsights = true, withSummary = false, withSnapshot = false} = {}) {
  const root = mkdtempSync(join(tmpdir(), "locus-draft-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const store = {outputRoot: join(root, "outputs"), cacheRoot: join(root, "cache")};
  const {context, paths} = createLocalTaskContext({
    store,
    request: {
      safeDisplayName: "采访.wav", mediaKind: "audio", sourceExtension: "wav",
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
    metadata: {source: "asr", language: null, engine: "iic/SenseVoiceSmall-onnx"},
  });
  await finalizeTask(paths, context, {
    status: "completed", taskId: null, taskDir: null, artifacts: {},
    text: TRANSCRIPT, summary: "", insights: [],
    transcript: {source: "asr", language: null, engine: "iic/SenseVoiceSmall-onnx"},
    dissection: null, error: null, draft: "",
  });
  await mkdir(paths.aiDir, {recursive: true});
  if (withInsights) {
    await writeFile(paths.insightsPath, `${JSON.stringify(INSIGHTS, null, 2)}\n`, "utf8");
  }
  if (withSummary) await writeFile(paths.summaryPath, "# 旧摘要\n旧内容\n", "utf8");
  if (withSnapshot) {
    const snapshot = {
      profile: null,
      profileSkipped: true,
      generationPreferences: {
        goal: "content_creation", scenario: "short_video", angles: ["topic_angle"],
        audience: "fans_readers", styles: ["grounded"], avoid: [],
      },
      labelSnapshot: {profile: [], generationPreferences: []},
    };
    await writeFile(paths.preferenceSnapshotPath, serializePreferenceSnapshot(snapshot), "utf8");
  }
  const manifest = JSON.parse(await readFile(paths.manifestPath, "utf8"));
  manifest.draft_seed_insight_id = 9;
  await writeFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return {root, store, context, paths, taskId: context.taskId};
}

test("a draft retry commits ai/draft.md, removes the original draft and records the seed", async (t) => {
  const {store, paths, taskId} = await makeTask(t, {withSummary: true, withSnapshot: true});
  await mkdir(join(paths.aiDir, "original"), {recursive: true});
  await writeFile(join(paths.aiDir, "original", "draft.md"), "旧稿\n", "utf8");

  const seen = [];
  const result = await runInsightRetryPipeline(request(taskId), {
    projectRoot: store.outputRoot,
    store,
    environ: {ANYSEARCH_MCP_URL: "http://127.0.0.1:1/mcp"},
    draftRunner: async (input) => {
      seen.push(input);
      return ARTICLE;
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.draft, ARTICLE);
  assert.equal(result.error, null);
  assert.equal(await readFile(paths.draftPath, "utf8"), ARTICLE);
  await assert.rejects(readFile(join(paths.aiDir, "original", "draft.md")), {code: "ENOENT"});
  const manifest = JSON.parse(await readFile(paths.manifestPath, "utf8"));
  assert.equal(manifest.status, "completed");
  assert.equal(manifest.draft_seed_insight_id, 5);
  assert.equal(manifest.artifacts.draft, "ai/draft.md");
  assert.equal(manifest.draft_path, "ai/draft.md");
  assert.equal(manifest.has_draft, true);
  assert.equal(manifest.artifacts.summary, "ai/summary.md");

  assert.equal(seen.length, 1);
  assert.equal(seen[0].seed.id, 5);
  assert.equal(seen[0].seed.topic, INSIGHTS.insights[0].topic);
  assert.equal(seen[0].platform, "douyin");
  assert.equal(seen[0].sourceKind, "transcript");
  assert.equal(seen[0].summary, "# 旧摘要\n旧内容");
  assert.equal(seen[0].preferenceSnapshot.generationPreferences.goal, "content_creation");
});

test("the real draft runner wires MCP tools, skills and a single LLM checkout", async (t) => {
  const {store, paths, taskId} = await makeTask(t);
  const calls = [];
  const llm = {
    chat: async (messages, tools) => {
      calls.push({messages, tools: tools.map((tool) => tool.name)});
      if (calls.length === 1) {
        return {
          text: null,
          toolCalls: [{id: "c1", name: "submit_draft", arguments: JSON.stringify({markdown: ARTICLE})}],
        };
      }
      return {text: "已完成", toolCalls: []};
    },
  };
  let closed = 0;
  const result = await runInsightRetryPipeline(request(taskId), {
    projectRoot: store.outputRoot,
    store,
    environ: {
      ANYSEARCH_MCP_URL: "http://127.0.0.1:1/mcp",
      APP_LLM_API_KEY: "key", APP_LLM_MODEL: "model", APP_LLM_BASE_URL: "http://127.0.0.1:1/v1",
    },
    mcpSessionFactory: async (config) => {
      assert.equal(config.url, "http://127.0.0.1:1/mcp");
      return {
        tools: [{
          name: "search",
          description: "检索",
          parameters: {type: "object", properties: {query: {type: "string"}}, required: ["query"]},
          handler: async () => "检索结果",
        }],
        close: async () => { closed += 1; },
      };
    },
    draftLlmFactory: async () => llm,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.draft, ARTICLE);
  assert.equal(closed, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].tools, ["search", "Skill", "submit_draft", "write_todos"]);
  assert.match(calls[0].messages[0].content, /<!-- skills-inventory -->/u);
  assert.match(calls[0].messages[0].content, /<!-- todo-state -->/u);
  assert.match(calls[0].messages[1].content, /如何把长视频拆成短视频/u);
  assert.equal(await readFile(paths.draftPath, "utf8"), ARTICLE);
});

test("the three draft failure codes leave a partial_completed manifest", async (t) => {
  const missingSeed = await makeTask(t, {withInsights: false});
  let runnerCalls = 0;
  const invalid = await runInsightRetryPipeline(request(missingSeed.taskId), {
    projectRoot: missingSeed.store.outputRoot,
    store: missingSeed.store,
    environ: {ANYSEARCH_MCP_URL: "http://127.0.0.1:1/mcp"},
    draftRunner: async () => { runnerCalls += 1; return ARTICLE; },
  });
  assert.equal(runnerCalls, 0);
  assert.equal(invalid.error.code, "DRAFT_SEED_INVALID");
  assert.equal(invalid.error.message, "insight_id 5 is not present in ai/insights.json; re-select an insight and retry.");
  assert.equal(invalid.error.stage, "draft_generating");
  assert.equal(JSON.parse(await readFile(missingSeed.paths.manifestPath, "utf8")).status, "partial_completed");

  const failing = await makeTask(t);
  const generation = await runInsightRetryPipeline(request(failing.taskId), {
    projectRoot: failing.store.outputRoot,
    store: failing.store,
    environ: {ANYSEARCH_MCP_URL: "http://127.0.0.1:1/mcp"},
    draftRunner: async () => { throw new Error("secret-key-prefix leaked"); },
  });
  assert.equal(generation.error.code, "DRAFT_GENERATION_FAILED");
  assert.equal(generation.error.message, "Draft generation failed.");
  assert.doesNotMatch(generation.error.message, /secret/u);

  const empty = await makeTask(t);
  const blank = await runInsightRetryPipeline(request(empty.taskId), {
    projectRoot: empty.store.outputRoot,
    store: empty.store,
    environ: {ANYSEARCH_MCP_URL: "http://127.0.0.1:1/mcp"},
    draftRunner: async () => "  \n ",
  });
  assert.equal(blank.error.code, "DRAFT_EMPTY_RESULT");
  assert.equal(blank.error.message, "Draft generation returned an empty result.");
  await assert.rejects(readFile(empty.paths.draftPath), {code: "ENOENT"});
});

test("an unconfigured retrieval endpoint fails before any model call", async (t) => {
  const {store, taskId} = await makeTask(t);
  let llmCalls = 0;
  const result = await runInsightRetryPipeline(request(taskId), {
    projectRoot: store.outputRoot,
    store,
    environ: {APP_LLM_API_KEY: "key", APP_LLM_MODEL: "model"},
    draftLlmFactory: async () => {
      llmCalls += 1;
      return {chat: async () => ({text: null, toolCalls: []})};
    },
  });
  assert.equal(result.error.code, "DRAFT_GENERATION_FAILED");
  assert.equal(llmCalls, 0);
});
