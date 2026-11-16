import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFfprobeCommand,
  isAudioValid,
  isMediaValid,
  isNormalizedPcmWav,
  parseFfprobeJson,
} from "../src/media/ffprobe.ts";
import { buildAudioExtractCommand } from "../src/media/audio.ts";
import { structuredErrorCode } from "../src/media/command.ts";

// 判定条件是行为的开关：同一个文件被判成「有效音频」还是「无效」，决定任务失败还是继续。
// ffprobe 的原始输出形状用真实抓取的结果固定下来，避免哪天字段改名后静默变成一律无效。

const VIDEO_WITH_AUDIO = JSON.stringify({
  streams: [
    { index: 0, codec_name: "mpeg4", codec_type: "video", width: 160, height: 120 },
    { index: 1, codec_name: "aac", codec_type: "audio", sample_fmt: "fltp", sample_rate: "44100", channels: 1 },
  ],
  format: { duration: "1.000000", size: "22688" },
});

const NORMALIZED_WAV = JSON.stringify({
  streams: [
    { index: 0, codec_name: "pcm_s16le", codec_type: "audio", sample_fmt: "s16", sample_rate: "16000", channels: 1 },
  ],
  format: { duration: "1.023000", size: "32768" },
});

test("a real video probe is recognised as valid media", () => {
  const info = parseFfprobeJson(VIDEO_WITH_AUDIO);
  assert.equal(info.hasVideo, true);
  assert.equal(info.hasAudio, true);
  assert.equal(info.videoCodec, "mpeg4");
  assert.equal(info.audioCodec, "aac");
  assert.equal(info.audioSampleRate, 44100);
  assert.equal(info.width, 160);
  assert.equal(isMediaValid(info), true);
  assert.equal(isAudioValid(info), true);
  assert.equal(isNormalizedPcmWav(info), false);
});

test("a normalized WAV satisfies the ASR input contract", () => {
  const info = parseFfprobeJson(NORMALIZED_WAV);
  assert.equal(isNormalizedPcmWav(info), true);
  assert.equal(isMediaValid(info), false, "没有视频流就不是有效音视频");
});

test("missing or unusable streams are rejected", () => {
  const noAudio = parseFfprobeJson(JSON.stringify({
    streams: [{ index: 0, codec_name: "mpeg4", codec_type: "video", width: 160, height: 120 }],
    format: { duration: "1.0", size: "1000" },
  }));
  assert.equal(noAudio.hasAudio, false);
  assert.equal(isMediaValid(noAudio), false);
  assert.equal(isAudioValid(noAudio), false);

  const zeroDuration = parseFfprobeJson(JSON.stringify({
    streams: [{ index: 0, codec_name: "pcm_s16le", codec_type: "audio", sample_fmt: "s16", sample_rate: "16000", channels: 1 }],
    format: { duration: "0", size: "0" },
  }));
  assert.equal(isAudioValid(zeroDuration), false, "零时长零体积的文件不能当有效音频");
  assert.equal(isNormalizedPcmWav(zeroDuration), false);
});

test("malformed probe output throws instead of guessing", () => {
  assert.throws(() => parseFfprobeJson("not json"));
  const empty = parseFfprobeJson(JSON.stringify({}));
  assert.equal(empty.hasVideo, false);
  assert.equal(empty.hasAudio, false);
  assert.equal(empty.durationSeconds, null);
});

test("commands match the production parameters", () => {
  assert.deepEqual(
    buildAudioExtractCommand("in.mp4", "out.wav"),
    ["ffmpeg", "-y", "-i", "in.mp4", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "out.wav"],
  );
  const probe = buildFfprobeCommand("in.mp4");
  assert.equal(probe[0], "ffprobe");
  assert.ok(probe.includes("-of"));
  assert.equal(probe.at(-1), "in.mp4");
});

test("structured error codes come from the stderr prefix", () => {
  assert.equal(structuredErrorCode("VIDEO_DOWNLOAD_TIMEOUT: 说明"), "VIDEO_DOWNLOAD_TIMEOUT");
  assert.equal(structuredErrorCode("ffmpeg version 7"), null);
  assert.equal(structuredErrorCode("A: x"), null, "单字母不算码");
  assert.equal(structuredErrorCode(""), null);
});
