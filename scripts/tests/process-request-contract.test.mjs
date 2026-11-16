// URL 任务请求的跨语言静态守卫。
// Python `worker_core/requests.py` 与 TypeScript `worker-ts/src/protocol/process-request.ts`
// 必须共享字段闭集、版本号、模型白名单、失败文案与 URL 裁剪规则。
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

test('field set, version, model allowlist and failure text match python', async () => {
  const python = await read(pythonRoot, 'worker_core', 'requests.py');
  const pythonContract = await read(pythonRoot, 'worker_core', 'desktop_contract.py');
  const pythonApp = await read(pythonRoot, 'worker_core', 'worker_application', 'url_processing.py');
  const typescript = await read(workerRoot, 'src', 'protocol', 'process-request.ts');
  const tsContract = await read(workerRoot, 'src', 'protocol', 'contract.ts');

  assert.ok(python.includes('PROCESS_VIDEO_REQUEST_FIELDS = frozenset({"contract_version", "url", "asr_model"})'));
  assert.ok(python.includes('INVALID_PROCESS_PAYLOAD_MESSAGE = "Process request payload was invalid."'));
  assert.ok(pythonContract.includes('PROCESS_VIDEO_CONTRACT_VERSION = 3'));
  assert.ok(pythonApp.includes('code="INVALID_REQUEST_PAYLOAD"'));
  assert.ok(pythonApp.includes('stage=JobStage.WAITING_INPUT'));

  for (const field of ['contract_version', 'url', 'asr_model']) {
    assert.ok(typescript.includes(`'${field}'`), `TypeScript 缺少字段 ${field}`);
  }
  assert.ok(typescript.includes("INVALID_PROCESS_PAYLOAD_CODE = 'INVALID_REQUEST_PAYLOAD'"));
  assert.ok(typescript.includes("INVALID_PROCESS_PAYLOAD_MESSAGE = 'Process request payload was invalid.'"));
  assert.ok(tsContract.includes('PROCESS_VIDEO_CONTRACT_VERSION = 3'));
  assert.ok(tsContract.includes("'iic/SenseVoiceSmall-onnx'"));
});

test('url trimming uses the python whitespace set, not the javascript trim set', async () => {
  const typescript = await read(workerRoot, 'src', 'protocol', 'process-request.ts');
  const python = await read(pythonRoot, 'worker_core', 'requests.py');

  assert.ok(python.includes('url=url.strip()'), 'Python 的 URL 裁剪规则已变化');
  assert.ok(typescript.includes('\\u001c-\\u001f'), 'TypeScript 缺少 Python 专有空白 U+001C..U+001F');
  assert.ok(typescript.includes('\\u0085'), 'TypeScript 缺少 Python 专有空白 U+0085');
  assert.ok(!typescript.includes('rawUrl.trim()'), 'TypeScript 不能用 JS trim 近似 Python strip');
});

test('the cli wires --request-stdin to the URL pipeline', async () => {
  const pythonCli = await read(pythonRoot, 'worker_core', 'cli.py');
  const typescriptCli = await read(workerRoot, 'src', 'cli.ts');
  const service = await read(workerRoot, 'src', 'worker-service.ts');

  assert.ok(pythonCli.includes('"--request-stdin"'), 'Python CLI 的请求模式已变化');
  assert.ok(typescriptCli.includes("'--request-stdin'"), 'URL 管线已接通，参数必须注册');
  assert.ok(typescriptCli.includes('runProcessVideoOnce(payload'));
  assert.ok(service.includes('parseProcessVideoRequest(payload)'));
  assert.ok(service.includes('resolveYtdlpLauncher(environ, options.projectRoot)'));
});
