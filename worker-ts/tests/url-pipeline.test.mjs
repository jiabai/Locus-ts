// URL 任务全链：请求 → 来源解析 → 假 yt-dlp 下载 → 真实 ffmpeg/ffprobe → 假转写器 → 清单。
//
// 这里不验证模型精度，也不联网：证明的是「下载器内核、媒体准备、任务清单与 CLI 业务入口」
// 真能接成一条链，且产物与 Python 读得懂的 task.json 形状一致。
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import {copyFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {runCommand} from '../src/media/command.ts';
import {identifySource} from '../src/sources/source-identity.ts';
import {runProcessVideoOnce} from '../src/worker-service.ts';

const URL = 'https://www.douyin.com/video/7524373044106677544';
const MODEL = 'iic/SenseVoiceSmall-onnx';
const LAUNCHER = 'fake-yt-dlp';
const NOW = new Date('2026-11-14T12:00:00.000Z');
const IDENTITY = identifySource(URL);
const FFMPEG = spawnSync('ffmpeg', ['-version'], {encoding: 'utf8'}).status === 0;

function makeRoot() {
  return mkdtempSync(path.join(tmpdir(), 'locus-url-pipeline-'));
}

function makeFixture(root) {
  const target = path.join(root, 'source.mp4');
  const result = spawnSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x64:rate=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', target,
  ], {encoding: 'utf8'});
  assert.equal(result.status, 0, `ffmpeg 生成 fixture 失败: ${result.stderr}`);
  return target;
}

function options(root, overrides = {}) {
  return {
    projectRoot: root,
    environ: {
      APP_OUTPUT_DIR: path.join(root, 'outputs'),
      APP_CACHE_DIR: path.join(root, 'cache'),
      APP_MODEL_DIR: path.join(root, 'models'),
      APP_YTDLP_PATH: '',
    },
    launcher: [LAUNCHER],
    sourceResolver: async (url) => ({downloadUrl: url, identity: IDENTITY}),
    transcriberFactory: async () => ({
      model: MODEL,
      async transcribe() {
        return {text: '来自本地识别的文字稿', language: 'zh', segments: []};
      },
      dispose() {},
    }),
    modelCacheValidator: async () => ({valid: true}),
    now: NOW,
    ...overrides,
  };
}

/** 假 yt-dlp 把 fixture 复制到下载目录；ffmpeg/ffprobe 交给真实命令。 */
function makeRunner(fixture, hooks = {}) {
  return async (command, runOptions) => {
    if (command[0] === LAUNCHER) {
      if (hooks.downloadFails) {
        return {command: [...command], returncode: 1, stdout: '', stderr: 'network down'};
      }
      const outputDir = hooks.downloadDir;
      await mkdir(outputDir, {recursive: true});
      const target = path.join(outputDir, 'video.mp4');
      await copyFile(fixture, target);
      if (hooks.subtitle) {
        await writeFile(path.join(outputDir, 'video.zh-Hans.srt'), [
          '1', '00:00:01,000 --> 00:00:02,000', '平台字幕第一行', '',
          '2', '00:00:02,000 --> 00:00:03,000', '平台字幕第二行', '',
        ].join('\n'));
      }
      return {command: [...command], returncode: 0, stdout: target, stderr: ''};
    }
    return runCommand(command, runOptions);
  };
}

function taskDir(root) {
  return path.join(root, 'outputs', 'tasks', `20261114-120000-douyin-${IDENTITY.stableId}`);
}

async function readManifest(root) {
  return JSON.parse(await readFile(path.join(taskDir(root), 'task.json'), 'utf8'));
}

