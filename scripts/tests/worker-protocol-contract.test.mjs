import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// TypeScript worker 的线协议守卫：前缀、契约版本、两条进度事件表必须与
// `contracts/desktop-worker-contract.json` 和 Python 的进度注册表逐项一致。
// 宿主按前缀分流 stderr、按 message_code 决定读哪些参数，漂移会直接表现为丢事件或判异常。

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workerRoot = resolve(repositoryRoot, "worker-ts");

const readJson = async (...segments) =>
  JSON.parse(await readFile(resolve(repositoryRoot, ...segments), "utf8"));

function stringConsts(source) {
  const found = {};
  for (const match of source.matchAll(/^export const ([A-Z0-9_]+) = '([^']*)';$/gm)) {
    found[match[1]] = match[2];
  }
  return found;
}

function numberConsts(source) {
  const found = {};
  for (const match of source.matchAll(/^export const ([A-Z0-9_]+) = (\d+);$/gm)) {
    found[match[1]] = Number(match[2]);
  }
  return found;
}

function parseWorkerProgressTable(source) {
  const table = {};
  for (const match of source.matchAll(/^ {2}'([a-z.]+)': \{allowedArgs: \[([^\]]*)\]\},$/gm)) {
    table[match[1]] = [...match[2].matchAll(/'([^']+)'/g)].map((item) => item[1]);
  }
  return table;
}

function parseModelProgressTable(source) {
  const table = {};
  for (const match of source.matchAll(
    /^ {2}'([a-z.]+)': \{status: '([a-z]+)', currentFile: '(required|forbidden)', messageArgs: \[([^\]]*)\]\},$/gm,
  )) {
    table[match[1]] = {
      status: match[2],
      current_file: match[3],
      allowedArgs: [...match[4].matchAll(/'([^']+)'/g)].map((item) => item[1]),
    };
  }
  return table;
}

function parsePythonWorkerRegistry(source) {
  const block = source.match(/WORKER_PROGRESS_REGISTRY[^=]*=\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(block, "progress_events.py 缺少 WORKER_PROGRESS_REGISTRY");
  const table = {};
  for (const match of block.matchAll(/"([a-z.]+)":\s*WorkerProgressSpec\(([^)]*)\)/g)) {
    table[match[1]] = [...match[2].matchAll(/"([^"]*)"/g)].map((item) => item[1]);
  }
  return table;
}

test("protocol constants match the desktop contract", async () => {
  const contract = await readJson("contracts", "desktop-worker-contract.json");
  const source = await readFile(resolve(workerRoot, "src/protocol/contract.ts"), "utf8");
  const strings = stringConsts(source);
  const numbers = numberConsts(source);

  assert.equal(strings.PROGRESS_EVENT_PREFIX, contract.events.workerProgressPrefix);
  assert.equal(strings.MODEL_DOWNLOAD_EVENT_PREFIX, contract.events.asrModelDownloadPrefix);
  assert.equal(strings.DIAGNOSTIC_EVENT_PREFIX, contract.events.workerDiagnosticPrefix);
  assert.equal(numbers.DESKTOP_WORKER_CONTRACT_VERSION, contract.contractVersion);
  assert.equal(
    numbers.LOCAL_MEDIA_CONTRACT_VERSION,
    contract.localMedia.workerRequest.properties.contract_version.const,
  );
  assert.equal(
    numbers.PROCESS_VIDEO_CONTRACT_VERSION,
    contract.processVideo.workerRequest.properties.contract_version.const,
  );
});

test("worker progress events match the contract and the python registry", async () => {
  const contract = await readJson("contracts", "desktop-worker-contract.json");
  const source = await readFile(resolve(workerRoot, "src/protocol/events.ts"), "utf8");
  const typescript = parseWorkerProgressTable(source);
  const expected = contract.progressEvents.worker.messageCodes;

  assert.ok(Object.keys(typescript).length >= 20, "events.ts 的进度表没有解析出来");
  assert.deepEqual(
    Object.keys(typescript).sort(),
    Object.keys(expected).sort(),
    "进度事件码必须与契约完全一致",
  );
  for (const [code, allowedArgs] of Object.entries(typescript)) {
    assert.deepEqual(allowedArgs, expected[code].allowedArgs, `${code} 的 allowedArgs 与契约不一致`);
  }

  const python = parsePythonWorkerRegistry(
    await readFile(resolve(repositoryRoot, "worker/worker_core/progress_events.py"), "utf8"),
  );
  assert.deepEqual(
    Object.keys(typescript).sort(),
    Object.keys(python).sort(),
    "进度事件码必须与 Python 注册表一致",
  );
  for (const [code, allowedArgs] of Object.entries(typescript)) {
    assert.deepEqual(allowedArgs, python[code], `${code} 的 allowedArgs 与 Python 不一致`);
  }
});

