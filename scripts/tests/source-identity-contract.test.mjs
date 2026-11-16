// 来源识别（`--resolve-source-stdin`）的跨语言静态守卫。
//
// Python `worker_core/source_identity.py` + `source_resolution.py` +
// `worker_application/source_identity.py` 与 TypeScript
// `worker-ts/src/sources/` 必须共享：版本号、平台闭集、ID 白名单正则、
// 分界常量、结果错误码闭集，以及 canonical URL 的构造模板。
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, '..', '..');
const pythonRoot = resolve(repositoryRoot, 'worker');
const workerRoot = resolve(repositoryRoot, 'worker-ts');

async function read(...parts) {
  return readFile(join(...parts), 'utf8');
}

test('identity constants, platform set and id patterns match python', async () => {
  const python = await read(pythonRoot, 'worker_core', 'source_identity.py');
  const typescript = await read(workerRoot, 'src', 'sources', 'source-identity.ts');

  assert.ok(python.includes('SOURCE_IDENTITY_VERSION = 1'));
  assert.ok(typescript.includes('SOURCE_IDENTITY_VERSION = 1'));
  assert.ok(python.includes('MAX_BILIBILI_PART_INDEX = 100_000'));
  assert.ok(typescript.includes('MAX_BILIBILI_PART_INDEX = 100_000'));
  // URL 提取与尾标点闭集逐字符一致。
  assert.ok(typescript.includes("[^\\s\"'<>]+"), 'TypeScript URL 正则与 Python 不同');
  assert.ok(typescript.includes("，。！？；：、."), 'TypeScript 尾标点闭集缺少中文标点');
  // ID 白名单正则体必须一致。
  for (const [py, ts] of [
    [String.raw`^[0-9a-f]{24}$`, 'XHS_NOTE_ID_PATTERN'],
    [String.raw`^BV[0-9A-Za-z]{10}$`, 'BILIBILI_BVID_PATTERN'],
    [String.raw`^av(\d{1,20})$`, 'BILIBILI_AVID_PATTERN'],
    [String.raw`^[A-Za-z0-9_-]{11}$`, 'YOUTUBE_VIDEO_ID_PATTERN'],
    [String.raw`^\d{15,24}$`, 'DOUYIN_AWEME_ID_PATTERN'],
  ]) {
    assert.ok(python.includes(py), `Python 缺少正则 ${py}`);
    assert.ok(typescript.includes(ts), `TypeScript 缺少常量 ${ts}`);
  }
  // 平台闭集与 canonical URL 构造模板。
  for (const template of [
    'https://www.xiaohongshu.com/explore/',
    'https://www.douyin.com/video/',
    'https://www.bilibili.com/video/',
    'https://www.youtube.com/watch?v=',
  ]) {
    assert.ok(python.includes(template), `Python 缺少 ${template}`);
    assert.ok(typescript.includes(template), `TypeScript 缺少 ${template}`);
  }
  // manifest 键序与读取校验键名。
  for (const key of ['stable_id', 'effective_part', 'canonical_url']) {
    assert.ok(python.includes(`"${key}"`), `Python manifest 缺少 ${key}`);
    assert.ok(typescript.includes(`'${key}'`) || typescript.includes(`"${key}"`),
      `TypeScript manifest 缺少 ${key}`);
  }
});

test('resolver and application layers share failure semantics and sanitizer output', async () => {
  const pythonApp = await read(pythonRoot, 'worker_core', 'worker_application', 'source_identity.py');
  const pythonResolution = await read(pythonRoot, 'worker_core', 'source_resolution.py');
  const typescriptApp = await read(workerRoot, 'src', 'sources', 'resolve-source.ts');
  const typescriptResolution = await read(workerRoot, 'src', 'sources', 'source-resolution.ts');

  for (const code of ['INVALID_SOURCE_IDENTITY_JSON', 'INVALID_SOURCE_IDENTITY_PAYLOAD', 'SOURCE_IDENTITY_UNAVAILABLE']) {
    assert.ok(pythonApp.includes(code), `Python 应用层缺少 ${code}`);
    assert.ok(typescriptApp.includes(code), `TypeScript 应用层缺少 ${code}`);
  }
  // 直连错误保留语义（短链全部失败时抛直连自己的错误）。
  assert.ok(pythonResolution.includes('raise direct_error'));
  assert.ok(typescriptResolution.includes('directError'));
  // 清洗的兜底文本逐字符一致。
  assert.ok(pythonResolution.includes('"[source URL removed]"'));
  assert.ok(typescriptResolution.includes("'[source URL removed]'"));
  // 请求校验：url 必须是非空字符串。
  assert.ok(pythonApp.includes('not isinstance(raw_url, str) or not raw_url.strip()'));
  assert.ok(typescriptApp.includes("typeof rawUrl !== 'string' || rawUrl.trim().length === 0"));
});

