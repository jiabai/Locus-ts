import assert from "node:assert/strict";
import test from "node:test";

import { runToolLoop } from "../src/ai/tool-loop.ts";

// 脚本化的假模型：按顺序吐出预设的回复，同时记录每次调用看到的工具集。
function scriptedChat(replies) {
  const calls = [];
  let index = 0;
  const chat = async (messages, tools) => {
    calls.push({
      messages: structuredClone(messages),
      toolNames: tools.map((tool) => tool.name),
    });
    const reply = replies[index];
    index += 1;
    if (reply === undefined) throw new Error("模型回复用完了");
    return reply;
  };
  return { chat, calls };
}

function toolCallReply(id, name, args) {
  return { text: null, toolCalls: [{ id, name, arguments: JSON.stringify(args) }] };
}

function makeTool(name, handler) {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {}, required: [] },
    handler,
  };
}

test("a tool returning null finishes the run without another model call", async () => {
  const delivered = {};
  const { chat, calls } = scriptedChat([toolCallReply("call_1", "submit_summary", { markdown: "# 标题" })]);
  const submit = makeTool("submit_summary", ({ args }) => {
    delivered.markdown = args.markdown;
    return null;
  });

  const outcome = await runToolLoop({
    chat,
    messages: [{ role: "user", content: "总结" }],
    tools: [submit],
    maxTurns: 3,
  });

  assert.equal(outcome.delivered, true);
  assert.equal(outcome.turns, 1);
  assert.deepEqual(delivered, { markdown: "# 标题" });
  // 交付完成后不再发起第二次调用，也不再回填工具结果。
  assert.equal(calls.length, 1);
  assert.equal(outcome.messages.filter((message) => message.role === "tool").length, 0);
});

test("the tool set can be swapped between turns, like the summary agent does", async () => {
  const delivery = {};
  const submitSummary = makeTool("submit_summary", ({ args }) => {
    delivery.summary = args.markdown;
    return null;
  });
  const submitMindmap = makeTool("submit_mindmap", ({ args }) => {
    delivery.mindmap = args.mermaid;
    return "Mindmap accepted. The system will next provide the summary task and submit_summary tool.";
  });
  const { chat, calls } = scriptedChat([
    toolCallReply("call_1", "submit_mindmap", { mermaid: "mindmap\n  root" }),
    toolCallReply("call_2", "submit_summary", { markdown: "# 摘要" }),
  ]);

  const outcome = await runToolLoop({
    chat,
    messages: [{ role: "user", content: "总结" }],
    tools: [submitMindmap],
    maxTurns: 4,
    // 真实 agent 就在这一步换工具并追加下一阶段任务；这里如实复现同样的动作。
    onToolEnd: ({ tool, tools, messages }) => {
      if (tool.name !== "submit_mindmap") return;
      tools.splice(0, tools.length, submitSummary);
      messages.push({ role: "user", content: "现在给出要点总结。" });
    },
  });

  assert.equal(outcome.delivered, true);
  assert.equal(outcome.turns, 2);
  assert.deepEqual(delivery, { mindmap: "mindmap\n  root", summary: "# 摘要" });
  assert.deepEqual(calls.map((call) => call.toolNames), [["submit_mindmap"], ["submit_summary"]]);
});

test("a text-only reply is nudged instead of accepted", async () => {
  const { chat, calls } = scriptedChat([
    { text: "这是摘要：# 标题", toolCalls: [] },
    toolCallReply("call_1", "submit_summary", { markdown: "# 标题" }),
  ]);

  const outcome = await runToolLoop({
    chat,
    messages: [{ role: "user", content: "总结" }],
    tools: [makeTool("submit_summary", () => null)],
    maxTurns: 3,
    onBeforeComplete: () => false,
  });

  assert.equal(outcome.delivered, true);
  assert.equal(outcome.turns, 2);
  const nudged = calls[1].messages.at(-1);
  assert.equal(nudged.role, "user");
  assert.match(nudged.content, /Delivery is incomplete/);
});

