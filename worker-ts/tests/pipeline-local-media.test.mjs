import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ASREmptyTranscriptError } from "../src/asr/errors.ts";
import { runLocalMediaPipeline } from "../src/pipeline/local-media.ts";
import { runProcessLocalMediaOnce } from "../src/worker-service.ts";

// 真跑 ffmpeg 才能验证「媒体产物 → 转写 → 文字稿」真的接得上。
// 转写器换成假的：这条测试要证明的是管线接线与产物，不是模型精度（那是 ASR 门禁的事）。
function hasFfmpeg() {
  return spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).status === 0;
}

const FFMPEG = hasFfmpeg();

function ffmpeg(args) {
  const result = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `ffmpeg 失败: ${result.stderr}`);
}

function makeRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "locus-pipeline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function makeEnviron(root) {
  return {
    APP_OUTPUT_DIR: join(root, "outputs"),
    APP_CACHE_DIR: join(root, "cache"),
    APP_MODEL_DIR: join(root, "models"),
  };
}

function fakeTranscriber(text, hooks = {}) {
  return {
    model: "iic/SenseVoiceSmall-onnx",
    async transcribe() {
      if (hooks.error) throw hooks.error;
      return { text, language: "zh", segments: [] };
    },
    dispose() {
      hooks.onDispose?.();
    },
  };
}

function options(root, overrides = {}) {
  return {
    projectRoot: root,
    environ: makeEnviron(root),
    now: new Date("2026-11-14T12:00:00Z"),
    randomId: "abcdef0123456789",
    modelCacheValidator: async () => ({ valid: true }),
    ...overrides,
  };
}

async function readManifest(root, taskId) {
  const raw = await readFile(join(root, "outputs", "tasks", taskId, "task.json"), "utf8");
  return JSON.parse(raw);
}

async function leftovers(dir) {
  try {
    return (await readdir(dir)).filter((name) => name.startsWith(".") || name.startsWith("local-source-"));
  } catch {
    return [];
  }
}

