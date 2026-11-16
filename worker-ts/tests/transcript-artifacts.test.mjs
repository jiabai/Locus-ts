import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { EOL, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeTranscriptFiles } from "../src/artifacts/transcript-artifacts.ts";

// 产物文件名、Markdown 结构、平台换行与「没有分段就删旧文件」都要与 Python 侧一致，
// 否则同一任务在两侧会产出不同文件，迁移时用户会看到内容变了。

async function makeRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "locus-transcript-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const SEGMENTS = [
  { id: "seg-0001", start_ms: 0, end_ms: 1500, text: "第一段" },
  { id: "seg-0002", start_ms: 1500, end_ms: 3200, text: "第二段" },
];

test("the standard transcript directory goes through the multi-file transaction", async (t) => {
  const root = await makeRoot(t);
  const taskDir = join(root, "task-1");
  const transcriptDir = join(taskDir, "transcript");
  await mkdir(transcriptDir, { recursive: true });
  await writeFile(join(taskDir, "task.json"), '{"status":"old"}\n');

  const artifacts = await writeTranscriptFiles({
    text: "  正文第一段 第二段  ",
    outputDir: transcriptDir,
    outputStem: "",
    metadata: { source: "asr", language: null, engine: "iic/SenseVoiceSmall-onnx", canonicalSourceUrl: "https://example.com/v" },
    segments: SEGMENTS,
  });

  assert.equal(artifacts.text, "正文第一段 第二段");
  assert.equal(artifacts.txtPath, join(transcriptDir, "transcript.txt"));
  assert.equal(artifacts.segmentsPath, join(transcriptDir, "segments.json"));

  assert.equal(await readFile(artifacts.txtPath, "utf8"), `正文第一段 第二段${EOL}`);
  assert.equal(
    await readFile(artifacts.mdPath, "utf8"),
    [
      "# 视频文字稿",
      "",
      "## Metadata",
      "",
      "- Transcript Source: Local ASR",
      "- ASR Engine: iic/SenseVoiceSmall-onnx",
      "- Model: iic/SenseVoiceSmall-onnx",
      "- Source URL: https://example.com/v",
      "",
      "## Transcript",
      "",
      "正文第一段 第二段",
      "",
    ].join(EOL),
  );

  const segments = JSON.parse(await readFile(artifacts.segmentsPath, "utf8"));
  assert.deepEqual(segments, { segments: SEGMENTS });

  // 事务提交完之后不能留下 journal 或材料，任务清单也不能被这份写入顺手改掉。
  assert.deepEqual((await readdir(taskDir)).sort(), ["task.json", "transcript"]);
  assert.equal(await readFile(join(taskDir, "task.json"), "utf8"), '{"status":"old"}\n');
});

test("without segments the stale segments file is removed", async (t) => {
  const root = await makeRoot(t);
  const transcriptDir = join(root, "task-1", "transcript");
  await mkdir(transcriptDir, { recursive: true });
  await writeFile(join(transcriptDir, "segments.json"), '{"segments":[{"id":"old"}]}\n');

  const artifacts = await writeTranscriptFiles({
    text: "只有正文",
    outputDir: transcriptDir,
    outputStem: "",
    metadata: { source: "asr", language: null, engine: "iic/SenseVoiceSmall-onnx", canonicalSourceUrl: null },
  });

  assert.equal(artifacts.segmentsPath, null);
  await assert.rejects(() => readFile(join(transcriptDir, "segments.json")));
  assert.equal(await readFile(artifacts.txtPath, "utf8"), `只有正文${EOL}`);
});

test("an empty transcript is refused instead of writing an empty file", async (t) => {
  const root = await makeRoot(t);
  const transcriptDir = join(root, "task-1", "transcript");
  await mkdir(transcriptDir, { recursive: true });

  await assert.rejects(
    () => writeTranscriptFiles({ text: "   \n\t ", outputDir: transcriptDir, outputStem: "" }),
    (error) => {
      assert.equal(error.code, "ASR_EMPTY_TRANSCRIPT");
      return true;
    },
  );
  assert.deepEqual(await readdir(transcriptDir), []);
});

test("a prefixed output stem writes its own file names", async (t) => {
  const root = await makeRoot(t);
  const outputDir = join(root, "export");
  await mkdir(outputDir, { recursive: true });

  const artifacts = await writeTranscriptFiles({
    text: "导出正文",
    outputDir,
    outputStem: "demo",
    segments: SEGMENTS,
  });

  assert.equal(artifacts.txtPath, join(outputDir, "demo_transcript.txt"));
  assert.equal(artifacts.mdPath, join(outputDir, "demo_transcript.md"));
  assert.equal(artifacts.segmentsPath, join(outputDir, "demo_transcript_segments.json"));
  assert.deepEqual((await readdir(outputDir)).sort(), [
    "demo_transcript.md",
    "demo_transcript.txt",
    "demo_transcript_segments.json",
  ]);
  // 没有显式元数据时按本地识别写，且不编造引擎名。
  assert.match(await readFile(artifacts.mdPath, "utf8"), /- Transcript Source: Local ASR/);
});

test("subtitle transcripts record the platform language instead of an engine", async (t) => {
  const root = await makeRoot(t);
  const outputDir = join(root, "subtitle");
  await mkdir(outputDir, { recursive: true });

  const artifacts = await writeTranscriptFiles({
    text: "字幕正文",
    outputDir,
    outputStem: "",
    metadata: { source: "subtitle", language: "zh-CN", engine: null, canonicalSourceUrl: null },
  });

  const markdown = await readFile(artifacts.mdPath, "utf8");
  assert.match(markdown, /- Transcript Source: Platform subtitle/);
  assert.match(markdown, /- Subtitle Language: zh-CN/);
  assert.doesNotMatch(markdown, /ASR Engine/);
});
