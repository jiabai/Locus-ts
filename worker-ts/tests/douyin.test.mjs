// 跨语言基准：抖音传输层（ID 解析、分享页、候选流、进度事件、有序下载）
// 必须与 `worker/worker_core/douyin*` 在同样的输入下给出同样的结果。
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {SafeDownloadError} from '../src/download-reliability.ts';
import {
  emitStreamRetry,
  downloadDouyinVideo,
  downloadFirstAvailableCandidate,
  streamProgressEmitter,
} from '../src/sources/douyin/fallback.ts';
import {parseSharePageRouterData} from '../src/sources/douyin/page.ts';
import {
  buildPlayUrl,
  collectStreamCandidates,
  selectStreamCandidates,
} from '../src/sources/douyin/streams.ts';
import {extractAwemeId} from '../src/sources/douyin/source.ts';
import {DouyinFallbackError} from '../src/sources/douyin/types.ts';

const golden = JSON.parse(await readFile(
  new URL('./fixtures/douyin-golden.json', import.meta.url), 'utf8',
));
const AWEME_ID = '7524373044106677544';

class FakeHttpClient {
  #responses;
  #downloads;
  calls = [];
  downloadCalls = [];

  constructor({responses = {}, downloads = {}} = {}) {
    this.#responses = new Map(Object.entries(responses).map(([url, items]) => [url, [...items]]));
    this.#downloads = new Map(Object.entries(downloads).map(([url, items]) => [url, [...items]]));
  }

  async get(url, headers = {}, timeoutSeconds = 10) {
    this.calls.push({url, headers});
    const items = this.#responses.get(url);
    assert.ok(items !== undefined && items.length > 0, `Unexpected URL: ${url}`);
    const item = items.shift();
    if (item.error !== undefined) {
      throw new DouyinFallbackError(item.error.code, item.error.message);
    }
    return {
      status: item.status,
      headers: item.headers,
      body: Buffer.from(item.body, 'latin1'),
      url: item.url,
    };
  }

  async downloadToPath(url, destination, options = {}) {
    const resumeFromBytes = options.resumeFromBytes ?? 0;
    this.downloadCalls.push({url, resume_from_bytes: resumeFromBytes});
    const items = this.#downloads.get(url);
    assert.ok(items !== undefined && items.length > 0, `Unexpected download URL: ${url}`);
    const item = items.shift();
    const partPath = `${destination}.part`;
    if (item.stalled !== undefined) {
      if (item.part === '') {
        await rm(partPath, {force: true});
      } else {
        await writeFile(partPath, item.part, 'latin1');
      }
      throw new SafeDownloadError(item.stalled, `fake ${item.stalled}`);
    }
    if (item.error !== undefined) {
      await rm(partPath, {force: true});
      throw new Error(item.error);
    }
    const payload = Buffer.from(item.payload, 'latin1');
    if (resumeFromBytes > 0) {
      const existing = await readFile(partPath).catch(() => null);
      if (existing === null || existing.length !== resumeFromBytes) {
        throw new SafeDownloadError('DOWNLOAD_RESUME_INVALID',
          'fake resume offset does not match the partial file');
      }
      await writeFile(partPath, Buffer.concat([existing, payload.subarray(resumeFromBytes)]));
    } else {
      await writeFile(partPath, payload);
    }
    await rename(partPath, destination);
    if (options.onProgress !== undefined) {
      let emitted = resumeFromBytes;
      while (emitted < payload.length) {
        emitted = Math.min(payload.length, emitted + 4 * 1024 * 1024);
        options.onProgress(emitted, options.totalBytes ?? emitted);
      }
    }
    return payload.length;
  }
}

function candidateView(candidate) {
  return {
    quality: candidate.quality,
    url: candidate.url,
    size_bytes: candidate.sizeBytes,
    width: candidate.width ?? null,
    height: candidate.height ?? null,
    headers: candidate.headers,
  };
}

test('aweme id extraction matches the python golden', () => {
  for (const entry of golden.aweme_ids) {
    assert.equal(extractAwemeId(entry.input), entry.result, entry.input);
  }
});

test('play url construction matches the python golden', () => {
  for (const entry of golden.play_urls) {
    assert.equal(buildPlayUrl(entry.uri, entry.quality), entry.result, entry.uri);
  }
});

test('share page parsing matches the python golden', () => {
  for (const entry of golden.pages) {
    try {
      assert.deepEqual(parseSharePageRouterData(entry.html), entry.result.item, entry.label);
    } catch (error) {
      assert.ok(error instanceof DouyinFallbackError, `${entry.label}: ${error}`);
      assert.deepEqual({error: {code: error.code, message: error.message}},
        entry.result, entry.label);
    }
  }
});

