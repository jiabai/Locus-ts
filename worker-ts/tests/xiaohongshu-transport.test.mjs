// 传输层冒烟：仅用本机 HTTP 服务，验证 Cookie 透传、Range 续传、
// 服务端忽略续传时的重下、字幕主机白名单与停滞判定；不触公网。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {gzipSync} from 'node:zlib';

import {SafeDownloadError, header} from '../src/download-reliability.ts';
import {decodeResponseBody} from '../src/sources/xiaohongshu/page.ts';
import {
  FetchXiaohongshuHttpClient,
  downloadSubtitleToPath,
  mediaHeaders,
  pageHeaders,
} from '../src/sources/xiaohongshu/transport.ts';

const PAYLOAD = Buffer.from('0123456789');

async function startServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address();
  return {server, port, base: `http://127.0.0.1:${port}`};
}

test('page get remembers cookies for later media requests', async () => {
  const seen = [];
  const {server, base} = await startServer((request, response) => {
    seen.push({url: request.url, cookie: request.headers.cookie ?? '', range: request.headers.range ?? ''});
    if (request.url === '/explore/note') {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': 'a1=abc123; Path=/; HttpOnly',
      });
      response.end('<html>note</html>');
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': String(PAYLOAD.length),
    });
    response.end(PAYLOAD);
  });
  const root = await mkdtemp(path.join(tmpdir(), 'locus-xhs-http-'));
  try {
    const client = new FetchXiaohongshuHttpClient();
    const page = await client.get(`${base}/explore/note`, pageHeaders());
    assert.equal(page.status, 200);
    assert.equal(Buffer.from(page.body).toString('utf8'), '<html>note</html>');

    const destination = path.join(root, 'note.mp4');
    const written = await client.downloadToPath(`${base}/media/note.mp4`, destination, {
      headers: mediaHeaders(),
    });
    assert.equal(written, PAYLOAD.length);
    assert.deepEqual(await readFile(destination), PAYLOAD);
    assert.equal(seen.at(-1).cookie, 'a1=abc123');
    assert.equal(seen.at(-1).range, '');
  } finally {
    server.closeAllConnections();
    server.close();
    await rm(root, {recursive: true, force: true});
  }
});

test('a gzip page is decoded once and loses its encoding header', async () => {
  // 真实公网回归：fetch 已解压正文，客户端记录响应头时去掉 Content-Encoding，
  // 否则页面解析会拿头再解一次并报 XHS_PAGE_UNAVAILABLE。
  const html = Buffer.from('<html><script>window.__INITIAL_STATE__={"note":{}}</script></html>');
  const {server, base} = await startServer((request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Encoding': 'gzip',
    });
    response.end(gzipSync(html));
  });
  try {
    const client = new FetchXiaohongshuHttpClient();
    const page = await client.get(`${base}/explore/note`, pageHeaders());
    assert.equal(header(page.headers, 'Content-Encoding'), null);
    assert.deepEqual(Buffer.from(page.body), html);
    assert.equal(decodeResponseBody(page), html.toString('utf8'));
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('resume sends Range and accepts a matching 206', async () => {
  const ranges = [];
  const {server, base} = await startServer((request, response) => {
    ranges.push(request.headers.range ?? '');
    const range = request.headers.range ?? '';
    if (range === 'bytes=4-') {
      response.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Content-Range': `bytes 4-${PAYLOAD.length - 1}/${PAYLOAD.length}`,
      });
      response.end(PAYLOAD.subarray(4));
      return;
    }
    response.writeHead(200, {'Content-Type': 'video/mp4'});
    response.end(PAYLOAD);
  });
  const root = await mkdtemp(path.join(tmpdir(), 'locus-xhs-resume-'));
  try {
    const destination = path.join(root, 'note.mp4');
    await writeFile(`${destination}.part`, PAYLOAD.subarray(0, 4));
    const client = new FetchXiaohongshuHttpClient();
    const written = await client.downloadToPath(`${base}/media/note.mp4`, destination, {
      headers: mediaHeaders(),
    });
    assert.equal(written, PAYLOAD.length);
    assert.deepEqual(await readFile(destination), PAYLOAD);
    assert.deepEqual(ranges, ['bytes=4-']);
  } finally {
    server.closeAllConnections();
    server.close();
    await rm(root, {recursive: true, force: true});
  }
});

test('ignored Range triggers one clean redownload', async () => {
  const ranges = [];
  const {server, base} = await startServer((request, response) => {
    ranges.push(request.headers.range ?? '');
    // 服务端不认续传：即使带了 Range 也回 200 全量。
    response.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': String(PAYLOAD.length),
    });
    response.end(PAYLOAD);
  });
  const root = await mkdtemp(path.join(tmpdir(), 'locus-xhs-range-'));
  try {
    const destination = path.join(root, 'note.mp4');
    await writeFile(`${destination}.part`, PAYLOAD.subarray(0, 4));
    const client = new FetchXiaohongshuHttpClient();
    const written = await client.downloadToPath(`${base}/media/note.mp4`, destination, {
      headers: mediaHeaders(),
    });
    assert.equal(written, PAYLOAD.length);
    assert.deepEqual(await readFile(destination), PAYLOAD);
    // 第一次带 Range 被无视（错误被吞掉），第二次不带 Range 重下。
    assert.deepEqual(ranges, ['bytes=4-', '']);
  } finally {
    server.closeAllConnections();
    server.close();
    await rm(root, {recursive: true, force: true});
  }
});

test('subtitle download rejects hosts outside the allowlist', async () => {
  let requests = 0;
  const {server, base} = await startServer((request, response) => {
    requests += 1;
    response.writeHead(200, {'Content-Type': 'application/x-subrip'});
    response.end('1\n');
  });
  const root = await mkdtemp(path.join(tmpdir(), 'locus-xhs-host-'));
  try {
    const client = new FetchXiaohongshuHttpClient();
    await assert.rejects(
      downloadSubtitleToPath(`${base}/sub.srt`, path.join(root, 'sub.srt'), client),
      (error) => {
        assert.ok(error instanceof SafeDownloadError);
        assert.equal(error.code, 'DOWNLOAD_URL_INVALID');
        return true;
      },
    );
    assert.equal(requests, 0);
  } finally {
    server.closeAllConnections();
    server.close();
    await rm(root, {recursive: true, force: true});
  }
});

test('stalled stream keeps the partial file for the next attempt', async () => {
  const {server, base} = await startServer((request, response) => {
    response.writeHead(200, {'Content-Type': 'video/mp4', 'Content-Length': '100'});
    response.write('partial');
    // 不结束响应：客户端应在无进展超时后按停滞失败。
  });
  const root = await mkdtemp(path.join(tmpdir(), 'locus-xhs-stall-'));
  try {
    const destination = path.join(root, 'note.mp4');
    const client = new FetchXiaohongshuHttpClient();
    await assert.rejects(
      client.downloadToPath(`${base}/media/note.mp4`, destination, {
        headers: mediaHeaders(),
        noProgressTimeoutSeconds: 0.2,
      }),
      (error) => {
        assert.ok(error instanceof SafeDownloadError, String(error));
        assert.equal(error.code, 'DOWNLOAD_STALLED');
        return true;
      },
    );
    assert.equal((await stat(`${destination}.part`)).size, 'partial'.length);
  } finally {
    server.closeAllConnections();
    server.close();
    await rm(root, {recursive: true, force: true});
  }
});
