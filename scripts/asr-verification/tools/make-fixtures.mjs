// 一次性工具：从本地语料裁出固定 fixture 并写入 fixtures/manifest.json。
// 语料本身不进仓库（体积与授权），fixture 进仓库并由 sha256 固定，
// 因此门禁运行时不需要语料，只需要 fixtures 与模型缓存。
//
// 用法：node tools/make-fixtures.mjs <语料目录>
//   语料目录需含 monologue-pharma.wav 与 interview-finance.wav（16 kHz 单声道 16 位）。
import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {encodeWavMono16, readWavMono16, SAMPLE_RATE} from '../src/wav.mjs';
import {fileSha256} from '../src/model-dir.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.dirname(HERE);
const FIXTURE_DIR = path.join(PACKAGE_ROOT, 'fixtures');

const corpusDir = process.argv[2];
if (!corpusDir) throw new Error('用法：node tools/make-fixtures.mjs <语料目录>');

// offset 以样本为单位。选点标准：该窗口的 VAD 分段在 Python 生产实现与 TypeScript
// 实现之间必须完全一致（见 README「fixture 选点」）。边界落在临界帧上的窗口会因前端
// 1e-5 量级的浮点差异漂移 10~120ms，不能作为结构基线。
const SPECS = [
  {
    id: 'speech-12s',
    source: 'monologue-pharma.wav',
    offsetSamples: 160000,
    sampleCount: 12 * SAMPLE_RATE,
    note: '连续说话、单段但跨越 10 秒 VAD 分块边界，覆盖跨块缓存传递',
  },
  {
    id: 'dialogue-32s',
    source: 'interview-finance.wav',
    offsetSamples: 0,
    sampleCount: 32 * SAMPLE_RATE,
    note: '对话、4 段、4 个 VAD 分块，覆盖多段切分与块边界上的端点闭合',
  },
  {
    id: 'silence-3s',
    source: null,
    offsetSamples: 0,
    sampleCount: 3 * SAMPLE_RATE,
    note: '纯静音：VAD 必须给出零段并抛 ASR_EMPTY_TRANSCRIPT',
  },
];

const manifest = {
  note: 'fixture 由 tools/make-fixtures.mjs 从本地语料裁剪生成；语料不入库，fixture 入库并由 sha256 固定。重新生成会改变哈希，须同时重建 golden。',
  sampleRate: SAMPLE_RATE,
  fixtures: [],
};

for (const spec of SPECS) {
  let samples;
  if (spec.source === null) {
    samples = new Float32Array(spec.sampleCount);
  } else {
    const sourcePath = path.join(corpusDir, spec.source);
    const full = readWavMono16(sourcePath, readFileSync(sourcePath));
    if (spec.offsetSamples + spec.sampleCount > full.length) {
      throw new Error(`${spec.id} 超出语料长度：需要 ${spec.offsetSamples + spec.sampleCount}，实际 ${full.length}`);
    }
    samples = full.subarray(spec.offsetSamples, spec.offsetSamples + spec.sampleCount);
  }
  const file = `${spec.id}.wav`;
  const bytes = encodeWavMono16(samples);
  writeFileSync(path.join(FIXTURE_DIR, file), bytes);
  manifest.fixtures.push({
    id: spec.id,
    file,
    source: spec.source,
    offsetSamples: spec.offsetSamples,
    sampleCount: spec.sampleCount,
    sha256: fileSha256(path.join(FIXTURE_DIR, file)),
    note: spec.note,
  });
  console.log(`${file}  ${samples.length} 样本  ${bytes.length} 字节  ${manifest.fixtures.at(-1).sha256}`);
}

writeFileSync(path.join(FIXTURE_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log('已写入 fixtures/manifest.json');
