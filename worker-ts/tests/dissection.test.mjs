import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildDissectionArtifacts,
  dissectionToDict,
  formatDissectionMarkdown,
  parseDissectionReport,
  parsePersistedDissection,
  DissectionGenerationError,
} from "../src/ai/dissection-report.ts";
import { buildDissectionAgentPrompt } from "../src/ai/prompts.ts";
import { MarkdownSplitter } from "../src/ai/transcript-chunks.ts";

const golden = JSON.parse(await readFile(
  new URL("./fixtures/dissection-golden.json", import.meta.url), "utf8",
));

const chunksFor = (transcript, maxLength) => new MarkdownSplitter(maxLength).split(transcript);

test("all six dissection prompts match the Python rendering byte for byte", () => {
  for (const item of golden.prompts) {
    const chunks = chunksFor(golden.promptBody, 8);
    assert.deepEqual(chunks.map((chunk) => ({ id: chunk.id, content: chunk.content })), item.chunks);
    assert.equal(
      buildDissectionAgentPrompt(chunks, item.language, item.sourceKind),
      item.expected,
      `prompt ${item.language} / ${item.sourceKind}`,
    );
  }
  const prompt = buildDissectionAgentPrompt(chunksFor(golden.promptBody, 8), "en-US");
  for (const fragment of [
    "submit_dissection", "character-for-character", "3 through 7",
    '"high" | "medium" | "low"', "global inapplicability",
  ]) {
    assert.ok(prompt.includes(fragment), fragment);
  }
});

test("report validation accepts the same payloads and produces identical provenance", () => {
  for (const item of golden.reports) {
    const options = {
      payload: item.payload,
      transcript: item.transcript,
      chunks: chunksFor(item.transcript, 2000),
      sourceLanguage: item.sourceLanguage,
    };
    if (item.expected !== null) {
      const report = parseDissectionReport(options);
      assert.deepEqual(dissectionToDict(report), item.expected, `report ${item.label}`);
    } else {
      assert.throws(
        () => parseDissectionReport(options),
        (error) => {
          assert.ok(error instanceof DissectionGenerationError, `report ${item.label} 的错误类型`);
          assert.equal(error.code, item.errorCode);
          assert.equal(error.validationCategory, item.validationCategory, `report ${item.label}`);
          return true;
        },
        `report ${item.label} 必须被拒止`,
      );
    }
  }
});

test("artifact JSON, Markdown and platform line endings match the Python bytes", () => {
  for (const item of golden.artifacts) {
    const report = parseDissectionReport({
      payload: item.payload,
      transcript: item.transcript,
      chunks: chunksFor(item.transcript, 2000),
      sourceLanguage: item.sourceLanguage,
    });
    assert.equal(formatDissectionMarkdown(report, item.language), item.markdownLf,
      `markdown LF ${item.transcript.length} / ${item.language}`);
    const built = buildDissectionArtifacts(report, item.language);
    assert.equal(Buffer.from(built.jsonBytes).toString("utf8"), item.jsonText,
      `json bytes ${item.transcript.length} / ${item.language}`);
    assert.equal(Buffer.from(built.markdownBytes).toString("utf8"), item.markdownText,
      `markdown bytes ${item.transcript.length} / ${item.language}`);
  }
});

test("persisted reports are accepted only when provenance still matches the current transcript", () => {
  for (const item of golden.persisted) {
    const options = { payload: item.payload, transcript: item.transcript };
    if (item.expected !== null) {
      assert.deepEqual(parsePersistedDissection(options), item.expected, `persisted ${item.label}`);
    } else {
      assert.throws(
        () => parsePersistedDissection(options),
        (error) => {
          assert.ok(error instanceof DissectionGenerationError);
          assert.equal(error.code, item.errorCode, `persisted ${item.label}`);
          return true;
        },
        `persisted ${item.label} 必须被拒止`,
      );
    }
  }
});

test("reordered object keys still compare equal, and article provenance stays separate", () => {
  const valid = golden.persisted.find((item) => item.label === "valid");
  const reordered = {
    weaknesses: valid.payload.weaknesses,
    strengths: valid.payload.strengths,
    ...valid.payload,
  };
  assert.deepEqual(parsePersistedDissection({ payload: reordered, transcript: valid.transcript }), valid.expected);

  const semanticKeys = [
    "overallNarrative", "segments", "highlights", "reusableTemplate",
    "audienceFit", "strengths", "weaknesses",
  ];
  const semantic = Object.fromEntries(semanticKeys.map((key) => [key, valid.payload[key]]));
  const article = parseDissectionReport({
    payload: semantic,
    transcript: valid.transcript,
    chunks: chunksFor(valid.transcript, 2000),
    sourceLanguage: "zh-CN",
    sourceKind: "article",
  });
  const dict = dissectionToDict(article);
  assert.equal(dict.schemaVersion, 2);
  assert.equal(dict.sourceKind, "article");
  assert.equal("sourceTranscriptSha256" in dict, false);
  assert.ok(formatDissectionMarkdown(article, "en-US").startsWith("# Article Dissection"));
});
