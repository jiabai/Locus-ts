import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// 整理稿分支的跨语言守卫：系统提示词、切块预算、七条失败文案、进度事件与产物路径
// 在 Python 与 TypeScript 两侧各有一份。fixture 由 transcript-polish-golden.py 从 Python
// 生产源码生成，worker-ts 单测把 TypeScript 输出与它逐字节对齐；这里把 fixture 再钉回
// Python 源码，避免「改了 Python 却忘了重新生成 golden」被单测放过。

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workerRoot = resolve(repositoryRoot, "worker-ts");

async function sources() {
  const [python, retry, registry, polish, step, pipeline, events, fixture, closedSet, targets, paths] = await Promise.all([
    readFile(resolve(repositoryRoot, "worker/worker_core/transcript_polish.py"), "utf8"),
    readFile(resolve(repositoryRoot, "worker/worker_core/worker_application/insight_retry.py"), "utf8"),
    readFile(resolve(repositoryRoot, "worker/worker_core/progress_events.py"), "utf8"),
    readFile(resolve(workerRoot, "src/ai/transcript-polish.ts"), "utf8"),
    readFile(resolve(workerRoot, "src/pipeline/transcript-polish-step.ts"), "utf8"),
    readFile(resolve(workerRoot, "src/pipeline/insight-retry.ts"), "utf8"),
    readFile(resolve(workerRoot, "src/protocol/events.ts"), "utf8"),
    readFile(resolve(workerRoot, "tests/fixtures/transcript-polish-golden.json"), "utf8"),
    readFile(resolve(repositoryRoot, "contracts/task-artifact-transaction-v1.json"), "utf8"),
    readFile(resolve(workerRoot, "src/protocol/retry-request.ts"), "utf8"),
    readFile(resolve(workerRoot, "src/tasks/paths.ts"), "utf8"),
  ]);
  return {
    python, retry, registry, polish, step, pipeline, events, paths,
    fixture: JSON.parse(fixture), closedSet: JSON.parse(closedSet), targets,
  };
}

function pythonSystemPrompt(source) {
  const block = source.match(/POLISH_SYSTEM_PROMPT = \(([\s\S]*?)\n\)/)?.[1];
  assert.ok(block, "找不到 Python POLISH_SYSTEM_PROMPT");
  const literals = [...block.matchAll(/"((?:[^"\\]|\\.)*)"/g)];
  assert.ok(literals.length >= 8, "系统提示词的字面量数量异常");
  return literals.map((match) => {
    assert.ok(!match[1].includes("\\"), "本守卫不处理带转义的系统提示词字面量");
    return match[1];
  }).join("");
}

test("the polish system prompt and constants are pinned to the Python source", async () => {
  const { python, polish, fixture } = await sources();
  assert.equal(fixture.systemPrompt, pythonSystemPrompt(python));
  assert.ok(polish.includes("POLISH_SYSTEM_PROMPT = '"), "TS 系统提示词必须是单个字面量拼接");

  const expected = {
    polishChunkChars: Number(python.match(/POLISH_CHUNK_CHARS = (\d+)/)?.[1]),
    polishContextChars: Number(python.match(/POLISH_CONTEXT_CHARS = (\d+)/)?.[1]),
    polishMaxChunks: Number(python.match(/POLISH_MAX_CHUNKS = (\d+)/)?.[1]),
    polishMetaSchemaVersion: Number(python.match(/POLISH_META_SCHEMA_VERSION = (\d+)/)?.[1]),
  };
  for (const [key, value] of Object.entries(expected)) assert.ok(Number.isInteger(value), `${key} 缺失`);
  assert.deepEqual(fixture.constants, expected);
  for (const [constant, key] of [
    ["POLISH_CHUNK_CHARS", "polishChunkChars"],
    ["POLISH_CONTEXT_CHARS", "polishContextChars"],
    ["POLISH_MAX_CHUNKS", "polishMaxChunks"],
    ["POLISH_META_SCHEMA_VERSION", "polishMetaSchemaVersion"],
  ]) {
    assert.equal(Number(polish.match(new RegExp(`export const ${constant} = (\\d+);`))?.[1]),
      expected[key], `TypeScript ${constant} 与 Python 不一致`);
  }
});

