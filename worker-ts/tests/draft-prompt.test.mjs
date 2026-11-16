import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {buildDraftSystemPrompt, buildDraftUserPrompt} from "../src/ai/draft-prompt.ts";
import {parsePreferenceSnapshot} from "../src/ai/preference-snapshot.ts";
import {DRAFT_PLATFORM_IDS, draftPlatformLabel} from "../src/ai/draft-platform.ts";

const fixture = JSON.parse(await readFile(new URL("./fixtures/draft-golden.json", import.meta.url), "utf8"));

test("the nine platform ids and their prompt labels match the Python source", () => {
  assert.deepEqual(DRAFT_PLATFORM_IDS, fixture.platformIds);
  for (const entry of fixture.platformLabels) {
    assert.equal(draftPlatformLabel(entry.id), entry.label);
  }
  assert.equal(draftPlatformLabel("unknown-platform"), "unknown-platform");
});

test("system prompts are byte-identical for every platform, summary and source kind", () => {
  for (const entry of fixture.systemPrompts) {
    assert.equal(
      buildDraftSystemPrompt(entry.platform, entry.summary, entry.sourceKind),
      entry.expected,
      `system prompt mismatch: ${entry.platform}/${entry.sourceKind}/${JSON.stringify(entry.summary)}`,
    );
  }
  assert.equal(fixture.systemPrompts.length, 18);
});

test("seed prompts are byte-identical across languages, snapshots, summaries and platforms", () => {
  for (const entry of fixture.userPrompts) {
    const snapshot = entry.snapshot === null ? null : parsePreferenceSnapshot(entry.snapshot);
    assert.equal(
      buildDraftUserPrompt({
        seed: {
          id: entry.insight.id,
          topic: entry.insight.topic,
          matchReason: entry.insight.matchReason,
          followUpQuestions: entry.insight.followUpQuestions,
          suitableUse: entry.insight.suitableUse,
          sourceChunkId: entry.insight.sourceChunkId,
        },
        preferenceSnapshot: snapshot,
        outputLanguage: entry.language,
        summary: entry.summary,
        platform: entry.platform,
        sourceKind: entry.sourceKind,
      }),
      entry.expected,
      `seed prompt mismatch: ${entry.label}`,
    );
  }
  assert.equal(fixture.userPrompts.length, 7);
});
