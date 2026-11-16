import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runToolLoop } from "../src/ai/tool-loop.ts";
import {
  generateInsights, validateInsightsDelivery, writeInsightFiles, insightToDict,
} from "../src/ai/insights-agent.ts";
import { parsePreferenceSnapshot } from "../src/ai/preference-snapshot.ts";

const MARKDOWN = "# 会议\n\n第一段谈流程。\n\n第二段谈平台化。\n";
const ITEM = {
  topic: "流程先于工具",
  matchReason: "原文两次强调流程瓶颈",
  followUpQuestions: ["该从哪条流程开始？", "如何衡量效果？"],
  suitableUse: "短视频开场",
  sourceChunkId: 1,
};

function text(raw) {
  return raw.replaceAll("\r\n", "\n");
}

function toolCall(id, payload) {
  return { text: null, toolCalls: [{ id, name: "submit_insights", arguments: JSON.stringify({ insights: payload }) }] };
}

function scriptedRuntime(replies) {
  const calls = [];
  return {
    calls,
    async complete(options) {
      return runToolLoop({
        ...options,
        chat: async (messages, tools) => {
          // Tool 里有 handler 函数，不能整体 structuredClone；只留下请求里真正会发出的部分。
          calls.push({
            messages: structuredClone(messages),
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: structuredClone(tool.parameters),
            })),
          });
          const reply = replies.shift();
          if (reply === undefined) throw new Error("模型回复用完了");
          return reply;
        },
      });
    },
  };
}

function makeRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "locus-insights-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("delivery validation enforces the schema and keeps ids sequential", () => {
  const accepted = validateInsightsDelivery([ITEM, { ...ITEM, topic: "另一话题", sourceChunkId: 2 }], [1, 2]);
  assert.equal(accepted.length, 2);
  assert.deepEqual(accepted.map((item) => item.id), [1, 2]);
  assert.deepEqual(insightToDict(accepted[0]), { id: 1, ...ITEM });

  const broken = [
    [],
    Array.from({ length: 13 }, () => ITEM),
    [{ ...ITEM, extra: 1 }],
    [{ topic: ITEM.topic }],
    [{ ...ITEM, topic: "   " }],
    [{ ...ITEM, matchReason: "\t" }],
    [{ ...ITEM, followUpQuestions: [] }],
    [{ ...ITEM, followUpQuestions: ["q", "q"] }],
    [{ ...ITEM, followUpQuestions: ["a", "b", "c", "d"] }],
    [{ ...ITEM, followUpQuestions: [" "] }],
    [{ ...ITEM, sourceChunkId: 9 }],
    [{ ...ITEM, sourceChunkId: "1" }],
    [{ ...ITEM, sourceChunkId: null }],
    [ITEM, { ...ITEM, topic: "流程先于工具" }],
    "not-an-array",
  ];
  for (const payload of broken) {
    assert.throws(() => validateInsightsDelivery(payload, [1, 2]), (error) => {
      assert.equal(error.code, "AI_INVALID_RESULT");
      return true;
    }, `应当拒止：${JSON.stringify(payload).slice(0, 70)}`);
  }
});

test("the agent sends chunk ids in the prompt and in the tool schema", async () => {
  const runtime = scriptedRuntime([toolCall("call_1", [ITEM])]);
  const insights = await generateInsights({
    markdown: MARKDOWN, outputLanguage: "zh-CN", llm: runtime,
  });
  assert.equal(insights.length, 1);
  assert.equal(runtime.calls.length, 1);
  assert.deepEqual(runtime.calls[0].tools.map((tool) => tool.name), ["submit_insights"]);
  const enumIds = runtime.calls[0].tools[0].parameters.properties.insights.items.properties.sourceChunkId.enum;
  assert.deepEqual(enumIds, [1]);
  assert.match(runtime.calls[0].messages[1].content, /Legal sourceChunkId values: \[1\]\./);
  assert.match(runtime.calls[0].messages[0].content, /Do not finish with a plain reply/);
});

test("an invalid delivery is sent back as tool feedback and retried", async () => {
  const runtime = scriptedRuntime([
    toolCall("call_1", [{ ...ITEM, sourceChunkId: 99 }]),
    toolCall("call_2", [ITEM]),
  ]);
  const insights = await generateInsights({ markdown: MARKDOWN, outputLanguage: "zh-CN", llm: runtime });
  assert.equal(insights.length, 1);
  const feedback = runtime.calls[1].messages.at(-1);
  assert.equal(feedback.role, "tool");
  assert.match(feedback.content, /Submit a corrected complete list with submit_insights\./);
});

