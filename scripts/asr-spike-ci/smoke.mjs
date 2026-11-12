// macOS 平台加载验证：在 CI 上用模型归档自带 test_wavs 运行 sherpa-onnx-node 全链路。
// 运行：node scripts/asr-spike-ci/smoke.mjs <模型目录> <test_wavs目录> <输出JSON路径>
// macOS 需要 DYLD_LIBRARY_PATH 指向 node_modules/sherpa-onnx-node/lib，由 workflow 设置。
import {readdirSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import sherpaOnnx from 'sherpa-onnx-node';

const {OfflineRecognizer, Vad, readWave} = sherpaOnnx;

const [modelDir, wavsDir, outputPath] = process.argv.slice(2);
if (!modelDir || !wavsDir || !outputPath) {
  throw new Error('用法：node smoke.mjs <模型目录> <test_wavs目录> <输出JSON路径>');
}
const modelPath = path.join(modelDir, 'model.int8.onnx');
const tokensPath = path.join(modelDir, 'tokens.txt');
const vadModelPath = path.join(modelDir, 'silero_vad.onnx');
for (const filePath of [modelPath, tokensPath, vadModelPath]) {
  if (!statSync(filePath).isFile()) {
    throw new Error(`模型文件缺失：${filePath}`);
  }
}

const loadStart = performance.now();
const vad = new Vad(
  {
    sileroVad: {
      model: vadModelPath,
      threshold: 0.5,
      minSpeechDuration: 0.25,
      minSilenceDuration: 0.5,
      windowSize: 512,
      maxSpeechDuration: 20,
    },
    sampleRate: 16000,
    numThreads: 4,
    provider: 'cpu',
  },
  60,
);
const recognizer = new OfflineRecognizer({
  featConfig: {sampleRate: 16000, featureDim: 80},
  modelConfig: {
    senseVoice: {model: modelPath, language: 'zh', useInverseTextNormalization: 1},
    tokens: tokensPath,
    numThreads: 4,
    provider: 'cpu',
  },
});
const modelLoadMs = Math.round(performance.now() - loadStart);

const wavNames = readdirSync(wavsDir).filter((name) => name.endsWith('.wav')).sort();
if (wavNames.length === 0) {
  throw new Error(`test_wavs 目录为空：${wavsDir}`);
}

const results = [];
for (const name of wavNames) {
  const wave = readWave(path.join(wavsDir, name));
  if (wave.sampleRate !== 16000) {
    throw new Error(`采样率不符：${name} 实际 ${wave.sampleRate}`);
  }
  vad.reset();
  const segments = [];
  const drain = () => {
    while (!vad.isEmpty()) {
      const front = vad.front();
      segments.push({start: front.start, samples: front.samples});
      vad.pop();
    }
  };
  const windowSize = 512;
  for (let offset = 0; offset < wave.samples.length; offset += windowSize) {
    vad.acceptWaveform(
      wave.samples.subarray(offset, Math.min(offset + windowSize, wave.samples.length)),
    );
    drain();
  }
  vad.flush();
  drain();
  if (segments.length === 0) {
    throw new Error(`VAD 未检测到语音：${name}`);
  }
  const texts = [];
  for (const speech of segments) {
    const stream = recognizer.createStream();
    stream.acceptWaveform({samples: speech.samples, sampleRate: 16000});
    recognizer.decode(stream);
    const result = recognizer.getResult(stream);
    const text = result.text.replace(/<\|[^|>]+?\|>/g, '').trim();
    if (!text) {
      throw new Error(`识别结果为空：${name}`);
    }
    texts.push(text);
  }
  results.push({file: name, vad_segments: segments.length, text: texts.join(' ')});
  console.log(`${name} 分段 ${segments.length} 文本 ${texts.join(' ')}`);
}

const payload = {
  platform: process.platform,
  arch: process.arch,
  node_version: process.version,
  sherpa_onnx_node_version: sherpaOnnx.version,
  onnxruntime_version: sherpaOnnx.onnxruntimeVersion,
  model_load_ms: modelLoadMs,
  results,
};
writeFileSync(outputPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
console.log(`平台验证结果已写入 ${outputPath}`);