// 小红书传输层的跨语言静态守卫。
// Python `worker_core/xiaohongshu*` 与 TypeScript `worker-ts/src/sources/xiaohongshu/`
// 必须共享常量、请求头、错误码、字幕优先序与「三平台全部接通」的装配边界。
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

test('xiaohongshu constants are identical on both sides', async () => {
  const pythonTransport = await read(pythonRoot, 'xiaohongshu', 'transport.py');
  const pythonSource = await read(pythonRoot, 'xiaohongshu', 'source.py');
  const pythonPage = await read(pythonRoot, 'xiaohongshu', 'page.py');
  const typescriptTransport = await read(workerRoot, 'src', 'sources', 'xiaohongshu', 'transport.ts');
  const typescriptSource = await read(workerRoot, 'src', 'sources', 'xiaohongshu', 'source.ts');
  const typescriptPage = await read(workerRoot, 'src', 'sources', 'xiaohongshu', 'page.ts');

  assert.ok(pythonTransport.includes('Chrome/120.0 Safari/537.36'));
  assert.ok(typescriptTransport.includes('Chrome/120.0 Safari/537.36'));
  assert.ok(pythonTransport.includes('XHS_MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024'));
  assert.ok(typescriptTransport.includes('XHS_MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024'));
  assert.ok(pythonTransport.includes('XHS_DOWNLOAD_CHUNK_BYTES = 256 * 1024'));
  assert.ok(typescriptTransport.includes('XHS_DOWNLOAD_CHUNK_BYTES = 256 * 1024'));
  assert.ok(pythonTransport.includes('XHS_NO_PROGRESS_TIMEOUT_SECONDS = 120.0'));
  assert.ok(typescriptTransport.includes('XHS_NO_PROGRESS_TIMEOUT_SECONDS = 120'));
  assert.ok(pythonTransport.includes('XHS_MAX_SUBTITLE_BYTES = 2 * 1024 * 1024'));
  assert.ok(typescriptTransport.includes('XHS_MAX_SUBTITLE_BYTES = 2 * 1024 * 1024'));
  assert.ok(pythonPage.includes('XHS_MAX_HTML_BYTES = 10 * 1024 * 1024'));
  assert.ok(typescriptPage.includes('XHS_MAX_HTML_BYTES = 10 * 1024 * 1024'));
  assert.ok(pythonSource.includes('XHS_MAX_REDIRECT_DEPTH = 5'));
  assert.ok(typescriptSource.includes('XHS_MAX_REDIRECT_DEPTH = 5'));
  assert.ok(pythonSource.includes('XHS_SHORT_LINK_BODY_BYTES = 256 * 1024'));
  assert.ok(typescriptSource.includes('XHS_SHORT_LINK_BODY_BYTES = 256 * 1024'));
  assert.ok(pythonSource.includes('XHS_BASE_URL = "https://www.xiaohongshu.com"'));
  assert.ok(typescriptSource.includes("XHS_BASE_URL = 'https://www.xiaohongshu.com'"));
  assert.ok(pythonTransport.includes('XHS_REFERER = "https://www.xiaohongshu.com/"'));
  assert.ok(typescriptTransport.includes("XHS_REFERER = 'https://www.xiaohongshu.com/'"));
});