test("all seven polish failure codes and messages are identical on both sides", async () => {
  const { python, step, polish } = await sources();
  const cases = [
    ["TRANSCRIPT_TEXT_PATH_INVALID", "Official transcript.txt is required for transcript polishing."],
    ["TRANSCRIPT_TEXT_NOT_FOUND", "Official transcript text could not be read."],
    ["POLISH_EMPTY_TRANSCRIPT", "Official transcript text is empty."],
    ["POLISH_LLM_EMPTY_RESULT", "Transcript polishing returned an empty result."],
    ["POLISH_ARTIFACT_WRITE_FAILED", "Polished transcript could not be stored safely."],
    ["POLISH_FAILED", null],
    ["POLISH_TRANSCRIPT_TOO_LONG", null],
  ];
  for (const [code, message] of cases) {
    assert.ok(python.includes(`"${code}"`), `Python 缺少 ${code}`);
    assert.ok(step.includes(`'${code}'`), `TypeScript 缺少 ${code}`);
    if (message !== null) {
      assert.ok(python.includes(`"${message}"`), `Python 缺少 ${code} 的文案`);
      assert.ok(step.includes(`= '${message}'`), `TypeScript 缺少 ${code} 的文案`);
    }
  }
  assert.ok(python.includes("f\"Transcript needs more than {POLISH_MAX_CHUNKS} polish chunks.\""));
  assert.ok(step.includes("`Transcript needs more than ${POLISH_MAX_CHUNKS} polish chunks.`"));
  assert.ok(python.includes("JobStage.INSIGHTS_GENERATING"));
  assert.ok(step.includes("const STAGE = 'insights_generating'"));
  // 超长稿必须在任何模型调用之前被挡下，否则会白扣额度。
  assert.ok(python.includes("if len(chunks) > POLISH_MAX_CHUNKS:"));
  assert.ok(step.includes("if (chunks.length > POLISH_MAX_CHUNKS)"));
  assert.ok(polish.includes("MarkdownSplitter"));
});

test("the two polished artifacts stay outside the transaction closed set on both sides", async () => {
  const { python, step, closedSet, paths } = await sources();
  for (const name of ["polished.txt", "polished.meta.json"]) {
    assert.ok(python.includes(name), `Python 缺少 ${name}`);
    assert.ok(paths.includes(name), `TypeScript 任务路径缺少 ${name}`);
    assert.equal(closedSet.allowedDestinations.some((entry) => entry.includes(name)), false,
      `${name} 不应进事务闭集`);
  }
  assert.ok(python.includes('"schemaVersion": POLISH_META_SCHEMA_VERSION'));
  assert.ok(python.includes('source_transcript_sha256(body)'));
  assert.ok(step.includes("serializePolishMeta(body)"));
});

test("ai.generation.running is emitted with the normalized attempt/total on both sides", async () => {
  const { python, registry, polish, events } = await sources();
  assert.ok(python.includes('"ai.generation.running"'));
  assert.ok(python.includes("attempt_for(index)"));
  assert.ok(registry.includes('"ai.generation.running": WorkerProgressSpec(("attempt", "total"))'));
  assert.ok(events.includes("'ai.generation.running': {allowedArgs: ['attempt', 'total']}"));
  assert.ok(python.includes("70 + ((index * 20) // len(chunks))"));
  assert.ok(python.includes("max(1, min(100, chunk_count))"));
  assert.ok(polish.includes("70 + Math.floor((index * 20) / chunks.length)"));
  assert.ok(polish.includes("Math.max(1, Math.min(100, chunks.length))"));
});

test("the transcript target is wired into both retry entry points", async () => {
  const { retry, pipeline, targets, polish } = await sources();
  assert.ok(retry.includes('if request.target == "transcript":'));
  assert.ok(retry.includes("run_transcript_polish_step("));
  assert.ok(pipeline.includes("if (request.target === 'transcript')"));
  assert.ok(pipeline.includes("runTranscriptRetry("));
  const implemented = targets.match(/export const IMPLEMENTED_RETRY_TARGETS: readonly RetryTarget\[\] = ([^;]+);/)?.[1];
  assert.equal(implemented?.trim(), "RETRY_TARGETS", "六个 target 全部实现时直接复用契约闭集");
  assert.ok(targets.includes("'transcript'"));
  assert.ok(pipeline.includes("insightTargetEnv(environ, 'transcript')"));
  // 托管 checkout 只做一次：不能复用「每次 chat 都换凭证」的 insight provider。
  assert.ok(polish.includes("callIndex: 1"));
  assert.ok(polish.includes("omitMaxTokens"));
});
