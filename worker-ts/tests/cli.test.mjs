import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// 入口的宿主可见契约：stdout 恰好一行 JSON、事件走 stderr、退出码表达宿主该不该停。
// 需要下载成功的用例在 worker-service 层用假 fetch 覆盖，这里只跑不联网的分支。

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function runCli(args, env = {}, input = "") {
  return spawnSync(process.execPath, ["--experimental-strip-types", CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    input,
  });
}

test("a legacy model id fails with the documented code and exit 1", (t) => {
  const modelDir = mkdtempSync(join(tmpdir(), "locus-cli-"));
  t.after(() => rm(modelDir, { recursive: true, force: true }));

  const run = runCli(["--download-asr-model", "--asr-model", "iic/SenseVoiceSmall"], {
    APP_MODEL_DIR: modelDir,
  });

  assert.equal(run.status, 1);
  const lines = run.stdout.trim().split("\n");
  assert.equal(lines.length, 1, "stdout 必须恰好一行结果");
  assert.deepEqual(JSON.parse(lines[0]), {
    status: "failed",
    code: "ASR_MODEL_UNSUPPORTED",
    message: "ASR model download failed.",
  });
});

test("missing or unknown arguments are usage errors with exit 2 and no stdout", () => {
  for (const args of [
    ["--download-asr-model"],
    ["--asr-model", "iic/SenseVoiceSmall-onnx"],
    ["--download-asr-model", "--process-local-media-stdin", "--asr-model", "iic/SenseVoiceSmall-onnx"],
    ["--process-local-media-stdin", "--unknown"],
    ["--download-asr-model", "--retry-insights-stdin", "--asr-model", "iic/SenseVoiceSmall-onnx"],
    ["--process-local-media-stdin", "--retry-insights-stdin"],
    [],
  ]) {
    const run = runCli(args);
    assert.equal(run.status, 2, `${args.join(" ")} 应当是用法错误`);
    assert.equal(run.stdout, "", `${args.join(" ")} 不该往 stdout 写东西`);
    assert.match(run.stderr, /usage: cli\.ts/);
  }
});

test("--asr-model needs a value", () => {
  const run = runCli(["--download-asr-model", "--asr-model"]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--asr-model 需要一个值/);
});

test("an unusable stdin reports WORKER_STDIN_INVALID with exit 1", () => {
  for (const input of ["", "   ", "[1,2]", "{broken"]) {
    const run = runCli(["--process-local-media-stdin"], {}, input);
    assert.equal(run.status, 1, JSON.stringify(input));
    const lines = run.stdout.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), {
      status: "failed",
      task_id: null,
      task_dir: null,
      artifacts: {},
      text: "",
      summary: "",
      insights: [],
      transcript: null,
      dissection: null,
      error: {
        code: "WORKER_STDIN_INVALID",
        message: "Worker request stdin was invalid.",
        stage: "waiting_input",
      },
      draft: "",
    });
  }
});

