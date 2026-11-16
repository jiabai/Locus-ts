// URL 任务管线的跨语言静态守卫。
// 基准由 scripts/tests/url-media-golden.py 从 Python MediaPreparationFacade 生成；
// 这里把「哪些源码决定事件、错误码、CLI 入口与随包下载器路径」钉住。
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, '..', '..');
const pythonRoot = resolve(repositoryRoot, 'worker', 'worker_core');
const workerRoot = resolve(repositoryRoot, 'worker-ts');

async function read(...parts) {
  return readFile(join(...parts), 'utf8');
}

test('URL media preparation shares progress events and failure codes with Python', async () => {
  const preparation = await read(pythonRoot, 'media_preparation.py');
  const typescript = await read(workerRoot, 'src', 'media', 'url-media.ts');

  for (const code of [
    'video.download.preparing', 'video.stream.validating', 'audio.extract.running',
    'audio.extract.reused', 'subtitle.detect.running',
  ]) {
    assert.ok(preparation.includes(`"${code}"`), `Python 缺少事件 ${code}`);
    assert.ok(typescript.includes(`'${code}'`), `TypeScript 缺少事件 ${code}`);
  }
  for (const [code, message] of [
    ['VIDEO_DOWNLOAD_FAILED', 'Media command failed'],
    ['VIDEO_DOWNLOAD_OUTPUT_MISSING', 'Video download completed but no media file was found.'],
    ['MEDIA_VALIDATION_FAILED', 'Downloaded file must contain valid video and audio streams.'],
    ['AUDIO_EXTRACTION_FAILED', 'Audio extraction failed.'],
  ]) {
    assert.ok(preparation.includes(`"${code}"`), `Python 缺少错误码 ${code}`);
    assert.ok(typescript.includes(`'${code}'`), `TypeScript 缺少错误码 ${code}`);
    if (message !== 'Media command failed') {
      assert.ok(typescript.includes(`'${message}'`), `TypeScript 缺少文案 ${code}`);
    }
  }
  assert.ok(preparation.includes('sanitize_source_text(str(exc), source.request)'));
  assert.ok(typescript.includes('sanitizeSourceText(error.message, source)'));
  assert.ok(preparation.includes("command[0] == \"bilibili-fallback\""));
  assert.ok(typescript.includes('isBilibiliFallbackCommand(downloadResult.command)'));
});

test('the URL pipeline mirrors run_worker_pipeline stages', async () => {
  const orchestration = await read(pythonRoot, 'pipeline_runtime', 'orchestration.py');
  const transcript = await read(pythonRoot, 'pipeline_runtime', 'transcript.py');
  const pipeline = await read(workerRoot, 'src', 'pipeline', 'url-media.ts');

  assert.ok(orchestration.includes('write_prepared_subtitle_stage'));
  assert.ok(orchestration.includes('run_asr_transcript_stage'));
  assert.ok(orchestration.includes('def complete_transcript_stage'));
  assert.ok(transcript.includes('"subtitle.detect.found"'));
  assert.ok(transcript.includes('"asr.transcribe.starting"'));
  for (const code of [
    'subtitle.detect.found', 'asr.transcribe.starting', 'asr.cache.preparing',
    'asr.transcribe.running',
  ]) {
    assert.ok(pipeline.includes(`'${code}'`), `TypeScript 管线缺少事件 ${code}`);
  }
  for (const code of [
    'SOURCE_IDENTITY_UNAVAILABLE', 'TASK_STORAGE_UNAVAILABLE',
    'ASR_MODEL_UNSUPPORTED', 'ASR_MODEL_NOT_DOWNLOADED',
    'TASK_ARTIFACT_COMMIT_FAILED', 'TASK_ARTIFACT_RECOVERY_FAILED',
  ]) {
    assert.ok(pipeline.includes(`'${code}'`), `TypeScript 管线缺少失败码 ${code}`);
  }
  assert.ok(pipeline.includes('normalizeLanguageTag'));
  assert.ok(pipeline.includes('canonicalSourceUrl'));
});

test('the standalone downloader path is an explicit contract env key', async () => {
  const contract = JSON.parse(await read(repositoryRoot, 'contracts', 'desktop-worker-contract.json'));
  const constants = await read(workerRoot, 'src', 'protocol', 'contract.ts');
  const service = await read(workerRoot, 'src', 'worker-service.ts');
  const cli = await read(workerRoot, 'src', 'cli.ts');

  assert.equal(contract.env.ytdlpPath, 'APP_YTDLP_PATH');
  assert.ok(constants.includes("YTDLP_PATH_ENV = 'APP_YTDLP_PATH'"));
  assert.ok(service.includes('resolveYtdlpLauncher(environ, options.projectRoot)'));
  assert.ok(service.includes("'yt-dlp.exe'") && service.includes("'yt-dlp_macos'"));
  assert.ok(cli.includes("'--request-stdin'"));
  assert.ok(cli.includes("runProcessVideoOnce(payload"));
});

test('platform transports stay injectable and the probe is wired by default', async () => {
  const pipeline = await read(workerRoot, 'src', 'pipeline', 'url-media.ts');
  const strategies = await read(workerRoot, 'src', 'media', 'platform-strategies.ts');
  assert.ok(pipeline.includes('options.strategies ?? createPlatformFallbackStrategies()'));
  assert.ok(pipeline.includes('options.probeXiaohongshuSubtitle'));
  assert.ok(pipeline.includes('downloadXiaohongshuSubtitleProbe'));
  assert.ok(strategies.includes('[FALLBACK_COMMAND_NAMES.douyin]'));
  assert.ok(strategies.includes('[FALLBACK_COMMAND_NAMES.xiaohongshu]'));
  assert.ok(strategies.includes('[FALLBACK_COMMAND_NAMES.bilibili]'));
});

test('golden is generated from Python production code and consumed by TS tests', async () => {
  const generator = await read(repositoryRoot, 'scripts', 'tests', 'url-media-golden.py');
  const unit = await read(workerRoot, 'tests', 'url-media.test.mjs');
  const fixture = await read(workerRoot, 'tests', 'fixtures', 'url-media-golden.json');

  assert.ok(generator.includes('MediaPreparationFacade('));
  assert.ok(generator.includes('facade.prepare('));
  assert.ok(generator.includes('normalize_language_tag'));
  assert.ok(unit.includes('fixtures/url-media-golden.json'));
  assert.ok(unit.includes('assert.deepEqual(actual.events, entry.events'));
  const parsed = JSON.parse(fixture);
  assert.equal(parsed.cases.length, 10);
  assert.ok(parsed.cases.some((entry) => entry.outcome.error));
  assert.ok(parsed.cases.some((entry) => entry.outcome.subtitle));
});
