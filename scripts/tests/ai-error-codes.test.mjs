import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// AI 错误码守卫：TypeScript 与 Python 的错误码表必须同集合。
// 前端按码给三语文案、宿主按码分流重试，多一个或少一个都会变成「用户看到一个没翻译的码」。
// 文案本身在各自的单测里逐条固定，这里只比对码集合。

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workerRoot = resolve(repositoryRoot, "worker-ts");

function keysOf(source, blockName) {
  const block = source.match(
    new RegExp(`(?:export )?(?:const )?${blockName}[^=]*= \\{([\\s\\S]*?)\\n\\};?`),
  )?.[1];
  assert.ok(block, `找不到 ${blockName}`);
  return [...block.matchAll(/"?(AI_[A-Z0-9_]+)"?:/g)].map((match) => match[1]).sort();
}

test("the AI error codes match the python tables", async () => {
  const typescript = await readFile(resolve(workerRoot, "src/ai/errors.ts"), "utf8");
  const python = await readFile(resolve(repositoryRoot, "worker/worker_core/ai_runtime.py"), "utf8");

  assert.deepEqual(
    keysOf(typescript, "CHECKOUT_ERROR_MESSAGES"),
    keysOf(python, "_CHECKOUT_ERROR_MESSAGES"),
    "checkout 错误码必须与 Python 同集合",
  );
  assert.deepEqual(
    keysOf(typescript, "GENERATION_ERROR_MESSAGES"),
    keysOf(python, "_GENERATION_ERROR_MESSAGES"),
    "生成路径错误码必须与 Python 同集合",
  );
});

test("every code in the tables is also a member of the closed union", async () => {
  const typescript = await readFile(resolve(workerRoot, "src/ai/errors.ts"), "utf8");
  const union = typescript.match(/export type InsightGenerationCode =([\s\S]*?);/)?.[1];
  assert.ok(union, "errors.ts 缺少 InsightGenerationCode");
  const allowed = new Set([...union.matchAll(/'(AI_[A-Z0-9_]+)'/g)].map((match) => match[1]));

  for (const table of ["CHECKOUT_ERROR_MESSAGES", "GENERATION_ERROR_MESSAGES"]) {
    for (const code of keysOf(typescript, table)) {
      assert.ok(allowed.has(code), `${code} 不在 InsightGenerationCode 闭集里`);
    }
  }
});
