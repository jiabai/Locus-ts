import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  TITLE_SAMPLE_CHARACTERS,
  TITLE_SYSTEM_PROMPT,
  TitleOutputInvalidError,
  buildTitlePrompt,
  generateNoteTitle,
  parseTitleResponse,
  sampleTranscript,
} from "../src/ai/note-title.ts";
import { buildChatRequestBody, chatCompletion } from "../src/ai/chat.ts";

const GOLDEN = new URL("./fixtures/note-title-golden.json", import.meta.url);
const ENDPOINT = {
  provider: "openai_compatible",
  baseUrl: "http://127.0.0.1:1/v1",
  model: "test-model",
  apiKey: "sk-test",
  timeoutSeconds: 15,
  maxOutputTokens: 8192,
};

async function golden() {
  return JSON.parse(await readFile(GOLDEN, "utf8"));
}

test("the title system prompt and sample budget match Python byte for byte", async () => {
  const fixture = await golden();
  assert.equal(TITLE_SYSTEM_PROMPT, fixture.systemPrompt);
  assert.equal(TITLE_SAMPLE_CHARACTERS, fixture.sampleCharacters);
  assert.throws(() => sampleTranscript("  \n "));
});

test("long transcripts are sampled at head, exact middle and tail by code point", async () => {
  const fixture = await golden();
  for (const entry of fixture.samples) {
    assert.equal(sampleTranscript(entry.body), entry.expected);
  }
  const long = fixture.samples.find((entry) => entry.body.length > TITLE_SAMPLE_CHARACTERS);
  assert.ok(long);
  const parts = long.expected.split("\n\n");
  assert.equal(parts.length, 3);
  assert.equal([...parts[0]].length, [...parts[1]].length);
  assert.equal([...parts[1]].length, [...parts[2]].length);
  assert.ok([...long.expected].length <= TITLE_SAMPLE_CHARACTERS);
  assert.throws(() => buildTitlePrompt("短稿", "fr-FR"));
});

test("title prompts render Python json.dumps spacing for all three languages", async () => {
  const fixture = await golden();
  for (const entry of fixture.prompts) {
    assert.equal(buildTitlePrompt(entry.body, entry.language), entry.expected);
  }
});

test("title responses use the same closed JSON schema and Unicode rules as Python", async () => {
  const fixture = await golden();
  for (const entry of fixture.responses) {
    if (entry.expected === null) {
      assert.throws(() => parseTitleResponse(entry.body, entry.language ?? undefined),
        TitleOutputInvalidError, `应当拒止：${entry.body.slice(0, 60)}`);
    } else {
      assert.equal(parseTitleResponse(entry.body, entry.language ?? undefined), entry.expected);
    }
  }
});

test("a title completion is a single JSON-object chat with no tools", async () => {
  const calls = [];
  const llm = {
    async chat(messages, tools, options) {
      calls.push({ messages, tools, options });
      return { text: '{"title": "理解人工智能时代的沟通能力"}', toolCalls: [] };
    },
  };
  const title = await generateNoteTitle({
    body: "今天我们聊企业 AI 落地。",
    outputLanguage: "zh-CN",
    llm,
  });
  assert.equal(title, "理解人工智能时代的沟通能力");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].tools, []);
  assert.deepEqual(calls[0].options, { responseFormat: "json_object" });
  assert.equal(calls[0].messages.length, 2);
  assert.deepEqual(calls[0].messages[0], { role: "system", content: TITLE_SYSTEM_PROMPT });
  assert.equal(calls[0].messages[1].role, "user");
  assert.ok(calls[0].messages[1].content.includes("今天我们聊企业 AI 落地。"));
});

test("response_format is added only when requested, leaving the captured golden unchanged", () => {
  const messages = [{ role: "user", content: "hi" }];
  const base = buildChatRequestBody(ENDPOINT, messages, [], 8192);
  assert.equal("response_format" in base, false);
  const withFormat = buildChatRequestBody(ENDPOINT, messages, [], 8192, "json_object");
  assert.deepEqual(withFormat.response_format, { type: "json_object" });
  assert.deepEqual({ ...withFormat, response_format: undefined },
    { ...base, response_format: undefined });
});

test("a JSON-object response_format reaches the wire unchanged", async () => {
  const captured = [];
  await chatCompletion({
    endpoint: ENDPOINT,
    messages: [{ role: "user", content: "hi" }],
    responseFormat: "json_object",
    fetchImpl: async (url, init) => {
      captured.push(JSON.parse(init.body));
      return { status: 200, body: JSON.stringify({ choices: [{ message: { content: "{}" } }] }) };
    },
  });
  assert.deepEqual(captured[0].response_format, { type: "json_object" });
  assert.equal("tools" in captured[0], false);
});