test("model download events match the contract", async () => {
  const contract = await readJson("contracts", "desktop-worker-contract.json");
  const source = await readFile(resolve(workerRoot, "src/asr/model-download.ts"), "utf8");
  const typescript = parseModelProgressTable(source);
  const expected = contract.progressEvents.asrModelDownload.messageCodes;

  assert.ok(Object.keys(typescript).length >= 8, "model-download.ts 的进度表没有解析出来");
  for (const [code, spec] of Object.entries(typescript)) {
    const reference = expected[code];
    assert.ok(reference, `契约里没有 ${code}`);
    assert.equal(spec.status, reference.status, `${code} 的 status 与契约不一致`);
    assert.equal(spec.current_file, reference.current_file, `${code} 的 current_file 约定与契约不一致`);
    assert.deepEqual(spec.allowedArgs, reference.allowedArgs, `${code} 的 allowedArgs 与契约不一致`);
  }
});

test("worker stages match the contract's stage list", async () => {
  const source = await readFile(resolve(workerRoot, "src/protocol/events.ts"), "utf8");
  const block = source.match(/WORKER_PROGRESS_STAGES = \[([\s\S]*?)\] as const;/)?.[1];
  assert.ok(block, "events.ts 缺少 WORKER_PROGRESS_STAGES");
  const stages = [...block.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
  assert.ok(stages.includes("video_transcribing"));
  assert.equal(new Set(stages).size, stages.length, "stage 不能重复");
});

test("the local media request parser matches the contract's request shape", async () => {
  const contract = await readJson("contracts", "desktop-worker-contract.json");
  const source = await readFile(resolve(workerRoot, "src/protocol/requests.ts"), "utf8");
  const block = source.match(/const LOCAL_MEDIA_REQUEST_FIELDS = new Set\(\[([\s\S]*?)\]\);/)?.[1];
  assert.ok(block, "requests.ts 缺少 LOCAL_MEDIA_REQUEST_FIELDS");
  const fields = [...block.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);

  const request = contract.localMedia.workerRequest;
  assert.deepEqual(fields.sort(), Object.keys(request.properties).sort(), "请求字段必须与契约完全一致");
  assert.deepEqual(fields.sort(), [...request.required].sort(), "契约里每个字段都是必填");
  assert.equal(request.additionalProperties, false, "契约不允许额外字段，解析器也必须拒止");
});

test("the extension sets match the contract's extensionsByKind", async () => {
  const contract = await readJson("contracts", "desktop-worker-contract.json");
  const source = await readFile(resolve(workerRoot, "src/protocol/contract.ts"), "utf8");

  const parseSet = (name) => {
    const block = source.match(new RegExp(`export const ${name}: ReadonlySet<string> = new Set\\(\\[([\\s\\S]*?)\\]\\);`))?.[1];
    assert.ok(block, `contract.ts 缺少 ${name}`);
    return [...block.matchAll(/'([a-z0-9]+)'/g)].map((match) => match[1]).sort();
  };

  assert.deepEqual(parseSet("VIDEO_EXTENSIONS"), [...contract.localMedia.extensionsByKind.video].sort());
  assert.deepEqual(parseSet("AUDIO_EXTENSIONS"), [...contract.localMedia.extensionsByKind.audio].sort());

  const modelBlock = source.match(/export const DESKTOP_ASR_MODELS: ReadonlySet<string> = new Set\(\[([\s\S]*?)\]\);/)?.[1];
  assert.ok(modelBlock, "contract.ts 缺少 DESKTOP_ASR_MODELS");
  const models = [...modelBlock.matchAll(/'([^']+)'/g)].map((match) => match[1]).sort();
  const request = contract.localMedia.workerRequest.properties.asr_model.enum;
  assert.deepEqual(models, [...request].sort(), "模型闭集必须与契约一致");
});

test("the cli registers only the modes implemented in this package", async () => {
  const contract = await readJson("contracts", "desktop-worker-contract.json");
  const source = await readFile(resolve(workerRoot, "src/cli.ts"), "utf8");
  // 只取「模式开关」：`argument === '--x'` 后面紧跟着把某个布尔量置 true。
  // `--asr-model` 这类带值的参数不是模式，不能算进来。
  const flags = [...source.matchAll(/argument === '(--[a-z-]+)'\) \{\s*\n\s*\w+ = true;/g)]
    .map((match) => match[1])
    .sort();

  // 未迁移的模式不注册参数：宿主传进来会以退出码 2 明确失败，而不是静默成功。
  // `--request-stdin` 随 URL 下载管线一起接通；`--web-operation-id`
  // 带值、不是模式开关，不进这份闭集；`--probe-llm-stdin` 是 BYOK 探针模式。
  assert.deepEqual(flags, [
    "--download-asr-model", "--probe-llm-stdin", "--process-local-media-stdin",
    "--request-stdin", "--resolve-source-stdin", "--retry-insights-stdin",
    "--save-web-page-stdin",
  ]);
  assert.equal(contract.localMedia.workerMode, "--process-local-media-stdin");
  assert.equal(contract.aiGeneration.command, "retry_insights");
});

test("the retry request parser matches the contract and the Python field set", async () => {
  const contract = await readJson("contracts", "desktop-worker-contract.json");
  const source = await readFile(resolve(workerRoot, "src/protocol/retry-request.ts"), "utf8");
  const python = await readFile(resolve(repositoryRoot, "worker/worker_core/requests.py"), "utf8");

  const readFields = (text, pattern, name) => {
    const block = text.match(pattern)?.[1];
    assert.ok(block, `缺少 ${name}`);
    return [...block.matchAll(/["']([a-z_]+)["']/g)].map((match) => match[1]).sort();
  };

  const fields = readFields(
    source,
    /const RETRY_REQUEST_FIELDS = new Set\(\[([\s\S]*?)\]\);/,
    "TS RETRY_REQUEST_FIELDS",
  );
  assert.deepEqual(
    fields,
    readFields(
      python,
      /RETRY_REQUEST_FIELDS = frozenset\(\s*\{([\s\S]*?)\}\s*\)/,
      "Python RETRY_REQUEST_FIELDS",
    ),
    "字段集合必须与 Python 完全一致",
  );
  const shape = contract.aiGeneration.request;
  assert.deepEqual(shape.required.slice().sort(), ["output_language", "target", "task_id"]);
  assert.equal(shape.additionalProperties, false);
  for (const key of Object.keys(shape.properties)) {
    assert.ok(fields.includes(key), `契约字段 ${key} 必须被解析器接受`);
  }

  const targetsBlock = source.match(/export const RETRY_TARGETS = \[([\s\S]*?)\] as const;/)?.[1];
  assert.ok(targetsBlock, "缺少 RETRY_TARGETS");
  const targets = [...targetsBlock.matchAll(/'([a-z]+)'/g)].map((match) => match[1]).sort();
  assert.deepEqual(targets, shape.properties.target.enum.slice().sort());

  const implemented = source.match(/export const IMPLEMENTED_RETRY_TARGETS: readonly RetryTarget\[\] = ([^;]+);/)?.[1];
  assert.ok(implemented, "缺少 IMPLEMENTED_RETRY_TARGETS");
  // 六个 target 全部实现时直接复用契约闭集；迁移过程中曾是它的子集。
  assert.equal(implemented.trim(), "RETRY_TARGETS", "所有契约 target 都必须有生成链");
  assert.deepEqual(targets, shape.properties.target.enum.slice().sort());

  const languages = await readFile(resolve(workerRoot, "src/ai/output-language.ts"), "utf8");
  const languagesBlock = languages.match(/export const SUPPORTED_OUTPUT_LANGUAGES[\s\S]*?= \[([\s\S]*?)\]/)?.[1];
  assert.ok(languagesBlock, "缺少 SUPPORTED_OUTPUT_LANGUAGES");
  const supported = [...languagesBlock.matchAll(/'([^']+)'/g)].map((match) => match[1]).sort();
  assert.deepEqual(supported, shape.properties.output_language.enum.slice().sort());
});