test('a URL task runs through download, media preparation, ASR and the manifest',
  {skip: !FFMPEG}, async () => {
    const root = makeRoot();
    const fixture = makeFixture(root);
    const events = [];
    const result = await runProcessVideoOnce({
      contract_version: 3, url: URL, asr_model: MODEL,
    }, options(root, {
      runner: makeRunner(fixture, {downloadDir: path.join(root, 'cache', 'tasks',
        `20261114-120000-douyin-${IDENTITY.stableId}`, 'download')}),
      onProgress: (event) => events.push(event),
    }));

    assert.equal(result.status, 'completed');
    assert.equal(result.text, '来自本地识别的文字稿');
    assert.deepEqual(result.transcript, {source: 'asr', language: null, engine: MODEL});
    assert.equal(result.error, null);
    assert.match(result.task_id, /^20261114-120000-douyin-/u);
    for (const key of ['video', 'audio', 'transcript_txt', 'transcript_md']) {
      assert.ok(key in result.artifacts, `缺少产物 ${key}`);
    }

    const manifest = await readManifest(root);
    assert.equal('source_kind' in manifest, false);
    assert.equal(manifest.schema_version, 3);
    assert.equal(manifest.platform, 'douyin');
    assert.equal(manifest.source_url, IDENTITY.canonicalUrl);
    assert.equal(manifest.source_identity.stable_id, IDENTITY.stableId);
    assert.equal(manifest.status, 'completed');
    assert.equal(manifest.model, MODEL);

    const markdown = await readFile(path.join(taskDir(root), 'transcript', 'transcript.md'), 'utf8');
    assert.ok(markdown.includes(`- Source URL: ${IDENTITY.canonicalUrl}`));
    assert.ok(markdown.includes('- Transcript Source: Local ASR'));

    assert.deepEqual(events.map((event) => [event.message_code, event.progress, event.stage]), [
      ['video.download.preparing', 18, 'video_extracting'],
      ['video.stream.validating', 34, 'video_extracting'],
      ['audio.extract.running', 48, 'video_extracting'],
      ['subtitle.detect.running', 58, 'video_transcribing'],
      ['asr.transcribe.starting', 58, 'video_transcribing'],
      ['asr.cache.preparing', 58, 'video_transcribing'],
      ['asr.transcribe.running', 68, 'video_transcribing'],
    ]);
  });

test('a platform subtitle short-circuits ASR and writes segments',
  {skip: !FFMPEG}, async () => {
    const root = makeRoot();
    const fixture = makeFixture(root);
    const events = [];
    const result = await runProcessVideoOnce({
      contract_version: 3, url: URL, asr_model: MODEL,
    }, options(root, {
      runner: makeRunner(fixture, {
        subtitle: true,
        downloadDir: path.join(root, 'cache', 'tasks',
          `20261114-120000-douyin-${IDENTITY.stableId}`, 'download'),
      }),
      onProgress: (event) => events.push(event),
    }));

    assert.equal(result.status, 'completed');
    assert.equal(result.text, '平台字幕第一行\n平台字幕第二行');
    assert.deepEqual(result.transcript, {source: 'subtitle', language: 'zh-Hans', engine: null});
    assert.ok('segments' in result.artifacts);
    const segments = JSON.parse(await readFile(
      path.join(taskDir(root), 'transcript', 'segments.json'), 'utf8',
    ));
    assert.deepEqual(segments.segments.map((segment) => segment.id), ['subtitle-1', 'subtitle-2']);
    const markdown = await readFile(path.join(taskDir(root), 'transcript', 'transcript.md'), 'utf8');
    assert.ok(markdown.includes('- Transcript Source: Platform subtitle'));
    assert.ok(markdown.includes('- Subtitle Language: zh-Hans'));
    assert.deepEqual(events.at(-1), {
      stage: 'video_transcribing',
      progress: 68,
      message_code: 'subtitle.detect.found',
      message_args: {language: 'zh-Hans'},
    });
    assert.ok(!events.some((event) => event.message_code.startsWith('asr.')));
  });

test('a download failure writes a failed manifest with a task id',
  {skip: !FFMPEG}, async () => {
    const root = makeRoot();
    const fixture = makeFixture(root);
    const result = await runProcessVideoOnce({
      contract_version: 3, url: URL, asr_model: MODEL,
    }, options(root, {
      runner: makeRunner(fixture, {downloadFails: true}),
      // 这条用例只验证 yt-dlp 失败的上报形状；关掉平台 fallback，避免触网。
      strategies: [],
    }));
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'VIDEO_DOWNLOAD_FAILED');
    assert.equal(result.error.stage, 'video_extracting');
    assert.ok(result.task_id);
    const manifest = await readManifest(root);
    assert.equal(manifest.status, 'failed');
    assert.equal(manifest.error.code, 'VIDEO_DOWNLOAD_FAILED');
  });

test('an invalid request never resolves a source or creates a task', async () => {
  const root = makeRoot();
  const result = await runProcessVideoOnce({contract_version: 3, url: URL}, options(root));
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'INVALID_REQUEST_PAYLOAD');
  assert.equal(result.error.stage, 'waiting_input');
  assert.equal(result.task_id, null);
});