test("an invalid request still leaves exit 0 because the failure is in the result line", (t) => {
  const root = mkdtempSync(join(tmpdir(), "locus-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const run = runCli(
    ["--process-local-media-stdin"],
    { APP_OUTPUT_DIR: join(root, "outputs"), APP_CACHE_DIR: join(root, "cache") },
    JSON.stringify({ contract_version: 4, source_path: "relative.wav" }),
  );

  assert.equal(run.status, 0);
  const lines = run.stdout.trim().split("\n");
  assert.equal(lines.length, 1, "stdout 必须恰好一行结果");
  const payload = JSON.parse(lines[0]);
  assert.equal(payload.status, "failed");
  assert.equal(payload.error.code, "LOCAL_MEDIA_VALIDATION_FAILED");
  assert.equal(payload.task_id, null);
});

test("a local media run writes progress to stderr and one result line to stdout", (t) => {
  const root = mkdtempSync(join(tmpdir(), "locus-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "missing.wav");

  const run = runCli(
    ["--process-local-media-stdin"],
    {
      APP_OUTPUT_DIR: join(root, "outputs"),
      APP_CACHE_DIR: join(root, "cache"),
      APP_MODEL_DIR: join(root, "models"),
    },
    JSON.stringify({
      contract_version: 4,
      source_path: source,
      media_kind: "audio",
      safe_display_name: "missing.wav",
      source_extension: "wav",
      asr_model: "iic/SenseVoiceSmall-onnx",
    }),
  );

  assert.equal(run.status, 0);
  const lines = run.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  const payload = JSON.parse(lines[0]);
  assert.equal(payload.status, "failed");
  assert.equal(payload.error.code, "AUDIO_NORMALIZATION_FAILED");
  assert.match(payload.task_id, /^\d{8}-\d{6}-local-[0-9a-f]{16}$/);
  // 进度事件带前缀写 stderr，stdout 里不能混进来。
  assert.match(run.stderr, /^APP_PROGRESS \{"stage":"video_extracting"/m);
  assert.equal(run.stdout.includes("APP_PROGRESS"), false);
});

test("retry-insights uses the same stdin contract as the local media mode", () => {
  for (const input of ["", "   ", "[1,2]", "{broken"]) {
    const run = runCli(["--retry-insights-stdin"], {}, input);
    assert.equal(run.status, 1, JSON.stringify(input));
    const lines = run.stdout.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).error.code, "WORKER_STDIN_INVALID");
  }
});

test("retry-insights failures live in the result line and keep exit code 0", () => {
  const badPayload = runCli(
    ["--retry-insights-stdin"],
    {},
    JSON.stringify({ task_id: "../escape", target: "summary", output_language: "zh-CN" }),
  );
  assert.equal(badPayload.status, 0);
  assert.equal(badPayload.stdout.trim().split("\n").length, 1);
  const invalid = JSON.parse(badPayload.stdout.trim());
  assert.equal(invalid.status, "partial_completed");
  assert.equal(invalid.error.code, "INVALID_RETRY_PAYLOAD");
  assert.equal(invalid.error.stage, "insights_generating");

  // 六个 target 都已实现，解析通过的请求会继续走到「打开任务」这一层。
  const notFound = runCli(
    ["--retry-insights-stdin"],
    {},
    JSON.stringify({
      task_id: "20261114-120000-local-abcdef0123456789", target: "draft",
      insight_id: 1, platform: "douyin", output_language: "zh-CN",
    }),
  );
  assert.equal(notFound.status, 0);
  assert.equal(JSON.parse(notFound.stdout.trim()).error.code, "TASK_MANIFEST_NOT_FOUND");
});

test("save-web-page usage errors pair the two arguments and validate the uuid", () => {
  for (const args of [
    ["--save-web-page-stdin"],
    ["--web-operation-id", "00000000-0000-0000-0000-000000000001"],
    ["--save-web-page-stdin", "--web-operation-id", "not-a-uuid"],
    ["--save-web-page-stdin", "--web-operation-id", "00000000-0000-0000-0000-000000000001",
      "--retry-insights-stdin"],
  ]) {
    const run = runCli(args);
    assert.equal(run.status, 2, `${args.join(" ")} 应当是用法错误`);
    assert.equal(run.stdout, "", `${args.join(" ")} 不该往 stdout 写东西`);
    assert.match(run.stderr, /usage: cli\.ts/);
  }
});

test("save-web-page rejects a stdin operation id that differs from the command line", () => {
  const root = mkdtempSync(join(tmpdir(), "locus-cli-"));
  try {
    const run = runCli(
      ["--save-web-page-stdin", "--web-operation-id", "00000000-0000-0000-0000-000000000001"],
      { APP_OUTPUT_DIR: join(root, "outputs"), APP_CACHE_DIR: join(root, "cache") },
      JSON.stringify({
        contract_version: 2,
        operation_id: "00000000-0000-0000-0000-000000000002",
        task_id: "20261114-120000-web-abcdef0123456789",
        article: {
          title: "标题", text: "正文".repeat(40), markdown: "# 标题\n",
          sourceUrl: "https://example.io/a",
        },
      }),
    );
    assert.equal(run.status, 1);
    const lines = run.stdout.trim().split("\n");
    assert.equal(lines.length, 1);
    const payload = JSON.parse(lines[0]);
    assert.equal(payload.status, "failed");
    assert.deepEqual(payload.error, {
      code: "WORKER_STDIN_INVALID",
      message: "Worker request stdin was invalid.",
      stage: "web_saving",
    });
    assert.equal(payload.task_id, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a web page save via the real CLI writes one result line and one progress event", (t) => {
  const root = mkdtempSync(join(tmpdir(), "locus-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const run = runCli(
    ["--save-web-page-stdin", "--web-operation-id", "00000000-0000-0000-0000-000000000001"],
    {
      APP_OUTPUT_DIR: join(root, "outputs"),
      APP_CACHE_DIR: join(root, "cache"),
    },
    JSON.stringify({
      contract_version: 2,
      operation_id: "00000000-0000-0000-0000-000000000001",
      task_id: "20261114-120000-web-abcdef0123456789",
      article: {
        title: "公开文章与本地保存",
        text: "段落保留原始UTF-8字节。\n".repeat(8),
        markdown: "## 文章\n\n段落保留结构。\n",
        sourceUrl: "https://example.io/articles/a1",
      },
    }),
  );

  assert.equal(run.status, 0);
  const lines = run.stdout.trim().split("\n");
  assert.equal(lines.length, 1, "stdout 必须恰好一行结果");
  const payload = JSON.parse(lines[0]);
  assert.equal(payload.status, "completed");
  assert.equal(payload.task_id, "20261114-120000-web-abcdef0123456789");
  assert.equal(payload.task_created, true);
  assert.deepEqual(payload.artifacts, {
    article_txt: "article/article.txt", article_md: "article/article.md",
  });
  assert.equal(payload.source.url, "https://example.io/articles/a1");

  const events = run.stderr.trim().split("\n").filter((line) => line.includes("APP_PROGRESS"));
  assert.deepEqual(events.map((line) => JSON.parse(line.slice("APP_PROGRESS".length)).message_code),
    ["web.page.saving"]);
});

test("probe-llm-stdin folds every stdin problem into one invalid-request result line", () => {
  for (const stdin of ["", "not json", "[]", JSON.stringify({base_url: "x"})]) {
    const run = runCli(["--probe-llm-stdin"], {}, stdin);
    assert.equal(run.status, 0, `stdin=${stdin} 也要正常结束`);
    const lines = run.stdout.trim().split("\n");
    assert.equal(lines.length, 1, `stdin=${stdin} 恰好一行结果`);
    const payload = JSON.parse(lines[0]);
    assert.equal(payload.ok, false);
    assert.equal(payload.error_code, "LLM_PROBE_INVALID_REQUEST");
    assert.equal(Number.isInteger(payload.latency_ms), true);
  }
});

test("probe-llm-stdin short-circuits before the one-mode exclusivity check like python", () => {
  // Python 的探针分支在模式互斥之前：带其它模式时探针照样跑、退出 0。
  const run = runCli(["--probe-llm-stdin", "--retry-insights-stdin"], {}, "not json");
  assert.equal(run.status, 0);
  const payload = JSON.parse(run.stdout.trim());
  assert.equal(payload.error_code, "LLM_PROBE_INVALID_REQUEST");
});

test("probe-llm-stdin still honours the web and asr pairing validations", () => {
  for (const args of [
    ["--probe-llm-stdin", "--save-web-page-stdin"],
    ["--probe-llm-stdin", "--asr-model", "iic/SenseVoiceSmall-onnx"],
  ]) {
    const run = runCli(args);
    assert.equal(run.status, 2, `${args.join(" ")} 该按用法错误退出`);
    assert.equal(run.stdout, "");
  }
});

test("resolve-source-stdin returns bare completed and failed envelopes with exit 0", () => {
  const good = runCli(["--resolve-source-stdin"], {}, JSON.stringify({
    url: "https://www.bilibili.com/video/BV1Aa411c7mD?p=2&spm_id_from=secret",
  }));
  assert.equal(good.status, 0);
  const lines = good.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    status: "completed",
    source_url: "https://www.bilibili.com/video/BV1Aa411c7mD?p=2",
    source_identity: {
      version: 1, platform: "bilibili", stable_id: "BV1Aa411c7mD",
      effective_part: 2, canonical_url: "https://www.bilibili.com/video/BV1Aa411c7mD?p=2",
    },
  });

  for (const stdin of ["{}", JSON.stringify({url: "https://example.com/watch/1"})]) {
    const run = runCli(["--resolve-source-stdin"], {}, stdin);
    assert.equal(run.status, 0, `stdin=${stdin} 业务失败也是正常结束`);
    const payload = JSON.parse(run.stdout.trim());
    assert.equal(payload.status, "failed");
    assert.equal(payload.task_id, undefined, "来源识别是裸信封，没有 task_id");
    assert.equal(payload.error.stage, undefined, "错误里没有 stage 键");
  }
});

test("resolve-source-stdin folds stdin problems into a bare failed envelope with exit 1", () => {
  // Python 的 read_stdin_request 在读入时就校验 JSON 与对象形状：坏 JSON、
  // 非对象都算 stdin 失败，走 stdin_failure_result 并退出 1。
  for (const stdin of ["", "not json", "[]"]) {
    const run = runCli(["--resolve-source-stdin"], {}, stdin);
    assert.equal(run.status, 1, `stdin=${stdin} 读失败退出 1`);
    assert.deepEqual(JSON.parse(run.stdout.trim()), {
      status: "failed", error: {code: "WORKER_STDIN_INVALID"},
    });
  }
});

test("request-stdin is a registered mode with the same stdin contract", () => {
  for (const stdin of ["", "[1,2]", "{broken"]) {
    const run = runCli(["--request-stdin"], {}, stdin);
    assert.equal(run.status, 1, JSON.stringify(stdin));
    assert.deepEqual(JSON.parse(run.stdout.trim()), {
      status: "failed",
      task_id: null,
      task_dir: null,
      artifacts: {},
      text: "",
      summary: "",
      insights: [],
      transcript: null,
      dissection: null,
      error: {
        code: "WORKER_STDIN_INVALID",
        message: "Worker request stdin was invalid.",
        stage: "waiting_input",
      },
      draft: "",
    });
  }
  const combined = runCli(["--request-stdin", "--process-local-media-stdin"]);
  assert.equal(combined.status, 2, "一次只能指定一个模式");
  assert.equal(combined.stdout, "");
});

test("request-stdin reports invalid payloads and a missing downloader in the result line", () => {
  const invalid = runCli(["--request-stdin"], {}, JSON.stringify({
    contract_version: 3, url: "https://www.douyin.com/video/7524373044106677544",
  }));
  assert.equal(invalid.status, 0);
  assert.equal(JSON.parse(invalid.stdout.trim()).error.code, "INVALID_REQUEST_PAYLOAD");

  // 没有注入 APP_YTDLP_PATH、项目根也没有 bin/ 资产：固定失败码，不泄漏路径。
  const valid = runCli(["--request-stdin"], {
    APP_YTDLP_PATH: "",
  }, JSON.stringify({
    contract_version: 3,
    url: "https://www.douyin.com/video/7524373044106677544",
    asr_model: "iic/SenseVoiceSmall-onnx",
  }));
  assert.equal(valid.status, 0);
  const payload = JSON.parse(valid.stdout.trim());
  assert.equal(payload.status, "failed");
  assert.equal(payload.error.code, "VIDEO_DOWNLOAD_FAILED");
  assert.equal(payload.error.message, "Video downloader is unavailable.");
});
