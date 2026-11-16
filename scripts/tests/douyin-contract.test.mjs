// 抖音传输层的跨语言静态守卫。
// Python `worker_core/douyin*` 与 TypeScript `worker-ts/src/sources/douyin/` 必须共享
// 常量、错误码、失败文案与「只接通抖音」这条边界。
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

test('douyin constants are identical on both sides', async () => {
  const pythonFallback = await read(pythonRoot, 'douyin_fallback.py');
  const pythonTransport = await read(pythonRoot, 'douyin', 'transport.py');
  const pythonStreams = await read(pythonRoot, 'douyin', 'streams.py');
  const typescriptFallback = await read(workerRoot, 'src', 'sources', 'douyin', 'fallback.ts');
  const typescriptTransport = await read(workerRoot, 'src', 'sources', 'douyin', 'transport.ts');
  const typescriptStreams = await read(workerRoot, 'src', 'sources', 'douyin', 'streams.ts');

  assert.ok(pythonFallback.includes('SHARE_PAGE_ATTEMPTS = 3'));
  assert.ok(typescriptFallback.includes('SHARE_PAGE_ATTEMPTS = 3'));
  assert.ok(pythonFallback.includes('SHARE_PAGE_RETRY_DELAY_RANGE_SECONDS = (3.0, 10.0)'));
  assert.ok(typescriptFallback.includes('[3, 10]'));
  assert.ok(pythonFallback.includes('STREAM_PROGRESS_EMIT_INTERVAL_BYTES = 8 * 1024 * 1024'));
  assert.ok(typescriptFallback.includes('STREAM_PROGRESS_EMIT_INTERVAL_BYTES = 8 * 1024 * 1024'));
  assert.ok(pythonFallback.includes('STREAM_PROGRESS_MAX_STEP = 3'));
  assert.ok(typescriptFallback.includes('STREAM_PROGRESS_MAX_STEP = 3'));
  assert.ok(pythonTransport.includes('DOUYIN_DOWNLOAD_CHUNK_BYTES = 256 * 1024'));
  assert.ok(typescriptTransport.includes('DOUYIN_DOWNLOAD_CHUNK_BYTES = 256 * 1024'));
  assert.ok(pythonTransport.includes('DOUYIN_NO_PROGRESS_TIMEOUT_SECONDS = 60.0'));
  assert.ok(typescriptTransport.includes('DOUYIN_NO_PROGRESS_TIMEOUT_SECONDS = 60'));
  assert.ok(pythonTransport.includes('DOUYIN_STREAM_SOCKET_TIMEOUT_SECONDS = 15.0'));
  assert.ok(typescriptTransport.includes('DOUYIN_STREAM_SOCKET_TIMEOUT_SECONDS = 15'));
  assert.ok(pythonStreams.includes('PLAY_QUALITIES = ("1080p", "720p", "540p", "480p", "360p")'));
  for (const quality of ['1080p', '720p', '540p', '480p', '360p']) {
    assert.ok(typescriptStreams.includes(`'${quality}'`), quality);
  }
});

test('douyin request headers, user agent and share page url stay in sync', async () => {
  const python = await read(pythonRoot, 'douyin', 'transport.py');
  const pythonSource = await read(pythonRoot, 'douyin', 'source.py');
  const typescript = await read(workerRoot, 'src', 'sources', 'douyin', 'transport.ts');
  const typescriptSource = await read(workerRoot, 'src', 'sources', 'douyin', 'source.ts');

  assert.ok(python.includes('Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X)'));
  assert.ok(typescript.includes('Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X)'));
  for (const header of ['User-Agent', 'Accept', 'Referer']) {
    assert.ok(python.includes(`"${header}"`), header);
    assert.ok(typescript.includes(header), `TypeScript 缺少请求头 ${header}`);
  }
  assert.ok(python.includes('"https://www.iesdouyin.com/"'));
  assert.ok(typescript.includes("'https://www.iesdouyin.com/'"));
  assert.ok(pythonSource.includes('/share/video/{aweme_id}/?app=aweme'));
  assert.ok(typescriptSource.includes('/share/video/${awemeId}/?app=aweme'));
  assert.ok(pythonSource.includes('"v.douyin.com"'));
  assert.ok(typescriptSource.includes("'v.douyin.com'"));
});

