import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import test from "node:test";

import {
  DRAFT_AGENT_MAX_TURNS,
  createSubmitDraftTool,
  DraftSink,
  generateDraft,
  planningEnabled,
  PLANNING_OFF_VALUES,
  resolveDraftMaxTurns,
  SUBMIT_DRAFT_TOOL_SPEC,
} from "../src/ai/draft-agent.ts";
import {buildDraftSystemPrompt} from "../src/ai/draft-prompt.ts";
import {DRAFT_PLATFORM_IDS} from "../src/ai/draft-platform.ts";
import {createDraftLlm} from "../src/ai/draft-agent.ts";
import {loadSkills} from "../src/ai/workspace/skills.ts";

const fixture = JSON.parse(await readFile(new URL("./fixtures/draft-golden.json", import.meta.url), "utf8"));

const SEED = {
  id: 3,
  topic: "企业级 Agent 的价值分水岭",
  matchReason: "源自原视频的核心判断",
  followUpQuestions: ["上下文为何决定上限？"],
  suitableUse: "公众号",
  sourceChunkId: 7,
};

function toolCall(id, name, args) {
  return {id, name, arguments: JSON.stringify(args)};
}

function completion(text, toolCalls = []) {
  return {text, toolCalls};
}

test("submit_draft tool spec and handler replies are byte-identical to Python", async () => {
  assert.deepEqual(SUBMIT_DRAFT_TOOL_SPEC, fixture.submitDraftTool);
  const sink = new DraftSink();
  assert.equal(sink.value, "");
  assert.equal(sink.set("   "), false);
  assert.equal(sink.value, "");
  assert.equal(sink.set("第一版"), true);
  assert.equal(sink.set("\n\t "), false);
  assert.equal(sink.value, "第一版");
  assert.equal(sink.set("第二版"), true);
  assert.equal(sink.value, "第二版");

  const tool = createSubmitDraftTool(sink);
  const call = {id: "1", name: "submit_draft", arguments: "{}"};
  assert.equal(await tool.handler({toolName: "submit_draft", args: {markdown: "# 稿子\n\n正文"}, call}), fixture.submitDraftResponses.accepted);
  assert.equal(await tool.handler({toolName: "submit_draft", args: {markdown: "  "}, call}), fixture.submitDraftResponses.rejected);
  assert.equal(sink.value, "# 稿子\n\n正文");
});

test("turn budget and planning switch follow APP_DRAFT_* and Python defaults", () => {
  assert.equal(DRAFT_AGENT_MAX_TURNS, fixture.maxTurns);
  assert.deepEqual(PLANNING_OFF_VALUES, fixture.planningOffValues);
  assert.equal(resolveDraftMaxTurns({}), 40);
  assert.equal(resolveDraftMaxTurns({APP_DRAFT_MAX_TURNS: " 7 "}), 7);
  assert.equal(resolveDraftMaxTurns({APP_DRAFT_MAX_TURNS: "0"}), 40);
  assert.equal(resolveDraftMaxTurns({APP_DRAFT_MAX_TURNS: "3.5"}), 40);
  assert.equal(resolveDraftMaxTurns({APP_DRAFT_MAX_TURNS: "0x10"}), 40);
  assert.equal(planningEnabled({}), true);
  assert.equal(planningEnabled({APP_DRAFT_PLANNING: "false"}), false);
  assert.equal(planningEnabled({APP_DRAFT_PLANNING: "0"}), false);
  assert.equal(buildDraftSystemPrompt("douyin").includes(fixture.retrievalFallbackPhrase), true);
  assert.equal(DRAFT_PLATFORM_IDS.length, 9);
});

