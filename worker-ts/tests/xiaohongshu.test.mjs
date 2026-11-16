// 跨语言基准：小红书来源解析、页面与状态、候选流、字幕轨与完整下载，
// 必须与 `worker/worker_core/xiaohongshu*` 在同样的输入下给出同样的结果。
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {SafeDownloadError} from '../src/download-reliability.ts';
import {downloadXiaohongshuVideo} from '../src/sources/xiaohongshu/fallback.ts';
import {downloadXiaohongshuSubtitle} from '../src/sources/xiaohongshu/fallback.ts';
import {
  XHS_MAX_HTML_BYTES,
  decodeResponseBody,
  extractInitialState,
  isImageOnlyNote,
  jsToJson,
  lookupNote,
  raiseForPageResponse,
} from '../src/sources/xiaohongshu/page.ts';
import {
  XHS_BASE_URL,
  XHS_MAX_REDIRECT_DEPTH,
  XHS_SHORT_HOSTS,
  XHS_TRAILING_URL_PUNCTUATION,
  buildExploreUrl,
  parseXiaohongshuSource,
} from '../src/sources/xiaohongshu/source.ts';
import {collectDownloadUrls, parseVideoStreams} from '../src/sources/xiaohongshu/streams.ts';
import {
  PREFERRED_SUBTITLE_GROUPS,
  SUBTITLE_HOST_SUFFIXES,
  isAllowedSubtitleUrl,
  normalizeSubtitleLanguage,
  selectPreferredSubtitleTrack,
} from '../src/sources/xiaohongshu/subtitles.ts';
import {
  XHS_DESKTOP_USER_AGENT,
  XHS_DOWNLOAD_CHUNK_BYTES,
  XHS_MAX_SUBTITLE_BYTES,
  XHS_MAX_VIDEO_BYTES,
  XHS_NO_PROGRESS_TIMEOUT_SECONDS,
  XHS_REFERER,
  XHS_SUBTITLE_CONTENT_TYPES,
  XHS_SUBTITLE_HOST_SUFFIXES,
  mapDownloadError,
  mediaHeaders,
  pageHeaders,
} from '../src/sources/xiaohongshu/transport.ts';
import {XiaohongshuFallbackError} from '../src/sources/xiaohongshu/types.ts';

const golden = JSON.parse(await readFile(
  new URL('./fixtures/xiaohongshu-golden.json', import.meta.url), 'utf8',
));

class FakeClient {
  #responses;
  #downloads;
  calls = [];
  downloadCalls = [];

  constructor({responses = {}, downloads = {}} = {}) {
    this.#responses = new Map(
      Object.entries(responses).map(([url, items]) => [url, [...items]]),
    );
    this.#downloads = new Map(
      Object.entries(downloads).map(([url, items]) => [url, [...items]]),
    );
  }

  async get(url, headers = {}, timeoutSeconds = 10) {
    this.calls.push({url, headers});
    void timeoutSeconds;
    const items = this.#responses.get(url);
    assert.ok(items !== undefined && items.length > 0, `Unexpected URL: ${url}`);
    const item = items.shift();
    if (item.error !== undefined) {
      if (item.error.code.startsWith('XHS_')) {
        throw new XiaohongshuFallbackError(item.error.code, item.error.message);
      }
      throw new SafeDownloadError(item.error.code, item.error.message);
    }
    return responseOf(item);
  }

  async downloadToPath(url, destination, options = {}) {
    this.downloadCalls.push({
      url,
      destination: path.basename(destination),
      headers: options.headers ?? {},
      timeout_seconds: options.timeoutSeconds ?? 30,
      max_bytes: options.maxBytes ?? null,
      no_progress_timeout_seconds: options.noProgressTimeoutSeconds ?? null,
      allowed_content_types: [...(options.allowedContentTypes ?? [])],
      allowed_host_suffixes: [...(options.allowedHostSuffixes ?? [])],
    });
    const items = this.#downloads.get(url);
    assert.ok(items !== undefined && items.length > 0, `Unexpected download URL: ${url}`);
    const item = items.shift();
    if (item.kind === 'safe') throw new SafeDownloadError(item.code, item.message);
    if (item.kind === 'xiaohongshu') {
      throw new XiaohongshuFallbackError(item.code, item.message);
    }
    if (item.kind === 'other') throw new Error(item.message);
    const payload = Buffer.from(item.payload, 'latin1');
    await writeFile(destination, payload);
    return payload.length;
  }
}

function responseOf(entry) {
  return {
    status: entry.status,
    headers: entry.headers,
    body: Buffer.from(entry.body, 'latin1'),
    url: entry.url,
  };
}

function candidateShape(value) {
  return {
    quality_key: value.qualityKey,
    url: value.url,
    backup_urls: [...value.backupUrls],
    size_bytes: value.sizeBytes,
    width: value.width,
    height: value.height,
    video_codec: value.videoCodec,
    video_bitrate: value.videoBitrate,
    stream_type: value.streamType,
    weight: value.weight,
    default_stream: value.defaultStream,
    headers: {...value.headers},
  };
}

