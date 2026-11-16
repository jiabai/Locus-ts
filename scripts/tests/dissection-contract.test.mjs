import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// 文字稿解剖的跨语言守卫：轮数与切块上限、系统提示词、工具反馈、七个错误码、
// 三语标签、来源摘要字段与产物路径在 Python 与 TypeScript 两侧各有一份。
// fixture 由 dissection-golden.py 从 Python 生产源码生成，worker-ts 单测把 TypeScript
// 输出与它逐字节比对；这里把 fixture 再钉回 Python 源码与线协议契约。

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workerRoot = resolve(repositoryRoot, "worker-ts");

async function sources() {
  const [
    agent, report, prompts, pipelineStep, retryEntry, dissectionStep,
    tsAgent, tsReport, tsPrompts, tsPipeline, tsToolLoop, targets, fixtureText, closedSet,
  ] = await Promise.all([
    readFile(resolve(repositoryRoot, "worker/worker_core/dissection_agent.py"), "utf8"),
    readFile(resolve(repositoryRoot, "worker/worker_core/dissection_report.py"), "utf8"),
    readFile(resolve(repositoryRoot, "worker/worker_core/ai_prompts.py"), "utf8"),
    readFile(resolve(repositoryRoot, "worker/worker_core/pipeline_runtime/insights.py"), "utf8"),
    readFile(resolve(repositoryRoot, "worker/worker_core/worker_application/insight_retry.py"), "utf8"),
    readFile(resolve(repositoryRoot, "worker/worker_core/pipeline_runtime/dissection.py"), "utf8"),
    readFile(resolve(workerRoot, "src/ai/dissection-agent.ts"), "utf8"),
    readFile(resolve(workerRoot, "src/ai/dissection-report.ts"), "utf8"),
    readFile(resolve(workerRoot, "src/ai/prompts.ts"), "utf8"),
    readFile(resolve(workerRoot, "src/pipeline/insight-retry.ts"), "utf8"),
    readFile(resolve(workerRoot, "src/ai/tool-loop.ts"), "utf8"),
    readFile(resolve(workerRoot, "src/protocol/retry-request.ts"), "utf8"),
    readFile(resolve(workerRoot, "tests/fixtures/dissection-golden.json"), "utf8"),
    readFile(resolve(repositoryRoot, "contracts/task-artifact-transaction-v1.json"), "utf8"),
  ]);
  return {
    agent, report, prompts, pipelineStep, retryEntry, dissectionStep,
    tsAgent, tsReport, tsPrompts, tsPipeline, tsToolLoop, targets,
    fixture: JSON.parse(fixtureText), closedSet: JSON.parse(closedSet),
  };
}

test("turn budget, chunk limit and the system prompt are pinned to the Python source", async () => {
  const { agent, prompts, tsAgent, tsPrompts, fixture } = await sources();
  assert.equal(Number(agent.match(/DISSECTION_AGENT_MAX_TURNS = (\d+)/)?.[1]), 6);
  assert.equal(Number(agent.match(/MAX_DISSECTION_CHUNKS = (\d+)/)?.[1]), 16);
  assert.equal(Number(tsAgent.match(/export const DISSECTION_AGENT_MAX_TURNS = (\d+);/)?.[1]), 6);
  assert.equal(Number(tsAgent.match(/export const MAX_DISSECTION_CHUNKS = (\d+);/)?.[1]), 16);

  const pySystem = agent.match(/system_prompt=\(([\s\S]*?)\n\s*\),/)?.[1];
  assert.ok(pySystem, "找不到 Python 解剖系统提示词");
  const pyText = [...pySystem.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]).join("");
  const tsBlock = tsAgent.match(/const DISSECTION_SYSTEM_PROMPT = ([\s\S]*?);\n\n/)?.[1];
  assert.ok(tsBlock, "找不到 TypeScript 解剖系统提示词");
  const tsText = [...tsBlock.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((match) => match[1]).join("");
  assert.equal(tsText, pyText);

  for (const item of fixture.prompts) {
    assert.ok(item.expected.includes("# "), "golden 提示词必须有标题行");
    assert.ok(item.expected.includes("submit_dissection"));
  }
  assert.equal(fixture.prompts.length, 6);
  assert.ok(prompts.includes("_DISSECTION_SCHEMA_EXAMPLE"));
  assert.ok(tsPrompts.includes("DISSECTION_SCHEMA_EXAMPLE"));
  assert.ok(prompts.includes("def build_dissection_agent_prompt"));
  assert.ok(tsPrompts.includes("export function buildDissectionAgentPrompt"));
});

