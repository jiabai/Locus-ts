import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// ASR 门禁的静态守卫：不需要模型文件，在 CI 上校验生产资产清单、fixture、golden 与
// Python 下载器之间没有漂移。真正的推理比对由 scripts/asr-verification/run.mjs 执行。

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const gateRoot = resolve(repositoryRoot, "scripts/asr-verification");
const workerRoot = resolve(repositoryRoot, "worker-ts");

const readJson = async (...segments) =>
  JSON.parse(await readFile(resolve(gateRoot, ...segments), "utf8"));
const readJsonFile = async (filePath) => JSON.parse(await readFile(filePath, "utf8"));

function parsePythonAssetHashes(source) {
  const bpeConstant = source.match(/^ONNX_BPE_FILE_NAME = "([^"]+)"$/m)?.[1];
  assert.ok(bpeConstant, "model_download.py 缺少 ONNX_BPE_FILE_NAME");
  const block = source.match(/ONNX_REQUIRED_ASSET_HASHES[^=]*=\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(block, "model_download.py 缺少 ONNX_REQUIRED_ASSET_HASHES");
  const hashes = {};
  for (const match of block.matchAll(/Path\(f?"([^"]+)"\):\s*\n?\s*"([0-9a-f]{64})"/g)) {
    hashes[match[1].replace("{ONNX_BPE_FILE_NAME}", bpeConstant)] = match[2];
  }
  return hashes;
}

