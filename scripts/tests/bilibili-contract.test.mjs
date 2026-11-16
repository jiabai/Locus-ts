// B 站传输层的跨语言静态守卫。
// Python `worker_core/bilibili*` 与 TypeScript `worker-ts/src/sources/bilibili/` 必须共享
// 常量、请求头、错误码、失败文案与 DASH 选择规则。
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

test('bilibili constants are identical on both sides', async () => {
  const pythonTransport = await read(pythonRoot, 'bilibili', 'transport.py');
  const pythonPlayback = await read(pythonRoot, 'bilibili', 'playback.py');
  const pythonSource = await read(pythonRoot, 'bilibili', 'source.py');
  const typescriptTransport = await read(workerRoot, 'src', 'sources', 'bilibili', 'transport.ts');
  const typescriptPlayback = await read(workerRoot, 'src', 'sources', 'bilibili', 'playback.ts');
  const typescriptSource = await read(workerRoot, 'src', 'sources', 'bilibili', 'source.ts');

  assert.ok(pythonTransport.includes('Chrome/120.0 Safari/537.36'));
  assert.ok(typescriptTransport.includes('Chrome/120.0 Safari/537.36'));
  assert.ok(pythonTransport.includes('BILIBILI_MAX_RESPONSE_BYTES = 4 * 1024 * 1024'));
  assert.ok(typescriptTransport.includes('BILIBILI_MAX_RESPONSE_BYTES = 4 * 1024 * 1024'));
  assert.ok(pythonTransport.includes('BILIBILI_MAX_STREAM_BYTES = 2 * 1024 * 1024 * 1024'));
  assert.ok(typescriptTransport.includes('BILIBILI_MAX_STREAM_BYTES = 2 * 1024 * 1024 * 1024'));
  assert.ok(pythonTransport.includes('BILIBILI_DOWNLOAD_CHUNK_BYTES = 256 * 1024'));
  assert.ok(typescriptTransport.includes('BILIBILI_DOWNLOAD_CHUNK_BYTES = 256 * 1024'));
  assert.ok(pythonTransport.includes('BILIBILI_NO_PROGRESS_TIMEOUT_SECONDS = 120.0'));
  assert.ok(typescriptTransport.includes('BILIBILI_NO_PROGRESS_TIMEOUT_SECONDS = 120'));
  assert.ok(pythonSource.includes('BILIBILI_MAX_REDIRECT_DEPTH = 5'));
  assert.ok(typescriptSource.includes('BILIBILI_MAX_REDIRECT_DEPTH = 5'));
  assert.ok(pythonPlayback.includes('BILIBILI_API_BASE_URL = "https://api.bilibili.com"'));
  assert.ok(typescriptPlayback.includes("BILIBILI_API_BASE_URL = 'https://api.bilibili.com'"));
  assert.ok(pythonPlayback.includes('BILIBILI_CODEC_RANK = {13: 300, 12: 200, 7: 100}'));
  assert.ok(typescriptPlayback.includes('[[13, 300], [12, 200], [7, 100]]'));
});

test('bilibili headers and codec query parameters stay in sync', async () => {
  const python = await read(pythonRoot, 'bilibili', 'transport.py');
  const typescript = await read(workerRoot, 'src', 'sources', 'bilibili', 'transport.ts');
  const pythonPlayback = await read(pythonRoot, 'bilibili', 'playback.py');
  const typescriptPlayback = await read(workerRoot, 'src', 'sources', 'bilibili', 'playback.ts');

  for (const header of ['User-Agent', 'Referer', 'Origin', 'Accept', 'Accept-Language',
    'Accept-Encoding', 'Connection']) {
    assert.ok(python.includes(`"${header}"`), header);
    assert.ok(typescript.includes(header), `TypeScript 缺少请求头 ${header}`);
  }
  assert.ok(python.includes('"https://www.bilibili.com/"'));
  assert.ok(typescript.includes("'https://www.bilibili.com/'"));
  assert.ok(python.includes('"https://www.bilibili.com"'));
  assert.ok(typescript.includes("'https://www.bilibili.com'"));
  assert.ok(pythonPlayback.includes('fnval=4048&fnver=0&fourk=1'));
  assert.ok(typescriptPlayback.includes('fnval=4048&fnver=0&fourk=1'));
  assert.ok(pythonPlayback.includes('/x/web-interface/view?'));
  assert.ok(typescriptPlayback.includes('/x/web-interface/view?'));
  assert.ok(pythonPlayback.includes('/x/player/playurl?'));
  assert.ok(typescriptPlayback.includes('/x/player/playurl?'));
});

