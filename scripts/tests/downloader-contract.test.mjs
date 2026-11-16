// 下载器内核的跨语言静态守卫。
// Python `worker_core/media.py` / `subtitles.py` / `media_preparation.py` 与
// TypeScript `worker-ts/src/media/` 必须共享命令参数、错误码、字幕规则与
// 「URL 管线只调用官方独立可执行文件」这条边界。
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

test('ytdlp command constants and selectors are identical on both sides', async () => {
  const python = await read(pythonRoot, 'media.py');
  const typescript = await read(workerRoot, 'src', 'media', 'ytdlp.ts');

  assert.ok(python.includes('"--no-playlist"'));
  assert.ok(python.includes('"--merge-output-format"'));
  assert.ok(python.includes('YOUTUBE_JS_RUNTIMES = ("deno", "node", "quickjs", "bun")'));
  assert.ok(python.includes('YTDLP_DOWNLOAD_TIMEOUT_SECONDS = 20 * 60'));
  assert.ok(python.includes('YTDLP_DOWNLOAD_TIMEOUT_CODE = "VIDEO_DOWNLOAD_TIMEOUT"'));
  assert.ok(python.includes('"zh-Hans,zh-CN,zh-Hant,zh,en,ja,ko"'));
  for (const argument of [
    '--no-playlist', '--merge-output-format', '--js-runtimes', '--write-subs',
    '--write-auto-subs', '--sub-langs', '--sub-format',
  ]) {
    assert.ok(typescript.includes(`'${argument}'`), `TypeScript 缺少参数 ${argument}`);
  }
  assert.ok(typescript.includes("'zh-Hans,zh-CN,zh-Hant,zh,en,ja,ko'"));
  assert.ok(typescript.includes('YTDLP_DOWNLOAD_TIMEOUT_SECONDS = 20 * 60'));
  assert.ok(typescript.includes("YTDLP_DOWNLOAD_TIMEOUT_CODE = 'VIDEO_DOWNLOAD_TIMEOUT'"));
  // 独立可执行文件是产品规格决定：TypeScript 不得回退到系统 Python 的 yt_dlp 模块。
  assert.ok(!typescript.includes("'-m', 'yt_dlp'"));
  assert.ok(!typescript.includes('sys.executable'));
});

test('youtube classification codes and cookie sanitizing markers stay in sync', async () => {
  const python = await read(pythonRoot, 'media.py');
  const typescript = await read(workerRoot, 'src', 'media', 'ytdlp.ts');

  for (const code of [
    'YOUTUBE_AGE_RESTRICTED', 'YOUTUBE_RATE_LIMITED', 'YOUTUBE_LOGIN_REQUIRED',
    'YOUTUBE_NO_PLAYABLE_STREAM', 'YOUTUBE_PRIVATE_OR_UNAVAILABLE',
    'YOUTUBE_STREAM_FORBIDDEN', 'YOUTUBE_DOWNLOAD_FAILED',
  ]) {
    assert.ok(python.includes(`code = "${code}"`) || python.includes(`"${code}"`), code);
    assert.ok(typescript.includes(`'${code}'`), `TypeScript 缺少失败码 ${code}`);
  }
  assert.ok(python.includes('"[youtube media url removed]"'));
  assert.ok(typescript.includes("'[youtube media url removed]'"));
  assert.ok(python.includes('"unable to download video subtitles"'));
  assert.ok(typescript.includes("'unable to download video subtitles'"));
});

