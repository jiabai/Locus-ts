import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

// 草稿链的跨语言守卫：九个平台 id、两份提示词、工具契约、三个失败码、40 轮上限、
// 检索环境变量与产物路径在 Python 与 TypeScript 两侧各有一份。
// fixture 由 draft-golden.py 从 Python 生产源码生成，worker-ts 单测逐字节比对。

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workerRoot = resolve(repositoryRoot, "worker-ts");

async function sources() {
  const [
    pyAgent, pyPrompts, pyRetry, pyRequests, pyLlm,
    tsPlatform, tsPrompt, tsAgent, tsStep, tsPipeline, tsRetryRequest,
    tsMcp, tsSkills, tsPlanning, tsManifest, tsIndex, fixtureText, closedSet,
  ] = await Promise.all([
    readFile(resolve(repositoryRoot, "worker/worker_core/draft_agent.py"), "utf8"),
    readFile(resolve(repositoryRoot, "worker/worker_core/ai_prompts.py"), "utf8"),
    readFile(resolve(repositoryRoot, "worker/worker_core/worker_application/insight_retry.py"), "utf8"),
    readFile(resolve(repositoryRoot, "worker/worker_core/requests.py"), "utf8"),
    readFile(resolve(repositoryRoot, "worker/worker_core/llm.py"), "utf8"),
    readFile(resolve(workerRoot, "src/ai/draft-platform.ts"), "utf8"),
    readFile(resolve(workerRoot, "src/ai/draft-prompt.ts"), "utf8"),
    readFile(resolve(workerRoot, "src/ai/draft-agent.ts"), "utf8"),
    readFile(resolve(workerRoot, "src/pipeline/draft-step.ts"), "utf8"),
    readFile(resolve(workerRoot, "src/pipeline/insight-retry.ts"), "utf8"),
    readFile(resolve(workerRoot, "src/protocol/retry-request.ts"), "utf8"),
    readFile(resolve(workerRoot, "src/ai/workspace/mcp-client.ts"), "utf8"),
    readFile(resolve(workerRoot, "src/ai/workspace/skills.ts"), "utf8"),
    readFile(resolve(workerRoot, "src/ai/workspace/planning.ts"), "utf8"),
    readFile(resolve(workerRoot, "src/tasks/manifest.ts"), "utf8"),
    readFile(resolve(workerRoot, "src/tasks/index.ts"), "utf8"),
    readFile(resolve(workerRoot, "tests/fixtures/draft-golden.json"), "utf8"),
    readFile(resolve(repositoryRoot, "contracts/task-artifact-transaction-v1.json"), "utf8"),
  ]);
  return {
    pyAgent, pyPrompts, pyRetry, pyRequests, pyLlm,
    tsPlatform, tsPrompt, tsAgent, tsStep, tsPipeline, tsRetryRequest,
    tsMcp, tsSkills, tsPlanning, tsManifest, tsIndex,
    fixture: JSON.parse(fixtureText), closedSet: JSON.parse(closedSet),
  };
}

test("all nine platform ids and their labels exist on both sides", async () => {
  const {pyPrompts, pyRequests, tsPlatform, tsRetryRequest, fixture} = await sources();
  for (const entry of fixture.platformLabels) {
    assert.ok(pyPrompts.includes(`"${entry.id}"`), `Python 缺少 ${entry.id}`);
    assert.ok(tsPlatform.includes(`${entry.id}:`), `TypeScript 缺少 ${entry.id}`);
    assert.ok(pyPrompts.includes(`"${entry.label}"`), `Python 缺少显示名 ${entry.label}`);
    assert.ok(tsPlatform.includes(`'${entry.label}'`), `TypeScript 缺少显示名 ${entry.label}`);
  }
  assert.equal(fixture.platformIds.length, 9);
  assert.ok(pyPrompts.includes("DRAFT_PLATFORM_IDS"));
  assert.ok(pyRequests.includes("platform not in DRAFT_PLATFORM_IDS"));
  assert.ok(tsRetryRequest.includes("isDraftPlatform(normalized)"));
});

test("the system prompt guard clauses and turn budget match Python", async () => {
  const {pyAgent, tsPrompt, tsAgent, fixture} = await sources();
  assert.equal(Number(pyAgent.match(/_DEFAULT_MAX_TURNS = (\d+)/)?.[1]), fixture.maxTurns);
  assert.equal(Number(tsAgent.match(/export const DRAFT_AGENT_MAX_TURNS = (\d+);/)?.[1]), fixture.maxTurns);
  assert.ok(pyAgent.includes(fixture.retrievalFallbackPhrase));
  assert.ok(tsPrompt.includes(fixture.retrievalFallbackPhrase));
  for (const value of fixture.planningOffValues) {
    assert.ok(pyAgent.includes(`"${value}"`));
    assert.ok(tsAgent.includes(`'${value}'`));
  }
  assert.ok(pyAgent.includes("APP_DRAFT_PLANNING"));
  assert.ok(pyAgent.includes("APP_DRAFT_MAX_TURNS"));
  assert.ok(tsAgent.includes("APP_DRAFT_PLANNING"));
  assert.ok(tsAgent.includes("APP_DRAFT_MAX_TURNS"));
  assert.ok(pyAgent.includes("def _build_system_prompt"));
  assert.ok(tsPrompt.includes("export function buildDraftSystemPrompt"));
  assert.ok(pyPromptsInSeed(await sources()));
});