// model-assets.ts 是 TypeScript，静态测试不引入类型剥离，因此按结构解析。
function parseTypeScriptAssetHashes(source) {
  const senseVoiceId = source.match(/SENSEVOICE_MODEL_ID = ['"]([^'"]+)['"]/)?.[1];
  const vadId = source.match(/VAD_MODEL_ID = ['"]([^'"]+)['"]/)?.[1];
  assert.ok(senseVoiceId && vadId, "model-assets.ts 缺少模型标识");
  const variableToPath = {
    ASR_MODEL_DIR: `models/${senseVoiceId}`,
    VAD_MODEL_DIR: `models/${vadId}`,
  };
  const collect = (name) => {
    const block = source.match(new RegExp(`${name}[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};`))?.[1];
    assert.ok(block, `model-assets.ts 缺少 ${name}`);
    const hashes = {};
    for (const match of block.matchAll(/\[`\$\{(\w+)\}\/([^`]+)`\]:\s*\n?\s*'([0-9a-f]{64})'/g)) {
      const prefix = variableToPath[match[1]];
      assert.ok(prefix, `model-assets.ts 使用了未知目录常量 ${match[1]}`);
      hashes[`${prefix}/${match[2]}`] = match[3];
    }
    return hashes;
  };
  return {
    required: collect("ONNX_REQUIRED_ASSET_HASHES"),
    additional: collect("ADDITIONAL_ASSET_HASHES"),
  };
}

test("production asset pins match the python model downloader", async () => {
  const source = await readFile(resolve(workerRoot, "src/asr/model-assets.ts"), "utf8");
  const pythonSource = await readFile(resolve(repositoryRoot, "worker/worker_core/model_download.py"), "utf8");
  const production = parseTypeScriptAssetHashes(source);
  const python = parsePythonAssetHashes(pythonSource);

  assert.deepEqual(
    production.required,
    python,
    "model-assets.ts 的 ONNX_REQUIRED_ASSET_HASHES 必须与 worker_core/model_download.py 逐项一致",
  );
  assert.ok(
    Object.keys(production.additional).length >= 2,
    "ADDITIONAL_ASSET_HASHES 必须覆盖 VAD 的 config.yaml 与 am.mvn，否则 VAD 参数变化不会被发现",
  );
  for (const key of Object.keys(production.additional)) {
    assert.match(key, /^models\/iic\//, `附加哈希应指向 models/iic：${key}`);
  }

  const gateAssets = await readJson("assets.json");
  assert.equal(
    gateAssets.models.pinnedBy,
    "worker-ts/src/asr/model-assets.ts",
    "门禁不得再自带一份模型哈希",
  );
});

test("model download progress codes match the python registry", async () => {
  // 模型下载的进度事件直接进桌面 UI，Python 侧的 `build_model_progress_event` 会
  // 逐项校验（未知码、状态不符、current_file 该有没有、message_args 越界都拒收）。
  // TypeScript 侧不能另造一套，这里把两张表对起来。
  const tsSource = await readFile(resolve(workerRoot, "src/asr/model-download.ts"), "utf8");
  const pythonSource = await readFile(resolve(repositoryRoot, "worker/worker_core/progress_events.py"), "utf8");

  const tsSpecs = {};
  for (const match of tsSource.matchAll(
    /'([a-z.]+)':\s*\{status:\s*'([a-z]+)',\s*currentFile:\s*'([a-z]+)',\s*messageArgs:\s*\[([^\]]*)\]/g,
  )) {
    tsSpecs[match[1]] = {
      status: match[2],
      currentFile: match[3],
      args: [...match[4].matchAll(/'([^']+)'/g)].map((item) => item[1]),
    };
  }
  assert.ok(Object.keys(tsSpecs).length >= 8, "model-download.ts 的进度表没有解析出来");

  const pythonBlock = pythonSource.match(/MODEL_PROGRESS_REGISTRY[^=]*=\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(pythonBlock, "progress_events.py 缺少 MODEL_PROGRESS_REGISTRY");
  const pythonSpecs = {};
  for (const match of pythonBlock.matchAll(/"(model\.[a-z.]+)":\s*ModelProgressSpec\(/g)) {
    let depth = 1;
    let index = match.index + match[0].length;
    while (index < pythonBlock.length && depth > 0) {
      if (pythonBlock[index] === "(") depth += 1;
      if (pythonBlock[index] === ")") depth -= 1;
      index += 1;
    }
    const literals = [...pythonBlock.slice(match.index, index).matchAll(/"([^"]*)"/g)].map((item) => item[1]);
    pythonSpecs[match[1]] = { status: literals[1], currentFile: literals[2], args: literals.slice(3) };
  }

  for (const [code, spec] of Object.entries(tsSpecs)) {
    const reference = pythonSpecs[code];
    assert.ok(reference, `Python 进度注册表里没有 ${code}`);
    assert.equal(spec.status, reference.status, `${code} 的 status 与 Python 不一致`);
    assert.equal(spec.currentFile, reference.currentFile, `${code} 的 current_file 约定与 Python 不一致`);
    assert.deepEqual(
      spec.args.slice().sort(),
      reference.args.slice().sort(),
      `${code} 的 message_args 与 Python 允许的键不一致`,
    );
  }
});

test("runtime pins agree across worker package, assets and deno config", async () => {
  const workerPackage = await readJsonFile(resolve(workerRoot, "package.json"));
  const gateAssets = await readJson("assets.json");
  const gatePackage = await readJson("package.json");
  const deno = await readJson("deno.json");

  assert.equal(
    workerPackage.dependencies["onnxruntime-node"],
    gateAssets.engine.version,
    "worker-ts 与门禁记录的 onnxruntime-node 版本必须一致",
  );
  assert.equal(workerPackage.dependencies["onnxruntime-node"], "1.29.0",
    "onnxruntime-node 版本偏离 1.29.0 会改变低置信帧的 argmax，须重新生成全部 golden");
  assert.equal(
    gatePackage.dependencies?.["onnxruntime-node"],
    undefined,
    "门禁必须复用 worker-ts 的依赖，不能再装一份原生库",
  );
  assert.equal(deno.nodeModulesDir, "manual",
    "Deno 需要 nodeModulesDir=manual 才能解析随包 node_modules");
  assert.deepEqual(
    gateAssets.deno.permissions,
    ["--allow-read", "--allow-write", "--allow-ffi"],
    "缺 --allow-ffi 时 Deno 无法加载 onnxruntime 原生模块",
  );
});

test("the native runtime stays behind the ASR adapter", async () => {
  // 任务流程只能依赖 `src/asr/index.ts`；原生库与实现细节不得泄漏到其他模块或门禁。
  const collect = async (dir) => {
    const entries = await readdir(dir, {withFileTypes: true, recursive: true});
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => resolve(entry.parentPath ?? entry.path, entry.name));
  };
  const sources = await collect(resolve(workerRoot, "src"));

  const nativeUsers = [];
  for (const file of sources) {
    const text = await readFile(file, "utf8");
    if (/from ['"]onnxruntime-node['"]|import\(['"]onnxruntime-node['"]\)/.test(text)) {
      nativeUsers.push(file.slice(repositoryRoot.length + 1).replaceAll("\\", "/"));
    }
  }
  assert.deepEqual(
    nativeUsers,
    ["worker-ts/src/asr/sensevoice.ts"],
    "只有 SenseVoice 适配器可以直接依赖 onnxruntime-node",
  );

  const gateEntry = await readFile(resolve(gateRoot, "run.mjs"), "utf8");
  assert.ok(
    gateEntry.includes("path.join(WORKER_TS, 'src', 'asr', 'index.ts')"),
    "门禁必须导入生产 ASR 代码（src/asr/index.ts），不能自带实现",
  );
  const asrSpecifiers = [...gateEntry.matchAll(/'src',\s*'asr',\s*'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(
    asrSpecifiers,
    ["index.ts"],
    "门禁只能通过公共入口导入 ASR，不能直接摸实现细节",
  );
});

test("fixtures are hash-pinned and cover the required branches", async () => {
  const manifest = await readJson("fixtures/manifest.json");
  assert.ok(manifest.fixtures.length >= 3, "至少需要连续语音、多段对话、静音三类 fixture");

  for (const fixture of manifest.fixtures) {
    const bytes = await readFile(resolve(gateRoot, "fixtures", fixture.file));
    const digest = createHash("sha256").update(bytes).digest("hex");
    assert.equal(digest, fixture.sha256, `${fixture.file} 的 SHA-256 与 manifest 不一致`);
    assert.equal(bytes.subarray(0, 4).toString("ascii"), "RIFF", `${fixture.file} 不是 RIFF/WAVE`);
    assert.equal(bytes.readUInt32LE(24), 16000, `${fixture.file} 不是 16 kHz`);
    assert.equal(bytes.readUInt16LE(22), 1, `${fixture.file} 不是单声道`);
    assert.equal(bytes.readUInt16LE(34), 16, `${fixture.file} 不是 16 位`);
    assert.equal(Math.floor((bytes.length - 44) / 2), fixture.sampleCount,
      `${fixture.file} 的样本数与 manifest 不一致`);
  }

  assert.ok(manifest.fixtures.some((item) => item.source === null),
    "缺少静音或空输入用例，无语音分支不会被覆盖");
});

test("production reference and golden cover every fixture", async () => {
  const manifest = await readJson("fixtures/manifest.json");
  const reference = await readJson("golden/production-reference.json");
  const policy = await readJson("golden/policy.json");

  assert.equal(policy.dither, 0, "门禁必须用 dither=0，生产 dither=1.0 不可逐位复现");
  assert.equal(policy.textCerTolerance, 0.005, "CER 阈值必须与产品规格的 0.5 个百分点一致");

  const fixtureIds = manifest.fixtures.map((item) => item.id).sort();
  assert.deepEqual(Object.keys(reference.cases).sort(), fixtureIds,
    "生产基线必须覆盖全部 fixture");

  for (const fixture of manifest.fixtures) {
    assert.equal(reference.cases[fixture.id].wav_sha256, fixture.sha256,
      `${fixture.id} 的生产基线绑定的是另一份音频`);
    const empty = reference.cases[fixture.id].empty === true;
    if (empty) {
      assert.equal(fixture.source, null, "只有静音用例允许期望空转写");
    } else {
      assert.ok(reference.cases[fixture.id].segments.length > 0,
        `${fixture.id} 的生产基线没有任何分段`);
    }
  }

  const platforms = await readdir(resolve(gateRoot, "golden"), {withFileTypes: true});
  const platformDirs = platforms.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  assert.ok(platformDirs.length > 0, "至少需要一个平台的 golden");

  for (const platform of platformDirs) {
    for (const fixture of manifest.fixtures) {
      if (reference.cases[fixture.id].empty === true) continue;
      const golden = await readJson("golden", platform, `${fixture.id}.json`);
      assert.equal(golden.wav_sha256, fixture.sha256, `${platform}/${fixture.id} 绑定了另一份音频`);
      assert.equal(golden.dither, 0, `${platform}/${fixture.id} 必须记录 dither=0`);
      assert.ok(golden.text.length > 0, `${platform}/${fixture.id} 的文本为空`);
      assert.equal(golden.segments.length, golden.segment_texts.length,
        `${platform}/${fixture.id} 的分段数与文本数不一致`);
      assert.deepEqual(golden.segments, reference.cases[fixture.id].segments,
        `${platform}/${fixture.id} 的分段必须与生产基线一致；不一致说明门禁会把已知偏差当成通过`);
      assert.equal(golden.segment_texts.join(" "), golden.text,
        `${platform}/${fixture.id} 的全文必须等于逐段文本以空格拼接`);
    }
  }
});
