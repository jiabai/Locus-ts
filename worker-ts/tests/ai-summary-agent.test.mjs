import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runToolLoop } from "../src/ai/tool-loop.ts";
import {
  generateSummary,
  normalizeMermaidMindmap,
  normalizeSummaryMarkdown,
  writeSummaryFiles,
} from "../src/ai/summary-agent.ts";

// 假模型 + 真工具循环：验证的是「两段交付的编排」，不是模型质量。
function scriptedRuntime(replies) {
  const calls = [];
  return {
    calls,
    async complete(options) {
      const chat = async (messages, tools) => {
        calls.push({
          messages: structuredClone(messages),
          toolNames: tools.map((tool) => tool.name),
        });
        const reply = replies.shift();
        if (reply === undefined) throw new Error("模型回复用完了");
        return reply;
      };
      return runToolLoop({ ...options, chat });
    },
  };
}

function toolCall(id, name, args) {
  return { text: null, toolCalls: [{ id, name, arguments: JSON.stringify(args) }] };
}

const MARKDOWN = "# 采访\n\n第一段。\n\n第二段。";

function text(raw) {
  return raw.replaceAll("\r\n", "\n");
}

function makeRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "locus-summary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("normalization adds the title and the trailing newline the UI expects", () => {
  // 没有 # 开头就按输出语言补标题，否则摘要会从二级标题开始。
  assert.equal(normalizeSummaryMarkdown("总览\n\n- 要点", "zh-CN"), "# 要点总结\n\n总览\n\n- 要点\n");
  assert.equal(normalizeSummaryMarkdown("總覽", "zh-TW"), "# 重點摘要\n\n總覽\n");
  assert.equal(normalizeSummaryMarkdown("Overview", "en-US"), "# Key Summary\n\nOverview\n");
  // 已有标题就原样保留；代码围栏被剥掉。
  assert.equal(normalizeSummaryMarkdown("```\n# 我的标题\n正文\n```", "zh-CN"), "# 我的标题\n正文\n");
  assert.equal(normalizeSummaryMarkdown("   ", "zh-CN"), "");
});

test("mindmap normalization keeps only the source from the root line", () => {
  assert.equal(
    normalizeMermaidMindmap("```\nmindmap\n  root((主题))\n    分支  \n```"),
    "mindmap\n  root((主题))\n    分支\n",
  );
  // 解释文字写在围栏外时，围栏本身会被保留——这是 Python 的现状，两边必须一致；
  // 提示词已经明确要求「只输出 Mermaid 源」，出现这种情况属于模型没遵守。
  assert.equal(
    normalizeMermaidMindmap("这是导图：\n```\nmindmap\n  root((主题))\n```"),
    "mindmap\n  root((主题))\n```\n",
  );
  // 没有独立的 mindmap 行就不是合法导图，不能硬补一个。
  assert.equal(normalizeMermaidMindmap("root((主题))\n  分支"), "");
  assert.equal(normalizeMermaidMindmap(""), "");
  assert.equal(normalizeMermaidMindmap("mindmap"), "mindmap\n");
});

test("the agent delivers the mindmap first, then the summary", async () => {
  const runtime = scriptedRuntime([
    toolCall("call_1", "submit_mindmap", { mermaid: "导图如下：\nmindmap\n  root((主题))\n    分支" }),
    toolCall("call_2", "submit_summary", { markdown: "总览\n\n- 一条要点" }),
  ]);

  const result = await generateSummary({
    markdown: MARKDOWN,
    outputLanguage: "zh-CN",
    llm: runtime,
  });

  assert.equal(result.mindmap, "mindmap\n  root((主题))\n    分支\n");
  assert.equal(result.summary, "# 要点总结\n\n总览\n\n- 一条要点\n");
  assert.equal(runtime.calls.length, 2);
  // 第一轮：只有一个工具，首条消息是 system。
  assert.deepEqual(runtime.calls[0].toolNames, ["submit_mindmap"]);
  assert.equal(runtime.calls[0].messages[0].role, "system");
  assert.match(runtime.calls[0].messages[0].content, /key summary agent/);
  assert.match(runtime.calls[0].messages[1].content, /Organize the transcript/);
  // 第二轮：工具换成摘要工具，并且追加了带导图的摘要任务。
  assert.deepEqual(runtime.calls[1].toolNames, ["submit_summary"]);
  // 摘要任务在工具结果之前追加（先换阶段再回填结果），所以取「最后一条 user 消息」。
  const followUp = runtime.calls[1].messages.findLast((message) => message.role === "user");
  assert.match(followUp.content, /Mermaid mindmap\nmindmap\n {2}root\(\(主题\)\)/);
});