test('stream candidates match the python golden', async () => {
  for (const entry of golden.candidates) {
    const client = new FakeHttpClient({responses: entry.probe_responses});
    if (entry.result.error !== undefined) {
      await assert.rejects(collectStreamCandidates(entry.item, client), (error) => {
        assert.ok(error instanceof DouyinFallbackError);
        assert.deepEqual({code: error.code, message: error.message}, entry.result.error);
        return true;
      }, entry.label);
      continue;
    }
    const collected = await collectStreamCandidates(entry.item, client);
    assert.deepEqual(collected.map(candidateView), entry.result.candidates, entry.label);
    assert.deepEqual(client.calls.map((call) => call.url), entry.probe_calls, entry.label);
  }
});

test('candidate selection matches the python golden', () => {
  for (const entry of golden.selection) {
    const candidates = entry.candidates.map((value) => ({
      quality: value.quality,
      url: value.url,
      sizeBytes: value.size_bytes,
      headers: value.headers,
    }));
    assert.deepEqual(selectStreamCandidates(candidates).map(candidateView), entry.result);
  }
});

test('stream progress emitter matches the python golden', () => {
  for (const entry of golden.progress_emitter) {
    const events = [];
    const emitter = streamProgressEmitter((event) => events.push(event));
    for (const [downloaded, total] of entry.steps) emitter(downloaded, total);
    assert.deepEqual(events, entry.events, JSON.stringify(entry.steps));
  }
});

test('stream retry events match the python golden', () => {
  for (const entry of golden.retry_events) {
    const events = [];
    emitStreamRetry((event) => events.push(event), entry.failed_index, entry.total);
    assert.deepEqual(events, entry.events, `${entry.failed_index}/${entry.total}`);
  }
});

test('ordered candidate downloads match the python golden', async () => {
  for (const entry of golden.ordered_downloads) {
    const root = await mkdtemp(path.join(tmpdir(), 'locus-douyin-'));
    try {
      const client = new FakeHttpClient({downloads: entry.downloads});
      const events = [];
      const candidates = entry.candidates.map((value) => ({
        quality: value.quality,
        url: value.url,
        sizeBytes: value.size_bytes,
        headers: value.headers,
      }));
      let outcome;
      try {
        const outputPath = await downloadFirstAvailableCandidate(
          AWEME_ID, candidates, root, client, 15, (event) => events.push(event),
        );
        outcome = {
          path: path.basename(outputPath),
          bytes: (await readFile(outputPath)).toString('latin1'),
        };
      } catch (error) {
        assert.ok(error instanceof DouyinFallbackError, `${entry.label}: ${error}`);
        const destination = await readFile(path.join(root, `${AWEME_ID}.mp4`), 'latin1')
          .catch(() => null);
        const part = await readFile(path.join(root, `${AWEME_ID}.mp4.part`), 'latin1')
          .catch(() => null);
        outcome = {error: {code: error.code, message: error.message}, bytes: destination, part};
      }
      assert.deepEqual(outcome, entry.outcome, entry.label);
      assert.deepEqual(client.downloadCalls, entry.download_calls, entry.label);
      assert.deepEqual(events, entry.events, entry.label);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  }
});

test('full douyin downloads match the python golden', async () => {
  for (const entry of golden.full_downloads) {
    const root = await mkdtemp(path.join(tmpdir(), 'locus-douyin-full-'));
    try {
      const client = new FakeHttpClient({
        responses: entry.responses,
        downloads: entry.downloads,
      });
      const events = [];
      const sleeps = [];
      let outcome;
      try {
        const outputPath = await downloadDouyinVideo(entry.url, root, {
          httpClient: client,
          onProgress: (event) => events.push(event),
          sleeper: async (seconds) => {
            sleeps.push(seconds);
          },
        });
        outcome = {
          path: path.basename(outputPath),
          bytes: (await readFile(outputPath)).toString('latin1'),
        };
      } catch (error) {
        assert.ok(error instanceof DouyinFallbackError, `${entry.label}: ${error}`);
        outcome = {error: {code: error.code, message: error.message}};
      }
      assert.deepEqual(outcome, entry.outcome, entry.label);
      assert.deepEqual(events, entry.events, entry.label);
      assert.deepEqual(client.calls.map((call) => call.url), entry.get_calls, entry.label);
      assert.equal(sleeps.length, entry.sleeps.length, entry.label);
      for (const seconds of sleeps) {
        assert.ok(seconds >= 3 && seconds <= 10, `${entry.label}: ${seconds}`);
      }
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  }
});
