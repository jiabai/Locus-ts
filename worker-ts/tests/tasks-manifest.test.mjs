import assert from "node:assert/strict";
import test from "node:test";

import {
  SOURCE_PRIVACY_MIGRATION_VERSION,
  TASK_SCHEMA_VERSION,
  serializeTaskManifest,
  validateManifestArtifacts,
} from "../src/tasks/manifest.ts";
import { createLocalTaskContext, validateLocalSource } from "../src/tasks/index.ts";
import { createTaskPaths, toPosixPath } from "../src/tasks/paths.ts";

const CONTEXT = {
  taskId: "20261114-120000-local-abcdef0123456789",
  createdAt: "2026-11-14T12:00:00Z",
  model: "iic/SenseVoiceSmall-onnx",
  source: {
    kind: "local_file",
    displayName: "采访 01.wav",
    mediaKind: "audio",
    extension: "wav",
  },
};

const COMPLETED = {
  status: "completed",
  taskId: CONTEXT.taskId,
  taskDir: "C:/data/outputs/tasks/20261114-120000-local-abcdef0123456789",
  artifacts: {
    audio: "media/audio.wav",
    transcript_txt: "transcript/transcript.txt",
    transcript_md: "transcript/transcript.md",
  },
  text: "  今天我们来聊一聊本地文件转写。  ",
  summary: "",
  insights: [],
  transcript: { source: "asr", language: null, engine: "iic/SenseVoiceSmall-onnx" },
  dissection: null,
  error: null,
  draft: "",
};

const FIXED_NOW = () => new Date("2026-11-14T12:34:56.789Z");

function parseManifest(bytes) {
  return JSON.parse(Buffer.from(bytes).toString("utf8"));
}

test("a local manifest carries the exact field set the other implementations read", () => {
  const manifest = parseManifest(serializeTaskManifest(CONTEXT, COMPLETED, { now: FIXED_NOW }));

  assert.deepEqual(Object.keys(manifest), [
    "schema_version",
    "source_privacy_migration_version",
    "source_privacy_quarantined",
    "task_id",
    "created_at",
    "updated_at",
    "source_kind",
    "source_url",
    "source_identity",
    "local_source",
    "platform",
    "status",
    "app_version",
    "worker_version",
    "model",
    "transcript",
    "artifacts",
    "error",
    "text_preview",
    "insights_count",
    "draft_path",
    "has_draft",
    "draft_seed_insight_id",
  ]);
  assert.equal(manifest.schema_version, TASK_SCHEMA_VERSION);
  assert.equal(manifest.source_privacy_migration_version, SOURCE_PRIVACY_MIGRATION_VERSION);
  assert.equal(manifest.source_privacy_quarantined, false);
  assert.equal(manifest.source_kind, "local_file");
  assert.equal(manifest.platform, "local");
  // 本地任务没有 URL，也没有来源标识：空串与 null 是「契约里的没有」，不是缺失。
  assert.equal(manifest.source_url, "");
  assert.equal(manifest.source_identity, null);
  assert.deepEqual(manifest.local_source, {
    display_name: "采访 01.wav",
    media_kind: "audio",
    extension: "wav",
  });
  assert.equal(manifest.updated_at, "2026-11-14T12:34:56Z");
  assert.equal(manifest.draft_seed_insight_id, null);
  assert.equal(manifest.draft_path, null);
  assert.equal(manifest.has_draft, false);
});

test("the manifest text preview is trimmed and capped at 180 code points", () => {
  const manifest = parseManifest(serializeTaskManifest(CONTEXT, COMPLETED, { now: FIXED_NOW }));
  assert.equal(manifest.text_preview, "今天我们来聊一聊本地文件转写。");

  const long = "字".repeat(200);
  const truncated = parseManifest(
    serializeTaskManifest(CONTEXT, { ...COMPLETED, text: long }, { now: FIXED_NOW }),
  );
  assert.equal([...truncated.text_preview].length, 180);
});

test("the manifest is written with LF and a trailing newline", () => {
  const bytes = serializeTaskManifest(CONTEXT, COMPLETED, { now: FIXED_NOW });
  const text = Buffer.from(bytes).toString("utf8");
  assert.equal(text.includes("\r"), false);
  assert.equal(text.endsWith("}\n"), true);
});

test("a prior note title and draft seed survive a rewrite", () => {
  const bytes = serializeTaskManifest(CONTEXT, COMPLETED, {
    now: FIXED_NOW,
    prior: {
      draftSeedInsightId: 7,
      noteTitle: { text: "旧标题", status: "completed", output_language: "zh-CN", error_code: null },
    },
  });
  const manifest = parseManifest(bytes);
  assert.equal(manifest.draft_seed_insight_id, 7);
  assert.deepEqual(manifest.note_title, {
    text: "旧标题",
    status: "completed",
    output_language: "zh-CN",
    error_code: null,
  });
});

test("an explicit draft seed clears or overrides the prior value", () => {
  const prior = { draftSeedInsightId: 7, noteTitle: null };
  const cleared = parseManifest(
    serializeTaskManifest(CONTEXT, COMPLETED, { now: FIXED_NOW, prior, draftSeedInsightId: null }),
  );
  assert.equal(cleared.draft_seed_insight_id, null);

  const overridden = parseManifest(
    serializeTaskManifest(CONTEXT, COMPLETED, { now: FIXED_NOW, prior, draftSeedInsightId: 12 }),
  );
  assert.equal(overridden.draft_seed_insight_id, 12);
});