test("onBeforeComplete can accept a plain reply when nothing is expected", async () => {
  const { chat } = scriptedChat([{ text: "没有需要交付的产物。", toolCalls: [] }]);
  const outcome = await runToolLoop({
    chat,
    messages: [{ role: "user", content: "总结" }],
    tools: [],
    maxTurns: 2,
    onBeforeComplete: () => true,
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.turns, 1);
});

test("an unknown tool name is reported back and the loop continues", async () => {
  const { chat, calls } = scriptedChat([
    toolCallReply("call_1", "submit_pdf", {}),
    toolCallReply("call_2", "submit_summary", { markdown: "# 标题" }),
  ]);

  const outcome = await runToolLoop({
    chat,
    messages: [{ role: "user", content: "总结" }],
    tools: [makeTool("submit_summary", () => null)],
    maxTurns: 3,
  });

  assert.equal(outcome.delivered, true);
  assert.equal(outcome.turns, 2);
  const toolMessage = calls[1].messages.find((message) => message.role === "tool");
  assert.match(toolMessage.content, /Unknown tool: submit_pdf/);
});

test("invalid tool arguments are reported back instead of throwing", async () => {
  const { chat, calls } = scriptedChat([
    { text: null, toolCalls: [{ id: "call_1", name: "submit_summary", arguments: "{not json" }] },
    toolCallReply("call_2", "submit_summary", { markdown: "# 标题" }),
  ]);

  const outcome = await runToolLoop({
    chat,
    messages: [{ role: "user", content: "总结" }],
    tools: [makeTool("submit_summary", () => null)],
    maxTurns: 3,
  });

  assert.equal(outcome.delivered, true);
  const toolMessage = calls[1].messages.find((message) => message.role === "tool");
  assert.match(toolMessage.content, /Invalid tool arguments/);
});

test("multiple tool calls in one message run in order", async () => {
  const seen = [];
  const { chat } = scriptedChat([
    {
      text: null,
      toolCalls: [
        { id: "call_a", name: "first", arguments: "{}" },
        { id: "call_b", name: "second", arguments: "{}" },
      ],
    },
    toolCallReply("call_c", "first", {}),
  ]);

  const outcome = await runToolLoop({
    chat,
    messages: [{ role: "user", content: "开始" }],
    tools: [
      makeTool("first", () => { seen.push("first"); return "ok"; }),
      makeTool("second", ({ call }) => { seen.push(call.id); return "ok"; }),
    ],
    maxTurns: 2,
  });

  assert.deepEqual(seen, ["first", "call_b", "first"]);
  assert.equal(outcome.delivered, false);
  assert.equal(outcome.turns, 2);
});

test("an empty model reply is retried once before giving up", async () => {
  const calls = [];
  const chat = async () => {
    calls.push(1);
    return { text: null, toolCalls: [] };
  };
  const outcome = await runToolLoop({
    chat,
    messages: [{ role: "user", content: "总结" }],
    tools: [],
    maxTurns: 3,
  });

  assert.equal(outcome.delivered, false);
  // 一轮 + 一次重试；重试不是 turn，不会把 maxTurns 消耗光。
  assert.equal(calls.length, 2);
});

test("the loop stops at maxTurns when nothing is ever delivered", async () => {
  const { chat, calls } = scriptedChat([
    toolCallReply("call_1", "submit_summary", {}),
    toolCallReply("call_2", "submit_summary", {}),
  ]);

  const outcome = await runToolLoop({
    chat,
    messages: [{ role: "user", content: "总结" }],
    tools: [makeTool("submit_summary", () => "The summary is empty: submit the complete Markdown key summary.")],
    maxTurns: 2,
  });

  assert.equal(outcome.delivered, false);
  assert.equal(outcome.turns, 2);
  assert.equal(calls.length, 2);
});

test("the loop refuses an invalid turn budget instead of looping forever", async () => {
  for (const maxTurns of [0, -1, 1.5, Number.NaN]) {
    await assert.rejects(
      () => runToolLoop({
        chat: async () => ({ text: "x", toolCalls: [] }),
        messages: [],
        tools: [],
        maxTurns,
      }),
      /positive integer/,
    );
  }
});
