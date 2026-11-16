import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildChatRequestBody,
  chatCompletion,
  chatCompletionsUrl,
} from "../src/ai/chat.ts";

const GOLDEN_URL = new URL("./fixtures/insight-request-golden.json", import.meta.url);

const ENDPOINT = {
  provider: "openai_compatible",
  baseUrl: "http://127.0.0.1:1/v1",
  model: "test-model",
  apiKey: "sk-test",
  timeoutSeconds: 15,
  maxOutputTokens: 8192,
};

const SUMMARY_TOOL = {
  name: "submit_summary",
  description: "Submit the final Markdown key summary; a valid submission finishes this run.",
  parameters: {
    type: "object",
    properties: {
      markdown: {
        type: "string",
        description: "Complete Markdown key summary ready for direct display",
      },
    },
    required: ["markdown"],
  },
};

function capturingFetch(response) {
  const captured = [];
  const fetchImpl = async (url, init) => {
    captured.push({ url, init, body: JSON.parse(init.body) });
    return response;
  };
  return { fetchImpl, captured };
}

function completion(body) {
  return { status: 200, body: JSON.stringify(body) };
}

test("the request body matches what the Python SDK actually sends", async () => {
  // golden 由 `work/ai-spike/capture_py_request.py` 抓 `ProviderOpenAIOfficial` 的真实请求得到。
  // 照着文档写容易「看起来对」，抓包才能保证两个实现发出的是同一个请求。
  const golden = JSON.parse(await readFile(GOLDEN_URL, "utf8"));
  const body = buildChatRequestBody(
    ENDPOINT,
    [
      { role: "system", content: "你是一个中文笔记助手。" },
      { role: "user", content: "请总结下面这段文字稿。" },
    ],
    [SUMMARY_TOOL],
    ENDPOINT.maxOutputTokens,
  );
  assert.deepEqual(body, golden);
});

test("a request without tools omits tools and tool_choice", () => {
  const body = buildChatRequestBody(ENDPOINT, [{ role: "user", content: "你好" }], [], 1024);
  assert.deepEqual(body, {
    model: "test-model",
    stream: false,
    messages: [{ role: "user", content: "你好" }],
    max_tokens: 1024,
  });
  assert.equal("tools" in body, false);
  assert.equal("tool_choice" in body, false);
});

test("assistant tool calls and tool results serialize to the OpenAI wire shape", () => {
  const body = buildChatRequestBody(
    ENDPOINT,
    [
      { role: "user", content: "总结" },
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "call_1", name: "submit_mindmap", arguments: '{"mermaid":"mindmap"}' }],
      },
      { role: "tool", toolCallId: "call_1", content: "Mindmap accepted." },
    ],
    [SUMMARY_TOOL],
    8192,
  );
  assert.deepEqual(body.messages, [
    { role: "user", content: "总结" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "submit_mindmap", arguments: '{"mermaid":"mindmap"}' },
      }],
    },
    { role: "tool", tool_call_id: "call_1", content: "Mindmap accepted." },
  ]);
});

test("a tool call reply parses into text plus tool calls", async () => {
  const { fetchImpl, captured } = capturingFetch(completion({
    choices: [{
      index: 0,
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_a", type: "function", function: { name: "submit_summary", arguments: '{"markdown":"# 标题"}' } },
          { id: "call_b", type: "function", function: { name: "submit_mindmap", arguments: "{}" } },
        ],
      },
    }],
  }));

  const result = await chatCompletion({
    endpoint: ENDPOINT,
    messages: [{ role: "user", content: "总结" }],
    tools: [SUMMARY_TOOL],
    fetchImpl,
  });

  assert.equal(result.text, null);
  assert.deepEqual(result.toolCalls, [
    { id: "call_a", name: "submit_summary", arguments: '{"markdown":"# 标题"}' },
    { id: "call_b", name: "submit_mindmap", arguments: "{}" },
  ]);
  // 凭据只出现在 Authorization 头里，不进请求体。
  assert.equal(captured[0].url, "http://127.0.0.1:1/v1/chat/completions");
  assert.equal(captured[0].init.headers.Authorization, "Bearer sk-test");
  assert.equal(JSON.stringify(captured[0].body).includes("sk-test"), false);
});

