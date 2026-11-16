import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import test from "node:test";

import {buildSkillsInventory, createSkillTool, loadSkills, SKILL_TOOL_SPEC} from "../src/ai/workspace/skills.ts";
import {
  buildPlanningPrompt,
  createPlanningState,
  createWriteTodosTool,
  PLANNING_REMINDER,
  renderPlan,
  TODO_STATE_CLOSE,
  TODO_STATE_OPEN,
  WRITE_TODOS_TOOL_SPEC,
} from "../src/ai/workspace/planning.ts";
import {injectSystemBlock} from "../src/ai/workspace/system-block.ts";
import {mcpResultToText} from "../src/ai/workspace/mcp-client.ts";

const fixture = JSON.parse(await readFile(new URL("./fixtures/draft-golden.json", import.meta.url), "utf8"));
const skillsRoot = fileURLToPath(new URL("../skills/", import.meta.url));

test("the packaged skill loads with Python's exact frontmatter description and body", async () => {
  const skills = await loadSkills(skillsRoot);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, "viral-writer");
  assert.equal(skills[0].active, true);
  assert.equal(skills[0].content, fixture.skillContent);
  assert.equal(
    fixture.skillsInventory.includes(`- **viral-writer**: `),
    true,
  );
});

test("skills inventory, Skill tool and planning tool specs match the Python source", async () => {
  const skills = await loadSkills(skillsRoot);
  const normalized = skills.map((skill) => ({...skill, path: "SKILLS_ROOT/viral-writer"}));
  assert.equal(buildSkillsInventory(normalized), fixture.skillsInventory);
  assert.deepEqual(SKILL_TOOL_SPEC, fixture.skillTool);
  assert.deepEqual(WRITE_TODOS_TOOL_SPEC, fixture.writeTodosTool);

  const tool = createSkillTool(skills);
  assert.equal(await tool.handler({toolName: "Skill", args: {name: "viral-writer"}, call: {id: "1", name: "Skill", arguments: "{}"}}), fixture.skillContent);
  assert.match(await tool.handler({toolName: "Skill", args: {name: "missing"}, call: {id: "2", name: "Skill", arguments: "{}"}}), /not found/u);
});

test("plan rendering, guidance, reminder and veto cap match Python", () => {
  for (const entry of fixture.planningPrompts) {
    assert.equal(buildPlanningPrompt(entry.todos), entry.expected);
    assert.equal(renderPlan(entry.todos), entry.rendered);
  }
  assert.equal(PLANNING_REMINDER, fixture.planningReminder);

  const state = createPlanningState();
  assert.equal(state.veto(), false);
  state.replace([
    {content: "结构构思", status: "in_progress"},
    {content: "资料检索", status: "pending"},
  ]);
  assert.equal(state.veto(), true);
  assert.equal(state.veto(), true);
  assert.equal(state.veto(), false);
  state.replace([{content: "结构构思", status: "completed"}]);
  assert.equal(state.veto(), false);
});

test("write_todos normalizes malformed items and returns the rendered plan", async () => {
  const state = createPlanningState();
  const tool = createWriteTodosTool(state);
  const result = await tool.handler({
    toolName: "write_todos",
    args: {todos: [{content: "结构构思", status: "in_progress"}, {content: "资料检索", status: "bogus"}]},
    call: {id: "3", name: "write_todos", arguments: "{}"},
  });
  assert.equal(result, "Plan updated:\n\n- [~] 结构构思\n- [ ] 资料检索");
  assert.deepEqual(state.todos, [
    {content: "结构构思", status: "in_progress"},
    {content: "资料检索", status: "pending"},
  ]);
});

test("system sentinels replace their own block without accumulating", () => {
  const messages = [{role: "system", content: "基础指令\n"}];
  injectSystemBlock(messages, "<!-- skills-inventory -->", "<!-- /skills-inventory -->", "技能清单 v1");
  injectSystemBlock(messages, TODO_STATE_OPEN, TODO_STATE_CLOSE, "计划 v1");
  const first = messages[0].content;
  assert.match(first, /技能清单 v1/u);
  assert.match(first, /计划 v1/u);
  injectSystemBlock(messages, "<!-- skills-inventory -->", "<!-- /skills-inventory -->", "技能清单 v2");
  injectSystemBlock(messages, TODO_STATE_OPEN, TODO_STATE_CLOSE, "计划 v2");
  assert.match(messages[0].content, /技能清单 v2/u);
  assert.match(messages[0].content, /计划 v2/u);
  assert.equal((messages[0].content.match(/技能清单/gu) ?? []).length, 1);
  assert.equal((messages[0].content.match(/计划 v/gu) ?? []).length, 1);
  injectSystemBlock(messages, TODO_STATE_OPEN, TODO_STATE_CLOSE, "");
  assert.doesNotMatch(messages[0].content, /todo-state/u);
});

test("MCP tool results are flattened into a tool message text", () => {
  assert.equal(
    mcpResultToText({content: [{type: "text", text: "甲"}, {type: "text", text: "乙"}]}),
    "甲\n乙",
  );
  assert.equal(mcpResultToText({content: [{type: "image", data: "AA=="}]}), '{"type":"image","data":"AA=="}');
});
