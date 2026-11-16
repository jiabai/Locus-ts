// worker 的命令行入口。
//
// 与 Python 版 `worker_core/cli.py` 的分工保持一致：参数解析、事件打到 stderr、
// 单行 JSON 结果打到 stdout、退出码只表达「宿主是否该停下来」。
// 尚未迁移的模式不注册参数，宿主传进来会得到用法错误（退出码 2），而不是静默成功。
import process from 'node:process';

import {jsonLine} from './protocol/contract.ts';
import {MAX_WEB_PAGE_MESSAGE_BYTES} from './web/web-page-contract.ts';
import {renderModelProgressEvent, renderWorkerProgressEvent} from './protocol/events.ts';
import {readStdinRequest, StdinRequestError} from './protocol/stdin.ts';
import {runLlmProbe} from './ai/llm-probe.ts';
import {resolveSourceIdentityOnce} from './sources/resolve-source.ts';
import {failedResult, resultToPayload} from './tasks/types.ts';
import {
  runAsrModelDownloadOnce,
  runProcessLocalMediaOnce,
  runProcessVideoOnce,
  runRetryInsightsOnce,
  runSaveWebPageOnce,
} from './worker-service.ts';

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const USAGE = [
  'usage: cli.ts --download-asr-model --asr-model <model-id>',
  '       cli.ts --request-stdin             (URL 任务请求走 stdin)',
  '       cli.ts --process-local-media-stdin   (请求走 stdin)',
  '       cli.ts --save-web-page-stdin --web-operation-id <uuid>   (请求走 stdin)',
  '       cli.ts --retry-insights-stdin       (请求走 stdin)',
  '       cli.ts --resolve-source-stdin       (来源识别请求走 stdin)',
  '       cli.ts --probe-llm-stdin            (BYOK 探针请求走 stdin)',
  '',
  '  --download-asr-model      下载（或复用）ASR 模型缓存到 APP_MODEL_DIR',
  '  --asr-model <model-id>    需配合 --download-asr-model；只接受 iic/SenseVoiceSmall-onnx',
  '  --request-stdin          处理一条 URL 任务，结果写到 stdout',
  '  --process-local-media-stdin  处理一条本地音视频任务，结果写到 stdout',
  '  --save-web-page-stdin     保存一份网页抽取为正式任务；stdin 上限 40 MiB',
  '  --web-operation-id <uuid> 需配合 --save-web-page-stdin；请求里的 operation_id 必须与它一致',
  '  --retry-insights-stdin   为已转写的任务重新生成产物，结果写到 stdout',
  '  --resolve-source-stdin   识别一条分享链接的平台与稳定 ID，结果写到 stdout',
  '  --probe-llm-stdin        探测一条 BYOK 模型配置，输出 {ok, error_code, latency_ms}',
].join('\n');

type Mode =
  | 'download-model'
  | 'process-video'
  | 'process-local-media'
  | 'save-web-page'
  | 'retry-insights'
  | 'resolve-source';

interface ParsedArgs {
  readonly mode: Mode;
  readonly asrModel?: string;
  readonly webOperationId?: string;
  readonly probeLlmStdin: boolean;
}