test("an audio task produces transcript artifacts and a completed manifest", { skip: !FFMPEG }, async (t) => {
  const root = makeRoot(t);
  const source = join(root, "采访 01.wav");
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ac", "2", "-ar", "44100", source]);

  const result = await runLocalMediaPipeline({
    request: {
      sourcePath: source,
      mediaKind: "audio",
      safeDisplayName: "采访 01.wav",
      sourceExtension: "wav",
      asrModel: "iic/SenseVoiceSmall-onnx",
    },
    ...options(root),
    transcriberFactory: async () => fakeTranscriber("今天我们来聊一聊本地转写。"),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.taskId, "20261114-120000-local-abcdef0123456789");
  assert.deepEqual(Object.keys(result.artifacts).sort(), ["audio", "transcript_md", "transcript_txt"]);
  assert.equal(result.artifacts.audio, "media/audio.wav");
  assert.equal(result.artifacts.transcript_txt, "transcript/transcript.txt");
  assert.equal(result.text, "今天我们来聊一聊本地转写。");
  assert.deepEqual(result.transcript, {
    source: "asr",
    language: null,
    engine: "iic/SenseVoiceSmall-onnx",
  });
  // 返回的 task_dir 是给宿主拼接用的，必须能直接当路径用（Windows 上也要正斜杠）。
  assert.equal(result.taskDir.endsWith("tasks/20261114-120000-local-abcdef0123456789"), true);

  const manifest = await readManifest(root, result.taskId);
  assert.equal(manifest.status, "completed");
  assert.equal(manifest.task_id, result.taskId);
  assert.deepEqual(manifest.artifacts, result.artifacts);
  assert.equal(manifest.model, "iic/SenseVoiceSmall-onnx");
  assert.equal(manifest.text_preview, "今天我们来聊一聊本地转写。");
  assert.deepEqual(manifest.transcript, {
    source: "asr",
    language: null,
    engine: "iic/SenseVoiceSmall-onnx",
  });
  assert.equal(manifest.error, null);

  const taskDir = join(root, "outputs", "tasks", result.taskId);
  assert.match(await readFile(join(taskDir, "transcript", "transcript.txt"), "utf8"), /本地转写/);
  assert.match(await readFile(join(taskDir, "transcript", "transcript.md"), "utf8"), /Local ASR/);
  // 缓存里的源文件副本与 media 目录都不该留下 staging 残片。
  assert.deepEqual(await leftovers(join(root, "cache", "tasks", result.taskId, "download")), []);
  assert.deepEqual(await leftovers(join(taskDir, "media")), []);
});

test("a video task keeps the video artifact and still normalizes audio", { skip: !FFMPEG }, async (t) => {
  const root = makeRoot(t);
  const source = join(root, "clip.mp4");
  ffmpeg([
    "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:v", "mpeg4", "-c:a", "aac", "-shortest", source,
  ]);

  const result = await runLocalMediaPipeline({
    request: {
      sourcePath: source,
      mediaKind: "video",
      safeDisplayName: "clip.mp4",
      sourceExtension: "mp4",
      asrModel: "iic/SenseVoiceSmall-onnx",
    },
    ...options(root),
    transcriberFactory: async () => fakeTranscriber("视频里的声音。"),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.artifacts.video, "media/video.mp4");
  assert.equal(result.artifacts.audio, "media/audio.wav");
  const manifest = await readManifest(root, result.taskId);
  assert.equal(manifest.local_source.media_kind, "video");
  assert.equal(manifest.local_source.display_name, "clip.mp4");
});

test("progress events are the ones the host already understands", { skip: !FFMPEG }, async (t) => {
  const root = makeRoot(t);
  const source = join(root, "a.wav");
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ac", "1", "-ar", "44100", source]);

  const events = [];
  await runLocalMediaPipeline({
    request: {
      sourcePath: source,
      mediaKind: "audio",
      safeDisplayName: "a.wav",
      sourceExtension: "wav",
      asrModel: "iic/SenseVoiceSmall-onnx",
    },
    ...options(root),
    onProgress: (event) => events.push(event),
    transcriberFactory: async () => fakeTranscriber("好的。"),
  });

  assert.deepEqual(events.map((event) => event.message_code), [
    "local.media.validating",
    "local.audio.normalizing",
    "asr.transcribe.starting",
    "asr.cache.preparing",
    "asr.transcribe.running",
  ]);
  assert.deepEqual(events.map((event) => event.progress), [18, 34, 58, 58, 68]);
  assert.deepEqual(events.map((event) => event.stage), [
    "video_extracting",
    "video_extracting",
    "video_transcribing",
    "video_transcribing",
    "video_transcribing",
  ]);
  assert.deepEqual(events[3].message_args, { model: "iic/SenseVoiceSmall-onnx" });
});

test("a missing model cache fails the task after the media is already prepared", { skip: !FFMPEG }, async (t) => {
  const root = makeRoot(t);
  const source = join(root, "a.wav");
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ac", "1", "-ar", "44100", source]);

  const result = await runLocalMediaPipeline({
    request: {
      sourcePath: source,
      mediaKind: "audio",
      safeDisplayName: "a.wav",
      sourceExtension: "wav",
      asrModel: "iic/SenseVoiceSmall-onnx",
    },
    ...options(root),
    modelCacheValidator: async () => ({ valid: false }),
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "ASR_MODEL_NOT_DOWNLOADED");
  assert.equal(result.error.stage, "video_transcribing");
  assert.equal(result.transcript, null);
  // 媒体已经准备好了：音频产物算数，文字稿不算数。
  assert.equal(result.artifacts.audio, "media/audio.wav");
  assert.equal("transcript_txt" in result.artifacts, false);

  const manifest = await readManifest(root, result.taskId);
  assert.equal(manifest.status, "failed");
  assert.equal(manifest.error.code, "ASR_MODEL_NOT_DOWNLOADED");
});

test("an ASR failure keeps the code, writes the manifest and still disposes", { skip: !FFMPEG }, async (t) => {
  const root = makeRoot(t);
  const source = join(root, "a.wav");
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ac", "1", "-ar", "44100", source]);

  let disposed = false;
  const result = await runLocalMediaPipeline({
    request: {
      sourcePath: source,
      mediaKind: "audio",
      safeDisplayName: "a.wav",
      sourceExtension: "wav",
      asrModel: "iic/SenseVoiceSmall-onnx",
    },
    ...options(root),
    transcriberFactory: async () => fakeTranscriber("", {
      error: new ASREmptyTranscriptError("ASR returned an empty transcript."),
      onDispose: () => { disposed = true; },
    }),
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "ASR_EMPTY_TRANSCRIPT");
  assert.equal(disposed, true);
  const manifest = await readManifest(root, result.taskId);
  assert.equal(manifest.error.code, "ASR_EMPTY_TRANSCRIPT");
  assert.equal(existsSync(join(root, "outputs", "tasks", result.taskId, "transcript", "transcript.txt")), false);
});

test("the PyTorch model id is rejected explicitly instead of attempted", { skip: !FFMPEG }, async (t) => {
  const root = makeRoot(t);
  const source = join(root, "a.wav");
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ac", "1", "-ar", "44100", source]);

  let factoryCalls = 0;
  const result = await runLocalMediaPipeline({
    request: {
      sourcePath: source,
      mediaKind: "audio",
      safeDisplayName: "a.wav",
      sourceExtension: "wav",
      asrModel: "iic/SenseVoiceSmall",
    },
    ...options(root),
    transcriberFactory: async () => {
      factoryCalls += 1;
      return fakeTranscriber("不应发生");
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "ASR_MODEL_UNSUPPORTED");
  assert.equal(factoryCalls, 0);
});

test("an unreadable source fails with the local-audio code and keeps the task", async (t) => {
  const root = makeRoot(t);

  const result = await runLocalMediaPipeline({
    request: {
      sourcePath: join(root, "does-not-exist.wav"),
      mediaKind: "audio",
      safeDisplayName: "does-not-exist.wav",
      sourceExtension: "wav",
      asrModel: "iic/SenseVoiceSmall-onnx",
    },
    ...options(root),
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "AUDIO_NORMALIZATION_FAILED");
  assert.equal(result.error.stage, "video_extracting");
  // 失败也要有任务目录与清单：界面靠它展示失败原因。
  const manifest = await readManifest(root, result.taskId);
  assert.equal(manifest.status, "failed");
  assert.deepEqual(manifest.artifacts, {});
});

test("an invalid request fails before any directory is created", async (t) => {
  const root = makeRoot(t);

  const payload = await runProcessLocalMediaOnce(
    { contract_version: 4, source_path: "relative.wav" },
    { projectRoot: root, environ: makeEnviron(root) },
  );

  assert.equal(payload.status, "failed");
  assert.equal(payload.task_id, null);
  assert.equal(payload.task_dir, null);
  assert.deepEqual(payload.artifacts, {});
  assert.deepEqual(payload.error, {
    code: "LOCAL_MEDIA_VALIDATION_FAILED",
    message: "Local media request payload was invalid.",
    stage: "waiting_input",
  });
  assert.equal(existsSync(join(root, "outputs")), false);
  assert.equal(existsSync(join(root, "cache")), false);
});

test("the service returns the contract payload shape for a completed task", { skip: !FFMPEG }, async (t) => {
  const root = makeRoot(t);
  const source = join(root, "meeting.wav");
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ac", "1", "-ar", "44100", source]);

  const payload = await runProcessLocalMediaOnce(
    {
      contract_version: 4,
      source_path: source,
      media_kind: "audio",
      safe_display_name: "meeting.wav",
      source_extension: "wav",
      asr_model: "iic/SenseVoiceSmall-onnx",
    },
    {
      ...options(root),
      transcriberFactory: async () => fakeTranscriber("五分钟的会。"),
    },
  );

  assert.deepEqual(Object.keys(payload).sort(), [
    "artifacts", "dissection", "draft", "error", "insights", "status",
    "summary", "task_dir", "task_id", "text", "transcript",
  ]);
  assert.equal(payload.status, "completed");
  assert.equal(payload.error, null);
  assert.deepEqual(payload.insights, []);
  assert.equal(payload.summary, "");
  assert.equal(payload.draft, "");
  assert.equal(payload.dissection, null);
  assert.equal(payload.text, "五分钟的会。");
  // 直接落盘过：task.json 与文字稿都在。
  const taskDir = join(root, "outputs", "tasks", payload.task_id);
  await mkdir(taskDir, { recursive: true });
  assert.equal(existsSync(join(taskDir, "task.json")), true);
});
