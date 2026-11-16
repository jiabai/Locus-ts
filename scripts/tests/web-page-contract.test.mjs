import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// 网页契约的跨语言守卫：URL 规范化、字节上限、任务 id / 操作 id 的形状、保存与重算的
// 失败码、进度事件与清单形状在 Python 与 TypeScript 两侧各有一份用途。fixture 里的
// 逐字节 golden 由 web-page-golden.py 生成，worker-ts 单测把 TypeScript 输出与它对齐；
// 这里把两侧源码的常量与闭集互相钉住，防止任何一侧单独漂移。

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workerRoot = resolve(repositoryRoot, "worker-ts");

async function read(relative) {
  return readFile(resolve(repositoryRoot, relative), "utf8");
}

function pythonConstant(source, name) {
  const value = source.match(new RegExp(`^${name} = ([^\\n]+)`, "m"))?.[1]?.trim();
  assert.ok(value, `Python 侧缺少常量 ${name}`);
  return value;
}

function typescriptConstant(source, name) {
  const value = source.match(new RegExp(`export const ${name} = ([^;]+);`))?.[1]?.trim();
  assert.ok(value, `TypeScript 侧缺少常量 ${name}`);
  return value;
}

test("contract version and byte limits are identical on both sides", async () => {
  const [python, typescript, fixture] = await Promise.all([
    read("worker/worker_core/web_page_contract.py"),
    read("worker-ts/src/web/web-page-contract.ts"),
    readFile(resolve(workerRoot, "tests/fixtures/web-page-golden.json"), "utf8"),
  ]);
  for (const name of [
    "WEB_PAGE_CONTRACT_VERSION",
    "MAX_WEB_PAGE_MESSAGE_BYTES",
    "MAX_ARTICLE_TEXT_BYTES",
    "MAX_ARTICLE_MARKDOWN_BYTES",
  ]) {
    assert.equal(typescriptConstant(typescript, name), pythonConstant(python, name), name);
  }
  assert.equal(JSON.parse(fixture).contractVersion, 2);
});

test("the canonical query whitelist and identity patterns match the Python source", async () => {
  const [python, typescript] = await Promise.all([
    read("worker/worker_core/web_page_contract.py"),
    read("worker-ts/src/web/web-page-contract.ts"),
  ]);
  for (const literal of ['"id", "article_id", "post_id", "story_id"', '"page", "p"']) {
    assert.ok(python.includes(literal), `Python 查询白名单缺少 ${literal}`);
  }
  for (const literal of ["'id', 'article_id', 'post_id', 'story_id'", "item.key === 'page' || item.key === 'p'"]) {
    assert.ok(typescript.includes(literal), `TypeScript 查询白名单缺少 ${literal}`);
  }
  for (const pattern of ["[0-9]{1,20}", "[1-9][0-9]{0,5}"]) {
    assert.ok(python.includes(pattern));
    assert.ok(typescript.includes(pattern));
  }
  // 任务 id 的正则体必须逐字符一致；操作 id Python 用 `str(UUID(...))` 规范校验，
  // TypeScript 用等价的小写 UUID 正则。
  const webTaskId = python.match(/_WEB_TASK_ID = re\.compile\(r"\^([^\$]+)\$"\)/)?.[1];
  assert.ok(webTaskId, "找不到 Python _WEB_TASK_ID");
  assert.ok(typescript.includes(`WEB_TASK_ID_PATTERN = /^${webTaskId}$/u`));
  assert.ok(python.includes("str(UUID(operation)) != operation"));
  assert.ok(typescript.includes(
    "OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u",
  ));
});

test("saving and retry failure codes, stages and messages match the Python branches", async () => {
  const [storage, retry, save, pipeline, cli] = await Promise.all([
    read("worker/worker_core/web_page_storage.py"),
    read("worker/worker_core/worker_application/insight_retry.py"),
    read("worker-ts/src/pipeline/web-page-save.ts"),
    read("worker-ts/src/pipeline/insight-retry.ts"),
    read("worker-ts/src/cli.ts"),
  ]);
  const typescriptSave = save + cli;
  assert.ok(storage.includes('"WEB_PAGE_REQUEST_OR_STORAGE_INVALID"'));
  assert.ok(storage.includes('"Web page saving failed."'));
  assert.ok(typescriptSave.includes("WEB_PAGE_REQUEST_OR_STORAGE_INVALID"));
  assert.ok(typescriptSave.includes("'Web page saving failed.'"));

  assert.ok(retry.includes('"WEB_PAGE_RETRY_TARGET_INVALID"'));
  assert.ok(retry.includes('"This retry target is unavailable for web pages."'));
  assert.ok(pipeline.includes("'WEB_PAGE_RETRY_TARGET_INVALID'"));
  assert.ok(pipeline.includes("'This retry target is unavailable for web pages.'"));

  // 重算入口按来源注入 `APP_AI_SOURCE_KIND`，网页任务拒绝 title/transcript。
  assert.ok(retry.includes('runtime_env["APP_AI_SOURCE_KIND"]'));
  assert.ok(pipeline.includes("APP_AI_SOURCE_KIND: webPage ? 'article' : 'transcript'"));
  assert.ok(pipeline.includes("request.target === 'title' || request.target === 'transcript'"));
});

test("the saving progress event and stage exist in both registries", async () => {
  const [python, specs] = await Promise.all([
    read("worker/worker_core/progress_events.py"),
    read("worker-ts/src/protocol/events.ts"),
  ]);
  assert.ok(python.includes('"web.page.saving": WorkerProgressSpec()'));
  assert.ok(specs.includes("'web.page.saving': {allowedArgs: []}"));
  assert.ok(python.includes('"web_saving"'));
  assert.ok(specs.includes("'web_saving'"));
});

test("the web manifest shape stays pinned: schema 4, web_source, no local fields", async () => {
  const [python, manifest, load, index] = await Promise.all([
    read("worker/worker_core/task_store.py"),
    read("worker-ts/src/tasks/manifest.ts"),
    read("worker-ts/src/tasks/load.ts"),
    read("worker-ts/src/tasks/index.ts"),
  ]);
  assert.ok(python.includes("4 if isinstance(context.source, WebPageSource) else TASK_SCHEMA_VERSION"));
  assert.ok(manifest.includes("webPage ? WEB_TASK_SCHEMA_VERSION : TASK_SCHEMA_VERSION"));
  assert.ok(manifest.includes("export const WEB_TASK_SCHEMA_VERSION = 4;"));
  for (const [pythonLiteral, typescriptLiteral] of [
    ['"source_kind": "web_page"', "source_kind: 'web_page'"],
    ['"web_source"', "web_source: {title: source.title, extracted_at: source.extractedAt}"],
    ['"platform": "web"', "platform: 'web'"],
  ]) {
    assert.ok(python.includes(pythonLiteral), `Python 清单缺少 ${pythonLiteral}`);
    assert.ok(manifest.includes(typescriptLiteral), `TypeScript 清单缺少 ${typescriptLiteral}`);
  }
  // 打开旧任务时网页分支跳过目录补建；产物闭集按 article 两键走。
  assert.ok(python.includes("if not isinstance(context.source, WebPageSource):"));
  assert.ok(load.includes("source.kind === 'web_page'"));
  assert.ok(index.includes("source.kind === 'web_page'"));
});