test('xiaohongshu constants match the python golden', () => {
  const constants = golden.constants;
  assert.equal(XHS_BASE_URL, constants.base_url);
  assert.equal(XHS_MAX_REDIRECT_DEPTH, constants.max_redirect_depth);
  assert.deepEqual([...XHS_SHORT_HOSTS].sort(), constants.short_hosts);
  assert.equal(XHS_TRAILING_URL_PUNCTUATION, constants.trailing_url_punctuation);
  assert.equal(XHS_MAX_HTML_BYTES, constants.max_html_bytes);
  assert.equal(XHS_MAX_VIDEO_BYTES, constants.max_video_bytes);
  assert.equal(XHS_MAX_SUBTITLE_BYTES, constants.max_subtitle_bytes);
  assert.equal(XHS_DOWNLOAD_CHUNK_BYTES, constants.download_chunk_bytes);
  assert.equal(XHS_NO_PROGRESS_TIMEOUT_SECONDS, constants.no_progress_timeout_seconds);
  assert.equal(XHS_DESKTOP_USER_AGENT, constants.desktop_user_agent);
  assert.equal(XHS_REFERER, constants.referer);
  assert.deepEqual([...XHS_SUBTITLE_CONTENT_TYPES], constants.subtitle_content_types);
  assert.deepEqual([...XHS_SUBTITLE_HOST_SUFFIXES], constants.subtitle_host_suffixes);
  assert.deepEqual([...PREFERRED_SUBTITLE_GROUPS], constants.preferred_subtitle_groups);
  assert.deepEqual(pageHeaders(), constants.page_headers);
  assert.deepEqual(mediaHeaders(), constants.media_headers);
  assert.deepEqual([...SUBTITLE_HOST_SUFFIXES], constants.subtitle_host_suffixes);
});

test('xiaohongshu input parsing matches the python golden', async () => {
  for (const entry of golden.source) {
    const client = new FakeClient({responses: entry.responses});
    if (entry.result.error !== undefined) {
      await assert.rejects(
        parseXiaohongshuSource(entry.input, client),
        (error) => {
          assert.ok(error instanceof XiaohongshuFallbackError, entry.label);
          assert.equal(error.code, entry.result.error.code, entry.label);
          assert.equal(error.message, entry.result.error.message, entry.label);
          return true;
        },
        entry.label,
      );
    } else {
      const parsed = await parseXiaohongshuSource(entry.input, client);
      assert.deepEqual({
        note_id: parsed.noteId,
        full_url: parsed.fullUrl,
        xsec_token: parsed.xsecToken,
      }, entry.result.parsed, entry.label);
    }
    assert.deepEqual(client.calls, entry.get_calls, entry.label);
  }
});

test('buildExploreUrl matches the python golden', () => {
  for (const entry of golden.build_urls) {
    assert.equal(
      buildExploreUrl(entry.note_id, entry.token, entry.base_url),
      entry.result,
      entry.label,
    );
  }
});

test('page status mapping matches the python golden', () => {
  for (const entry of golden.page.statuses) {
    const response = {
      status: entry.status,
      headers: entry.headers,
      body: Buffer.from(entry.body, 'latin1'),
      url: '',
    };
    if (entry.result.ok === true) {
      raiseForPageResponse(response);
    } else {
      assert.throws(
        () => raiseForPageResponse(response),
        (error) => {
          assert.equal(error.code, entry.result.error.code, entry.label);
          assert.equal(error.message, entry.result.error.message, entry.label);
          return true;
        },
        entry.label,
      );
    }
  }
});

test('response decoding matches the python golden', () => {
  for (const entry of golden.page.decodes) {
    const response = {
      status: 200,
      headers: entry.headers,
      body: Buffer.from(entry.body, 'latin1'),
      url: '',
    };
    if (entry.result.text !== undefined) {
      assert.equal(decodeResponseBody(response), entry.result.text, entry.label);
    } else {
      assert.throws(
        () => decodeResponseBody(response),
        (error) => error.code === entry.result.error.code,
        entry.label,
      );
    }
  }
});

test('page response size limit matches the python golden', () => {
  const limit = golden.page.limit;
  assert.equal(
    decodeResponseBody({
      status: 200,
      headers: {},
      body: Buffer.from(limit.within_body, 'latin1'),
      url: '',
    }, limit.within_max_bytes),
    limit.within,
  );
  assert.throws(
    () => decodeResponseBody({
      status: 200,
      headers: {},
      body: Buffer.from(limit.exceeded_body, 'latin1'),
      url: '',
    }, limit.exceeded_max_bytes),
    (error) => error.code === limit.exceeded.error.code,
  );
});

