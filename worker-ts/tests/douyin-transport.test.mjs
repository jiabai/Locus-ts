// 传输层冒烟：用本机 HTTP 服务验证 `FetchDouyinHttpClient` 的真实行为
// （重定向后的最终 URL、Cookie 记忆、Range 续传、流式落盘），不触公网。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {downloadDouyinVideo} from '../src/sources/douyin/fallback.ts';
import {FetchDouyinHttpClient} from '../src/sources/douyin/transport.ts';

const AWEME_ID = '7524373044106677544';
const PAYLOAD = Buffer.from('0123456789');

function sharePageHtml(mediaUrl) {
  return `<html><script>window._ROUTER_DATA = ${JSON.stringify({
    loaderData: {
      'video_(id)/page': {
        videoInfoRes: {
          item_list: [{
            aweme_id: AWEME_ID,
            video: {bit_rate: [{
              gear_name: '1080p',
              data_size: PAYLOAD.length,
              play_addr: {url_list: [mediaUrl]},
            }]},
          }],
        },
      },
    },
  })};</script></html>`;
}

async function startServer() {
  const seen = {cookies: [], ranges: []};
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/share/video/')) {
      response.writeHead(200, {
        'Content-Type': 'text/html',
        'Set-Cookie': 'ttwid=abc123; Path=/; HttpOnly',
      });
      response.end(sharePageHtml(`http://127.0.0.1:${server.address().port}/media.mp4`));
      return;
    }
    if (url.pathname === '/media.mp4') {
      seen.cookies.push(request.headers.cookie ?? '');
      const range = request.headers.range ?? '';
      seen.ranges.push(range);
      if (range === '') {
        response.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': String(PAYLOAD.length),
        });
        response.end(PAYLOAD);
        return;
      }
      const start = Number.parseInt(range.replace(/bytes=(\d+)-/u, '$1'), 10);
      const slice = PAYLOAD.subarray(start);
      response.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Content-Range': `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}`,
      });
      response.end(slice);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {server, seen, port: server.address().port};
}

/** 把分享页域名改写成本机服务，其余行为与生产客户端一致。 */
class LocalShareClient extends FetchDouyinHttpClient {
  #port;

  constructor(port) {
    super();
    this.#port = port;
  }

  get(url, headers, timeoutSeconds) {
    return super.get(url.replace('https://www.iesdouyin.com', `http://127.0.0.1:${this.#port}`),
      headers, timeoutSeconds);
  }
}

test('downloadDouyinVideo streams through a local server and remembers cookies', async () => {
  const {server, seen, port} = await startServer();
  const root = await mkdtemp(path.join(tmpdir(), 'locus-douyin-http-'));
  try {
    const outputPath = await downloadDouyinVideo(`https://www.douyin.com/video/${AWEME_ID}`,
      root, {httpClient: new LocalShareClient(port)});
    assert.equal(path.basename(outputPath), `${AWEME_ID}.mp4`);
    assert.deepEqual(await readFile(outputPath), PAYLOAD);
    // 分享页种下的 Cookie 必须带到媒体请求上。
    assert.ok(seen.cookies.length >= 1);
    assert.equal(seen.cookies.at(-1), 'ttwid=abc123');
    assert.equal(seen.ranges.at(-1), '');
  } finally {
    server.closeAllConnections();
    server.close();
    await rm(root, {recursive: true, force: true});
  }
});

test('downloadToPath resumes from an existing part file with a range request', async () => {
  const {server, seen} = await startServer();
  const root = await mkdtemp(path.join(tmpdir(), 'locus-douyin-range-'));
  try {
    const destination = path.join(root, 'video.mp4');
    await writeFile(`${destination}.part`, PAYLOAD.subarray(0, 4));
    const written = await new FetchDouyinHttpClient().downloadToPath(
      `http://127.0.0.1:${server.address().port}/media.mp4`,
      destination,
      {resumeFromBytes: 4, totalBytes: PAYLOAD.length},
    );
    assert.equal(written, PAYLOAD.length);
    assert.deepEqual(await readFile(destination), PAYLOAD);
    assert.equal(seen.ranges.at(-1), 'bytes=4-');
  } finally {
    server.close();
    await rm(root, {recursive: true, force: true});
  }
});

test('a stalled stream keeps the partial file and reports DOWNLOAD_STALLED', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, {'Content-Type': 'video/mp4', 'Content-Length': '10'});
    response.write('0123');
    // 之后不再发送任何字节，等客户端看门狗掐断。
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(path.join(tmpdir(), 'locus-douyin-stall-'));
  try {
    const destination = path.join(root, 'video.mp4');
    await assert.rejects(
      new FetchDouyinHttpClient().downloadToPath(
        `http://127.0.0.1:${server.address().port}/media.mp4`,
        destination,
        {noProgressTimeoutSeconds: 0.2, timeoutSeconds: 0.2},
      ),
      (error) => {
        assert.equal(error.code, 'DOWNLOAD_STALLED');
        return true;
      },
    );
    assert.deepEqual(await readFile(`${destination}.part`), Buffer.from('0123'));
  } finally {
    server.closeAllConnections();
    server.close();
    await rm(root, {recursive: true, force: true});
  }
});