test('subtitle rules use the same language order, suffixes and dedupe semantics', async () => {
  const python = await read(pythonRoot, 'subtitles.py');
  const typescript = await read(workerRoot, 'src', 'media', 'subtitles.ts');
  const preparation = await read(pythonRoot, 'media_preparation.py');
  const downloadOutput = await read(workerRoot, 'src', 'media', 'download-output.ts');

  for (const language of ['zh-Hans', 'zh-CN', 'zh-Hant', 'zh', 'en-US', 'en', 'ja', 'ko']) {
    assert.ok(python.includes(`"${language}"`), language);
    assert.ok(typescript.includes(`'${language}'`), `TypeScript 缺少语言 ${language}`);
  }
  assert.ok(python.includes('SUPPORTED_SUBTITLE_SUFFIXES = (".srt", ".vtt")'));
  assert.ok(typescript.includes("['.srt', '.vtt']"));
  assert.ok(python.includes('html.unescape(without_tags)'));
  assert.ok(typescript.includes('decodeHTML('));
  assert.ok(preparation.includes('VIDEO_SUFFIXES = {".mp4", ".mov", ".mkv", ".webm", ".m4v"}'));
  for (const suffix of ['.mp4', '.mov', '.mkv', '.webm', '.m4v']) {
    assert.ok(downloadOutput.includes(`'${suffix}'`), suffix);
  }
});

test('orchestration keeps python retry, fallback and timeout structure', async () => {
  const python = await read(pythonRoot, 'media.py');
  const typescript = await read(workerRoot, 'src', 'media', 'download.ts');

  assert.ok(python.includes('_raise_if_download_timeout(result)'));
  assert.ok(python.includes('include_subtitles=False'));
  assert.ok(python.includes('for strategy in FALLBACK_DOWNLOAD_STRATEGIES'));
  assert.ok(python.includes('f"{exc.code}: {exc}"'));
  assert.ok(typescript.includes('structuredErrorCode(result.stderr) === YTDLP_DOWNLOAD_TIMEOUT_CODE'));
  assert.ok(typescript.includes('commandFor(options, false)'));
  assert.ok(typescript.includes('for (const strategy of options.strategies)'));
  assert.ok(typescript.includes('`${error.code}: ${error.message}`'));
  for (const name of ['douyin-fallback', 'xiaohongshu-fallback', 'bilibili-fallback']) {
    assert.ok(python.includes(`command_name="${name}"`), name);
    assert.ok(typescript.includes(`'${name}'`), name);
  }
});

test('the URL pipeline calls the standalone downloader and registers the CLI mode', async () => {
  const pythonCli = await read(pythonRoot, 'cli.py');
  const typescriptCli = await read(workerRoot, 'src', 'cli.ts');
  const urlMedia = await read(workerRoot, 'src', 'media', 'url-media.ts');
  const pipeline = await read(workerRoot, 'src', 'pipeline', 'url-media.ts');
  const spec = await read(repositoryRoot, 'docs', 'product-specs', '2026-11-13-worker-typescript-rewrite.md');

  assert.ok(pythonCli.includes('"--request-stdin"'));
  assert.ok(typescriptCli.includes("'--request-stdin'"), 'URL 管线接通后必须注册该参数');
  assert.ok(urlMedia.includes('downloadVideo({'));
  assert.ok(urlMedia.includes('launcher: options.launcher'));
  assert.ok(pipeline.includes('runUrlMediaPipeline'));
  assert.ok(spec.includes('禁止回退到系统 Python'));
  // 三平台全部接通：默认策略由 platform-strategies 装配，且不再有空实现。
  assert.ok(pipeline.includes('options.strategies ?? createPlatformFallbackStrategies()'));
  const platformStrategies = await read(workerRoot, 'src', 'media', 'platform-strategies.ts');
  assert.ok(platformStrategies.includes('[FALLBACK_COMMAND_NAMES.douyin]'));
  assert.ok(platformStrategies.includes('[FALLBACK_COMMAND_NAMES.xiaohongshu]'));
  assert.ok(platformStrategies.includes('[FALLBACK_COMMAND_NAMES.bilibili]'));
});

test('installer bakes the standalone yt-dlp asset instead of a python module', async () => {
  const spec = await read(repositoryRoot, 'docs', 'product-specs', '2026-11-13-worker-typescript-rewrite.md');
  assert.ok(spec.includes('官方独立 yt-dlp 可执行文件'));
  assert.ok(spec.includes('禁止回退到系统 Python'));
});
