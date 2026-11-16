import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { prepareLocalMedia } from "../src/media/local-media.ts";
import { isNormalizedPcmWav, probeMediaFile } from "../src/media/ffprobe.ts";

// 真跑 ffmpeg：归一化参数、流校验与错误码只能靠真实文件验证。
// 本机没有 ffmpeg 时整组跳过，不假装通过。

function hasFfmpeg() {
  const probe = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
  return probe.status === 0;
}

const FFMPEG = hasFfmpeg();

function ffmpeg(args) {
  const result = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `ffmpeg 失败: ${result.stderr}`);
}

function makeRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "locus-local-media-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function makePaths(root, taskId = "task-1") {
  const mediaDir = join(root, "output", "tasks", taskId, "media");
  return {
    downloadDir: join(root, "cache", "tasks", taskId, "download"),
    mediaDir,
    audioPath: join(mediaDir, "audio.wav"),
    videoPathForExtension: (extension) => join(mediaDir, `video.${extension}`),
  };
}

async function leftovers(dir) {
  try {
    return (await readdir(dir)).filter((name) => name.startsWith(".") || name.startsWith("local-source-"));
  } catch {
    return [];
  }
}

test("a stereo 44.1 kHz wav becomes 16 kHz mono PCM and cleans its staging file", { skip: !FFMPEG }, async (t) => {
  const root = makeRoot(t);
  const source = join(root, "input.wav");
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ac", "2", "-ar", "44100", source]);

  const paths = makePaths(root);
  const progress = [];
  const result = await prepareLocalMedia({
    sourcePath: source,
    mediaKind: "audio",
    sourceExtension: "wav",
    paths,
    onProgress: (code, value) => progress.push([code, value]),
  });

  assert.equal(result.videoPath, null);
  assert.equal(result.audioPath, paths.audioPath);
  const info = await probeMediaFile(paths.audioPath);
  assert.equal(isNormalizedPcmWav(info), true, "产物必须是 16 kHz 单声道 16 位 PCM WAV");
  assert.deepEqual(progress, [
    ["local.media.validating", 18],
    ["local.audio.normalizing", 34],
  ]);
  assert.deepEqual(await leftovers(paths.downloadDir), [], "源文件副本必须清掉");
  assert.deepEqual(await leftovers(paths.mediaDir), [], "不能留下 staging 文件");
});

test("a video is copied with its original extension and its audio extracted", { skip: !FFMPEG }, async (t) => {
  const root = makeRoot(t);
  const source = join(root, "input.mp4");
  ffmpeg([
    "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:v", "mpeg4", "-c:a", "aac", "-shortest", source,
  ]);

  const paths = makePaths(root);
  const progress = [];
  const result = await prepareLocalMedia({
    sourcePath: source,
    mediaKind: "video",
    sourceExtension: "mp4",
    paths,
    onProgress: (code) => progress.push(code),
  });

  assert.equal(result.videoPath, join(paths.mediaDir, "video.mp4"));
  const video = await probeMediaFile(result.videoPath);
  assert.equal(video.hasVideo, true);
  assert.equal((await readFile(result.videoPath)).length, (await readFile(source)).length);
  assert.equal(isNormalizedPcmWav(await probeMediaFile(result.audioPath)), true);
  assert.deepEqual(progress, ["local.media.validating", "local.video.copying", "audio.extract.running"]);
  assert.deepEqual(await leftovers(paths.downloadDir), []);
});

test("a stream/kind mismatch uses the documented code; video with audio is accepted as audio", { skip: !FFMPEG }, async (t) => {
  const root = makeRoot(t);
  const wav = join(root, "tone.wav");
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", wav]);
  const video = join(root, "clip.mp4");
  ffmpeg([
    "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:v", "mpeg4", "-c:a", "aac", "-shortest", video,
  ]);

  await assert.rejects(
    () => prepareLocalMedia({ sourcePath: wav, mediaKind: "video", sourceExtension: "mp4", paths: makePaths(root, "a") }),
    (error) => {
      assert.equal(error.code, "LOCAL_MEDIA_KIND_MISMATCH");
      return true;
    },
  );
  // 带音频的视频按「音频」处理是允许的：与 Python 的 `_validate_local_streams` 一致。
  // 前端在选文件时已经按扩展名挡住了这类组合，这里只是不额外加一层拒绝。
  const accepted = await prepareLocalMedia({
    sourcePath: video,
    mediaKind: "audio",
    sourceExtension: "mp4",
    paths: makePaths(root, "b"),
  });
  assert.equal(accepted.videoPath, null);
  assert.equal(isNormalizedPcmWav(await probeMediaFile(accepted.audioPath)), true);
});

test("a video without an audio stream is refused", { skip: !FFMPEG }, async (t) => {
  const root = makeRoot(t);
  const silentVideo = join(root, "silent.mp4");
  ffmpeg(["-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=1", "-c:v", "mpeg4", "-an", silentVideo]);

  await assert.rejects(
    () => prepareLocalMedia({
      sourcePath: silentVideo,
      mediaKind: "video",
      sourceExtension: "mp4",
      paths: makePaths(root),
    }),
    (error) => {
      assert.equal(error.code, "LOCAL_VIDEO_AUDIO_STREAM_MISSING");
      return true;
    },
  );
});

test("a non-media file fails validation and a missing file fails the copy", { skip: !FFMPEG }, async (t) => {
  const root = makeRoot(t);
  const text = join(root, "notes.wav");
  await writeFile(text, "this is not audio\n");

  await assert.rejects(
    () => prepareLocalMedia({ sourcePath: text, mediaKind: "audio", sourceExtension: "wav", paths: makePaths(root, "a") }),
    (error) => {
      assert.equal(error.code, "LOCAL_MEDIA_VALIDATION_FAILED");
      return true;
    },
  );

  await assert.rejects(
    () => prepareLocalMedia({
      sourcePath: join(root, "absent.wav"),
      mediaKind: "audio",
      sourceExtension: "wav",
      paths: makePaths(root, "b"),
    }),
    (error) => {
      assert.equal(error.code, "AUDIO_NORMALIZATION_FAILED");
      return true;
    },
  );
});

test("a failing run leaves no partial artifacts behind", { skip: !FFMPEG }, async (t) => {
  const root = makeRoot(t);
  const paths = makePaths(root);
  const text = join(root, "notes.wav");
  await writeFile(text, "not audio\n");

  await assert.rejects(() => prepareLocalMedia({
    sourcePath: text,
    mediaKind: "audio",
    sourceExtension: "wav",
    paths,
  }));

  await assert.rejects(() => readFile(paths.audioPath), "失败不能产出 audio.wav");
  assert.deepEqual(await leftovers(paths.downloadDir), []);
  await assert.rejects(() => readdir(paths.mediaDir));
});