class UsageError extends Error {}

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function parseArgs(argv: readonly string[]): ParsedArgs {
  let downloadAsrModel = false;
  let processVideo = false;
  let processLocalMedia = false;
  let saveWebPage = false;
  let retryInsights = false;
  let resolveSource = false;
  let probeLlmStdin = false;
  let asrModel: string | undefined;
  let webOperationId: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--download-asr-model') {
      downloadAsrModel = true;
    } else if (argument === '--request-stdin') {
      processVideo = true;
    } else if (argument === '--process-local-media-stdin') {
      processLocalMedia = true;
    } else if (argument === '--save-web-page-stdin') {
      saveWebPage = true;
    } else if (argument === '--retry-insights-stdin') {
      retryInsights = true;
    } else if (argument === '--resolve-source-stdin') {
      resolveSource = true;
    } else if (argument === '--probe-llm-stdin') {
      probeLlmStdin = true;
    } else if (argument === '--asr-model') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError('--asr-model 需要一个值');
      asrModel = value;
      index += 1;
    } else if (argument === '--web-operation-id') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError('--web-operation-id 需要一个值');
      if (!CANONICAL_UUID.test(value)) throw new UsageError('--web-operation-id 必须是规范小写 UUID');
      webOperationId = value;
      index += 1;
    } else {
      throw new UsageError(`未知参数：${argument}`);
    }
  }

  if (downloadAsrModel && asrModel === undefined) {
    throw new UsageError('--download-asr-model 需要 --asr-model');
  }
  if (!downloadAsrModel && asrModel !== undefined) {
    throw new UsageError('--asr-model 只能与 --download-asr-model 一起使用');
  }
  // 与 Python 一致：`--save-web-page-stdin` 与 `--web-operation-id` 必须成对出现。
  if (saveWebPage !== (webOperationId !== undefined)) {
    throw new UsageError('--save-web-page-stdin 需要 --web-operation-id');
  }
  if (!saveWebPage && webOperationId !== undefined) {
    throw new UsageError('--web-operation-id 只能与 --save-web-page-stdin 一起使用');
  }
  // 与 Python 一样：探针在配对校验之后、模式互斥之前短路——它只管 stdin 的
  // 一份独立请求，跟其余模式不抢 stdin，也就不受「一次只能指定一个模式」约束。
  if (probeLlmStdin) {
    return {mode: 'retry-insights', probeLlmStdin, ...(asrModel === undefined ? {} : {asrModel}),
      ...(webOperationId === undefined ? {} : {webOperationId})};
  }
  const modes = [downloadAsrModel, processVideo, processLocalMedia, saveWebPage, retryInsights, resolveSource]
    .filter(Boolean);
  if (modes.length !== 1) throw new UsageError('一次只能指定一个模式');
  return {
    mode: downloadAsrModel
      ? 'download-model'
      : processVideo ? 'process-video'
        : processLocalMedia ? 'process-local-media'
          : saveWebPage ? 'save-web-page'
            : retryInsights ? 'retry-insights' : 'resolve-source',
    probeLlmStdin,
    ...(asrModel === undefined ? {} : {asrModel}),
    ...(webOperationId === undefined ? {} : {webOperationId}),
  };
}

/** 结束码与 Python 一致：只有模型下载会把 failed 变成非零退出码。 */
async function runDownloadModel(asrModel: string): Promise<number> {
  const result = await runAsrModelDownloadOnce({
    model: asrModel,
    onProgress: (event) => {
      process.stderr.write(`${renderModelProgressEvent(event)}\n`);
    },
  });
  process.stdout.write(`${jsonLine(result)}\n`);
  return result.status === 'failed' ? EXIT_FAILED : EXIT_OK;
}

/** stdin 不可用时连请求都没有，只能按契约回一条固定失败结果。 */
async function readRequest(stage: 'waiting_input' | 'web_saving' = 'waiting_input'): Promise<Record<string, unknown> | null> {
  try {
    return await readStdinRequest(process.stdin, stage === 'web_saving' ? MAX_WEB_PAGE_MESSAGE_BYTES : undefined);
  } catch (error) {
    if (!(error instanceof StdinRequestError)) throw error;
    process.stdout.write(`${jsonLine(resultToPayload(failedResult({
      code: 'WORKER_STDIN_INVALID',
      message: 'Worker request stdin was invalid.',
      stage,
    })))}\n`);
    return null;
  }
}

/** URL 任务：stdin 上限 1 MiB，业务失败写在结果行里，退出码仍是 0。 */
async function runProcessVideo(): Promise<number> {
  const payload = await readRequest();
  if (payload === null) return EXIT_FAILED;

  const result = await runProcessVideoOnce(payload, {
    projectRoot: process.cwd(),
    onProgress: (event) => {
      process.stderr.write(`${renderWorkerProgressEvent(event)}\n`);
    },
  });
  process.stdout.write(`${jsonLine(result)}\n`);
  return EXIT_OK;
}

async function runLocalMedia(): Promise<number> {
  const payload = await readRequest();
  if (payload === null) return EXIT_FAILED;

  const result = await runProcessLocalMediaOnce(payload, {
    projectRoot: process.cwd(),
    onProgress: (event) => {
      process.stderr.write(`${renderWorkerProgressEvent(event)}\n`);
    },
  });
  process.stdout.write(`${jsonLine(result)}\n`);
  // 媒体任务的失败写在结果行里，宿主按 status 分流；退出码 0 表示「worker 正常结束了」。
  return EXIT_OK;
}

