import assert from "node:assert/strict";
import test from "node:test";

import {
  MODEL_DOWNLOAD_EVENT_PREFIX,
  PROGRESS_EVENT_PREFIX,
  isSafeErrorCode,
  jsonLine,
} from "../src/protocol/contract.ts";
import {
  ProgressEventInvalidError,
  WORKER_PROGRESS_SPECS,
  buildWorkerProgressEvent,
  isSafeCurrentFile,
  renderModelProgressEvent,
  renderWorkerProgressEvent,
} from "../src/protocol/events.ts";

// 事件形状由契约定义，宿主收到非法事件会判定 worker 异常。这里把「什么该拒」固定下来：
// 未知码、越界进度、越界参数、该带 current_file 却没带、不该带却带了。

const modelEvent = (overrides) => ({
  message_code: "model.download.completed",
  status: "completed",
  progress: 100,
  message_args: { model: "iic/SenseVoiceSmall-onnx" },
  ...overrides,
});

test("worker progress events carry the documented prefix and fields", () => {
  const line = renderWorkerProgressEvent(
    buildWorkerProgressEvent("asr.transcribe.running", { stage: "video_transcribing", progress: 68 }),
  );
  assert.ok(line.startsWith(PROGRESS_EVENT_PREFIX));
  assert.deepEqual(JSON.parse(line.slice(PROGRESS_EVENT_PREFIX.length)), {
    stage: "video_transcribing",
    progress: 68,
    message_code: "asr.transcribe.running",
  });
});

test("message args are validated against the code's allowlist", () => {
  const withModel = buildWorkerProgressEvent("asr.cache.preparing", {
    stage: "video_transcribing",
    progress: 58,
    messageArgs: { model: "iic/SenseVoiceSmall-onnx" },
  });
  assert.deepEqual(withModel.message_args, { model: "iic/SenseVoiceSmall-onnx" });

  assert.throws(
    () => buildWorkerProgressEvent("asr.cache.preparing", {
      stage: "video_transcribing",
      progress: 58,
      messageArgs: { model: "iic/NotAModel" },
    }),
    ProgressEventInvalidError,
  );
  assert.throws(
    () => buildWorkerProgressEvent("asr.transcribe.running", {
      stage: "video_transcribing",
      progress: 68,
      messageArgs: { model: "iic/SenseVoiceSmall-onnx" },
    }),
    ProgressEventInvalidError,
  );

  const attempts = buildWorkerProgressEvent("ai.generation.running", {
    stage: "insights_generating",
    progress: 80,
    messageArgs: { attempt: 2, total: 3 },
  });
  assert.deepEqual(attempts.message_args, { attempt: 2, total: 3 });
  assert.throws(
    () => buildWorkerProgressEvent("ai.generation.running", {
      stage: "insights_generating",
      progress: 80,
      messageArgs: { attempt: 4, total: 3 },
    }),
    ProgressEventInvalidError,
  );
});

test("out-of-range progress and unknown stages are refused", () => {
  assert.throws(() => buildWorkerProgressEvent("web.page.loading", { stage: "web_loading", progress: 101 }));
  assert.throws(() => buildWorkerProgressEvent("web.page.loading", { stage: "web_loading", progress: 12.5 }));
  assert.throws(() => buildWorkerProgressEvent("web.page.loading", { stage: "nope", progress: 10 }));
  assert.throws(() => buildWorkerProgressEvent("web.page.unknown", { stage: "web_loading", progress: 10 }));
});

test("model download events validate status and current_file", () => {
  const line = renderModelProgressEvent(modelEvent({}));
  assert.ok(line.startsWith(MODEL_DOWNLOAD_EVENT_PREFIX));
  assert.equal(JSON.parse(line.slice(MODEL_DOWNLOAD_EVENT_PREFIX.length)).progress, 100);

  const fileEvent = renderModelProgressEvent({
    message_code: "model.file.downloading",
    status: "downloading",
    progress: 30,
    current_file: "model_quant.onnx",
  });
  assert.equal(
    JSON.parse(fileEvent.slice(MODEL_DOWNLOAD_EVENT_PREFIX.length)).current_file,
    "model_quant.onnx",
  );

  // 状态必须与码绑定。
  assert.throws(
    () => renderModelProgressEvent(modelEvent({ status: "downloading" })),
    ProgressEventInvalidError,
  );
  // 需要 current_file 的事件不能缺。
  assert.throws(
    () => renderModelProgressEvent({
      message_code: "model.file.completed",
      status: "downloading",
      progress: 40,
    }),
    ProgressEventInvalidError,
  );
  // 不需要 current_file 的事件不能多带。
  assert.throws(
    () => renderModelProgressEvent(modelEvent({ current_file: "am.mvn" })),
    ProgressEventInvalidError,
  );
});

test("current_file must be a safe basename", () => {
  assert.equal(isSafeCurrentFile("model_quant.onnx"), true);
  assert.equal(isSafeCurrentFile("chn_jpn_yue_eng_ko_spectok.bpe.model"), true);
  assert.equal(isSafeCurrentFile("tokens.json"), true);

  assert.equal(isSafeCurrentFile("../model_quant.onnx"), false);
  assert.equal(isSafeCurrentFile("sub/dir.onnx"), false);
  assert.equal(isSafeCurrentFile(".hidden"), true, "点开头的普通文件名仍然合法");
  assert.equal(isSafeCurrentFile(".."), false);
  assert.equal(isSafeCurrentFile("my token file.txt"), false, "敏感词文件名不能进事件");
});

test("error codes and JSON lines stay printable", () => {
  assert.equal(isSafeErrorCode("ASR_MODEL_DOWNLOAD_FAILED"), true);
  assert.equal(isSafeErrorCode("asr_model_download_failed"), false);
  assert.equal(isSafeErrorCode("A".repeat(65)), false);

  const line = jsonLine({ status: "completed", model: "iic/SenseVoiceSmall-onnx", text: "中文字幕" });
  assert.equal(line.includes("\n"), false);
  assert.equal(line.includes("中"), false, "非 ASCII 必须转义，保证 stdout 字节形状与旧 worker 一致");
  assert.deepEqual(JSON.parse(line).text, "中文字幕");
});

test("every registered worker code has a shape the builder accepts", () => {
  // 表里每一行都必须能构造出合法事件：防止新增码时忘了同步 stage 或参数约束。
  for (const [code, spec] of Object.entries(WORKER_PROGRESS_SPECS)) {
    const args = Object.fromEntries(spec.allowedArgs.map((key) =>
      [key, key === "model" ? "iic/SenseVoiceSmall-onnx" : key === "language" ? "zh-CN" : 1]));
    assert.doesNotThrow(
      () => buildWorkerProgressEvent(code, { stage: "completed", progress: 100, messageArgs: args }),
      `${code} 无法构造合法事件`,
    );
  }
});