test("an invalid mindmap is sent back to the model instead of aborting", async () => {
  const runtime = scriptedRuntime([
    toolCall("call_1", "submit_mindmap", { mermaid: "root((没有根行))" }),
    toolCall("call_2", "submit_mindmap", { mermaid: "mindmap\n  root((主题))" }),
    toolCall("call_3", "submit_summary", { markdown: "# 摘要\n正文" }),
  ]);

  const result = await generateSummary({
    markdown: MARKDOWN,
    outputLanguage: "zh-CN",
    llm: runtime,
  });

  assert.equal(result.summary, "# 摘要\n正文\n");
  assert.equal(runtime.calls.length, 3);
  const rejection = runtime.calls[1].messages.find((message) => message.role === "tool");
  assert.match(rejection.content, /Invalid mindmap/);
  // 仍在导图阶段：工具集没有换。
  assert.deepEqual(runtime.calls[1].toolNames, ["submit_mindmap"]);
});

test("a run that never delivers fails with the code the UI knows", async () => {
  const noMindmap = scriptedRuntime([
    { text: "我不想交。", toolCalls: [] },
    { text: "还是不交。", toolCalls: [] },
  ]);
  await assert.rejects(
    () => generateSummary({ markdown: MARKDOWN, outputLanguage: "zh-CN", llm: noMindmap, maxTurns: 2 }),
    (error) => {
      assert.equal(error.code, "AI_INVALID_MINDMAP");
      assert.equal(error.message, "Summary agent did not deliver a valid Mermaid mindmap.");
      return true;
    },
  );

  const noSummary = scriptedRuntime([
    toolCall("call_1", "submit_mindmap", { mermaid: "mindmap\n  root((主题))" }),
    { text: "摘要我就不写了。", toolCalls: [] },
  ]);
  await assert.rejects(
    () => generateSummary({ markdown: MARKDOWN, outputLanguage: "zh-CN", llm: noSummary, maxTurns: 2 }),
    (error) => {
      assert.equal(error.code, "AI_EMPTY_SUMMARY");
      assert.equal(error.message, "Summary agent did not deliver a summary.");
      return true;
    },
  );
});

test("a text-only reply is nudged by name", async () => {
  const runtime = scriptedRuntime([
    { text: "这里是导图……", toolCalls: [] },
    toolCall("call_1", "submit_mindmap", { mermaid: "mindmap\n  root((主题))" }),
    toolCall("call_2", "submit_summary", { markdown: "# 摘要" }),
  ]);

  await generateSummary({ markdown: MARKDOWN, outputLanguage: "zh-CN", llm: runtime, maxTurns: 3 });
  const nudge = runtime.calls[1].messages.at(-1);
  assert.match(nudge.content, /Call the submit_mindmap tool/);
});

test("an empty transcript and an invalid turn budget fail before any model call", async () => {
  const runtime = scriptedRuntime([]);
  await assert.rejects(
    () => generateSummary({ markdown: "   ", outputLanguage: "zh-CN", llm: runtime }),
    (error) => error.code === "AI_EMPTY_TRANSCRIPT",
  );
  for (const maxTurns of [0, 7, 1.5]) {
    await assert.rejects(
      () => generateSummary({ markdown: MARKDOWN, outputLanguage: "zh-CN", llm: runtime, maxTurns }),
      /max_turns/,
    );
  }
  assert.equal(runtime.calls.length, 0);
});

