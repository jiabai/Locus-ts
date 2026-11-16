// 网页保存契约的基准比对：URL 规范化、请求/正文/来源校验与保存用 Markdown 拼装。
//
// 基准由 `scripts/tests/web-page-golden.py` 从 Python 生产源码生成——两侧必须对
// 同一批输入给出同一批「接受 + 规范形」或「拒绝」，差一个字符都算规则漂移。
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {
  buildSavedMarkdown,
  canonicalWebUrl,
  parseWebPageRequest,
  validateArticlePayload,
  validateWebPageSource,
  validateWebTaskId,
  webPageSourceToDict,
} from "../src/web/web-page-contract.ts";

const GOLDEN = JSON.parse(
  await readFile(new URL("./fixtures/web-page-golden.json", import.meta.url), "utf8"),
);

function attempt(action) {
  try {
    return {ok: true, value: action()};
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return {ok: false, error: error.message};
  }
}

test("URL canonicalization matches the Python reference for every golden case", () => {
  assert.ok(GOLDEN.urls.length >= 60, "golden 数量不足");
  for (const {input, result} of GOLDEN.urls) {
    const actual = attempt(() => canonicalWebUrl(input));
    assert.equal(actual.ok, result.ok, `接受/拒绝不一致：${input}`);
    if (result.ok) {
      assert.equal(actual.value, result.value, `规范形不一致：${input}`);
    }
  }
});

test("article payload validation matches the Python reference", () => {
  for (const {payload, result} of GOLDEN.articles) {
    const actual = attempt(() => validateArticlePayload(payload));
    assert.equal(actual.ok, result.ok, `正文校验不一致：${JSON.stringify(payload).slice(0, 80)}`);
    if (result.ok) assert.deepEqual(actual.value, result.value);
  }
});

test("web page request parsing matches the Python reference", () => {
  for (const {payload, result} of GOLDEN.requests) {
    const actual = attempt(() => parseWebPageRequest(payload));
    assert.equal(actual.ok, result.ok, `请求校验不一致：${JSON.stringify(payload).slice(0, 80)}`);
    // golden 记录的是 Python `WebPageRequest.article`；两侧的请求对象字段同值。
    if (result.ok) assert.deepEqual(actual.value?.article, result.value);
  }
});

test("web page source metadata validation matches the Python reference", () => {
  for (const {url, title, extractedAt, result} of GOLDEN.sources) {
    const actual = attempt(() =>
      webPageSourceToDict(validateWebPageSource(url, title, extractedAt)));
    assert.equal(actual.ok, result.ok, `来源校验不一致：${url} ${title} ${extractedAt}`);
    if (result.ok) assert.deepEqual(actual.value, result.value);
  }
});

test("web task ids match the Python closed set", () => {
  for (const {input, result} of GOLDEN.taskIds) {
    const actual = attempt(() => validateWebTaskId(input));
    assert.equal(actual.ok, result.ok, `任务 id 校验不一致：${input}`);
    if (result.ok) assert.equal(actual.value, result.value);
  }
});

test("saved markdown assembly is byte-identical to Python", () => {
  for (const {title, url, extractedAt, markdown, expected} of GOLDEN.savedMarkdown) {
    assert.equal(buildSavedMarkdown(title, url, extractedAt, markdown), expected);
  }
});