async function runRetryInsights(): Promise<number> {
  const payload = await readRequest();
  if (payload === null) return EXIT_FAILED;

  const result = await runRetryInsightsOnce(payload, {
    projectRoot: process.cwd(),
    onProgress: (event) => {
      process.stderr.write(`${renderWorkerProgressEvent(event)}\n`);
    },
  });
  process.stdout.write(`${jsonLine(result)}\n`);
  // 与 Python 的 `return 1 if is_model_download and failed else 0` 一致：
  // 重新生成的失败由结果行的 status/error 表达，进程本身正常结束。
  return EXIT_OK;
}

/**
 * 来源识别：裸信封结果（没有 task_id / artifacts）。stdin 读失败按 Python 的
 * `stdin_failure_result("resolve_source_identity")` 输出并退出 1；业务失败
 * （坏 JSON / 无 url / 不支持的平台）收敛成 failed 结果行、退出码 0。
 */
async function runResolveSource(): Promise<number> {
  let payload: Record<string, unknown> | null;
  try {
    payload = await readStdinRequest(process.stdin);
  } catch (error) {
    if (!(error instanceof StdinRequestError)) throw error;
    payload = null;
  }
  if (payload === null) {
    process.stdout.write(`${jsonLine({status: 'failed', error: {code: 'WORKER_STDIN_INVALID'}})}\n`);
    return EXIT_FAILED;
  }
  const result = await resolveSourceIdentityOnce(JSON.stringify(payload));
  process.stdout.write(`${jsonLine(result)}\n`);
  return EXIT_OK;
}

/**
 * BYOK 探针：stdin 读失败按 Python 一样当作「没有请求」处理——探针把一切
 * stdin 问题都折叠成 LLM_PROBE_INVALID_REQUEST 结果行，退出码仍是 0。
 */
async function runProbeLlm(): Promise<number> {
  let requestJson: string | undefined;
  try {
    // Python 的 `read_stdin_request` 返回规范化 JSON 文本，探针再解析一次；
    // TS 直接把对象序列化回去，语义一致。
    requestJson = JSON.stringify(await readStdinRequest(process.stdin));
  } catch (error) {
    if (!(error instanceof StdinRequestError)) throw error;
    requestJson = undefined;
  }
  const result = await runLlmProbe(requestJson);
  process.stdout.write(`${jsonLine(result)}\n`);
  return EXIT_OK;
}

/** 网页保存：stdin 上限 40 MiB，请求里的 `operation_id` 必须与命令行一致。 */
async function runSaveWebPage(webOperationId: string): Promise<number> {
  const payload = await readRequest('web_saving');
  if (payload === null) return EXIT_FAILED;
  if (payload.operation_id !== webOperationId) {
    process.stdout.write(`${jsonLine(resultToPayload(failedResult({
      code: 'WORKER_STDIN_INVALID',
      message: 'Worker request stdin was invalid.',
      stage: 'web_saving',
    })))}\n`);
    return EXIT_FAILED;
  }

  const result = await runSaveWebPageOnce(payload, {
    onProgress: (event) => {
      process.stderr.write(`${renderWorkerProgressEvent(event)}\n`);
    },
  });
  process.stdout.write(`${jsonLine(result)}\n`);
  // 与媒体任务一致：保存失败写在结果行里，进程本身正常结束。
  return EXIT_OK;
}

async function main(argv: readonly string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    return EXIT_USAGE;
  }

  // 探针永远「正常结束」：请求校验失败也回一条结果，退出码恒为 0。
  if (args.probeLlmStdin) return runProbeLlm();
  if (args.mode === 'download-model') return runDownloadModel(args.asrModel as string);
  if (args.mode === 'process-video') return runProcessVideo();
  if (args.mode === 'process-local-media') return runLocalMedia();
  if (args.mode === 'save-web-page') return runSaveWebPage(args.webOperationId as string);
  if (args.mode === 'resolve-source') return runResolveSource();
  return runRetryInsights();
}

// 与 Python 外层保护等价：任何未捕获失败都要留下痕迹，但绝不能污染 stdout 的那一行结果。
main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`worker crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(EXIT_FAILED);
  },
);