test("managed draft checkout happens once for the whole tool loop", async () => {
  const checkouts = [];
  const transport = async (url, init) => {
    checkouts.push(url);
    return {
      status: 200,
      body: JSON.stringify({
        provider: "openai_compatible",
        base_url: "http://127.0.0.1:1/v1",
        model: "draft-model",
        api_key: "temporary-key",
      }),
    };
  };
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push(JSON.parse(init.body));
    return {status: 200, body: JSON.stringify({choices: [{message: {content: "好的", tool_calls: []}}]})};
  };
  const llm = await createDraftLlm({
    APP_LLM_SOURCE: "server",
    APP_LLM_CHECKOUT_URL: "https://checkout.example/config",
    APP_LLM_SESSION_TOKEN: "session",
    APP_LLM_CHECKOUT_REQUEST_ID: "seed",
  }, {transport, fetchImpl});
  await llm.chat([{role: "user", content: "第一轮"}], []);
  await llm.chat([{role: "user", content: "第二轮"}], []);
  assert.equal(checkouts.length, 1);
  assert.equal(requests.length, 2);
  for (const body of requests) {
    assert.equal(body.model, "draft-model");
    assert.equal(body.max_tokens, undefined);
    assert.equal(body.stream, false);
  }
});

test("the draft loop wires retrieval, skills, planning and delivery in Python order", async () => {
  const article = "# 标题\n\n这是可直接发布的稿子正文。\n";
  const responses = [
    completion(null, [toolCall("c1", "search", {query: "上下文能力"})]),
    completion(null, [toolCall("c2", "write_todos", {todos: [
      {content: "结构构思", status: "completed"},
      {content: "资料检索", status: "completed"},
      {content: "按平台文体写作", status: "completed"},
    ]})]),
    completion(null, [toolCall("c3", "Skill", {name: "viral-writer"})]),
    completion(null, [toolCall("c4", "submit_draft", {markdown: article})]),
    completion("已完成", []),
  ];
  const seen = [];
  const llm = {
    chat: async (messages, tools) => {
      seen.push({
        tools: tools.map((tool) => tool.name),
        system: messages[0].content,
      });
      const next = responses.shift();
      assert.ok(next, "模型请求超出了预设序列");
      return next;
    },
  };
  const retrieval = {
    name: "search",
    description: "检索资料",
    parameters: {type: "object", properties: {query: {type: "string"}}, required: ["query"]},
    handler: async ({args}) => `检索结果：${args.query}`,
  };
  const skills = await loadSkills(fileURLToPath(new URL("../skills/", import.meta.url)));
  const draft = await generateDraft({
    seed: SEED,
    preferenceSnapshot: null,
    summary: null,
    platform: "douyin",
    outputLanguage: "zh-CN",
    sourceKind: "transcript",
    llm,
    mcpTools: [retrieval],
    skills,
    planningEnabled: true,
    maxTurns: 40,
  });

  assert.equal(draft, article);
  assert.equal(seen.length, 5);
  assert.deepEqual(seen[0].tools, ["search", "Skill", "submit_draft", "write_todos"]);
  assert.match(seen[0].system, /<!-- skills-inventory -->/u);
  assert.match(seen[0].system, /## Skills/u);
  assert.match(seen[0].system, /<!-- todo-state -->/u);
  assert.match(seen[0].system, /## Plan/u);
  assert.match(seen[3].system, /### Current plan/u);
  assert.equal((seen[4].system.match(/<!-- skills-inventory -->/gu) ?? []).length, 1);
  assert.equal((seen[4].system.match(/<!-- \/skills-inventory -->/gu) ?? []).length, 1);
  assert.equal((seen[4].system.match(/<!-- todo-state -->/gu) ?? []).length, 1);
  assert.equal((seen[4].system.match(/<!-- \/todo-state -->/gu) ?? []).length, 1);
});

test("unfinished todos veto plain-text completion up to the reminder cap", async () => {
  const responses = [
    completion(null, [toolCall("c1", "write_todos", {todos: [
      {content: "结构构思", status: "in_progress"},
    ]})]),
    completion("我想结束", []),
    completion("还是想结束", []),
    completion(null, [toolCall("c2", "submit_draft", {markdown: "# 稿子\n\n正文"})]),
    completion("完成", []),
  ];
  const llm = {
    chat: async () => {
      const next = responses.shift();
      assert.ok(next);
      return next;
    },
  };
  const draft = await generateDraft({
    seed: SEED,
    preferenceSnapshot: null,
    summary: null,
    platform: "other",
    outputLanguage: "zh-CN",
    sourceKind: "transcript",
    llm,
    mcpTools: [],
    skills: [],
    planningEnabled: true,
    maxTurns: 40,
  });
  assert.equal(draft, "# 稿子\n\n正文");
});