test('short-link adapters share host sets, uas, bounds and failure semantics', async () => {
  const pythonResolvers = await read(pythonRoot, 'worker_core', 'platform_source_resolvers.py');
  const pythonBilibili = await read(pythonRoot, 'worker_core', 'bilibili', 'source.py');
  const pythonDouyin = await read(pythonRoot, 'worker_core', 'douyin', 'source.py');
  const pythonXhs = await read(pythonRoot, 'worker_core', 'xiaohongshu', 'source.py');
  const typescript = await read(workerRoot, 'src', 'sources', 'platform-short-links.ts');

  // 适配器顺序与短链 host 集合。
  const pyOrder = ['xiaohongshu', 'bilibili', 'douyin'].map((name) =>
    pythonResolvers.indexOf(`platform="${name}"`));
  assert.ok(pyOrder.every((index) => index > -1)
    && pyOrder[0] < pyOrder[1] && pyOrder[1] < pyOrder[2],
    'Python 适配器顺序必须是 xiaohongshu → bilibili → douyin');
  assert.ok(typescript.indexOf("'xiaohongshu'") < typescript.indexOf("'bilibili'")
    && typescript.indexOf("'bilibili'") < typescript.indexOf("'douyin'"),
    'TypeScript 适配器顺序必须是 xiaohongshu → bilibili → douyin');
  for (const host of ['xhslink.com', 'xhslink.cn', 'b23.tv', 'v.douyin.com']) {
    const pySource = host.startsWith('xhslink') ? pythonXhs
      : host === 'b23.tv' ? pythonBilibili : pythonDouyin;
    assert.ok(pySource.includes(host), `Python 短链 host 缺少 ${host}`);
    assert.ok(typescript.includes(host), `TypeScript 短链 host 缺少 ${host}`);
  }
  // 展开边界与重试。
  assert.ok(pythonBilibili.includes('BILIBILI_MAX_REDIRECT_DEPTH = 5')
    || pythonXhs.includes('XHS_MAX_REDIRECT_DEPTH = 5'));
  assert.ok(typescript.includes('MAX_REDIRECT_DEPTH = 5'));
  assert.ok(typescript.includes('256 * 1024'), 'TypeScript 短链正文上限应为 256 KiB');
  // 平台 UA（douyin 移动端，桌面端两平台同串）。
  assert.ok(typescript.includes('iPhone; CPU iPhone OS 16_5'), 'douyin 必须用移动端 UA');
  assert.ok(typescript.includes('Chrome/120.0 Safari/537.36'));
  // 适配器契约：失败收敛 null，不能把异常抛回解析器。
  assert.ok(pythonResolvers.includes('except XiaohongshuFallbackError:'));
  assert.ok(pythonResolvers.includes('except BilibiliFallbackError:'));
  assert.ok(pythonResolvers.includes('except DouyinFallbackError:'));
  assert.ok(typescript.includes('if (error instanceof ShortLinkFailure || error instanceof PageFetchError) return null;'));
  // douyin 的 aweme id 正则体（source.py 版本与 source_identity.py 不同：\d+ 无界）。
  for (const body of ['modal_id|aweme_id', 'video|note']) {
    assert.ok(pythonDouyin.includes(body), `Python douyin 正则缺少 ${body}`);
    assert.ok(typescript.includes(body), `TypeScript douyin 正则缺少 ${body}`);
  }
  // JS 正则字面量里的斜杠带转义。
  assert.ok(pythonDouyin.includes('share/slides') && typescript.includes('share\\/slides'),
    '两侧 douyin share/slides 正则不一致');
});

test('the cli resolve mode short-circuits nothing but returns 0 on business failure', async () => {
  const pythonCli = await read(pythonRoot, 'worker_core', 'cli.py');
  const typescriptCli = await read(workerRoot, 'src', 'cli.ts');

  assert.ok(pythonCli.includes('args.resolve_source_stdin'));
  assert.ok(pythonCli.includes('resolve_source_identity_once(request_json or "{}")'));
  // stdin 失败的 resolve 分支没有 stage 键。
  const stdinFailure = pythonCli.slice(pythonCli.indexOf('def stdin_failure_result'));
  assert.ok(stdinFailure.includes('"WORKER_STDIN_INVALID"'));
  assert.ok(typescriptCli.includes("argument === '--resolve-source-stdin'"));
  assert.ok(typescriptCli.includes('resolveSourceIdentityOnce'));
  assert.ok(typescriptCli.includes("{status: 'failed', error: {code: 'WORKER_STDIN_INVALID'}}"));
});
