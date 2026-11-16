import assert from 'node:assert/strict';
import {mkdtemp, readFile, utimes, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {
  PREFERRED_SUBTITLE_LANGUAGES,
  SUPPORTED_SUBTITLE_SUFFIXES,
  findSubtitleTranscript,
  parseSubtitleContent,
} from '../src/media/subtitles.ts';
import {
  VIDEO_SUFFIXES,
  findLatestVideo,
  findNewOrUpdatedVideo,
  findVideoByStem,
  findVideoFromDownloadStdout,
  snapshotVideoFiles,
} from '../src/media/download-output.ts';
import {toPosixPath} from '../src/tasks/paths.ts';

const golden = JSON.parse(
  await readFile(new URL('./fixtures/downloader-files-golden.json', import.meta.url), 'utf8'),
);

function toExpected(transcript) {
  if (transcript === null) return null;
  return {
    text: transcript.text,
    language: transcript.language,
    segments: transcript.segments.map((segment) => ({
      id: segment.id,
      start_ms: segment.startMs,
      end_ms: segment.endMs,
      text: segment.text,
    })),
  };
}

async function withTempDirectory(entries, run) {
  const root = await mkdtemp(join(tmpdir(), 'locus-downloader-files-'));
  for (const entry of entries) {
    const target = join(root, entry.name);
    const body = entry.content === undefined
      ? Buffer.alloc(entry.size, 0x78)
      : Buffer.from(entry.content, 'utf8');
    await writeFile(target, body);
    if (entry.mtime_seconds !== undefined) {
      await utimes(target, entry.mtime_seconds, entry.mtime_seconds);
    }
  }
  return await run(root);
}

test('subtitle constants match python', () => {
  assert.deepEqual([...PREFERRED_SUBTITLE_LANGUAGES], golden.subtitle_constants.preferred_languages);
  assert.deepEqual([...SUPPORTED_SUBTITLE_SUFFIXES], golden.subtitle_constants.supported_suffixes);
  assert.deepEqual([...VIDEO_SUFFIXES].sort(), golden.subtitle_constants.video_suffixes);
});

test('subtitle parsing matches python across languages, tags and timestamps', async () => {
  for (const entry of golden.subtitles) {
    const files = Object.entries(entry.files).map(([name, content]) => ({name, content}));
    const result = await withTempDirectory(files, (root) => findSubtitleTranscript(root));
    assert.deepEqual(toExpected(result), entry.result, entry.label);
  }
});

test('parseSubtitleContent exposes the same rule without a filesystem', () => {
  const transcript = parseSubtitleContent(
    '1\n00:00:01,000 --> 00:00:02,000\n<b>Hello &amp; world</b>\n',
    'en',
  );
  assert.deepEqual(toExpected(transcript), {
    text: 'Hello & world',
    language: 'en',
    segments: [{id: 'subtitle-1', start_ms: 1000, end_ms: 2000, text: 'Hello & world'}],
  });
  assert.equal(parseSubtitleContent('no timestamps', 'en'), null);
});

test('video file selection matches python across mtime, stem, stdout and snapshots', async () => {
  for (const entry of golden.video_files) {
    const result = await withTempDirectory(entry.files, async (root) => {
      const snapshot = new Map(
        Object.entries(entry.previous).map(([name, values]) => [
          toPosixPath(join(root, name)),
          [BigInt(values[0]) * 1_000_000_000n, BigInt(values[1])],
        ]),
      );
      const stdout = entry.stdout.replaceAll('<ROOT>', toPosixPath(root));
      const selected = async (filePath) => filePath === null ? null : filePath.split(/[\\/]/u).pop();
      return {
        latest: await selected(await findLatestVideo(root)),
        by_stem: await selected(await findVideoByStem(root, entry.stem || null)),
        from_stdout: await selected(await findVideoFromDownloadStdout(stdout, root)),
        new_or_updated: await selected(await findNewOrUpdatedVideo(root, snapshot)),
        snapshot_entries: (await snapshotVideoFiles(root)).size,
      };
    });
    assert.deepEqual(result, entry.result, entry.label);
  }
});

test('missing download directory yields empty selections', async () => {
  const missing = join(tmpdir(), 'locus-downloader-missing-dir-20261115');
  assert.equal(await findLatestVideo(missing), null);
  assert.equal(await findVideoByStem(missing, 'x'), null);
  assert.equal((await snapshotVideoFiles(missing)).size, 0);
  assert.equal(await findVideoFromDownloadStdout('a.mp4\n', missing), null);
});
