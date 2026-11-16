#!/usr/bin/env node
// TypeScript ASR 路径的可复现门禁。
//
// 用法：
//   node --experimental-strip-types run.mjs [--cache-dir <模型缓存目录>] [--only <fixture>]
//                                          [--json <路径>] [--freeze]
//
// 门禁直接调用生产代码 worker-ts/src/asr（`createTranscriber`），不维护第二份实现。
// 判定分三层，任一层失败即以非零码退出：
//   1. 资产：模型文件 SHA-256 与 fixture 哈希必须与固定值一致。
//   2. 结构：VAD 分段必须与生产 Python 基线逐毫秒相同。
//   3. 文本：必须与本机 golden 逐字相同（回归），且相对生产基线的 CER 不超过阈值。
//
// --freeze 只在明确知道结果正确时使用：它会把当前输出写成该平台的 golden。
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {characterErrorRate} from './src/metrics.mjs';

const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const FIXTURE_DIR = path.join(PACKAGE_ROOT, 'fixtures');
const GOLDEN_DIR = path.join(PACKAGE_ROOT, 'golden');
const WORKER_TS = path.join(REPO_ROOT, 'worker-ts');

// 生产代码是 TypeScript：Node 22 需要显式开启类型剥离，Deno 与 Node >=23.6 原生支持。
const asr = await import(pathToFileURL(path.join(WORKER_TS, 'src', 'asr', 'index.ts')).href);

function parseArgs(argv) {
  const options = {freeze: false, only: null, json: null, cacheDir: null};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--freeze') options.freeze = true;
    else if (arg === '--only') options.only = argv[++index];
    else if (arg === '--json') options.json = argv[++index];
    else if (arg === '--cache-dir') options.cacheDir = argv[++index];
    else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

const readJson = (filePath) => JSON.parse(readFileSync(filePath, 'utf8'));

function installedRuntimeVersion() {
  const pkgPath = path.join(WORKER_TS, 'node_modules', 'onnxruntime-node', 'package.json');
  if (!existsSync(pkgPath)) return 'not-installed';
  return readJson(pkgPath).version ?? 'unknown';
}

const options = parseArgs(process.argv.slice(2));
const pinned = readJson(path.join(PACKAGE_ROOT, 'assets.json'));
const policy = readJson(path.join(GOLDEN_DIR, 'policy.json'));
const platform = `${process.platform}-${process.arch}`;
const cacheDir = options.cacheDir
  ?? process.env.LOCUS_ASR_CACHE_DIR
  ?? path.join(REPO_ROOT, 'models', 'onnx');

if (!existsSync(cacheDir)) {
  console.error(`模型缓存目录不存在：${cacheDir}`);
  console.error('请用 --cache-dir 指向 <数据根>/models/onnx，或先由 worker 的模型下载器准备资产。');
  process.exit(2);
}

const failures = [];
const report = {
  generated_at: new Date().toISOString(),
  platform,
  runtime: {node: process.version, engine: pinned.engine.package, version: installedRuntimeVersion()},
  cache_dir: cacheDir,
  dither: policy.dither,
  cases: [],
};

// 1. fixture 完整性
const fixtureManifest = readJson(path.join(FIXTURE_DIR, 'manifest.json'));
for (const fixture of fixtureManifest.fixtures) {
  const bytes = readFileSync(path.join(FIXTURE_DIR, fixture.file));
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== fixture.sha256) {
    failures.push({case: fixture.id, check: 'fixture_sha256', expected: fixture.sha256, actual});
  }
}
if (report.runtime.version !== pinned.engine.version) {
  failures.push({
    case: '*',
    check: 'runtime_version',
    expected: pinned.engine.version,
    actual: report.runtime.version,
  });
}

// 2. 模型资产与适配器装配：哈希不符时 createTranscriber 抛 ASR_MODEL_NOT_DOWNLOADED
let transcriber;
try {
  transcriber = await asr.createTranscriber({
    dataRoot: path.dirname(path.dirname(cacheDir)),
    cacheDir,
    model: 'iic/SenseVoiceSmall-onnx',
    language: 'Chinese',
    dither: policy.dither,
  });
} catch (error) {
  const detail = asr.isASRError(error) ? JSON.stringify(error.toJSON()) : String(error?.message ?? error);
  console.error(`资产校验或模型加载失败（${error?.code ?? 'unknown'}）：${detail}`);
  process.exit(2);
}

const referencePath = path.join(GOLDEN_DIR, 'production-reference.json');
const reference = existsSync(referencePath) ? readJson(referencePath) : null;

const selected = fixtureManifest.fixtures.filter((item) => !options.only || item.id === options.only);
if (!selected.length) {
  console.error(`没有匹配的 fixture：${options.only}`);
  process.exit(2);
}