test('initial state extraction matches the python golden', () => {
  for (const entry of golden.state.states) {
    if (entry.result.error !== undefined) {
      assert.throws(
        () => lookupNote(extractInitialState(entry.body), entry.note_id),
        (error) => {
          assert.equal(error.code, entry.result.error.code, entry.label);
          assert.equal(error.message, entry.result.error.message, entry.label);
          return true;
        },
        entry.label,
      );
    } else {
      const note = lookupNote(extractInitialState(entry.body), entry.note_id);
      assert.deepEqual({
        note_keys: Object.keys(note).sort(),
        type: note.type,
      }, entry.result, entry.label);
    }
  }
});

test('js to json rewriting matches the python golden', () => {
  for (const entry of golden.state.js_to_json) {
    assert.equal(jsToJson(entry.input), entry.result, entry.label);
  }
});

test('image-only detection matches the python golden', () => {
  for (const entry of golden.state.is_image_only) {
    assert.equal(isImageOnlyNote(entry.note), entry.result, entry.label);
  }
});

test('stream candidates match the python golden', () => {
  const headers = mediaHeaders();
  for (const entry of golden.streams.candidates) {
    const candidates = parseVideoStreams(entry.note, {candidateHeaders: headers});
    assert.deepEqual(candidates.map(candidateShape), entry.result.candidates, entry.label);
  }
});

test('download url collection matches the python golden', () => {
  for (const entry of golden.streams.collect) {
    assert.deepEqual(
      collectDownloadUrls(entry.primary, entry.backups),
      entry.result,
      entry.label,
    );
  }
});

test('subtitle url and language rules match the python golden', () => {
  for (const entry of golden.subtitles.allowed_urls) {
    assert.equal(isAllowedSubtitleUrl(entry.url), entry.result, entry.label);
  }
  for (const entry of golden.subtitles.languages) {
    assert.equal(normalizeSubtitleLanguage(entry.input), entry.result, String(entry.input));
  }
});

test('preferred subtitle selection matches the python golden', () => {
  for (const entry of golden.subtitles.selection) {
    const track = selectPreferredSubtitleTrack(entry.note);
    assert.deepEqual(track === null ? null : {
      language: track.language,
      url: track.url,
      suffix: track.suffix,
    }, entry.result, entry.label);
  }
});

test('download error mapping matches the python golden', () => {
  for (const entry of golden.download_errors) {
    const source = entry.source === null
      ? null
      : new SafeDownloadError(entry.source.code, entry.source.message);
    const mapped = mapDownloadError(source);
    assert.deepEqual({code: mapped.code, message: mapped.message}, entry.result, entry.label);
  }
});

test('full download matches the python golden', async () => {
  for (const entry of golden.full_downloads) {
    const root = await mkdtemp(path.join(tmpdir(), 'locus-xhs-'));
    const client = new FakeClient({
      responses: entry.responses,
      downloads: entry.downloads,
    });
    const events = [];
    try {
      if (entry.result.error !== undefined) {
        await assert.rejects(
          downloadXiaohongshuVideo(golden.constants.note_url, root, {
            httpClient: client,
            onProgress: (event) => events.push(event),
          }),
          (error) => {
            assert.equal(error.code, entry.result.error.code, entry.label);
            assert.equal(error.message, entry.result.error.message, entry.label);
            return true;
          },
          entry.label,
        );
      } else {
        const videoPath = await downloadXiaohongshuVideo(golden.constants.note_url, root, {
          httpClient: client,
          onProgress: (event) => events.push(event),
        });
        const {readdir} = await import('node:fs/promises');
        assert.deepEqual({
          video: path.basename(videoPath),
          files: (await readdir(root)).sort(),
        }, entry.result, entry.label);
      }
      assert.deepEqual(
        events.map((event) => ({
          message_code: event.message_code,
          stage: event.stage,
          progress: event.progress,
          ...(event.message_args === undefined ? {} : {message_args: event.message_args}),
        })),
        entry.events.map((event) => ({
          message_code: event.message_code,
          stage: event.stage,
          progress: event.progress,
          ...(event.message_args === undefined ? {} : {message_args: event.message_args}),
        })),
        entry.label,
      );
      assert.deepEqual(client.downloadCalls, entry.download_calls, entry.label);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  }
});

test('subtitle probe matches the python golden', async () => {
  for (const entry of golden.subtitle_probe) {
    const root = await mkdtemp(path.join(tmpdir(), 'locus-xhs-sub-'));
    const client = new FakeClient({
      responses: entry.responses,
      downloads: entry.downloads,
    });
    try {
      const filePath = await downloadXiaohongshuSubtitle(golden.constants.note_url, root, {
        httpClient: client,
      });
      if (entry.result === null) {
        assert.equal(filePath, null, entry.label);
      } else {
        assert.ok(filePath !== null, entry.label);
        assert.deepEqual({
          name: path.basename(filePath),
          exists: true,
          text: await readFile(filePath, 'utf8'),
        }, entry.result, entry.label);
      }
      assert.deepEqual(client.downloadCalls, entry.download_calls, entry.label);
      assert.deepEqual(client.calls, entry.get_calls, entry.label);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  }
});