test("the base url is normalized before appending the path", () => {
  assert.equal(chatCompletionsUrl("https://api.openai.com/v1/"), "https://api.openai.com/v1/chat/completions");
  assert.equal(chatCompletionsUrl("https://x.test/v1"), "https://x.test/v1/chat/completions");
});

test("http statuses map to the documented error codes", async () => {
  const cases = [
    [401, "AI_LLM_KEY_REJECTED"],
    [403, "AI_LLM_KEY_REJECTED"],
    [404, "AI_LLM_MODEL_UNAVAILABLE"],
    [429, "AI_LLM_RATE_LIMITED"],
    [500, "AI_LLM_REQUEST_FAILED"],
  ];
  for (const [status, code] of cases) {
    await assert.rejects(
      () => chatCompletion({
        endpoint: ENDPOINT,
        messages: [{ role: "user", content: "总结" }],
        fetchImpl: async () => ({ status, body: "{}" }),
      }),
      (error) => {
        assert.equal(error.name, "InsightGenerationError");
        assert.equal(error.code, code, `HTTP ${status} 应当映射到 ${code}`);
        return true;
      },
    );
  }
});

test("some vendors report an unknown model as HTTP 400", async () => {
  await assert.rejects(
    () => chatCompletion({
      endpoint: ENDPOINT,
      messages: [{ role: "user", content: "总结" }],
      fetchImpl: async () => ({
        status: 400,
        body: JSON.stringify({ error: { message: "Model does not exist" } }),
      }),
    }),
    (error) => error.code === "AI_LLM_MODEL_UNAVAILABLE",
  );

  // 同样是 400，但和模型无关：保持笼统失败码。
  await assert.rejects(
    () => chatCompletion({
      endpoint: ENDPOINT,
      messages: [{ role: "user", content: "总结" }],
      fetchImpl: async () => ({ status: 400, body: JSON.stringify({ error: { message: "bad request" } }) }),
    }),
    (error) => error.code === "AI_LLM_REQUEST_FAILED",
  );
});

test("timeouts and connection failures are distinguishable", async () => {
  const timeoutError = new Error("timed out");
  timeoutError.name = "TimeoutError";
  await assert.rejects(
    () => chatCompletion({
      endpoint: ENDPOINT,
      messages: [{ role: "user", content: "总结" }],
      fetchImpl: async () => { throw timeoutError; },
    }),
    (error) => error.code === "AI_LLM_REQUEST_TIMEOUT",
  );

  await assert.rejects(
    () => chatCompletion({
      endpoint: ENDPOINT,
      messages: [{ role: "user", content: "总结" }],
      fetchImpl: async () => { throw new TypeError("fetch failed"); },
    }),
    (error) => error.code === "AI_LLM_NETWORK_FAILED",
  );
});

test("unreadable responses are rejected as invalid, never guessed", async () => {
  for (const raw of [
    "not json",
    "{}",
    JSON.stringify({ choices: [] }),
    JSON.stringify({ choices: [{ message: { content: 42 } }] }),
    JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: "", arguments: "{}" } }] } }] }),
    JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: "x", arguments: 1 } }] } }] }),
  ]) {
    await assert.rejects(
      () => chatCompletion({
        endpoint: ENDPOINT,
        messages: [{ role: "user", content: "总结" }],
        fetchImpl: async () => ({ status: 200, body: raw }),
      }),
      (error) => {
        assert.equal(error.code, "AI_LLM_INVALID_RESPONSE", raw);
        return true;
      },
    );
  }
});

test("a plain text reply keeps its content and has no tool calls", async () => {
  const result = await chatCompletion({
    endpoint: ENDPOINT,
    messages: [{ role: "user", content: "总结" }],
    fetchImpl: async () => completion({
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "好的" } }],
    }),
  });
  assert.deepEqual(result, { text: "好的", toolCalls: [] });
});

test("a structurally valid but empty message is an empty completion, not an error", async () => {
  // 「模型什么都没说」是循环要重试的情况（Python 的 EMPTY_OUTPUT_RETRY_ATTEMPTS），
  // 不是「响应不可读」——把它当解析错误会让重试逻辑永远走不到。
  const result = await chatCompletion({
    endpoint: ENDPOINT,
    messages: [{ role: "user", content: "总结" }],
    fetchImpl: async () => completion({ choices: [{ index: 0, message: {} }] }),
  });
  assert.deepEqual(result, { text: null, toolCalls: [] });
});
