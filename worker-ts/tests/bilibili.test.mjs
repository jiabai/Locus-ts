// 跨语言基准：B 站解析、API 解析、DASH 选择、响应解码、分片下载与合并，
// 必须与 `worker/worker_core/bilibili*` 在同样的输入下给出同样的结果。
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {SafeDownloadError} from '../src/download-reliability.ts';
import {downloadFirstAvailableUrl, mergeDashFiles} from '../src/sources/bilibili/artifacts.ts';
import {downloadBilibiliVideo} from '../src/sources/bilibili/fallback.ts';
import {
  buildPlayurlUrl,
  buildVideoInfoUrl,
  parsePlayurlResponse,
  parseViewResponse,
  selectDashStreamPair,
} from '../src/sources/bilibili/playback.ts';
import {parseBilibiliInput} from '../src/sources/bilibili/source.ts';
import {decodeResponseBody} from '../src/sources/bilibili/transport.ts';
import {BilibiliFallbackError} from '../src/sources/bilibili/types.ts';
import {toPosixPath} from '../src/tasks/paths.ts';

const golden = JSON.parse(await readFile(
  new URL('./fixtures/bilibili-golden.json', import.meta.url), 'utf8',
));

class FakeClient {
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
      throw new BilibiliFallbackError(item.error.code, item.error.message);
    }
    return {
      status: item.status,
      headers: item.headers,
      body: Buffer.from(item.body, 'latin1'),
      url: item.url,
    };
  }

  async downloadToPath(url, destination) {
    this.downloadCalls.push({url});
    const items = this.#downloads.get(url);
    assert.ok(items !== undefined && items.length > 0, `Unexpected download URL: ${url}`);
    const item = items.shift();
    if (item.kind === 'safe') throw new SafeDownloadError(item.code, item.message);
    if (item.kind === 'bilibili') throw new BilibiliFallbackError(item.code, item.message);
    if (item.kind === 'other') throw new Error(item.message);
    await writeFile(destination, Buffer.from(item.payload, 'latin1'));
    return Buffer.byteLength(item.payload, 'latin1');
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

function parsedView(value) {
  return {
    video_id: value.videoId,
    id_kind: value.idKind,
    part_index: value.partIndex,
    full_url: value.fullUrl,
  };
}

test('bilibili input parsing matches the python golden', async () => {
  for (const entry of golden.parse) {
    const client = new FakeClient({responses: entry.responses});
    if (entry.result.error !== undefined) {
      await assert.rejects(parseBilibiliInput(entry.input, client), (error) => {
        assert.ok(error instanceof BilibiliFallbackError, `${entry.label}: ${error}`);
        assert.deepEqual({code: error.code, message: error.message}, entry.result.error);
        return true;
      }, entry.label);
    } else {
      assert.deepEqual(parsedView(await parseBilibiliInput(entry.input, client)),
        entry.result.parsed, entry.label);
    }
    assert.deepEqual(client.calls.map((call) => call.url), entry.get_calls, entry.label);
  }
});

test('bilibili api urls match the python golden', () => {
  for (const entry of golden.urls) {
    if (entry.id_kind !== undefined) {
      assert.equal(buildVideoInfoUrl(entry.id_kind, entry.video_id), entry.result);
    } else {
      assert.equal(buildPlayurlUrl(entry.bvid, entry.cid), entry.result);
    }
  }
});

test('view parsing matches the python golden', () => {
  for (const entry of golden.views) {
    if (entry.result.error !== undefined) {
      assert.throws(() => parseViewResponse(responseOf(entry.response)), (error) => {
        assert.ok(error instanceof BilibiliFallbackError, `${entry.label}: ${error}`);
        assert.deepEqual({code: error.code, message: error.message}, entry.result.error);
        return true;
      }, entry.label);
      continue;
    }
    const info = parseViewResponse(responseOf(entry.response));
    assert.deepEqual({
      bvid: info.bvid,
      aid: info.aid,
      title: info.title,
      pages: info.pages.map((page) => ({
        cid: page.cid,
        page: page.page,
        part: page.part,
        duration_seconds: page.durationSeconds,
      })),
    }, entry.result.video, entry.label);
  }
});

test('dash selection matches the python golden', () => {
  for (const entry of golden.dash) {
    if (entry.result.error !== undefined) {
      assert.throws(() => selectDashStreamPair(entry.data, 100), (error) => {
        assert.ok(error instanceof BilibiliFallbackError, `${entry.label}: ${error}`);
        assert.deepEqual({code: error.code, message: error.message}, entry.result.error);
        return true;
      }, entry.label);
      continue;
    }
    const selection = selectDashStreamPair(entry.data, 100);
    assert.deepEqual({
      video_url: selection.videoUrl,
      audio_url: selection.audioUrl,
      video_backup_urls: selection.videoBackupUrls,
      audio_backup_urls: selection.audioBackupUrls,
      video_codec_id: selection.videoCodecId,
      quality: selection.quality,
      quality_name: selection.qualityName,
    }, entry.result.selection, entry.label);
  }
});

test('playurl parsing matches the python golden', () => {
  for (const entry of golden.playurl_parse) {
    if (entry.result.error !== undefined) {
      assert.throws(() => parsePlayurlResponse(responseOf(entry.response)), (error) => {
        assert.ok(error instanceof BilibiliFallbackError);
        assert.deepEqual({code: error.code, message: error.message}, entry.result.error);
        return true;
      }, entry.label);
      continue;
    }
    assert.deepEqual(Object.keys(parsePlayurlResponse(responseOf(entry.response))).sort(),
      entry.result.keys, entry.label);
  }
});

test('response decoding matches the python golden', () => {
  for (const entry of golden.decode) {
    const response = {
      status: entry.status,
      headers: entry.headers,
      body: Buffer.from(entry.body, 'latin1'),
      url: '',
    };
    if (entry.result.error !== undefined) {
      assert.throws(() => decodeResponseBody(response, entry.max_bytes), (error) => {
        assert.ok(error instanceof BilibiliFallbackError);
        assert.deepEqual({code: error.code, message: error.message}, entry.result.error);
        return true;
      }, entry.label);
    } else {
      assert.equal(decodeResponseBody(response, entry.max_bytes), entry.result.text, entry.label);
    }
  }
});

test('first available download matches the python golden', async () => {
  for (const entry of golden.artifacts) {
    const root = await mkdtemp(path.join(tmpdir(), 'locus-bilibili-artifact-'));
    try {
      const client = new FakeClient({downloads: entry.downloads});
      const target = path.join(root, 'video.m4s');
      if (entry.outcome.error !== undefined) {
        await assert.rejects(downloadFirstAvailableUrl(entry.urls, target, client), (error) => {
          assert.ok(error instanceof BilibiliFallbackError);
          assert.deepEqual({code: error.code, message: error.message}, entry.outcome.error);
          return true;
        }, entry.label);
      } else {
        const output = await downloadFirstAvailableUrl(entry.urls, target, client);
        assert.deepEqual({
          path: path.basename(output),
          bytes: (await readFile(output)).toString('latin1'),
        }, entry.outcome, entry.label);
      }
      assert.deepEqual(client.downloadCalls.map((call) => call.url), entry.download_calls,
        entry.label);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  }
});

test('ffmpeg merge matches the python golden', async () => {
  for (const entry of golden.merge) {
    const root = await mkdtemp(path.join(tmpdir(), 'locus-bilibili-merge-'));
    try {
      const video = path.join(root, 'v.m4s');
      const audio = path.join(root, 'a.m4s');
      const merge = path.join(root, 'out.mp4');
      await writeFile(video, 'v');
      await writeFile(audio, 'a');
      const commands = [];
      const runner = async (command) => {
        commands.push([...command]);
        if (entry.produce) await writeFile(command.at(-1), 'merged');
        return {command, returncode: entry.ffmpeg_returncode, stdout: '', stderr: ''};
      };
      if (entry.outcome.error !== undefined) {
        await assert.rejects(mergeDashFiles(video, audio, merge, runner), (error) => {
          assert.ok(error instanceof BilibiliFallbackError);
          assert.deepEqual({code: error.code, message: error.message}, entry.outcome.error);
          return true;
        }, entry.label);
      } else {
        await mergeDashFiles(video, audio, merge, runner);
        assert.deepEqual({bytes: (await readFile(merge)).toString('latin1')},
          entry.outcome, entry.label);
      }
      const normalized = commands.map((command) =>
        command.map((item) => item.replace(toPosixPath(root), '<tmp>')));
      assert.deepEqual(normalized, entry.commands, entry.label);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  }
});

test('full bilibili downloads match the python golden', async () => {
  for (const entry of golden.full_downloads) {
    const root = await mkdtemp(path.join(tmpdir(), 'locus-bilibili-full-'));
    try {
      const client = new FakeClient({
        responses: entry.responses,
        downloads: entry.downloads,
      });
      const events = [];
      const commands = [];
      const runner = async (command) => {
        commands.push([...command]);
        if (entry.ffmpeg_returncode === 0) await writeFile(command.at(-1), 'merged-mp4');
        return {
          command,
          returncode: entry.ffmpeg_returncode,
          stdout: '',
          stderr: entry.ffmpeg_returncode === 0 ? '' : 'boom',
        };
      };
      let outcome;
      try {
        const outputPath = await downloadBilibiliVideo(entry.url, root, {
          httpClient: client,
          commandRunner: runner,
          onProgress: (event) => events.push(event),
        });
        outcome = {
          path: path.basename(outputPath),
          bytes: (await readFile(outputPath)).toString('latin1'),
          leftover: await leftovers(root),
        };
      } catch (error) {
        assert.ok(error instanceof BilibiliFallbackError, `${entry.label}: ${error}`);
        outcome = {
          error: {code: error.code, message: error.message},
          leftover: await leftovers(root),
        };
      }
      assert.deepEqual(outcome, entry.outcome, entry.label);
      assert.deepEqual(events, entry.events, entry.label);
      assert.deepEqual(client.calls.map((call) => call.url), entry.get_calls, entry.label);
      assert.deepEqual(client.downloadCalls.map((call) => call.url), entry.download_calls,
        entry.label);
      const normalized = commands.map((command) =>
        command.map((item) => item.replace(toPosixPath(root), '<tmp>')));
      assert.deepEqual(normalized, entry.ffmpeg_commands, entry.label);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  }
});

async function leftovers(root) {
  const names = await readdir(root);
  return names.filter((name) => name.endsWith('.m4s') || name.endsWith('.part')).sort();
}