test('bilibili error codes and messages exist on both sides', async () => {
  const pythonFiles = [
    await read(pythonRoot, 'bilibili', 'source.py'),
    await read(pythonRoot, 'bilibili', 'playback.py'),
    await read(pythonRoot, 'bilibili', 'transport.py'),
    await read(pythonRoot, 'bilibili', 'artifacts.py'),
    await read(pythonRoot, 'bilibili_fallback.py'),
  ].join('\n');
  const typescriptFiles = [
    await read(workerRoot, 'src', 'sources', 'bilibili', 'source.ts'),
    await read(workerRoot, 'src', 'sources', 'bilibili', 'playback.ts'),
    await read(workerRoot, 'src', 'sources', 'bilibili', 'transport.ts'),
    await read(workerRoot, 'src', 'sources', 'bilibili', 'artifacts.ts'),
    await read(workerRoot, 'src', 'sources', 'bilibili', 'fallback.ts'),
  ].join('\n');

  const codes = new Set(
    [...pythonFiles.matchAll(/"BILIBILI_[A-Z_]+"/gu)].map((match) => match[0].slice(1, -1)),
  );
  assert.ok(codes.size >= 9, `Python 错误码数量异常: ${[...codes].join(',')}`);
  for (const code of codes) {
    assert.ok(typescriptFiles.includes(code), `TypeScript 缺少错误码 ${code}`);
  }
  for (const message of [
    'Only ordinary public Bilibili videos are supported.',
    'Bilibili short link redirected too many times.',
    'Bilibili short link could not be resolved.',
    'Requested Bilibili part does not exist.',
    'Selected Bilibili DASH stream is DRM protected.',
    'All Bilibili DASH media URLs failed to download.',
    'Bilibili video requires login or account authorization.',
    'ffmpeg did not produce a merged Bilibili MP4.',
  ]) {
    assert.ok(pythonFiles.includes(message), message);
    assert.ok(typescriptFiles.includes(message), `TypeScript 缺少文案 ${message}`);
  }
});

test('dash selection keeps the same ordering and drm rejection', async () => {
  const python = await read(pythonRoot, 'bilibili', 'playback.py');
  const typescript = await read(workerRoot, 'src', 'sources', 'bilibili', 'playback.ts');

  assert.ok(python.includes('_raise_if_drm(data)'));
  assert.ok(typescript.includes('raiseIfDrm(data)'));
  assert.ok(python.includes('_raise_if_drm(item)'));
  assert.ok(typescript.includes('raiseIfDrm(item)'));
  assert.ok(python.includes('BILIBILI_CODEC_RANK.get(codecid, 0)'));
  assert.ok(typescript.includes('CODEC_RANK.get(codecid) ?? 0'));
  // Python max 在并列时保留先出现的项；TS 用严格大于实现同样的稳定性。
  assert.ok(python.includes('max(video_streams, key=_video_stream_score)'));
  assert.ok(typescript.includes('compareScores(candidate, bestScore) > 0'));
  assert.ok(python.includes('best_video = max(video_streams, key=_video_stream_score)'));
});

test('response decoding covers gzip, brotli and deflate on both sides', async () => {
  const python = await read(pythonRoot, 'bilibili', 'transport.py');
  const typescript = await read(workerRoot, 'src', 'sources', 'bilibili', 'transport.ts');

  for (const encoding of ['gzip', 'br', 'deflate']) {
    assert.ok(python.includes(`"${encoding}"`), encoding);
    assert.ok(typescript.includes(`'${encoding}'`), encoding);
  }
  assert.ok(python.includes('zlib.decompress(body, -zlib.MAX_WBITS)'));
  assert.ok(typescript.includes('inflateRawSync(body)'));
  assert.ok(python.includes('"Bilibili response exceeded the safety limit."'));
  assert.ok(typescript.includes("'Bilibili response exceeded the safety limit.'"));
});

test('bilibili progress codes are declared in the protocol', async () => {
  const events = await read(workerRoot, 'src', 'protocol', 'events.ts');
  for (const code of ['bilibili.metadata.resolving', 'bilibili.stream.probing',
    'bilibili.video.downloading', 'bilibili.audio.downloading', 'bilibili.media.merging']) {
    assert.ok(events.includes(`'${code}'`), code);
  }
});

test('bilibili is wired as a production fallback with the shared runner', async () => {
  const strategies = await read(workerRoot, 'src', 'media', 'platform-strategies.ts');
  const download = await read(workerRoot, 'src', 'media', 'download.ts');

  assert.ok(strategies.includes('[FALLBACK_COMMAND_NAMES.bilibili]'));
  assert.ok(strategies.includes('downloadBilibiliVideo('));
  assert.ok(strategies.includes('commandRunner: context.runner'));
  assert.ok(download.includes('readonly runner?: CommandRunner;'));
  assert.ok(download.includes('runner: options.runner'));
});

test('dash merge uses the same ffmpeg argument order on both sides', async () => {
  const python = await read(pythonRoot, 'bilibili', 'artifacts.py');
  const typescript = await read(workerRoot, 'src', 'sources', 'bilibili', 'artifacts.ts');

  for (const argument of ['"ffmpeg"', '"-y"', '"-i"', '"-c"', '"copy"']) {
    assert.ok(python.includes(argument), argument);
    assert.ok(typescript.includes(argument.replaceAll('"', "'")), argument);
  }
  assert.ok(python.includes('video_path.as_posix()'));
  assert.ok(typescript.includes('toPosixPath(videoPath)'));
  assert.ok(python.includes('BILIBILI_FFMPEG_MERGE_FAILED'));
  assert.ok(typescript.includes('BILIBILI_FFMPEG_MERGE_FAILED'));
});