for (const fixture of selected) {
  const wavPath = path.join(FIXTURE_DIR, fixture.file);
  const expectedReference = reference?.cases?.[fixture.id] ?? null;
  const caseReport = {
    case: fixture.id,
    wav_sha256: fixture.sha256,
    checks: [],
    failures: [],
  };

  let actual = null;
  let errorCode = null;
  let errorMessage = null;
  const started = performance.now();
  try {
    actual = await transcriber.transcribe(wavPath);
  } catch (error) {
    errorCode = asr.isASRError(error) ? error.code : 'unexpected_error';
    errorMessage = error?.message ?? String(error);
  }
  caseReport.elapsed_ms = Math.round(performance.now() - started);

  if (expectedReference?.empty === true) {
    const passed = errorCode === asr.ASR_ERROR_CODES.emptyTranscript;
    caseReport.checks.push({name: 'empty_transcript', passed, detail: errorCode ?? '未抛错'});
    if (!passed) {
      caseReport.failures.push(`期望 ${asr.ASR_ERROR_CODES.emptyTranscript}，实际 ${errorCode ?? '成功返回'}`);
    }
  } else if (errorCode !== null) {
    caseReport.checks.push({name: 'transcribe', passed: false, detail: `${errorCode}: ${errorMessage}`});
    caseReport.failures.push(`转写失败：${errorCode} ${errorMessage}`);
  } else {
    const segments = actual.segments.map((segment) => [segment.start_ms, segment.end_ms]);
    caseReport.segments = segments;
    caseReport.segment_ids = actual.segments.map((segment) => segment.id);
    caseReport.segment_texts = actual.segments.map((segment) => segment.text);
    caseReport.text = actual.text;
    caseReport.char_count = actual.text.length;

    // 结构：必须与生产基线逐毫秒相同
    if (expectedReference) {
      const same = JSON.stringify(expectedReference.segments) === JSON.stringify(segments);
      caseReport.checks.push({name: 'segments_vs_production', passed: same});
      if (!same) {
        caseReport.failures.push(
          `分段与生产基线不同：期望 ${JSON.stringify(expectedReference.segments)}，实际 ${JSON.stringify(segments)}`,
        );
      }
      const cer = characterErrorRate(expectedReference.text, actual.text);
      caseReport.cer_vs_production = cer.rate;
      caseReport.cer_distance = cer.distance;
      const cerOk = cer.rate === null || cer.rate <= policy.textCerTolerance;
      caseReport.checks.push({
        name: 'cer_vs_production',
        passed: cerOk,
        detail: cer.rate === null ? '生产基线为空' : `${(cer.rate * 100).toFixed(3)}%`,
      });
      if (!cerOk) {
        caseReport.failures.push(
          `相对生产基线 CER ${(cer.rate * 100).toFixed(3)}% 超过阈值 ${(policy.textCerTolerance * 100).toFixed(1)}%`,
        );
      }
    }

    // 文本：与同平台 golden 逐字相同
    const goldenPath = path.join(GOLDEN_DIR, platform, `${fixture.id}.json`);
    if (options.freeze) {
      mkdirSync(path.join(GOLDEN_DIR, platform), {recursive: true});
      writeFileSync(goldenPath, `${JSON.stringify({
        case: fixture.id,
        platform,
        wav_sha256: fixture.sha256,
        runtime: report.runtime,
        dither: policy.dither,
        segments,
        segment_texts: caseReport.segment_texts,
        text: actual.text,
      }, null, 2)}\n`);
      caseReport.checks.push({name: 'freeze', passed: true, detail: `已写入 ${goldenPath}`});
    } else if (!existsSync(goldenPath)) {
      caseReport.checks.push({name: 'text_vs_golden', passed: false, detail: '缺少 golden'});
      caseReport.failures.push(
        `缺少 ${platform} 的 golden：先人工确认输出正确，再执行 npm run freeze 生成 ${goldenPath}`,
      );
    } else {
      const golden = readJson(goldenPath);
      const textSame = golden.text === actual.text;
      const segmentsSame = JSON.stringify(golden.segment_texts) === JSON.stringify(caseReport.segment_texts);
      const passed = textSame && segmentsSame;
      caseReport.checks.push({name: 'text_vs_golden', passed, detail: passed ? '逐字相同' : '存在差异'});
      if (!passed) {
        const diff = characterErrorRate(golden.text, actual.text);
        caseReport.failures.push(
          `与本机 golden 不同（逐段文本 ${segmentsSame ? '同' : '异'}、全文编辑距离 ${diff.distance ?? 'n/a'}）；`
          + '若确认是新基线，重新 freeze',
        );
      }
    }
  }

  for (const failure of caseReport.failures) failures.push({case: fixture.id, check: 'case', detail: failure});
  report.cases.push(caseReport);
}

transcriber.dispose();

report.failures = failures;
report.passed = failures.length === 0;

const pad = (value, width) => String(value).padEnd(width);
console.log(`平台 ${platform}  |  ${pinned.engine.package}@${report.runtime.version}  |  Node ${process.version}`);
console.log(`模型缓存 ${cacheDir}`);
console.log(`dither=${policy.dither}（生产默认 1.0，随机不可复现）  CER 阈值 ${(policy.textCerTolerance * 100).toFixed(1)}%\n`);
console.log(`${pad('case', 16)}${pad('段', 4)}${pad('字符', 6)}${pad('CER', 10)}${pad('耗时', 8)}结果`);
for (const item of report.cases) {
  const cer = item.cer_vs_production === undefined || item.cer_vs_production === null
    ? '-'
    : `${(item.cer_vs_production * 100).toFixed(3)}%`;
  const ok = item.failures.length === 0;
  console.log(
    `${pad(item.case, 16)}${pad(item.segments?.length ?? 0, 4)}${pad(item.char_count ?? 0, 6)}`
    + `${pad(cer, 10)}${pad(`${item.elapsed_ms}ms`, 8)}${ok ? 'PASS' : 'FAIL'}`,
  );
}

if (!report.passed) {
  console.error('\n失败项：');
  for (const failure of failures) {
    console.error(`  [${failure.case}] ${failure.check}: ${failure.detail ?? `${failure.expected} != ${failure.actual}`}`);
  }
}

if (options.json) {
  writeFileSync(options.json, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n报告已写入 ${options.json}`);
}

console.log(report.passed ? '\n门禁通过' : '\n门禁失败');
process.exit(report.passed ? 0 : 1);