test('xiaohongshu headers, short hosts and subtitle rules stay in sync', async () => {
  const pythonTransport = await read(pythonRoot, 'xiaohongshu', 'transport.py');
  const pythonSource = await read(pythonRoot, 'xiaohongshu', 'source.py');
  const pythonSubtitles = await read(pythonRoot, 'xiaohongshu', 'subtitles.py');
  const typescriptTransport = await read(workerRoot, 'src', 'sources', 'xiaohongshu', 'transport.ts');
  const typescriptSource = await read(workerRoot, 'src', 'sources', 'xiaohongshu', 'source.ts');
  const typescriptSubtitles = await read(workerRoot, 'src', 'sources', 'xiaohongshu', 'subtitles.ts');

  for (const header of ['User-Agent', 'Referer', 'Accept', 'Accept-Language',
    'Accept-Encoding', 'Connection', 'Cache-Control']) {
    assert.ok(pythonTransport.includes(`"${header}"`), header);
    assert.ok(typescriptTransport.includes(header), `TypeScript 缺少请求头 ${header}`);
  }
  for (const host of ['xhslink.com', 'www.xhslink.com', 'xhslink.cn', 'www.xhslink.cn']) {
    assert.ok(pythonSource.includes(`"${host}"`), host);
    assert.ok(typescriptSource.includes(`'${host}'`), `TypeScript 缺少短链主机 ${host}`);
  }
  for (const group of ['source', 'zh-Hans', 'zh-CN', 'zh-Hant', 'zh', 'en-US', 'en', 'ja', 'ko']) {
    assert.ok(pythonSubtitles.includes(`"${group}"`), group);
    assert.ok(typescriptSubtitles.includes(`'${group}'`), `TypeScript 缺少字幕组 ${group}`);
  }
  for (const suffix of ['xhscdn.com', 'xiaohongshu.com']) {
    assert.ok(pythonSubtitles.includes(`"${suffix}"`), suffix);
    assert.ok(typescriptSubtitles.includes(`'${suffix}'`), `TypeScript 缺少字幕主机 ${suffix}`);
  }
  // 只接受 https 与自家主机，两条规则必须同时存在。
  assert.ok(pythonSubtitles.includes('parsed.scheme.lower() != "https"'));
  assert.ok(typescriptSubtitles.includes("parsed.scheme !== 'https'"));
});

test('xiaohongshu error codes form the same closed set', async () => {
  const pythonFiles = [
    await read(pythonRoot, 'xiaohongshu', 'types.py'),
    await read(pythonRoot, 'xiaohongshu', 'source.py'),
    await read(pythonRoot, 'xiaohongshu', 'page.py'),
    await read(pythonRoot, 'xiaohongshu', 'transport.py'),
    await read(pythonRoot, 'xiaohongshu_fallback.py'),
  ].join('\n');
  const typescriptFiles = [
    await read(workerRoot, 'src', 'sources', 'xiaohongshu', 'types.ts'),
    await read(workerRoot, 'src', 'sources', 'xiaohongshu', 'source.ts'),
    await read(workerRoot, 'src', 'sources', 'xiaohongshu', 'page.ts'),
    await read(workerRoot, 'src', 'sources', 'xiaohongshu', 'transport.ts'),
    await read(workerRoot, 'src', 'sources', 'xiaohongshu', 'fallback.ts'),
  ].join('\n');

  const pythonCodes = new Set(
    [...pythonFiles.matchAll(/"XHS_[A-Z_]+"/gu)].map((match) => match[0].slice(1, -1)),
  );
  const typescriptCodes = new Set(
    [...typescriptFiles.matchAll(/'XHS_[A-Z_]+'/gu)].map((match) => match[0].slice(1, -1)),
  );
  assert.ok(pythonCodes.size >= 10, `Python 错误码数量异常: ${pythonCodes.size}`);
  assert.deepEqual([...typescriptCodes].sort(), [...pythonCodes].sort());
});

