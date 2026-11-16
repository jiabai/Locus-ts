import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  InvalidPreferenceSnapshotError, parsePreferenceSnapshot, serializePreferenceSnapshot,
} from "../src/ai/preference-snapshot.ts";

// 正反例由 `work/ai-spike/preference_cases.py` 驱动 Python 的 `parse_preference_snapshot`
// 生成：判定必须逐项一致，多放一个字段进来就会让一份伪造的偏好写进提示词。

const CASES = new URL("./fixtures/preference-parser-golden.json", import.meta.url);

test("the preference parser accepts and rejects exactly what python does", async () => {
  const cases = JSON.parse(await readFile(CASES, "utf8"));
  for (const item of cases) {
    let accepted = true;
    try {
      parsePreferenceSnapshot(item.payload);
    } catch (error) {
      assert.ok(error instanceof InvalidPreferenceSnapshotError, `${item.name} 抛出了别的错误`);
      accepted = false;
    }
    assert.equal(accepted, item.accepted, `${item.name} 的判定与 Python 不一致`);
  }
});

test("a parsed snapshot round-trips to the exact persisted payload", async () => {
  const golden = JSON.parse(await readFile(
    new URL("./fixtures/insights-prompts-golden.json", import.meta.url), "utf8",
  ));
  const snapshot = parsePreferenceSnapshot(golden.snapshot);
  assert.equal(serializePreferenceSnapshot(snapshot), golden.snapshot_file);
  assert.deepEqual(JSON.parse(serializePreferenceSnapshot(snapshot)), golden.snapshot);
});

test("a null profile is preserved, not silently filled with defaults", async () => {
  const cases = JSON.parse(await readFile(CASES, "utf8"));
  const payload = cases.find((item) => item.name === "profile null is allowed").payload;
  const snapshot = parsePreferenceSnapshot(payload);
  assert.equal(snapshot.profile, null);
  assert.equal(serializePreferenceSnapshot(snapshot).includes('"profile": null'), true);
});
