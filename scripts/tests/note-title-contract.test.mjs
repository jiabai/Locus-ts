import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// 标题分支的跨语言守卫：提示词常量、采样预算、失败文案、错误码与进度事件
// 都在 Python 与 TypeScript 两侧各有一份用途，任何一侧单独改动都会让宿主读到
// 「看得懂但语义不同」的结果。fixture 里的逐字节 golden 由 note-title-golden.py 生成，
// worker-ts 单测把 TypeScript 输出与它对齐；这里把 fixture 再钉回 Python 源码。

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workerRoot = resolve(repositoryRoot, "worker-ts");

async function sources() {
  const [python, progress, noteTitle, pipeline, fixture, specs] = await Promise.all([
    readFile(resolve(repositoryRoot, "worker/worker_core/note_title.py"), "utf8"),
    readFile(resolve(repositoryRoot, "worker/worker_core/progress_events.py"), "utf8"),
    readFile(resolve(workerRoot, "src/ai/note-title.ts"), "utf8"),
    readFile(resolve(workerRoot, "src/pipeline/insight-retry.ts"), "utf8"),
    readFile(resolve(workerRoot, "tests/fixtures/note-title-golden.json"), "utf8"),
    readFile(resolve(workerRoot, "src/protocol/events.ts"), "utf8"),
  ]);
  return { python, progress, noteTitle, pipeline, fixture: JSON.parse(fixture), specs };
}

function pythonSystemPrompt(source) {
  const block = source.match(/_SYSTEM_PROMPT = \(([\s\S]*?)\n\)/)?.[1];
  assert.ok(block, "找不到 Python _SYSTEM_PROMPT");
  const literals = [...block.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)];
  assert.ok(literals.length >= 5, "系统提示词的字面量数量异常");
  return literals.map((match) => {
    const value = match[1] ?? match[2];
    assert.ok(!value.includes("\\"), "本守卫不处理带转义的系统提示词字面量");
    return value;
  }).join("");
}

test("the title system prompt and sample budget are pinned to the Python source", async () => {
  const { python, noteTitle, fixture } = await sources();
  assert.equal(fixture.systemPrompt, pythonSystemPrompt(python));
  const budget = Number(python.match(/TITLE_SAMPLE_CHARACTERS = (\d+)/)?.[1]);
  assert.ok(Number.isInteger(budget));
  assert.equal(fixture.sampleCharacters, budget);
  assert.equal(Number(noteTitle.match(/export const TITLE_SAMPLE_CHARACTERS = (\d+)/)?.[1]), budget);
});

test("the title failure message, stage and error codes match the Python branch", async () => {
  const { python, pipeline, noteTitle } = await sources();
  const message = python.match(/"(The note title could not be generated or saved\.)"/)?.[1];
  assert.ok(message, "找不到 Python 标题失败文案");
  assert.ok(pipeline.includes(`TITLE_FAILURE_MESSAGE = '${message}'`));
  assert.ok(python.includes("JobStage.TITLE_GENERATING"));
  assert.ok(pipeline.includes("TITLE_STAGE = 'title_generating'"));

  const typescript = pipeline + noteTitle;
  for (const code of [
    "TITLE_OUTPUT_INVALID", "TITLE_GENERATION_FAILED",
    "TITLE_TRANSCRIPT_UNAVAILABLE", "TITLE_SAVE_FAILED",
  ]) {
    assert.ok(python.includes(code), `Python 侧缺少 ${code}`);
    assert.ok(typescript.includes(code), `TypeScript 侧缺少 ${code}`);
  }
});

test("both title progress events exist in the Python registry and the worker renderer", async () => {
  const { progress, specs } = await sources();
  for (const code of ["title.generation.running", "title.generation.completed"]) {
    assert.ok(progress.includes(`"${code}": WorkerProgressSpec()`), `Python 注册表缺少 ${code}`);
    assert.ok(specs.includes(`'${code}': {allowedArgs: []}`), `TypeScript 事件表缺少 ${code}`);
  }
  assert.ok(progress.includes('"title_generating"'));
  assert.ok(specs.includes("'title_generating'"));
});

test("the title target is registered as implemented and keeps its closed request shape", async () => {
  const { fixture, noteTitle } = await sources();
  const retry = await readFile(resolve(workerRoot, "src/protocol/retry-request.ts"), "utf8");
  const implemented = retry.match(/export const IMPLEMENTED_RETRY_TARGETS: readonly RetryTarget\[\] = ([^;]+);/)?.[1];
  assert.equal(implemented?.trim(), "RETRY_TARGETS", "六个 target 全部实现时直接复用契约闭集");
  assert.ok(retry.includes("'title'"));
  assert.ok(retry.includes("TITLE_REQUEST_FIELDS"));
  assert.ok(noteTitle.includes("responseFormat: 'json_object'"));
  assert.ok(fixture.responses.some((entry) => entry.body.includes('"title":"a","title":"b"')),
    "重复键反例必须留在 golden 里");
});
