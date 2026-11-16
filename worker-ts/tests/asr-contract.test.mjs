import assert from "node:assert/strict";
import test from "node:test";

import { decodeTokens, greedyDecode } from "../src/asr/ctc.ts";
import { parseCmvn, applyCmvn } from "../src/asr/cmvn.ts";
import { parseModelConfig, readAsrConfig, readVadConfig } from "../src/asr/config.ts";
import { readWavMono16 } from "../src/asr/audio.ts";
import { assertSupportedModel } from "../src/asr/types.ts";

// 纯函数层面的契约与失败语义：不需要模型，也不需要 onnxruntime。

test("supported model list is a closed set and legacy ids are rejected", () => {
  assert.equal(assertSupportedModel("iic/SenseVoiceSmall-onnx"), "iic/SenseVoiceSmall-onnx");
  for (const legacy of ["iic/SenseVoiceSmall", "something/else"]) {
    assert.throws(() => assertSupportedModel(legacy), (error) => {
      assert.equal(error.code, "ASR_MODEL_UNSUPPORTED");
      return true;
    });
  }
});

test("greedy decode folds repeats and drops blank frames", () => {
  // 3 帧、4 类：0=blank，2 连续出现只保留一次，1 与 2 之间有空帧不折叠。
  const vocab = 4;
  const rows = [
    [0.1, 0.7, 0.1, 0.1],
    [0.1, 0.7, 0.1, 0.1],
    [0.7, 0.1, 0.1, 0.1],
    [0.1, 0.1, 0.9, 0.0],
    [0.1, 0.1, 0.9, 0.0],
  ];
  const data = new Float32Array(rows.flat());
  assert.deepEqual(greedyDecode({ data, frames: 5, vocab }, 5), [1, 2]);
  // validFrames 取 encoder_out_lens，可以短于 logits 的帧数。
  assert.deepEqual(greedyDecode({ data, frames: 5, vocab }, 3), [1]);
  assert.deepEqual(greedyDecode({ data, frames: 5, vocab }, 0), []);
});

test("token decoding restores spaces and strips SenseVoice tags", () => {
  const tokens = ["<blank>", "\u2581hello", " world", "<|zh|>", "<|HAPPY|>", "\u2581again"];
  assert.equal(decodeTokens([1, 2, 3, 4, 5], tokens), "hello world again");
  assert.equal(decodeTokens([], tokens), "");
});

test("invalid audio is reported as a runtime error, not an empty transcript", () => {
  const notWav = Buffer.from("this is not a wave file at all, definitely");
  assert.throws(() => readWavMono16("bad.wav", notWav), (error) => {
    assert.equal(error.code, "ASR_RUNTIME_ERROR");
    return true;
  });

  const wrongRate = buildWav({ sampleRate: 44100 });
  assert.throws(() => readWavMono16("44100.wav", wrongRate), (error) => {
    assert.equal(error.code, "ASR_RUNTIME_ERROR");
    assert.match(error.detail, /44100/);
    return true;
  });

  const stereo = buildWav({ channels: 2 });
  assert.throws(() => readWavMono16("stereo.wav", stereo), (error) => error.code === "ASR_RUNTIME_ERROR");
});

test("valid 16 kHz mono audio is normalized by /32768", () => {
  const samples = readWavMono16("ok.wav", buildWav({ samples: [0, 16384, -32768] }));
  assert.equal(samples.length, 3);
  assert.equal(samples[0], 0);
  assert.equal(samples[1], 0.5);
  assert.equal(samples[2], -1);
});

test("config numbers that stand in for booleans are honored", () => {
  // 生产 VAD config.yaml 写的是 `do_extend: 1`；当成布尔缺失会让端点检测退化。
  const parsed = parseModelConfig(VAD_CONFIG);
  const { model } = readVadConfig(parsed);
  assert.equal(model.do_extend, true);
  assert.equal(model.max_single_segment_time, 20000);
  assert.deepEqual(model.sil_pdf_ids, [0]);
  assert.equal(model.speech_noise_thres, 0.6);
});

test("asr frontend keeps the production dither default when config omits it", () => {
  const config = readAsrConfig(parseModelConfig(ASR_CONFIG_WITHOUT_DITHER));
  assert.equal(config.dither, 1.0);
  assert.equal(config.lfrM, 7);
  assert.equal(config.lfrN, 6);
});

test("config without the consumed sections is rejected", () => {
  assert.throws(() => parseModelConfig("encoder: X\nencoder_conf:\n    a: 1\n"), (error) => {
    assert.equal(error.code, "ASR_RUNTIME_ERROR");
    return true;
  });
});

test("cmvn parsing rejects a truncated matrix", () => {
  // 真实格式是「<AddShift> dims」一行、下一行「<LearnRateCoef> 0 [ values... ]」。
  const truncated = "<AddShift> 560 560\n<LearnRateCoef> 0 [ 0.1 0.2 ]\n";
  assert.throws(() => parseCmvn(truncated, 400), (error) => error.code === "ASR_RUNTIME_ERROR");

  const ok = parseCmvn(
    "<AddShift> 2 2\n<LearnRateCoef> 0 [ -1 2 ]\n<Rescale> 2 2\n<LearnRateCoef> 0 [ 2 3 ]\n",
    2,
  );
  const [row] = applyCmvn([Float64Array.from([1, 1])], ok);
  assert.deepEqual(Array.from(row), [0, 9]);
});

const VAD_CONFIG = `frontend: WavFrontendOnline
frontend_conf:
    fs: 16000
    dither: 0.0
    lfr_m: 5
    lfr_n: 1
model_conf:
    sample_rate: 16000
    detect_mode: 1
    max_end_silence_time: 800
    max_start_silence_time: 3000
    window_size_ms: 200
    sil_to_speech_time_thres: 150
    speech_to_sil_time_thres: 150
    speech_2_noise_ratio: 1.0
    do_extend: 1
    lookback_time_start_point: 200
    lookahead_time_end_point: 100
    max_single_segment_time: 20000
    snr_thres: -100.0
    noise_frame_num_used_for_snr: 100
    decibel_thres: -100.0
    speech_noise_thres: 0.6
    fe_prior_thres: 0.0001
    sil_pdf_ids: [0]
    frame_in_ms: 10
    frame_length_ms: 25
`;

const ASR_CONFIG_WITHOUT_DITHER = `encoder: SenseVoiceEncoderSmall
model: SenseVoiceSmall
model_conf:
    sos: 1
    eos: 2
tokenizer_conf:
    unk_symbol: <unk>
frontend: WavFrontend
frontend_conf:
    fs: 16000
    n_mels: 80
    frame_length: 25
    frame_shift: 10
    lfr_m: 7
    lfr_n: 6
dataset_conf:
    batch_size: 1
`;

function buildWav({ sampleRate = 16000, channels = 1, samples = [0, 100, -100] } = {}) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((value, index) => data.writeInt16LE(value, index * 2));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2 * channels, 28);
  header.writeUInt16LE(2 * channels, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