test("summary files land in the task ai directory through the artifact transaction", async (t) => {
  const root = makeRoot(t);
  const taskDir = join(root, "tasks", "t1");
  const aiDir = join(taskDir, "ai");

  const artifacts = await writeSummaryFiles({
    summary: "总览\n\n- 要点",
    mindmap: "mindmap\n  root((主题))",
    outputDir: aiDir,
    outputStem: "",
    outputLanguage: "zh-CN",
  });

  assert.equal(artifacts.summaryPath, join(aiDir, "summary.md"));
  assert.equal(artifacts.mindmapPath, join(aiDir, "mindmap.mmd"));
  // 产物文件给人看，Windows 上用 CRLF；断言前统一换行，测试才能跨平台。
  assert.equal(text(await readFile(artifacts.summaryPath, "utf8")), "# 要点总结\n\n总览\n\n- 要点\n");
  assert.equal(text(await readFile(artifacts.mindmapPath, "utf8")), "mindmap\n  root((主题))\n");
  // 事务材料不该留在任务目录里。
  const leftovers = (await readdir(taskDir)).filter((name) => name.startsWith("."));
  assert.deepEqual(leftovers, []);

  // 覆盖写同样走事务：旧内容被替换，仍然没有残留。
  await writeSummaryFiles({
    summary: "# 新标题\n新内容",
    mindmap: "mindmap\n  root((新主题))",
    outputDir: aiDir,
    outputStem: "",
    outputLanguage: "zh-CN",
  });
  assert.equal(text(await readFile(artifacts.summaryPath, "utf8")), "# 新标题\n新内容\n");
  assert.deepEqual((await readdir(taskDir)).filter((name) => name.startsWith(".")), []);
});

test("a non-task export directory gets per-file atomic writes and no journal", async (t) => {
  const root = makeRoot(t);
  const exportDir = join(root, "export");

  const artifacts = await writeSummaryFiles({
    summary: "# 导出摘要\n正文",
    mindmap: "mindmap\n  root((导出))",
    outputDir: exportDir,
    outputStem: "meeting",
    outputLanguage: "zh-CN",
  });

  assert.equal(artifacts.summaryPath, join(exportDir, "meeting_summary.md"));
  assert.equal(artifacts.mindmapPath, join(exportDir, "meeting_mindmap.mmd"));
  assert.deepEqual((await readdir(exportDir)).sort(), ["meeting_mindmap.mmd", "meeting_summary.md"]);
});

test("writing rejects content that would produce an unusable artifact", async (t) => {
  const root = makeRoot(t);
  await assert.rejects(
    () => writeSummaryFiles({
      summary: "  ",
      mindmap: "mindmap\n  root((主题))",
      outputDir: join(root, "ai"),
      outputStem: "",
      outputLanguage: "zh-CN",
    }),
    (error) => error.code === "AI_EMPTY_SUMMARY",
  );
  await assert.rejects(
    () => writeSummaryFiles({
      summary: "# 摘要",
      mindmap: "root((没有根行))",
      outputDir: join(root, "ai"),
      outputStem: "",
      outputLanguage: "zh-CN",
    }),
    (error) => error.code === "AI_INVALID_MINDMAP",
  );

  // persist:false 只归一化，不落盘。
  const artifacts = await writeSummaryFiles({
    summary: "总览",
    mindmap: "mindmap\n  root((主题))",
    outputDir: join(root, "ai"),
    outputStem: "",
    outputLanguage: "zh-CN",
    persist: false,
  });
  assert.equal(artifacts.summary, "# 要点总结\n\n总览\n");
  assert.deepEqual(await readdir(join(root, "ai")).catch(() => []), []);
});
