// 跨语言基准：`worker-ts/src/download-reliability.ts` 必须与 Python 的
// `download_reliability.py` 在同样的响应、分块与时钟输入下给出同样的结果。
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  SafeDownloadError,
  writeHttpResponseAtomically,
  writeHttpStreamAtomically,
} from '../src/download-reliability.ts';

const golden = JSON.parse(await readFile(
  new URL('./fixtures/download-reliability-golden.json', import.meta.url), 'utf8',
));

function makeRoot() {
  return mkdtemp(path.join(tmpdir(), 'locus-reliability-'));
}

async function readOrNull(target) {
  try {
    return await readFile(target);
  } catch {
    return null;
  }
}

async function runCase(entry) {
  const root = await makeRoot();
  try {
    const destination = path.join(root, 'video.mp4');
    const partPath = `${destination}.part`;
    if (entry.destination_preexisting !== null) {
      await writeFile(destination, entry.destination_preexisting, 'latin1');
    }
    if (entry.part_preexisting !== null) {
      await writeFile(partPath, entry.part_preexisting, 'latin1');
    }
    const response = {
      status: entry.response.status,
      headers: entry.response.headers,
      body: Buffer.from(entry.response.body, 'latin1'),
      url: 'https://cdn.example/video.mp4',
    };
    let outcome;
    try {
      let written;
      if (entry.kind === 'response') {
        written = await writeHttpResponseAtomically(response, destination, {
          maxBytes: entry.options?.max_bytes ?? null,
        });
      } else {
        const ticks = entry.options?.ticks ?? null;
        let tickIndex = 0;
        written = await writeHttpStreamAtomically(
          response,
          (entry.chunks ?? []).map((chunk) => Buffer.from(chunk, 'latin1')),
          destination,
          {
            ...(entry.options?.max_bytes === null || entry.options?.max_bytes === undefined
              ? {}
              : {maxBytes: entry.options.max_bytes}),
            ...(entry.options?.no_progress_timeout_seconds === null
              || entry.options?.no_progress_timeout_seconds === undefined
              ? {}
              : {noProgressTimeoutSeconds: entry.options.no_progress_timeout_seconds}),
            ...(entry.options?.resume_from_bytes === null
              || entry.options?.resume_from_bytes === undefined
              ? {}
              : {resumeFromBytes: entry.options.resume_from_bytes}),
            ...(ticks === null ? {} : {monotonic: () => ticks[tickIndex++]}),
          },
        );
      }
      outcome = {written};
    } catch (error) {
      assert.ok(error instanceof SafeDownloadError, `${entry.label}: ${error}`);
      outcome = {error: {code: error.code, message: error.message}};
    }
    const destinationBytes = await readOrNull(destination);
    const partBytes = await readOrNull(partPath);
    return {
      outcome,
      files: {
        destination: destinationBytes === null ? null : destinationBytes.toString('latin1'),
        part: partBytes === null ? null : partBytes.toString('latin1'),
      },
    };
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}

test('response cases match the python golden', async () => {
  for (const entry of golden.response_cases) {
    assert.deepEqual(await runCase(entry), entry.expected, entry.label);
  }
});

test('stream cases match the python golden', async () => {
  for (const entry of golden.stream_cases) {
    assert.deepEqual(await runCase(entry), entry.expected, entry.label);
  }
});

test('resume error codes are the resumable ones', () => {
  assert.deepEqual([...golden.resumable_codes].sort(), ['DOWNLOAD_INCOMPLETE', 'DOWNLOAD_STALLED']);
});

test('a missing destination parent directory is created', async () => {
  const root = await makeRoot();
  try {
    const destination = path.join(root, 'nested', 'deeper', 'video.mp4');
    const written = await writeHttpResponseAtomically({
      status: 200,
      headers: {'Content-Type': 'video/mp4'},
      body: Buffer.from('abc'),
      url: 'https://cdn.example/video.mp4',
    }, destination);
    assert.equal(written, 3);
    assert.equal((await stat(destination)).size, 3);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
