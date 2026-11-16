// URL 任务身份与清单的跨语言静态守卫。
// 基准由 scripts/tests/url-task-golden.py 从 Python 生产代码生成；这里把「哪一段源码
// 决定任务 id / 来源字段 / 读回规则」钉住，防止改写时只看 fixture 不看事实来源。
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, '..', '..');
const pythonRoot = resolve(repositoryRoot, 'worker', 'worker_core');
const workerRoot = resolve(repositoryRoot, 'worker-ts');

async function read(...parts) {
  return readFile(join(...parts), 'utf8');
}

test('task id template and source slug truncation stay aligned', async () => {
  const python = await read(pythonRoot, 'task_store.py');
  const typescript = await read(workerRoot, 'src', 'tasks', 'index.ts');

  assert.ok(python.includes('f"{timestamp}-{platform}-{source_slug}"'));
  assert.ok(python.includes('f"-p{source_identity.effective_part}"'));
  assert.ok(python.includes('source_identity.stable_id[: 80 - len(part_suffix)]'));
  assert.ok(python.includes('canonical_url_for_persistence(source_identity)'));
  assert.ok(typescript.includes('`${datePart}-${timePart}-${options.identity.platform}-${sourceSlug}`'));
  assert.ok(typescript.includes('80 - partSuffix.length'));
  assert.ok(typescript.includes('canonicalUrlForPersistence(options.identity)'));
});

test('URL manifest fields omit source_kind and persist the canonical url', async () => {
  const python = await read(pythonRoot, 'task_store.py');
  const manifest = await read(workerRoot, 'src', 'tasks', 'manifest.ts');
  const types = await read(workerRoot, 'src', 'tasks', 'types.ts');

  assert.ok(python.includes('canonical_url = canonical_url_for_persistence(source.identity)'));
  assert.ok(python.includes('"source_identity": source.identity.to_manifest_dict()'));
  assert.ok(python.includes('"platform": source.identity.platform'));
  assert.ok(manifest.includes('canonicalUrlForPersistence(source.identity)'));
  assert.ok(manifest.includes('sourceIdentityToManifestDict(source.identity)'));
  // Python 的 URL 分支不写 source_kind；TS 的 urlManifestSourceFields 也不能写。
  const urlBranch = manifest.slice(manifest.indexOf('function urlManifestSourceFields'));
  const urlBody = urlBranch.slice(0, urlBranch.indexOf('\n}'));
  assert.ok(!urlBody.includes('source_kind'), 'URL 清单不得写出 source_kind');
  assert.ok(types.includes("readonly kind: 'url'"));
  assert.ok(types.includes('readonly source: TaskSource'));
});

test('manifest reader validates URL identity instead of refusing URL tasks', async () => {
  const python = await read(pythonRoot, 'task_store.py');
  const load = await read(workerRoot, 'src', 'tasks', 'load.ts');

  assert.ok(python.includes('if source_kind in {None, "url"}'));
  assert.ok(python.includes('manifest.get("source_url") != source_identity.canonical_url'));
  assert.ok(load.includes("kind === 'url'"));
  assert.ok(load.includes('sourceIdentityFromManifest(manifest.source_identity)'));
  assert.ok(load.includes("manifest.source_url !== identity.canonicalUrl"));
  assert.ok(!load.includes('URL 任务在这里明确拒止'), '旧注释必须随实现一起删掉');
});

test('golden is generated from Python production code and consumed by TS tests', async () => {
  const generator = await read(repositoryRoot, 'scripts', 'tests', 'url-task-golden.py');
  const unit = await read(workerRoot, 'tests', 'url-task.test.mjs');
  const fixture = await read(workerRoot, 'tests', 'fixtures', 'url-task-golden.json');

  assert.ok(generator.includes('task_store.create_task_context'));
  assert.ok(generator.includes('task_store.serialize_task_manifest'));
  assert.ok(generator.includes('task_store._task_source_from_manifest'));
  assert.ok(unit.includes('fixtures/url-task-golden.json'));
  assert.ok(unit.includes('assert.equal(Buffer.from(bytes).toString(\'utf8\'), entry.manifest'));
  const parsed = JSON.parse(fixture);
  assert.ok(parsed.cases.length >= 5);
  assert.ok(parsed.readback.some((entry) => entry.accept));
  assert.ok(parsed.readback.some((entry) => !entry.accept));
});

test('the CLI is registered now that the URL media preparation exists', async () => {
  const pythonCli = await read(pythonRoot, 'cli.py');
  const typescriptCli = await read(workerRoot, 'src', 'cli.ts');
  const urlMedia = await read(workerRoot, 'src', 'media', 'url-media.ts');
  assert.ok(pythonCli.includes('"--request-stdin"'));
  assert.ok(typescriptCli.includes("'--request-stdin'"));
  assert.ok(urlMedia.includes('subtitle.detect.running'));
  assert.ok(urlMedia.includes('prepareUrlMedia'));
});
