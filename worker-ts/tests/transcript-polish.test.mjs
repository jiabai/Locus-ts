import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  POLISH_CHUNK_CHARS,
  POLISH_CONTEXT_CHARS,
  POLISH_MAX_CHUNKS,
  POLISH_META_SCHEMA_VERSION,
  POLISH_SYSTEM_PROMPT,
  buildPolishPrompt,
  chunkTranscript,
  createPolishLlm,
  polishTranscriptChunks,
  polishTranscriptWithLlm,
  serializePolishMeta,
  sourceTranscriptSha256,
} from "../src/ai/index.ts";

const golden = JSON.parse(await readFile(
  new URL("./fixtures/transcript-polish-golden.json", import.meta.url), "utf8",
));

const completion = (text) => JSON.stringify({
  id: "chatcmpl-test",
  object: "chat.completion",
  created: 1,
  model: "fake-model",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }],
});

test("constants, system prompt and chunking match the Python golden byte for byte", () => {
  assert.deepEqual(
    {
      polishChunkChars: POLISH_CHUNK_CHARS,
      polishContextChars: POLISH_CONTEXT_CHARS,
      polishMaxChunks: POLISH_MAX_CHUNKS,
      polishMetaSchemaVersion: POLISH_META_SCHEMA_VERSION,
    },
    golden.constants,
  );
  assert.equal(POLISH_SYSTEM_PROMPT, golden.systemPrompt);
  assert.ok(POLISH_SYSTEM_PROMPT.includes("不得改变原意"));
  assert.ok(POLISH_SYSTEM_PROMPT.includes("禁止使用破折号和一字线"));

  for (const item of golden.chunks) {
    assert.deepEqual(
      chunkTranscript(golden.bodies[item.label], item.maxChars),
      item.expected,
      `chunk case ${item.label} @ ${item.maxChars}`,
    );
  }
  assert.deepEqual(chunkTranscript(""), []);
});

test("per-chunk prompts, source hashes and meta JSON match the Python golden", () => {
  for (const item of golden.prompts) {
    const chunks = chunkTranscript(golden.bodies[item.label], 1000);
    assert.equal(buildPolishPrompt(item.index, chunks), item.expected, `prompt ${item.label} #${item.index}`);
  }
  for (const item of golden.hashes) {
    assert.equal(sourceTranscriptSha256(golden.bodies[item.label]), item.expected, `hash ${item.label}`);
  }
  for (const item of golden.meta) {
    assert.equal(serializePolishMeta(golden.bodies[item.label]), item.expected, `meta ${item.label}`);
  }
});

test("progress events normalize attempt/total into 1..100 and keep Python's percentages", async () => {
  for (const group of golden.progress) {
    const chunks = Array.from({ length: group.chunkCount }, (_, index) => `句子${index}。`);
    const events = [];
    const result = await polishTranscriptChunks({
      chunks,
      llm: { textChat: async () => "修正后的句子。" },
      onProgress: (event) => events.push(event),
    });

    assert.equal(events.length, group.events.length, `progress count ${group.chunkCount}`);
    for (let index = 0; index < group.events.length; index += 1) {
      const expected = group.events[index];
      const event = events[index];
      assert.equal(event.message_code, "ai.generation.running");
      assert.equal(event.stage, "insights_generating");
      assert.equal(event.progress, expected.progress, `progress ${group.chunkCount} #${index}`);
      assert.deepEqual(event.message_args, { attempt: expected.attempt, total: expected.total });
    }
    assert.equal(result.emptyChunks, 0);
    assert.equal(result.text.split("\n").length, group.chunkCount);
  }
});

test("empty chunk replies fall back to the original text; all-empty means no result", async () => {
  const chunks = ["  原样句子一。  ", "原样句子二。"];
  const events = [];
  const empty = await polishTranscriptChunks({
    chunks,
    llm: { textChat: async () => "  " },
    onProgress: (event) => events.push(event),
  });
  assert.equal(empty.emptyChunks, 2);
  assert.equal(empty.text, "原样句子一。\n原样句子二。");
  assert.equal(events.length, 2);
  assert.equal(await polishTranscriptWithLlm({ chunks, llm: { textChat: async () => "" } }), "");

  const mixed = await polishTranscriptChunks({
    chunks,
    llm: { textChat: async ({ prompt }) => (prompt.includes("第 1 段") ? "修正一。" : null) },
  });
  assert.equal(mixed.emptyChunks, 1);
  assert.equal(mixed.text, "修正一。\n原样句子二。");
  assert.equal(await polishTranscriptWithLlm({
    chunks,
    llm: { textChat: async ({ prompt }) => (prompt.includes("第 1 段") ? "修正一。" : null) },
  }), "修正一。\n原样句子二。");
});