function pyPromptsInSeed({pyPrompts, tsPrompt}) {
  assert.ok(pyPrompts.includes("def build_draft_from_inspiration_prompt"));
  assert.ok(tsPrompt.includes("export function buildDraftUserPrompt"));
  return true;
}

test("submit_draft, Skill and write_todos tool contracts are pinned to Python", async () => {
  const {pyAgent, tsAgent, tsSkills, tsPlanning, fixture} = await sources();
  assert.equal(fixture.submitDraftTool.name, "submit_draft");
  assert.ok(pyAgent.includes("def _build_submit_draft_tool"));
  assert.ok(tsAgent.includes("export const SUBMIT_DRAFT_TOOL_SPEC"));
  assert.ok(pyAgent.includes("已接收稿子完整正文，任务可结束（无需任何 recap 或总结）。"));
  assert.ok(tsAgent.includes("已接收稿子完整正文，任务可结束（无需任何 recap 或总结）。"));
  assert.equal(fixture.skillTool.name, "Skill");
  assert.ok(tsSkills.includes("export const SKILL_TOOL_SPEC"));
  assert.equal(fixture.writeTodosTool.name, "write_todos");
  assert.ok(tsPlanning.includes("export const WRITE_TODOS_TOOL_SPEC"));
  assert.ok(tsPlanning.includes(fixture.planningReminder.slice(0, 40)));
});

test("the three draft failure codes, messages and stage match Python", async () => {
  const {pyRetry, tsStep} = await sources();
  const codes = ["DRAFT_SEED_INVALID", "DRAFT_GENERATION_FAILED", "DRAFT_EMPTY_RESULT"];
  for (const code of codes) {
    assert.ok(pyRetry.includes(code), `Python 缺少 ${code}`);
    assert.ok(tsStep.includes(code), `TypeScript 缺少 ${code}`);
  }
  assert.ok(tsStep.includes("DRAFT_STAGE = 'draft_generating'"));
  for (const fragment of [
    "is not present in ai/insights.json; ",
    "re-select an insight and retry.",
    "Draft generation failed.",
    "Draft generation returned an empty result.",
  ]) {
    assert.ok(pyRetry.includes(fragment), `Python 缺少文案 ${fragment}`);
  }
  // TypeScript 把 Python 的 f-string 两段拼成一条完整消息。
  for (const message of [
    "is not present in ai/insights.json; re-select an insight and retry.",
    "Draft generation failed.",
    "Draft generation returned an empty result.",
  ]) {
    assert.ok(tsStep.includes(message), `TypeScript 缺少文案 ${message}`);
  }
  assert.ok(pyRetry.includes("JobStage.DRAFT_GENERATING"));
});

test("draft artifacts use the transaction closed set and the manifest reports them", async () => {
  const {pyRetry, tsStep, tsManifest, tsIndex, closedSet} = await sources();
  for (const destination of ["ai/draft.md", "ai/original/draft.md"]) {
    assert.ok(closedSet.allowedDestinations.includes(destination), `${destination} 必须在事务闭集`);
    assert.ok(tsStep.includes(destination), `TypeScript 缺少 ${destination}`);
  }
  assert.ok(pyRetry.includes('"ai/original/draft.md": None'));
  assert.ok(tsStep.includes("[ORIGINAL_DRAFT_DESTINATION]: null"));
  assert.ok(tsIndex.includes("if (content === null) continue;"));
  assert.ok(tsManifest.includes("has_draft: draftPath !== null"));
  assert.ok(tsManifest.includes("draft_path: draftPath"));
});

test("retrieval credentials and checkout share the Python environment names", async () => {
  const {pyAgent, pyLlm, tsMcp, tsStep} = await sources();
  for (const name of [
    "ANYSEARCH_MCP_URL", "ANYSEARCH_API_KEY", "APP_ANYSEARCH_SOURCE",
    "APP_ANYSEARCH_CHECKOUT_URL", "APP_ANYSEARCH_SESSION_TOKEN",
  ]) {
    assert.ok(pyAgent.includes(name) || pyLlm.includes(name), `Python 缺少 ${name}`);
    assert.ok(tsMcp.includes(name) || tsStep.includes(name), `TypeScript 缺少 ${name}`);
  }
  assert.ok(pyAgent.includes("Authorization"));
  assert.ok(tsMcp.includes("Authorization"));
  assert.ok(pyLlm.includes("mcp_url"));
  assert.ok(tsMcp.includes("mcpUrl"));
  assert.ok(pyAgent.includes("checkout_llm_config_once"));
  assert.ok(pyAgent.includes("checkout_anysearch_config_once"));
});

test("all six contract targets are implemented and the temporary code is gone", async () => {
  const {tsPipeline, tsRetryRequest} = await sources();
  assert.ok(tsRetryRequest.includes("export const IMPLEMENTED_RETRY_TARGETS: readonly RetryTarget[] = RETRY_TARGETS;"));
  assert.ok(!tsPipeline.includes("INSIGHT_TARGET_UNSUPPORTED"));
  assert.ok(tsPipeline.includes("request.target === 'draft'"));
  for (const target of ["summary", "insights", "dissection", "draft", "transcript", "title"]) {
    assert.ok(tsRetryRequest.includes(`'${target}'`), `契约 target 闭集缺少 ${target}`);
  }
});
