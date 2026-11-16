import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {
  BILIBILI_HOST_SUFFIXES,
  DOWNLOADED_MEDIA_SUFFIXES,
  DOUYIN_HOST_SUFFIXES,
  PLATFORM_SUBTITLE_ARGS,
  XIAOHONGSHU_HOST_SUFFIXES,
  YOUTUBE_DOWNLOAD_FAILED_MESSAGE,
  YOUTUBE_FORMAT_SELECTOR,
  YOUTUBE_HOSTS,
  YOUTUBE_JS_RUNTIMES,
  YOUTUBE_SHORT_HOSTS,
  YTDLP_DOWNLOAD_TIMEOUT_CODE,
  YTDLP_DOWNLOAD_TIMEOUT_SECONDS,
  buildYtdlpCommand,
  classifyYoutubeDownloadFailure,
  containsSupportedUrl,
  extractDouyinVideoId,
  extractXiaohongshuNoteId,
  isRetryableYoutubeFailure,
  isYoutubeSubtitleDownloadFailure,
  iterUrlCandidates,
  outputTemplate,
  sanitizeYoutubeError,
  shouldAttemptBilibiliFallback,
  shouldAttemptDouyinFallback,
  shouldAttemptXiaohongshuFallback,
  shouldAttemptYoutubeProcessing,
} from '../src/media/ytdlp.ts';
import {structuredErrorCode} from '../src/media/command.ts';

const golden = JSON.parse(
  await readFile(new URL('./fixtures/downloader-golden.json', import.meta.url), 'utf8'),
);

const LAUNCHER = ['<launcher>'];

test('constants match the python downloader', () => {
  const c = golden.constants;
  assert.equal(YOUTUBE_FORMAT_SELECTOR, c.youtube_format_selector);
  assert.deepEqual([...YOUTUBE_JS_RUNTIMES], c.youtube_js_runtimes);
  assert.deepEqual([...PLATFORM_SUBTITLE_ARGS], c.platform_subtitle_args);
  assert.deepEqual([...YOUTUBE_HOSTS], c.youtube_hosts);
  assert.deepEqual([...YOUTUBE_SHORT_HOSTS], c.youtube_short_hosts);
  assert.deepEqual([...DOUYIN_HOST_SUFFIXES], c.douyin_host_suffixes);
  assert.deepEqual([...XIAOHONGSHU_HOST_SUFFIXES], c.xiaohongshu_host_suffixes);
  assert.deepEqual([...BILIBILI_HOST_SUFFIXES], c.bilibili_host_suffixes);
  assert.deepEqual([...DOWNLOADED_MEDIA_SUFFIXES], c.downloaded_media_suffixes);
  assert.equal(YTDLP_DOWNLOAD_TIMEOUT_SECONDS, c.ytdlp_timeout_seconds);
  assert.equal(YTDLP_DOWNLOAD_TIMEOUT_CODE, c.ytdlp_timeout_code);
});

test('ytdlp command arguments are identical for every golden url', () => {
  for (const entry of golden.commands) {
    assert.deepEqual(
      buildYtdlpCommand({
        url: entry.url,
        outputDir: entry.output_dir,
        launcher: LAUNCHER,
        includeSubtitles: entry.include_subtitles,
      }),
      entry.command,
      entry.label,
    );
  }
});

test('output template follows pathlib as_posix semantics', () => {
  const cases = [
    ['outputs', 'outputs/%(id)s.%(ext)s'],
    ['outputs/', 'outputs/%(id)s.%(ext)s'],
    ['', '%(id)s.%(ext)s'],
    ['.', '%(id)s.%(ext)s'],
    ['./outputs', 'outputs/%(id)s.%(ext)s'],
    ['outputs//nested', 'outputs/nested/%(id)s.%(ext)s'],
    ['outputs/./nested', 'outputs/nested/%(id)s.%(ext)s'],
    ['outputs/../nested', 'outputs/../nested/%(id)s.%(ext)s'],
    ['/tmp/out/', '/tmp/out/%(id)s.%(ext)s'],
    ['/', '/%(id)s.%(ext)s'],
    ['C:/', 'C:/%(id)s.%(ext)s'],
    ['C:\\Users\\locus\\outputs', 'C:/Users/locus/outputs/%(id)s.%(ext)s'],
    ['a b', 'a b/%(id)s.%(ext)s'],
  ];
  for (const [dir, expected] of cases) assert.equal(outputTemplate(dir), expected, dir);
});

