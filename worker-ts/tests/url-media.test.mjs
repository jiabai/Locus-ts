// URL 媒体准备的跨语言基准：fixture 由 scripts/tests/url-media-golden.py 从 Python
// MediaPreparationFacade._prepare_url 生成。下载器与 ffmpeg/ffprobe 在这里全部换成
// 假 runner，验证的是事件序列、错误码与产物定位，不是真实转码质量。
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync} from 'node:fs';
import {readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {MediaPreparationError} from '../src/media/errors.ts';
import {prepareUrlMedia} from '../src/media/url-media.ts';
import {identifySource} from '../src/sources/source-identity.ts';
import {createTaskPaths, toPosixPath} from '../src/tasks/paths.ts';
import {normalizeLanguageTag} from '../src/pipeline/url-media.ts';

const golden = JSON.parse(
  await readFile(new URL('./fixtures/url-media-golden.json', import.meta.url), 'utf8'),
);
const LAUNCHER = 'fake-yt-dlp';
const IDENTITY = identifySource(golden.url);
const SOURCE = {downloadUrl: golden.url, identity: IDENTITY};
const STDOUT_VIDEO = '__VIDEO__';
const FALLBACK_COMMAND = ['bilibili-fallback', golden.url];

const SUBTITLE_FILE = [
  '1',
  '00:00:01,000 --> 00:00:02,000',
  'First line',
  '',
  '2',
  '00:00:02,000 --> 00:00:03,000',
  'Second line',
  '',
].join('\n');

function ffprobeJson(valid) {
  return JSON.stringify({
    streams: [
      {codec_type: 'video', codec_name: 'h264', width: 64, height: 64},
      {codec_type: 'audio', codec_name: 'pcm_s16le', sample_fmt: 's16',
        sample_rate: '16000', channels: 1},
    ],
    format: {duration: valid ? '1.000000' : '0.000000', size: valid ? '1024' : '0'},
  });
}

function makeRoot() {
  return mkdtempSync(path.join(tmpdir(), 'locus-url-media-'));
}

function makePaths(root) {
  return createTaskPaths({
    outputRoot: path.join(root, 'outputs'),
    cacheRoot: path.join(root, 'cache'),
    taskId: '20261114-120000-douyin-7524373044106677544',
  });
}

/** 按场景配置假 runner：下载器返回一条 stdout 路径，ffprobe/ffmpeg 返回可控结果。 */
function makeRunner(paths, scenario) {
  const videoFile = path.join(paths.downloadDir, 'video.mp4');
  return async (command) => {
    const [executable, ...args] = command;
    if (executable === LAUNCHER) {
      if (scenario.downloadError) {
        return {command: [...command], returncode: 1, stdout: '', stderr: scenario.downloadError};
      }
      if (scenario.writeVideo) await writeFile(videoFile, 'video');
      return {
        command: scenario.fallback ? FALLBACK_COMMAND : [...command],
        returncode: 0,
        stdout: scenario.stdout === STDOUT_VIDEO ? videoFile : (scenario.stdout ?? ''),
        stderr: '',
      };
    }
    if (executable === 'ffprobe') {
      if (scenario.probeError) {
        return {command: [...command], returncode: 1, stdout: '', stderr: 'bad'};
      }
      return {
        command: [...command],
        returncode: 0,
        stdout: ffprobeJson(!scenario.probeInvalid),
        stderr: '',
      };
    }
    if (executable === 'ffmpeg') {
      if (scenario.audioError) {
        return {command: [...command], returncode: 1, stdout: '', stderr: 'bad'};
      }
      await writeFile(args[args.length - 1], 'wav');
      return {command: [...command], returncode: 0, stdout: '', stderr: ''};
    }
    return {command: [...command], returncode: 1, stdout: '', stderr: 'unexpected command'};
  };
}

const SCENARIOS = {
  'success without subtitle': {writeVideo: true, stdout: STDOUT_VIDEO},
  'download failure is sanitized': {downloadError: 'network down'},
  'download produced no media': {stdout: ''},
  'downloaded media is invalid': {writeVideo: true, stdout: STDOUT_VIDEO, probeInvalid: true},
  'media probe failed': {writeVideo: true, stdout: STDOUT_VIDEO, probeError: true},
  'audio extraction failed': {writeVideo: true, stdout: STDOUT_VIDEO, audioError: true},
  'existing audio is reused': {writeVideo: true, stdout: STDOUT_VIDEO, reuseAudio: true},
  'platform subtitle is used': {writeVideo: true, stdout: STDOUT_VIDEO, subtitle: true},
  'bilibili fallback skips subtitle detection': {
    writeVideo: true, stdout: STDOUT_VIDEO, fallback: true, subtitle: true,
  },
  'video commit failed': {writeVideo: true, stdout: STDOUT_VIDEO, commitFails: true},
};

async function runScenario(label, scenario) {
  const root = makeRoot();
  const paths = makePaths(root);
  for (const dir of [paths.mediaDir, paths.transcriptDir, paths.aiDir, paths.downloadDir]) {
    mkdirSync(dir, {recursive: true});
  }
  if (scenario.reuseAudio) await writeFile(paths.audioPath, 'wav');
  if (scenario.commitFails) mkdirSync(paths.videoPathForExtension('mp4'), {recursive: true});
  if (scenario.subtitle) {
    await writeFile(path.join(paths.downloadDir, 'video.zh-Hans.srt'), SUBTITLE_FILE);
  }
  const events = [];
  let prepared = null;
  let failure = null;
  try {
    prepared = await prepareUrlMedia({
      source: SOURCE,
      paths: {
        downloadDir: paths.downloadDir,
        mediaDir: paths.mediaDir,
        audioPath: paths.audioPath,
        videoPath: paths.videoPathForExtension('mp4'),
      },
      launcher: [LAUNCHER],
      runner: makeRunner(paths, scenario),
      strategies: [],
      probeXiaohongshuSubtitle: async () => {},
      onProgress: (event) => events.push(event),
    });
  } catch (error) {
    if (!(error instanceof MediaPreparationError)) throw error;
    failure = {code: error.code, message: error.message, stage: error.stage};
  }
  return {events, outcome: failure === null ? {
    video_path: toPosixPath(path.relative(paths.taskDir, prepared.videoPath)),
    audio_path: toPosixPath(path.relative(paths.taskDir, prepared.audioPath)),
    subtitle: prepared.subtitleCandidate === null ? null : {
      text: prepared.subtitleCandidate.text,
      language: prepared.subtitleCandidate.language,
      segments: prepared.subtitleCandidate.segments.map((segment) => ({
        id: segment.id,
        start_ms: segment.startMs,
        end_ms: segment.endMs,
        text: segment.text,
      })),
    },
  } : {error: failure}};
}

test('URL media preparation matches Python events, failures and artifacts', async () => {
  for (const entry of golden.cases) {
    const scenario = SCENARIOS[entry.label];
    assert.notEqual(scenario, undefined, `缺少场景配置：${entry.label}`);
    const actual = await runScenario(entry.label, scenario);
    assert.deepEqual(actual.events, entry.events, `${entry.label}: 进度事件`);
    assert.deepEqual(actual.outcome, entry.outcome, `${entry.label}: 结果/错误`);
  }
});

test('language tag normalization matches the progress event registry', () => {
  for (const entry of golden.language_tags) {
    assert.equal(normalizeLanguageTag(entry.input), entry.result, JSON.stringify(entry.input));
  }
});