test("the polish LLM checks out once, reuses the endpoint, and omits max_tokens by default", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return { status: 200, body: completion("整理后的正文。") };
  };
  const llm = await createPolishLlm(
    {
      APP_LLM_API_KEY: "local-test-key",
      APP_LLM_MODEL: "fake-model",
      APP_LLM_BASE_URL: "http://127.0.0.1:1/v1",
    },
    { fetchImpl },
  );
  assert.equal(await llm.textChat({ systemPrompt: "S", prompt: "P1" }), "整理后的正文。");
  assert.equal(await llm.textChat({ systemPrompt: "S", prompt: "P2" }), "整理后的正文。");

  assert.equal(requests.length, 2);
  for (const [index, request] of requests.entries()) {
    assert.equal(request.url, "http://127.0.0.1:1/v1/chat/completions");
    assert.equal(request.headers.Authorization, "Bearer local-test-key");
    assert.equal(request.body.stream, false);
    assert.deepEqual(request.body.messages, [
      { role: "system", content: "S" },
      { role: "user", content: index === 0 ? "P1" : "P2" },
    ]);
    assert.equal("tools" in request.body, false);
    assert.equal("tool_choice" in request.body, false);
    assert.equal("response_format" in request.body, false);
    // 草稿 provider 默认不设输出预算，不能把 insight agent 的 8192 带过来。
    assert.equal("max_tokens" in request.body, false);
  }
});

test("an explicit APP_LLM_MAX_TOKENS is forwarded, and managed checkout happens once", async () => {
  const byokRequests = [];
  const byok = await createPolishLlm(
    {
      APP_LLM_API_KEY: "k",
      APP_LLM_MODEL: "m",
      APP_LLM_MAX_TOKENS: "4096",
    },
    {
      fetchImpl: async (_url, init) => {
        byokRequests.push(JSON.parse(init.body));
        return { status: 200, body: completion("正文。") };
      },
    },
  );
  await byok.textChat({ systemPrompt: "S", prompt: "P" });
  assert.equal(byokRequests[0].max_tokens, 4096);

  let checkouts = 0;
  const managedRequests = [];
  const managed = await createPolishLlm(
    {
      APP_LLM_SOURCE: "server",
      APP_LLM_CHECKOUT_URL: "http://127.0.0.1:1/checkout",
      APP_LLM_SESSION_TOKEN: "session",
      APP_LLM_CHECKOUT_REQUEST_ID: "seed-transcript",
    },
    {
      transport: async () => {
        checkouts += 1;
        return {
          status: 200,
          body: JSON.stringify({
            provider: "openai",
            base_url: "http://127.0.0.1:1/v1",
            model: "managed-model",
            api_key: "temporary-key",
          }),
        };
      },
      fetchImpl: async (_url, init) => {
        managedRequests.push(JSON.parse(init.body));
        return { status: 200, body: completion("正文。") };
      },
    },
  );
  assert.equal(await managed.textChat({ systemPrompt: "S", prompt: "P1" }), "正文。");
  assert.equal(await managed.textChat({ systemPrompt: "S", prompt: "P2" }), "正文。");
  assert.equal(checkouts, 1, "整次整理只 checkout 一次，24 段不能扣 24 次额度");
  assert.equal(managedRequests.length, 2);
  assert.equal(managedRequests[0].model, "managed-model");
});

test("full pipeline with an injected model produces striped, joined polished text", async () => {
  const body = "第一句。\n\n第二句。\n\n第三句。";
  const chunks = chunkTranscript(body, 11);
  const calls = [];
  const llm = {
    textChat: async ({ systemPrompt, prompt }) => {
      calls.push({ systemPrompt, prompt });
      return `整理${calls.length}。`;
    },
  };
  const result = await polishTranscriptWithLlm({ chunks, llm });
  assert.equal(calls.length, chunks.length);
  assert.equal(calls[0].systemPrompt, POLISH_SYSTEM_PROMPT);
  assert.equal(result, chunks.map((_, index) => `整理${index + 1}。`).join("\n"));
});