test("a media manifest rejects article artifacts and impossible paths", () => {
  assert.throws(() => validateManifestArtifacts({ artifacts: { article_txt: "article/article.txt" } }));
  assert.throws(() => validateManifestArtifacts({ artifacts: { article_md: "article/article.md" } }));
  assert.throws(() => validateManifestArtifacts({ artifacts: { transcript_txt: "other/transcript.txt" } }));
  assert.throws(() => validateManifestArtifacts({ artifacts: { audio: "media/audio.mp3" } }));
  assert.throws(() => validateManifestArtifacts({ artifacts: { video: "media/clip.mp4" } }));
  assert.throws(() => validateManifestArtifacts({ artifacts: { unknown: "ai/unknown.json" } }));
  assert.throws(() => validateManifestArtifacts({ artifacts: null }));
  // `ai/original/draft.md` 是「原稿副本」这个非产物目标，不是 `draft` 键指向的文件；
  // 契约 `artifactKeysByDestination` 与 Python 的闭集都写的是 `ai/draft.md`。
  assert.throws(() => validateManifestArtifacts({ artifacts: { draft: "ai/original/draft.md" } }));

  // 合法集合：视频按来源扩展名命名，其余键都在闭集内。
  assert.doesNotThrow(() => validateManifestArtifacts({
    artifacts: {
      video: "media/video.mkv",
      audio: "media/audio.wav",
      transcript_txt: "transcript/transcript.txt",
      transcript_md: "transcript/transcript.md",
      segments: "transcript/segments.json",
      summary: "ai/summary.md",
      preference_snapshot: "ai/preference-snapshot.json",
      draft: "ai/draft.md",
    },
  }));
});

test("task ids follow <YYYYMMDD>-<HHMMSS>-local-<random> and paths stay posix", () => {
  const { context, paths } = createLocalTaskContext({
    store: { outputRoot: "/data/outputs", cacheRoot: "/data/cache" },
    request: {
      safeDisplayName: "采访 01.wav",
      mediaKind: "audio",
      sourceExtension: "wav",
      asrModel: "iic/SenseVoiceSmall-onnx",
    },
    now: new Date("2026-11-14T12:00:00Z"),
    randomId: "abcdef0123456789",
  });

  assert.equal(context.taskId, "20261114-120000-local-abcdef0123456789");
  assert.equal(context.createdAt, "2026-11-14T12:00:00Z");
  assert.equal(paths.transcriptDir.endsWith("transcript"), true);
  assert.equal(paths.downloadDir.includes("cache"), true);
  assert.equal(toPosixPath("C:\\data\\tasks\\t1\\media"), "C:/data/tasks/t1/media");
  assert.equal(toPosixPath(paths.videoPathForExtension("mkv")).endsWith("media/video.mkv"), true);
  assert.throws(() => paths.videoPathForExtension("wav"), /unsupported/);

  const built = createTaskPaths({ outputRoot: "/data/outputs", cacheRoot: "/data/cache", taskId: "t1" });
  assert.equal(built.manifestPath.endsWith("task.json"), true);
  assert.equal(built.segmentsPath.endsWith("segments.json"), true);
});

test("local sources reject unsafe display names and mismatched extensions", () => {
  const valid = {
    safeDisplayName: "采访 01.wav",
    mediaKind: "audio",
    sourceExtension: "wav",
    asrModel: "iic/SenseVoiceSmall-onnx",
  };
  assert.equal(validateLocalSource(valid).displayName, "采访 01.wav");

  const cases = [
    { ...valid, safeDisplayName: "../escape.wav" },
    { ...valid, safeDisplayName: "/abs/path.wav" },
    { ...valid, safeDisplayName: "C:\\Users\\me\\a.wav" },
    { ...valid, safeDisplayName: ".." },
    { ...valid, safeDisplayName: "   " },
    // 后缀与扩展名不一致：清单会写着 .wav 而文件是 .mp3。
    { ...valid, safeDisplayName: "采访.wav.mp3" },
    // 双向控制符可以把扩展名显示成别的样子。
    { ...valid, safeDisplayName: "采访\u202Efdp.wav" },
    { ...valid, safeDisplayName: `${"a".repeat(200)}.wav` },
    { ...valid, sourceExtension: "mp4" },
    { ...valid, mediaKind: "video" },
  ];
  for (const request of cases) {
    assert.throws(() => validateLocalSource(request), /invalid/i, JSON.stringify(request));
  }
});

test("the manifest of a failed task keeps the error and no artifacts", () => {
  const failed = {
    ...COMPLETED,
    status: "failed",
    artifacts: {},
    text: "",
    transcript: null,
    error: { code: "AUDIO_NORMALIZATION_FAILED", message: "Local audio could not be prepared safely.", stage: "video_extracting" },
  };
  const manifest = parseManifest(serializeTaskManifest(CONTEXT, failed, { now: FIXED_NOW }));
  assert.equal(manifest.status, "failed");
  assert.deepEqual(manifest.artifacts, {});
  assert.deepEqual(manifest.error, {
    code: "AUDIO_NORMALIZATION_FAILED",
    message: "Local audio could not be prepared safely.",
    stage: "video_extracting",
  });
  assert.equal(manifest.transcript, null);
});