test("tool feedback, nudge and all three dissection error codes match", async () => {
  const { agent, tsAgent, tsReport, report } = await sources();
  for (const code of [
    "DISSECTION_EMPTY_TRANSCRIPT", "DISSECTION_TRANSCRIPT_TOO_LARGE", "DISSECTION_INVALID_RESULT",
  ]) {
    assert.ok(agent.includes(code) || report.includes(code), `Python 缺少 ${code}`);
    assert.ok(tsAgent.includes(`'${code}'`), `TypeScript agent 缺少 ${code}`);
  }
  for (const fragment of [
    "Report rejected. Validation category:",
    "Submit the complete",
    "valid sourceChunkIds and ",
    "verbatim transcript quotations",
    "Use only supplied transcript evidence.",
  ]) {
    assert.ok(agent.includes(fragment), `Python 反馈文案缺少「${fragment}」`);
    assert.ok(tsReport.includes(fragment), `TypeScript 反馈文案缺少「${fragment}」`);
  }
  assert.ok(agent.includes("Delivery is incomplete. Call submit_dissection with the complete report."));
  assert.ok(tsAgent.includes("'Delivery is incomplete. Call submit_dissection with the complete report.'"));
  for (const category of [
    "schema_shape", "source_references", "quotation_provenance",
    "collection_limits", "enum_values",
  ]) {
    assert.ok(report.includes(`"${category}"`), `Python 缺少 category ${category}`);
    assert.ok(tsReport.includes(`'${category}'`) || tsReport.includes(`"${category}"`),
      `TypeScript 缺少 category ${category}`);
  }
});

test("progress events use the same formula, and the tool loop exposes the request hook", async () => {
  const { agent, tsAgent, tsToolLoop } = await sources();
  assert.ok(agent.includes('build_worker_progress_event('));
  assert.ok(agent.includes('"ai.generation.running"'));
  assert.ok(agent.includes("70 + ((self._attempt - 1) * 20 // self._max_turns)"));
  assert.ok(tsAgent.includes("70 + Math.floor(((attempt - 1) * 20) / maxTurns)"));
  assert.ok(tsAgent.includes("onChatRequest:"));
  assert.ok(tsToolLoop.includes("await options.onChatRequest?.({messages, tools});"));
  assert.ok(tsToolLoop.includes("readonly onChatRequest?: (event: {"));
});

test("report provenance, three-language labels and artifact destinations match", async () => {
  const { report, retryEntry, dissectionStep, tsReport, pipelineStep, closedSet, tsPipeline } = await sources();
  for (const key of [
    "schemaVersion", "sourceTranscriptSha256", "sourceLanguage", "sourceChunks",
    "overallNarrative", "segments", "highlights", "reusableTemplate",
    "audienceFit", "strengths", "weaknesses",
  ]) {
    assert.ok(report.includes(`"${key}"`), `Python 报告缺少 ${key}`);
    assert.ok(tsReport.includes(key), `TypeScript 报告缺少 ${key}`);
  }
  for (const label of ["文字稿解剖", "逐字稿解剖", "Transcript Dissection", "整體敘事", "Reusable template"]) {
    assert.ok(report.includes(`"${label}"`), `Python 标签表缺少 ${label}`);
    assert.ok(tsReport.includes(`'${label}'`), `TypeScript 标签表缺少 ${label}`);
  }
  assert.ok(report.includes("def parse_persisted_dissection"));
  assert.ok(retryEntry.includes("parse_persisted_dissection("));
  assert.ok(retryEntry.includes("def read_existing_dissection"));
  assert.ok(tsReport.includes("export function parsePersistedDissection"));
  assert.ok(tsPipeline.includes(
    "parsePersistedDissection({payload: parsed, transcript, sourceKind})",
  ));

  for (const destination of ["ai/dissection.json", "ai/dissection.md"]) {
    assert.ok(closedSet.allowedDestinations.includes(destination), `事务闭集缺少 ${destination}`);
    assert.ok(pipelineStep.includes(`"${destination}"`), `Python 生成步骤缺少 ${destination}`);
    assert.ok(tsPipeline.includes(destination) || tsReport.includes(destination),
      `TypeScript 缺少 ${destination}`);
  }
  assert.ok(dissectionStep.includes("build_dissection_artifacts"));
  assert.ok(dissectionStep.includes("def run_dissection_generation"));
});

test("dissection is registered among all six implemented targets", async () => {
  const { targets, tsPipeline, pipelineStep } = await sources();
  assert.ok(targets.includes("export const IMPLEMENTED_RETRY_TARGETS: readonly RetryTarget[] = RETRY_TARGETS;"));
  assert.ok(targets.includes("'dissection'"));
  assert.ok(tsPipeline.includes("request.target === 'dissection'"));
  assert.ok(tsPipeline.includes("generateDissection({"));
  assert.ok(tsPipeline.includes("insightTargetEnv(environ, request.target)"));
  assert.ok(pipelineStep.includes('if target == "dissection":'));
});