test("a plain reply is nudged by name and exhaustion reports AI_EMPTY_RESULT", async () => {
  const runtime = scriptedRuntime([
    { text: "我不想用工具。", toolCalls: [] },
    { text: "还是不用。", toolCalls: [] },
  ]);
  await assert.rejects(
    () => generateInsights({ markdown: MARKDOWN, outputLanguage: "en-US", llm: runtime, maxTurns: 2 }),
    (error) => error.code === "AI_EMPTY_RESULT",
  );
  assert.equal(runtime.calls.length, 2);
  const nudge = runtime.calls[1].messages.at(-1);
  assert.equal(nudge.role, "user");
  assert.equal(
    nudge.content,
    "Delivery is incomplete. Call submit_insights with the complete list. "
      + "A plain reply does not submit the inspiration artifact.",
  );
});

test("loop exhaustion and invalid inputs never reach the model in bad cases", async () => {
  const exhausted = scriptedRuntime([
    { text: "不交", toolCalls: [] },
    { text: "不交", toolCalls: [] },
  ]);
  await assert.rejects(
    () => generateInsights({ markdown: MARKDOWN, outputLanguage: "zh-CN", llm: exhausted, maxTurns: 2 }),
    (error) => error.code === "AI_EMPTY_RESULT",
  );
  const unused = scriptedRuntime([]);
  await assert.rejects(() => generateInsights({ markdown: "   ", outputLanguage: "zh-CN", llm: unused }),
    (error) => error.code === "AI_EMPTY_TRANSCRIPT");
  await assert.rejects(() => generateInsights({ markdown: MARKDOWN, outputLanguage: "zh-CN", llm: unused, maxTurns: 7 }));
  assert.equal(unused.calls.length, 0, "非法输入不该调用模型");
});

test("preference snapshots are rendered into the prompt without changing chunk ids", async () => {
  const fixture = JSON.parse(await readFile(
    new URL("./fixtures/insights-prompts-golden.json", import.meta.url), "utf8",
  ));
  const snapshot = parsePreferenceSnapshot(fixture.snapshot);
  const runtime = scriptedRuntime([toolCall("call_1", [ITEM])]);
  await generateInsights({
    markdown: MARKDOWN, outputLanguage: "zh-CN", llm: runtime, preferenceSnapshot: snapshot,
  });
  assert.match(runtime.calls[0].messages[1].content, /## Personalization snapshot/);
  assert.match(runtime.calls[0].messages[1].content, /"profileSkipped":false/);
});

test("insight files carry the persisted schema and platform newlines", async (t) => {
  const root = makeRoot(t);
  const aiDir = join(root, "ai");
  await mkdir(aiDir, { recursive: true });
  const insights = validateInsightsDelivery([ITEM], [1]);
  const artifacts = await writeInsightFiles({
    insights, outputDir: aiDir, outputStem: "", outputLanguage: "zh-CN",
  });
  assert.equal(text(await readFile(artifacts.jsonPath, "utf8")), text(Buffer.from(artifacts.jsonBytes).toString("utf8")));
  const payload = JSON.parse(await readFile(artifacts.jsonPath, "utf8"));
  assert.equal(payload.schemaVersion, 1);
  assert.deepEqual(payload.insights, [insightToDict(insights[0])]);
  assert.match(text(await readFile(artifacts.markdownPath, "utf8")), /^# 启发灵感\n\n## 灵感 1/);
  assert.deepEqual((await readdir(aiDir)).sort(), ["insights.json", "insights.md"]);

  // persist:false 只给字节，管线要靠它们把产物与清单放进同一事务。
  const detached = await writeInsightFiles({
    insights, outputDir: join(root, "other"), outputStem: "", outputLanguage: "zh-CN", persist: false,
  });
  assert.equal(detached.jsonBytes.byteLength > 0, true);
  await assert.rejects(() => readFile(detached.jsonPath));

  await assert.rejects(
    () => writeInsightFiles({ insights: [], outputDir: aiDir, outputStem: "", outputLanguage: "zh-CN" }),
    (error) => error.code === "AI_EMPTY_RESULT",
  );
});