test('xiaohongshu failure messages match the python wording', async () => {
  const python = [
    await read(pythonRoot, 'xiaohongshu', 'source.py'),
    await read(pythonRoot, 'xiaohongshu', 'page.py'),
    await read(pythonRoot, 'xiaohongshu', 'transport.py'),
    await read(pythonRoot, 'xiaohongshu_fallback.py'),
  ].join('\n');
  const typescript = [
    await read(workerRoot, 'src', 'sources', 'xiaohongshu', 'source.ts'),
    await read(workerRoot, 'src', 'sources', 'xiaohongshu', 'page.ts'),
    await read(workerRoot, 'src', 'sources', 'xiaohongshu', 'transport.ts'),
    await read(workerRoot, 'src', 'sources', 'xiaohongshu', 'fallback.ts'),
  ].join('\n');

  for (const message of [
    'Could not extract Xiaohongshu note ID from input.',
    'Could not extract Xiaohongshu note ID from URL.',
    'Xiaohongshu short link redirected too many times.',
    'Xiaohongshu short link could not be resolved.',
    'Xiaohongshu short link response did not contain a note URL.',
    'Xiaohongshu URL must use http or https.',
    'Unsupported Xiaohongshu host.',
    'Xiaohongshu note was not found.',
    'Xiaohongshu note requires login or is not public.',
    'Xiaohongshu request was rate limited.',
    'Xiaohongshu public note page was unavailable.',
    'Xiaohongshu response body could not be decoded.',
    'Xiaohongshu page response exceeded the safety limit.',
    'Xiaohongshu page did not include initial state.',
    'Xiaohongshu initial state was not parseable.',
    'Xiaohongshu initial state was malformed.',
    'Xiaohongshu initial state was not an object.',
    'Xiaohongshu initial state object was incomplete.',
    'Xiaohongshu note is image-only and has no playable video.',
    'Xiaohongshu public note returned no playable video stream.',
    'Xiaohongshu video exceeded the configured size limit.',
    'Xiaohongshu video download stalled.',
    'All Xiaohongshu fallback streams failed to download.',
    'Xiaohongshu media stream request failed.',
    'Xiaohongshu public page request failed.',
  ]) {
    assert.ok(python.includes(message), `Python 缺少文案: ${message}`);
    assert.ok(typescript.includes(message), `TypeScript 缺少文案: ${message}`);
  }
});

test('xiaohongshu progress codes are in the closed set and the probe is wired', async () => {
  const pythonEvents = await read(pythonRoot, 'progress_events.py');
  const typescriptEvents = await read(workerRoot, 'src', 'protocol', 'events.ts');
  const pipeline = await read(workerRoot, 'src', 'pipeline', 'url-media.ts');
  const strategies = await read(workerRoot, 'src', 'media', 'platform-strategies.ts');

  for (const code of ['xiaohongshu.page.resolving', 'xiaohongshu.video.saving',
    'xiaohongshu.stream.retrying']) {
    assert.ok(pythonEvents.includes(`"${code}"`), code);
    assert.ok(typescriptEvents.includes(`'${code}'`), code);
  }
  assert.ok(typescriptEvents.includes("'xiaohongshu.stream.retrying': {allowedArgs: ['attempt', 'total']}"));
  // yt-dlp 成功后的字幕探测必须有真实实现，不能再是空函数。
  assert.ok(pipeline.includes('downloadXiaohongshuSubtitleProbe'));
  assert.ok(pipeline.includes('downloadXiaohongshuSubtitle(url, outputDir)'));
  assert.ok(!pipeline.includes('probeXiaohongshuSubtitle ?? (async () => {})'));
  assert.ok(strategies.includes('[FALLBACK_COMMAND_NAMES.xiaohongshu]'));
  assert.ok(strategies.includes('XiaohongshuFallbackError'));
});

test('xiaohongshu golden comes from python production code', async () => {
  const generator = await read(repositoryRoot, 'scripts', 'tests', 'xiaohongshu-golden.py');
  const unit = await read(workerRoot, 'tests', 'xiaohongshu.test.mjs');
  const fixture = await read(workerRoot, 'tests', 'fixtures', 'xiaohongshu-golden.json');

  assert.ok(generator.includes('from worker_core.xiaohongshu_fallback import'));
  assert.ok(generator.includes('download_xiaohongshu_video'));
  assert.ok(generator.includes('download_xiaohongshu_subtitle'));
  assert.ok(unit.includes('downloadXiaohongshuVideo'));
  assert.ok(unit.includes('downloadXiaohongshuSubtitle'));
  assert.ok(fixture.includes('"full_downloads"'));
  assert.ok(fixture.includes('"subtitle_probe"'));
  // 基准里不允许出现本机真实路径。
  assert.ok(!/C:\\\\Users|AppData|\/Users\//u.test(fixture));
});
