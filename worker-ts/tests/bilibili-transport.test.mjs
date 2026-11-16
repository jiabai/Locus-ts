// 传输层冒烟：用本机 HTTP 服务验证 B 站客户端的正文上限、Range 续传与
// 「服务端不支持续传则重下一次」这条回退路径，不触公网。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {gzipSync} from 'node:zlib';

import {
  BILIBILI_MAX_RESPONSE_BYTES,
  FetchBilibiliHttpClient,
  decodeResponseBody,
  header,
} from '../src/sources/bilibili/transport.ts';

const PAYLOAD = Buffer.from('0123456789');

test('a gzip response is decoded once and loses its encoding header', async () => {
  // 真实公网回归：fetch 已按 Content-Encoding 解压正文，客户端记录响应头时必须去掉这一项，
  // 否则 decodeResponseBody 会对已解压的 JSON 再解一次并报「正文无法解码」。
  const body = Buffer.from(JSON.stringify({code: 0, message: 'OK', data: {bvid: 'BV1x'}}));
  const server = createServer((request, response) => {
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Encoding': 'gzip',
    });
    response.end(gzipSync(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await new FetchBilibiliHttpClient().get(
      `http://127.0.0.1:${server.address().port}/view`);
    assert.equal(header(response.headers, 'Content-Encoding'), null);
    assert.deepEqual(Buffer.from(response.body), body);
    assert.deepEqual(JSON.parse(decodeResponseBody(response)), {
      code: 0,
      message: 'OK',
      data: {bvid: 'BV1x'},
    });
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('get caps the response body at the safety limit plus one byte', async () => {
  const big = Buffer.alloc(BILIBILI_MAX_RESPONSE_BYTES + 4096, 0x61);
  const server = createServer((request, response) => {
    response.writeHead(200, {'Content-Type': 'application/json'});
    response.end(big);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await new FetchBilibiliHttpClient().get(
      `http://127.0.0.1:${server.address().port}/big`);
    assert.equal(response.body.length, BILIBILI_MAX_RESPONSE_BYTES + 1);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('downloadToPath resumes with a range request', async () => {
  const ranges = [];
  const server = createServer((request, response) => {
    const range = request.headers.range ?? '';
    ranges.push(range);
    if (range === '') {
      response.writeHead(200, {'Content-Type': 'video/mp4'});
      response.end(PAYLOAD);
      return;
    }
    const start = Number.parseInt(range.replace(/bytes=(\d+)-/u, '$1'), 10);
    response.writeHead(206, {
      'Content-Type': 'video/mp4',
      'Content-Range': `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}`,
    });
    response.end(PAYLOAD.subarray(start));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(path.join(tmpdir(), 'locus-bilibili-range-'));
  try {
    const destination = path.join(root, 'video.m4s');
    await writeFile(`${destination}.part`, PAYLOAD.subarray(0, 4));
    const written = await new FetchBilibiliHttpClient().downloadToPath(
      `http://127.0.0.1:${server.address().port}/video`, destination,
      {maxBytes: 1024});
    assert.equal(written, PAYLOAD.length);
    assert.deepEqual(await readFile(destination), PAYLOAD);
    assert.deepEqual(ranges, ['bytes=4-']);
  } finally {
    server.closeAllConnections();
    server.close();
    await rm(root, {recursive: true, force: true});
  }
});

test('a server that ignores Range is retried once from zero', async () => {
  const ranges = [];
  const server = createServer((request, response) => {
    const range = request.headers.range ?? '';
    ranges.push(range);
    // 无论带不带 Range 都回 200 全量：续传会因缺少 206 被判非法，客户端须从头再来。
    response.writeHead(200, {'Content-Type': 'video/mp4'});
    response.end(PAYLOAD);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(path.join(tmpdir(), 'locus-bilibili-norange-'));
  try {
    const destination = path.join(root, 'video.m4s');
    await writeFile(`${destination}.part`, PAYLOAD.subarray(0, 4));
    const written = await new FetchBilibiliHttpClient().downloadToPath(
      `http://127.0.0.1:${server.address().port}/video`, destination,
      {maxBytes: 1024});
    assert.equal(written, PAYLOAD.length);
    assert.deepEqual(await readFile(destination), PAYLOAD);
    assert.deepEqual(ranges, ['bytes=4-', '']);
  } finally {
    server.closeAllConnections();
    server.close();
    await rm(root, {recursive: true, force: true});
  }
});
