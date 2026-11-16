// BYOK 探针（`--probe-llm-stdin`）的跨语言静态守卫。
//
// Python `worker_core/llm_probe.py` 与 TypeScript `worker-ts/src/ai/llm-probe.ts`
// 必须共享同一份闭集：探针错误码、允许的供应商、必填字段、探针参数（tokens /
// 超时 / 提示词）、stdin 上限，以及「分类 → 探针错误码」的映射面。
// 两侧任一侧漂移，这份守卫先红。
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, '..', '..');
const pythonRoot = resolve(repositoryRoot, 'worker');
const workerRoot = resolve(repositoryRoot, 'worker-ts');

async function read(...parts) {
  return readFile(join(...parts), 'utf8');
}

test('probe error codes, providers and required fields match python exactly', async () => {
  const python = await read(pythonRoot, 'worker_core', 'llm_probe.py');
  const typescript = await read(workerRoot, 'src', 'ai', 'llm-probe.ts');

  for (const code of [
    'LLM_PROBE_INVALID_REQUEST', 'LLM_PROBE_NETWORK_ERROR', 'LLM_PROBE_AUTH_FAILED',
    'LLM_PROBE_MODEL_NOT_FOUND', 'LLM_PROBE_TIMEOUT', 'LLM_PROBE_RATE_LIMITED',
    'LLM_PROBE_INVALID_RESPONSE', 'LLM_PROBE_UNEXPECTED_ERROR',
  ]) {
    assert.ok(python.includes(code), `Python 探针缺少错误码 ${code}`);
    assert.ok(typescript.includes(code), `TypeScript 探针缺少错误码 ${code}`);
  }
  for (const literal of ["['openai', 'openai_compatible']", "['base_url', 'api_key', 'model', 'provider']"]) {
    assert.ok(typescript.includes(literal), `TypeScript 探针缺少 ${literal}`);
  }
  for (const literal of ['{"base_url", "api_key", "model", "provider"}', '{"openai", "openai_compatible"}']) {
    assert.ok(python.includes(literal), `Python 探针缺少 ${literal}`);
  }
  // 分类映射面：Python 的 PROBE_ERROR_CODE_BY_CATEGORY 与 TS 的
  // PROBE_ERROR_CODE_BY_GENERATION_CODE 必须覆盖同一批语义类别。
  for (const category of ['timeout', 'auth', 'model_not_found', 'rate_limit', 'network', 'invalid_response']) {
    assert.ok(python.includes(`"${category}":`), `Python 分类映射缺少 ${category}`);
  }
  for (const generationCode of [
    'AI_LLM_REQUEST_TIMEOUT', 'AI_LLM_KEY_REJECTED', 'AI_LLM_MODEL_UNAVAILABLE',
    'AI_LLM_RATE_LIMITED', 'AI_LLM_NETWORK_FAILED', 'AI_LLM_INVALID_RESPONSE',
  ]) {
    assert.ok(typescript.includes(`${generationCode}:`), `TS 分类映射缺少 ${generationCode}`);
  }
});

test('probe constants, prompt and stdin limit match python', async () => {
  const python = await read(pythonRoot, 'worker_core', 'llm_probe.py');
  const pythonCli = await read(pythonRoot, 'worker_core', 'cli.py');
  const typescript = await read(workerRoot, 'src', 'ai', 'llm-probe.ts');

  assert.ok(python.includes('PROBE_MAX_TOKENS = 1'));
  assert.ok(python.includes('PROBE_TIMEOUT_SECONDS = 15.0'));
  assert.ok(python.includes('_PROBE_PROMPT = "ping"'));
  assert.ok(typescript.includes('PROBE_MAX_TOKENS = 1'));
  assert.ok(typescript.includes('PROBE_TIMEOUT_SECONDS = 15'));
  assert.ok(typescript.includes("PROBE_PROMPT = 'ping'"));
  // 探针请求同样走 1 MiB 的 stdin 上限（read_stdin_request 的默认值）。
  assert.ok(pythonCli.includes('MAX_STDIN_REQUEST_BYTES = 1024 * 1024'));
  const stdinModule = await read(workerRoot, 'src', 'protocol', 'contract.ts');
  assert.ok(stdinModule.includes('MAX_STDIN_REQUEST_BYTES = 1024 * 1024'));
});

test('the cli probe branch prints one bare result line and always exits zero', async () => {
  const pythonCli = await read(pythonRoot, 'worker_core', 'cli.py');
  const typescriptCli = await read(workerRoot, 'src', 'cli.ts');

  // Python：探针分支在校验配对之后短路，打印 render_result_json(result)，返回 0。
  assert.ok(pythonCli.includes('args.probe_llm_stdin:'));
  assert.ok(pythonCli.includes('llm_probe.run_llm_probe(probe_request_json)'));
  assert.ok(pythonCli.includes('render_result_json(result)'));
  // TS：探针短路在「一次只能指定一个模式」之前，且退出码恒为 EXIT_OK。
  assert.ok(typescriptCli.includes("argument === '--probe-llm-stdin'"));
  assert.ok(typescriptCli.includes('runLlmProbe(requestJson)'));
  const shortCircuit = typescriptCli.indexOf('if (probeLlmStdin) {');
  const modesCheck = typescriptCli.indexOf("if (modes.length !== 1)");
  const webPairing = typescriptCli.indexOf("if (saveWebPage !== (webOperationId !== undefined))");
  assert.ok(shortCircuit > -1 && modesCheck > -1 && webPairing > -1);
  assert.ok(webPairing < shortCircuit, '探针短路必须在网页配对校验之后');
  assert.ok(shortCircuit < modesCheck, '探针短路必须在模式互斥之前');
});
