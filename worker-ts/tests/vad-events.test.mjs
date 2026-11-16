import assert from "node:assert/strict";
import test from "node:test";

import { decodeEvents, pairEvents } from "../src/asr/vad-state.ts";

// VAD 事件流的合法性规则：非法事件必须显式失败，不能被当成「没有语音」吞掉，
// 否则一次流解析错误会静默变成空文字稿。

const errorCode = "ASR_RUNTIME_ERROR";

test("empty chunk yields no events", () => {
  assert.deepEqual(decodeEvents([]), []);
});

test("event stream must be a single batch layer", () => {
  // 生产事件流是「块 → batch → 事件列表」三层；少一层是把 batch 当成块。
  assert.throws(() => decodeEvents([[0, 100]]), (error) => error.code === errorCode);
  assert.throws(() => decodeEvents([[], []]), (error) => error.code === errorCode);
});

test("open endpoints are decoded as null", () => {
  assert.deepEqual(decodeEvents([[[0, 100], [100, -1], [-1, 250]]]), [[0, 100], [100, null], [null, 250]]);
});

test("malformed pairs are rejected", () => {
  for (const chunk of [
    [[[0]]],
    [[[0, 100, 200]]],
    [[[-1, -1]]],
    [[[-5, 100]]],
    [["a", 100]],
  ]) {
    assert.throws(() => decodeEvents(chunk), (error) => error.code === errorCode, JSON.stringify(chunk));
  }
});

test("cross-chunk pairing closes open segments", () => {
  assert.deepEqual(pairEvents([
    [[[0, -1]]],
    [[[-1, 20010], [20010, -1]]],
    [[[-1, 40020]]],
  ]), [[0, 20010], [20010, 40020]]);
});

test("pairing rejects unterminated or inconsistent segments", () => {
  // 起点没有闭合
  assert.throws(() => pairEvents([[[[100, -1]]]]), (error) => error.code === errorCode);
  // 有终点没有起点
  assert.throws(() => pairEvents([[[[-1, 100]]]]), (error) => error.code === errorCode);
  // 终点不晚于起点
  assert.throws(() => pairEvents([[[[100, 50]]]]), (error) => error.code === errorCode);
  // 起点早于上一段终点
  assert.throws(() => pairEvents([[[[0, 100], [50, -1]]]]), (error) => error.code === errorCode);
  // 同一段重复开起点
  assert.throws(() => pairEvents([[[[0, -1], [10, -1]]]]), (error) => error.code === errorCode);
});