test('url candidate extraction matches python', () => {
  for (const entry of golden.url_candidates) {
    assert.deepEqual(iterUrlCandidates(entry.raw), entry.result, entry.label);
  }
});

test('youtube url detection matches python', () => {
  for (const entry of golden.youtube_processing) {
    assert.equal(shouldAttemptYoutubeProcessing(entry.url), entry.result, entry.label);
  }
});

test('youtube failure classification matches python', () => {
  for (const entry of golden.failures) {
    const result = classifyYoutubeDownloadFailure({
      command: ['yt-dlp'],
      returncode: 1,
      stdout: entry.stdout,
      stderr: entry.stderr,
    });
    assert.deepEqual(
      {returncode: result.returncode, stdout: result.stdout, stderr: result.stderr},
      entry.result,
      entry.label,
    );
  }
});

test('youtube error sanitizing matches python', () => {
  for (const entry of golden.sanitize) {
    assert.equal(sanitizeYoutubeError(entry.message), entry.result, entry.label);
  }
  assert.equal(sanitizeYoutubeError(''), '');
  assert.equal(
    classifyYoutubeDownloadFailure({command: [], returncode: 1, stdout: '', stderr: ''}).stderr,
    `YOUTUBE_DOWNLOAD_FAILED: ${YOUTUBE_DOWNLOAD_FAILED_MESSAGE}`,
  );
});

test('fallback trigger conditions match python', () => {
  for (const entry of golden.fallback_attempts) {
    assert.equal(shouldAttemptDouyinFallback(entry.url, entry.failure_message), entry.douyin,
      `douyin: ${entry.label}`);
    assert.equal(shouldAttemptXiaohongshuFallback(entry.url, entry.failure_message),
      entry.xiaohongshu, `xiaohongshu: ${entry.label}`);
    assert.equal(shouldAttemptBilibiliFallback(entry.url, entry.failure_message), entry.bilibili,
      `bilibili: ${entry.label}`);
  }
});

test('platform id extraction matches python', () => {
  for (const entry of golden.ids) {
    assert.equal(extractDouyinVideoId(entry.text), entry.douyin_id, `douyin: ${entry.label}`);
    assert.equal(extractXiaohongshuNoteId(entry.text), entry.xhs_note_id, `xhs: ${entry.label}`);
  }
});

test('supported host suffix matching is shared by command construction', () => {
  assert.equal(containsSupportedUrl('https://www.bilibili.com/video/BV1Aa411c7mD', BILIBILI_HOST_SUFFIXES), true);
  assert.equal(containsSupportedUrl('https://sub.b23.tv/abc', BILIBILI_HOST_SUFFIXES), true);
  assert.equal(containsSupportedUrl('https://notbilibili.com/abc', BILIBILI_HOST_SUFFIXES), false);
  assert.equal(containsSupportedUrl('https://bilibili.com.evil.example/abc', BILIBILI_HOST_SUFFIXES), false);
});

test('retry and timeout decisions use the classified structured code', () => {
  const failed = {command: ['yt-dlp'], returncode: 1, stdout: '', stderr: 'ERROR: random failure'};
  const forbidden = {command: ['yt-dlp'], returncode: 1, stdout: '', stderr: 'HTTP Error 403: Forbidden'};
  const privateVideo = {command: ['yt-dlp'], returncode: 1, stdout: '', stderr: 'private video'};
  assert.equal(isRetryableYoutubeFailure(failed), true);
  assert.equal(isRetryableYoutubeFailure(forbidden), true);
  assert.equal(isRetryableYoutubeFailure(privateVideo), false);
  assert.equal(isYoutubeSubtitleDownloadFailure('ERROR: Unable to download video subtitles'), true);
  assert.equal(isYoutubeSubtitleDownloadFailure('ERROR: other'), false);
  assert.equal(structuredErrorCode(`${YTDLP_DOWNLOAD_TIMEOUT_CODE}: timed out`), YTDLP_DOWNLOAD_TIMEOUT_CODE);
});
