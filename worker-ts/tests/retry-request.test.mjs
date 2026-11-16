import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  IMPLEMENTED_RETRY_TARGETS,
  InvalidRetryRequestError,
  parseRetryInsightsRequest,
  RETRY_TARGETS,
} from "../src/protocol/retry-request.ts";
import {DRAFT_PLATFORM_IDS, draftPlatformLabel} from "../src/ai/draft-platform.ts";

const BASE = { task_id: "20261114-120000-local-abcdef0123456789", target: "summary", output_language: "zh-CN" };

function rejects(payload) {
  assert.throws(() => parseRetryInsightsRequest(payload), InvalidRetryRequestError);
}

test("a minimal summary request parses and normalizes its task id", () => {
  assert.deepEqual(parseRetryInsightsRequest(BASE), {
    taskId: BASE.task_id, target: "summary", outputLanguage: "zh-CN",
  });
  assert.equal(parseRetryInsightsRequest({ ...BASE, task_id: `  ${BASE.task_id}  ` }).taskId, BASE.task_id);
  for (const language of ["zh-CN", "zh-TW", "en-US"]) {
    assert.equal(parseRetryInsightsRequest({ ...BASE, output_language: language }).outputLanguage, language);
  }
});

test("all six contract targets parse, with their own extra-field rules", () => {
  assert.deepEqual(
    [...RETRY_TARGETS].sort(),
    ["dissection", "draft", "insights", "summary", "title", "transcript"].sort(),
  );
  for (const target of RETRY_TARGETS) {
    const payload = { ...BASE, target };
    if (target === "draft") Object.assign(payload, { insight_id: 3, platform: "douyin" });
    assert.equal(parseRetryInsightsRequest(payload).target, target);
  }
  assert.deepEqual(IMPLEMENTED_RETRY_TARGETS, [...RETRY_TARGETS]);
});

test("title requests must carry exactly the three required fields", () => {
  rejects({ ...BASE, target: "title", preference_snapshot: {} });
  rejects({ ...BASE, target: "title", insight_id: 1 });
  rejects({ ...BASE, target: "title", platform: "douyin" });
});

test("unknown fields, bad task ids and bad languages are rejected", () => {
  rejects({ ...BASE, extra: 1 });
  rejects([]);
  rejects(null);
  rejects("{}");
  for (const taskId of ["", "   ", "../escape", "a/b", "a\\b", "/absolute", "含中文", "a.b", "a b"]) {
    rejects({ ...BASE, task_id: taskId });
  }
  for (const language of ["fr-FR", 3, null, undefined]) {
    rejects({ ...BASE, output_language: language });
  }
  rejects({ ...BASE, output_language: undefined });
  rejects({ ...BASE, target: "unknown" });
  rejects({ ...BASE, target: "Summary" });
  rejects({ target: "summary", output_language: "zh-CN" });
});

test("preference_snapshot belongs to insights only; platform belongs to draft only", async () => {
  rejects({ ...BASE, preference_snapshot: {} });
  rejects({ ...BASE, target: "insights", preference_snapshot: [] });
  rejects({ ...BASE, target: "insights", preference_snapshot: null });
  const fixture = JSON.parse(await readFile(
    new URL("./fixtures/insights-prompts-golden.json", import.meta.url), "utf8",
  ));
  const parsed = parseRetryInsightsRequest({
    ...BASE, target: "insights", preference_snapshot: fixture.snapshot,
  });
  assert.equal(parsed.preferenceSnapshot.generationPreferences.goal, "content_creation");
  rejects({ ...BASE, target: "insights", preference_snapshot: { ...fixture.snapshot, extra: 1 } });
  rejects({ ...BASE, target: "insights", preference_snapshot: { ...fixture.snapshot, profileSkipped: "no" } });

  rejects({ ...BASE, platform: "douyin" });
  rejects({ ...BASE, target: "insights", platform: "douyin" });
  // Python 对非 draft target 也接受一个多余的 insight_id（只在 draft 分支读取），
  // 这里保持一致：不「顺手加严」，否则旧宿主发的请求会在升级后失败。
  assert.doesNotThrow(() => parseRetryInsightsRequest({ ...BASE, insight_id: 7 }));
});

test("draft.platform is limited to the nine Python platform ids", async () => {
  const draft = { ...BASE, target: "draft", insight_id: 3, platform: "douyin" };
  const fixture = JSON.parse(await readFile(
    new URL("./fixtures/draft-golden.json", import.meta.url), "utf8",
  ));
  assert.deepEqual(DRAFT_PLATFORM_IDS, fixture.platformIds);
  for (const entry of fixture.platformLabels) {
    assert.equal(draftPlatformLabel(entry.id), entry.label);
  }
  for (const platform of ["weibo", "DOUYIN", "xhs", "unknown", "", "  "]) {
    rejects({ ...draft, platform });
  }
});

test("draft validates the seed id before any quota-consuming call", () => {
  const draft = { ...BASE, target: "draft", insight_id: 3, platform: "douyin" };
  assert.deepEqual(parseRetryInsightsRequest(draft), {
    taskId: BASE.task_id, target: "draft", outputLanguage: "zh-CN", insightId: 3, platform: "douyin",
  });
  assert.equal(parseRetryInsightsRequest({ ...draft, platform: "  douyin  " }).platform, "douyin");
  for (const platform of DRAFT_PLATFORM_IDS) {
    assert.equal(parseRetryInsightsRequest({ ...draft, platform }).platform, platform);
  }
  rejects({ ...draft, insight_id: true });
  rejects({ ...draft, insight_id: "3" });
  rejects({ ...draft, insight_id: 3.5 });
  rejects({ ...draft, insight_id: null });
  rejects({ ...BASE, target: "draft", platform: "douyin" });
  rejects({ ...draft, platform: "   " });
  rejects({ ...draft, platform: 42 });
});
