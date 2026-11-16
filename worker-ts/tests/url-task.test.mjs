// URL 任务身份与清单的跨语言基准：fixture 由 scripts/tests/url-task-golden.py 从 Python
// 生产代码生成，这里逐字节 / 逐用例比对，确保 Rust 与 Python 读到的 task.json 完全相同。
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createUrlTaskContext,
  taskArtifactsForExistingFiles,
} from '../src/tasks/index.ts';
import {
  SOURCE_PRIVACY_MIGRATION_VERSION,
  TASK_SCHEMA_VERSION,
  serializeTaskManifest,
} from '../src/tasks/manifest.ts';
import {createTaskPaths} from '../src/tasks/paths.ts';
import {
  taskContextFromLoadedManifest,
  validateTaskManifest,
} from '../src/tasks/load.ts';
import {
  SourceIdentityError,
  identifySource,
  sourceIdentity,
  sourceIdentityFromManifest,
} from '../src/sources/source-identity.ts';

const golden = JSON.parse(
  await readFile(new URL('./fixtures/url-task-golden.json', import.meta.url), 'utf8'),
);
const FIXED_NOW = () => new Date('2026-11-14T12:34:56.789Z');
const FIXED_CREATED = new Date('2026-11-14T12:00:00.000Z');
const STORE = {outputRoot: '/data/outputs', cacheRoot: '/data/cache'};

function identityFromGolden(entry) {
  const value = sourceIdentityFromManifest(entry.identity);
  assert.notEqual(value, null, `${entry.label}: golden identity must be readable`);
  return value;
}

function resultFor(entry) {
  return {
    status: 'completed',
    taskId: null,
    taskDir: null,
    artifacts: {transcript_txt: 'transcript/transcript.txt'},
    text: '  视频文字稿示例  ',
    summary: '',
    insights: [],
    transcript: {source: 'asr', language: null, engine: entry.asr_model},
    dissection: null,
    error: null,
    draft: '',
  };
}

test('constant values match the manifest contract', () => {
  assert.equal(TASK_SCHEMA_VERSION, golden.constants.schema_version);
  assert.equal(SOURCE_PRIVACY_MIGRATION_VERSION, golden.constants.source_privacy_migration_version);
});

test('URL identities resolve to the same stable ids as Python', () => {
  for (const entry of golden.cases) {
    const identity = identifySource(entry.url);
    assert.deepEqual(
      {
        version: 1,
        platform: identity.platform,
        stable_id: identity.stableId,
        effective_part: identity.effectivePart,
        canonical_url: identity.canonicalUrl,
      },
      entry.identity,
      entry.label,
    );
  }
});

test('createUrlTaskContext builds the same task id and context as Python', () => {
  for (const entry of golden.cases) {
    const identity = identityFromGolden(entry);
    const created = createUrlTaskContext({
      store: STORE,
      identity,
      asrModel: entry.asr_model,
      now: FIXED_CREATED,
    });
    assert.equal(created.context.taskId, entry.task_id, entry.label);
    assert.equal(created.context.createdAt, entry.created_at, entry.label);
    assert.equal(created.context.model, entry.asr_model, entry.label);
    assert.deepEqual(created.context.source, {kind: 'url', identity}, entry.label);
    assert.equal(created.paths.taskId, entry.task_id, entry.label);
  }
});

test('URL manifests are byte-for-byte identical to Python', () => {
  for (const entry of golden.cases) {
    const identity = identityFromGolden(entry);
    const context = {
      taskId: entry.task_id,
      createdAt: entry.created_at,
      model: entry.asr_model,
      source: {kind: 'url', identity},
    };
    const bytes = serializeTaskManifest(context, resultFor(entry), {now: FIXED_NOW});
    assert.equal(Buffer.from(bytes).toString('utf8'), entry.manifest, entry.label);
  }
});

test('a URL manifest never writes source_kind but always writes the canonical url', () => {
  const manifest = JSON.parse(golden.cases[2].manifest);
  assert.equal('source_kind' in manifest, false);
  assert.equal(manifest.source_url, manifest.source_identity.canonical_url);
  assert.equal(manifest.platform, manifest.source_identity.platform);
  assert.equal(manifest.schema_version, TASK_SCHEMA_VERSION);
  assert.equal(manifest.updated_at, golden.constants.updated_at);
});

test('unsafe source identities are rejected before a task directory is created', () => {
  assert.throws(
    () => createUrlTaskContext({
      store: STORE,
      identity: sourceIdentity('youtube', 'dQw4w9WgXcQ', 'https://example.com/other'),
      asrModel: 'iic/SenseVoiceSmall-onnx',
      now: FIXED_CREATED,
    }),
    SourceIdentityError,
  );
});

test('manifest source read-back accepts and rejects exactly the Python cases', () => {
  const taskId = JSON.parse(golden.cases[2].manifest).task_id;
  for (const entry of golden.readback) {
    let accepted = true;
    try {
      validateTaskManifest(entry.manifest, taskId);
    } catch {
      accepted = false;
    }
    assert.equal(accepted, entry.accept, entry.label);
  }
});

test('a URL manifest reopens as a URL task context', () => {
  const manifest = JSON.parse(golden.cases[2].manifest);
  const validated = validateTaskManifest(manifest, manifest.task_id);
  const {context} = taskContextFromLoadedManifest(STORE, manifest.task_id, validated);
  assert.equal(context.source.kind, 'url');
  assert.equal(context.source.identity.stableId, manifest.source_identity.stable_id);
  assert.equal(context.source.identity.effectivePart, manifest.source_identity.effective_part);
  assert.equal(context.model, manifest.model);
});

test('URL tasks use the default video artifact path, not a local source extension', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'locus-url-task-'));
  const paths = createTaskPaths({
    outputRoot: path.join(root, 'outputs'),
    cacheRoot: path.join(root, 'cache'),
    taskId: golden.cases[0].task_id,
  });
  mkdirSync(paths.mediaDir, {recursive: true});
  writeFileSync(path.join(paths.mediaDir, 'video.mp4'), 'video');
  const source = {kind: 'url', identity: identityFromGolden(golden.cases[0])};
  return taskArtifactsForExistingFiles(paths, source).then((artifacts) => {
    assert.deepEqual(artifacts, {video: 'media/video.mp4'});
  });
});