test('douyin error codes and messages exist on both sides', async () => {
  const pythonFiles = [
    await read(pythonRoot, 'douyin', 'page.py'),
    await read(pythonRoot, 'douyin', 'source.py'),
    await read(pythonRoot, 'douyin', 'streams.py'),
    await read(pythonRoot, 'douyin', 'transport.py'),
    await read(pythonRoot, 'douyin_fallback.py'),
  ].join('\n');
  const typescriptFiles = [
    await read(workerRoot, 'src', 'sources', 'douyin', 'page.ts'),
    await read(workerRoot, 'src', 'sources', 'douyin', 'source.ts'),
    await read(workerRoot, 'src', 'sources', 'douyin', 'streams.ts'),
    await read(workerRoot, 'src', 'sources', 'douyin', 'transport.ts'),
    await read(workerRoot, 'src', 'sources', 'douyin', 'fallback.ts'),
  ].join('\n');

  const codes = new Set(pythonFiles.match(/DOUYIN_[A-Z_]+/gu));
  assert.ok(codes.size >= 8, `Python 错误码数量异常: ${[...codes].join(',')}`);
  for (const code of codes) {
    assert.ok(typescriptFiles.includes(code), `TypeScript 缺少错误码 ${code}`);
  }
  for (const message of [
    'Douyin share page did not include router data.',
    'Douyin share page did not include videoInfoRes.',
    'Douyin share page did not include a playable item.',
    'Douyin item has no video.',
    'All Douyin fallback streams failed to download.',
    'Could not extract Douyin video ID from URL.',
  ]) {
    assert.ok(pythonFiles.includes(message), message);
    assert.ok(typescriptFiles.includes(message), `TypeScript 缺少文案 ${message}`);
  }
});

test('share page retry only covers the declared transient codes', async () => {
  const python = await read(pythonRoot, 'douyin_fallback.py');
  const typescript = await read(workerRoot, 'src', 'sources', 'douyin', 'fallback.ts');

  for (const code of ['DOUYIN_ROUTER_DATA_MISSING', 'DOUYIN_ROUTER_DATA_MALFORMED',
    'DOUYIN_SHARE_PAGE_UNAVAILABLE']) {
    assert.ok(python.includes(`"${code}"`), code);
    assert.ok(typescript.includes(`'${code}'`), `TypeScript 缺少可重试错误码 ${code}`);
  }
  assert.ok(python.includes('if exc.code not in SHARE_PAGE_RETRYABLE_ERROR_CODES:'));
  assert.ok(typescript.includes('SHARE_PAGE_RETRYABLE_ERROR_CODES.has(error.code)'));
  assert.ok(python.includes('if not callable(progress_callback) or failed_index >= total - 1:'));
  assert.ok(typescript.includes('failedIndex >= total - 1'));
});

test('progress codes and their argument sets are declared in the protocol', async () => {
  const events = await read(workerRoot, 'src', 'protocol', 'events.ts');
  for (const code of ['douyin.page.resolving', 'douyin.page.retrying', 'douyin.stream.probing',
    'douyin.video.saving', 'douyin.stream.retrying']) {
    assert.ok(events.includes(`'${code}'`), code);
  }
  assert.ok(events.includes("'douyin.page.retrying': {allowedArgs: ['attempt', 'total']}"));
  assert.ok(events.includes("'douyin.stream.retrying': {allowedArgs: ['attempt', 'total']}"));
  assert.ok(events.includes("'douyin.video.saving': {allowedArgs: []}"));
});

test('all three platforms are wired as production fallback strategies', async () => {
  const strategies = await read(workerRoot, 'src', 'media', 'platform-strategies.ts');
  const pipeline = await read(workerRoot, 'src', 'pipeline', 'url-media.ts');
  const download = await read(workerRoot, 'src', 'media', 'download.ts');

  assert.ok(strategies.includes('[FALLBACK_COMMAND_NAMES.douyin]'));
  assert.ok(strategies.includes('[FALLBACK_COMMAND_NAMES.xiaohongshu]'),
    '小红书传输层接通后须注册');
  assert.ok(strategies.includes('[FALLBACK_COMMAND_NAMES.bilibili]'));
  assert.ok(pipeline.includes('options.strategies ?? createPlatformFallbackStrategies()'));
  assert.ok(download.includes('Partial<Readonly<Record<FallbackCommandName'));
  assert.ok(download.includes('if (download === undefined) continue;'));
});

test('reliable download keeps the same error codes and resumable set', async () => {
  const python = await read(pythonRoot, 'download_reliability.py');
  const typescript = await read(workerRoot, 'src', 'download-reliability.ts');

  for (const code of ['DOWNLOAD_STALLED', 'DOWNLOAD_INCOMPLETE', 'DOWNLOAD_RESUME_INVALID',
    'DOWNLOAD_EMPTY_BODY', 'DOWNLOAD_SIZE_EXCEEDED', 'DOWNLOAD_SIZE_INVALID',
    'DOWNLOAD_HTTP_STATUS_INVALID', 'DOWNLOAD_CONTENT_RANGE_INVALID',
    'DOWNLOAD_CONTENT_TYPE_INVALID']) {
    assert.ok(python.includes(code), code);
    assert.ok(typescript.includes(code), `TypeScript 缺少失败码 ${code}`);
  }
  assert.ok(python.includes('{"DOWNLOAD_STALLED", "DOWNLOAD_INCOMPLETE"}'));
  assert.ok(typescript.includes("'DOWNLOAD_STALLED',\n  'DOWNLOAD_INCOMPLETE',"));
  assert.ok(python.includes('VIDEO_CONTENT_TYPES = ("video/", "application/octet-stream")'));
  assert.ok(typescript.includes("['video/', 'application/octet-stream']"));
});
