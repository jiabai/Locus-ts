import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runToolLoop } from "../src/ai/tool-loop.ts";
import {
  DISSECTION_AGENT_MAX_TURNS,
  MAX_DISSECTION_CHUNKS,
  SUBMIT_DISSECTION_TOOL_SPEC,
  generateDissection,
} from "../src/ai/dissection-agent.ts";
import {
  DissectionGenerationError,
  dissectionRejectionFeedback,
  dissectionToDict,
  parseDissectionReport,
} from "../src/ai/dissection-report.ts";
import { MarkdownSplitter } from "../src/ai/transcript-chunks.ts";

const golden = JSON.parse(await readFile(
  new URL("./fixtures/dissection-golden.json", import.meta.url), "utf8",
));

const TRANSCRIPT = "第一段🙂。\r\n第二段。\r\n";
const VALID = golden.reports.find((item) => item.label === "valid-short").payload;

function toolCall(id, report) {
  return {
    text: null,
    toolCalls: [{ id, name: "submit_dissection", arguments: JSON.stringify({ report }) }],
  };
}

function scriptedRuntime(replies) {
  const calls = [];
  return {
    calls,
    async complete(options) {
      return runToolLoop({
        ...options,
        chat: async (messages, tools) => {
          calls.push({
            messages: structuredClone(messages),
            toolNames: tools.map((tool) => tool.name),
          });
          const reply = replies.shift();
          if (reply === undefined) throw new Error("模型回复用完了");
          return reply;
        },
      });
    },
  };
}

function options(overrides = {}) {
  return {
    transcript: TRANSCRIPT,
    outputLanguage: "zh-CN",
    sourceLanguage: "zh-CN",
    llm: scriptedRuntime([toolCall("call-1", VALID)]),
    ...overrides,
  };
}

test("a valid delivery produces worker-owned provenance and one progress event", async () => {
  assert.equal(DISSECTION_AGENT_MAX_TURNS, 6);
  assert.equal(MAX_DISSECTION_CHUNKS, 16);
  const events = [];
  const runtime = scriptedRuntime([toolCall("call-1", VALID)]);
  const report = await generateDissection(options({
    llm: runtime,
    onProgress: (event) => events.push(event),
  }));

  assert.deepEqual(dissectionToDict(report), golden.reports[0].expected);
  assert.equal(runtime.calls.length, 1);
  assert.deepEqual(runtime.calls[0].toolNames, ["submit_dissection"]);
  assert.equal(runtime.calls[0].messages.length, 2);
  assert.equal(runtime.calls[0].messages[0].role, "system");
  assert.ok(runtime.calls[0].messages[0].content.includes("submit_dissection"));
  assert.ok(runtime.calls[0].messages[1].content.includes("Legal sourceChunkIds: [1]"));
  assert.deepEqual(events, [{
    stage: "insights_generating", progress: 70,
    message_code: "ai.generation.running", message_args: { attempt: 1, total: 6 },
  }]);
});

test("the tool schema is closed and carries the seven required report keys", () => {
  const parameters = SUBMIT_DISSECTION_TOOL_SPEC.parameters;
  assert.equal(SUBMIT_DISSECTION_TOOL_SPEC.name, "submit_dissection");
  assert.deepEqual(parameters.required, ["report"]);
  assert.equal(parameters.additionalProperties, false);
  assert.deepEqual(parameters.properties.report.required, [
    "overallNarrative", "segments", "highlights", "reusableTemplate",
    "audienceFit", "strengths", "weaknesses",
  ]);
  assert.equal(parameters.properties.report.additionalProperties, false);
});

test("validation feedback names the category and the model can resubmit", async () => {
  const bad = structuredClone(VALID);
  bad.highlights = ["Invented quotation"];
  const events = [];
  const runtime = scriptedRuntime([
    toolCall("call-1", bad),
    toolCall("call-2", VALID),
  ]);
  const result = await generateDissection(options({
    llm: runtime,
    onProgress: (event) => events.push(event),
  }));

  assert.deepEqual(dissectionToDict(result), golden.reports[0].expected);
  assert.equal(runtime.calls.length, 2);
  const feedback = runtime.calls[1].messages.at(-1);
  assert.equal(feedback.role, "tool");
  assert.ok(feedback.content.includes("quotation_provenance"), feedback.content);
  assert.equal(
    feedback.content,
    dissectionRejectionFeedback(new DissectionGenerationError(
      "DISSECTION_INVALID_RESULT", "unused", "quotation_provenance",
    )),
  );
  assert.deepEqual(events.map((event) => event.message_args.attempt), [1, 2]);
  assert.deepEqual(events.map((event) => event.progress), [70, 73]);
});

test("plain text replies are nudged back to the tool and six turns end in a stable error", async () => {
  const events = [];
  const runtime = scriptedRuntime(
    Array.from({ length: 6 }, (_, index) => ({ text: `还没交 ${index}`, toolCalls: [] })),
  );
  await assert.rejects(
    () => generateDissection(options({ llm: runtime, onProgress: (event) => events.push(event) })),
    (error) => {
      assert.ok(error instanceof DissectionGenerationError);
      assert.equal(error.code, "DISSECTION_INVALID_RESULT");
      assert.equal(error.message,
        "The transcript dissection agent did not deliver a valid report within its budget.");
      return true;
    },
  );
  assert.equal(runtime.calls.length, 6);
  assert.ok(runtime.calls[1].messages.at(-1).content.includes("submit_dissection"));
  assert.equal(events.length, 6);
  assert.ok(events.every((event) => event.message_args.attempt <= event.message_args.total));
});

test("empty, oversized and invalid inputs fail before any model request", async () => {
  const runtime = scriptedRuntime([]);
  await assert.rejects(
    () => generateDissection(options({ transcript: "  \n", llm: runtime })),
    (error) => {
      assert.equal(error.code, "DISSECTION_EMPTY_TRANSCRIPT");
      assert.equal(error.message, "The saved transcript is empty.");
      return true;
    },
  );
  await assert.rejects(
    () => generateDissection(options({ transcript: "x".repeat(32001), llm: runtime })),
    (error) => {
      assert.equal(error.code, "DISSECTION_TRANSCRIPT_TOO_LARGE");
      return true;
    },
  );
  assert.equal(new MarkdownSplitter().split("x".repeat(32000)).length, 16);
  await assert.rejects(
    () => generateDissection(options({ maxTurns: 7, llm: runtime })),
    (error) => error instanceof Error && !("code" in error),
  );
  await assert.rejects(
    () => generateDissection(options({ outputLanguage: "fr-FR", llm: runtime })),
    Error,
  );
  assert.equal(runtime.calls.length, 0);
});

test("report provenance is derived from the untrimmed transcript", async () => {
  const body = `  ${TRANSCRIPT}  `;
  const report = await generateDissection(options({
    transcript: body,
    llm: scriptedRuntime([toolCall("call-1", VALID)]),
  }));
  const expected = parseDissectionReport({
    payload: VALID,
    transcript: body,
    chunks: new MarkdownSplitter().split(body),
    sourceLanguage: "zh-CN",
  });
  assert.deepEqual(dissectionToDict(report), dissectionToDict(expected));
});
