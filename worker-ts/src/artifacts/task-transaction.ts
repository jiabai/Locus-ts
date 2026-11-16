// 任务产物的多文件事务：一次提交要么整体生效，要么整体回滚。
//
// 对齐 `worker/worker_core/task_transaction.py` 与 `contracts/task-artifact-transaction-v1.json`：
// 目标路径是闭集，journal 的字段、状态、内部文件名与提交顺序都按契约逐项校验。
// 三份实现（Python worker、TypeScript worker、Rust 宿主）会互读同一个 journal，
// 任何一处放宽都会让另外两份把不可信状态当成已提交。
//
// journal 落盘即提交点：`state=prepared` 表示可能只替换了一部分，恢复必须回滚；
// `state=committed` 表示产物已全部替换，恢复只需清理材料。
import {randomUUID} from 'node:crypto';
import {lstat, mkdir, readFile, readdir} from 'node:fs/promises';
import path from 'node:path';

import {
  AtomicFileCommitError,
  atomicRemoveFile,
  atomicWriteBytes,
  atomicWriteJson,
  installStagedFile,
  validateOptionalRegularFile,
  writeSyncedNewFile,
} from './atomic-file.ts';

export const JOURNAL_FILE_NAME = '.artifact-transaction.json';
export const SCHEMA_VERSION = 1;
const MANIFEST_DESTINATION = 'task.json';
const MAX_ENTRIES = 8;
const MAX_JOURNAL_BYTES = 64 * 1024;

const TRANSACTION_ID_PATTERN = /^[0-9a-f]{32}$/;
const ORPHAN_NAME_PATTERN = /^\.artifact-[0-9a-f]{32}-[0-7]\.(?:staging|rollback)$/;
const JOURNAL_STAGING_NAME_PATTERN = /^\.artifact-transaction\.[0-9a-f]{32}\.part\.json$/;

/** 闭集：每个产物目标与任务清单里的键一一对应。契约文件是唯一参照。 */
export const ARTIFACT_KEY_BY_RELATIVE_PATH: Readonly<Record<string, string>> = {
  'transcript/transcript.txt': 'transcript_txt',
  'transcript/transcript.md': 'transcript_md',
  'transcript/segments.json': 'segments',
  'article/article.txt': 'article_txt',
  'article/article.md': 'article_md',
  'ai/summary.md': 'summary',
  'ai/mindmap.mmd': 'mindmap',
  'ai/insights.json': 'insights',
  'ai/insights.md': 'insights_md',
  'ai/dissection.json': 'dissection',
  'ai/dissection.md': 'dissection_md',
  'ai/draft.md': 'draft',
};

const NON_ARTIFACT_DESTINATIONS = [
  MANIFEST_DESTINATION,
  'transcript/original/transcript.txt',
  'transcript/original/transcript.md',
  'ai/original/draft.md',
];

export const ALLOWED_DESTINATIONS: readonly string[] = [
  ...Object.keys(ARTIFACT_KEY_BY_RELATIVE_PATH),
  ...NON_ARTIFACT_DESTINATIONS,
];

const ALLOWED_DESTINATION_SET = new Set(ALLOWED_DESTINATIONS);

/** 可能承载事务内部文件的目录（去重、稳定排序，与契约的 `internalParents` 一致）。 */
export const INTERNAL_PARENTS: readonly string[] = [...new Set([
  '.',
  ...ALLOWED_DESTINATIONS.map((destination) => posixDirname(destination)),
])].sort();

export class TaskArtifactCommitError extends Error {
  readonly code = 'TASK_ARTIFACT_COMMIT_FAILED';

  constructor() {
    super('Task artifacts could not be stored safely.');
    this.name = 'TaskArtifactCommitError';
  }
}

export class TaskArtifactRecoveryError extends Error {
  readonly code = 'TASK_ARTIFACT_RECOVERY_FAILED';

  constructor() {
    super('Task artifacts could not be recovered safely.');
    this.name = 'TaskArtifactRecoveryError';
  }
}

export type RecoveryOutcome = 'none' | 'rolled_back' | 'committed_cleaned';

export interface TransactionEntry {
  readonly destination: string;
  readonly staging: string | null;
  readonly rollback: string | null;
  readonly existedBefore: boolean;
}

export interface TransactionJournal {
  readonly transactionId: string;
  readonly state: 'prepared' | 'committed';
  readonly entries: readonly TransactionEntry[];
}

export interface CommitOptions {
  /**
   * 故障注入点，只给测试用：抛错即模拟进程被杀，提交不做任何收尾。
   * 事件名与 Python 侧一致（`after_journal_prepared`、`after_replace:<destination>`、
   * `after_journal_committed`）。
   */
  readonly onFault?: (event: string) => void;
}

class InvalidTransactionError extends Error {
  constructor() {
    super('invalid transaction');
    this.name = 'InvalidTransactionError';
  }
}

function invalid(): InvalidTransactionError {
  return new InvalidTransactionError();
}

/** 提交一次任务产物修订，先恢复上一次未完成的 journal。 */
export async function commitTaskArtifacts(
  taskDir: string,
  mutations: Readonly<Record<string, Uint8Array | null>>,
  options: CommitOptions = {},
): Promise<void> {
  let faulted = false;
  const emitFault = (event: string): void => {
    if (options.onFault === undefined) return;
    try {
      options.onFault(event);
    } catch (error) {
      // 模拟掉电：保留现场，让下一次恢复去决定是回滚还是清理。
      faulted = true;
      throw error;
    }
  };

  let orderedMutations: [string, Uint8Array | null][];
  try {
    await validateTaskDir(taskDir);
    await recoverTaskArtifacts(taskDir);
    orderedMutations = await validateMutations(taskDir, mutations);
  } catch (error) {
    if (error instanceof TaskArtifactRecoveryError) throw error;
    if (faulted) throw error;
    throw new TaskArtifactCommitError();
  }

  const transactionId = randomUUID().replaceAll('-', '');
  const entries: TransactionEntry[] = [];
  for (const [index, [destination, content]] of orderedMutations.entries()) {
    const existedBefore = await pathExists(destinationPathFor(taskDir, destination));
    entries.push({
      destination,
      staging: content === null
        ? null
        : internalRelativePath(destination, transactionId, index, 'staging'),
      rollback: existedBefore
        ? internalRelativePath(destination, transactionId, index, 'rollback')
        : null,
      existedBefore,
    });
  }
  const materialPaths = entries.flatMap((entry) =>
    [entry.staging, entry.rollback]
      .filter((relative): relative is string => relative !== null)
      .map((relative) => taskDirPath(taskDir, relative)));

  let journalInstalled = false;
  try {
    await prepareMaterials(taskDir, entries, orderedMutations);
    await atomicWriteJson(taskDirPath(taskDir, JOURNAL_FILE_NAME), journalPayload({
      transactionId,
      state: 'prepared',
      entries,
    }));
    journalInstalled = true;
    emitFault('after_journal_prepared');

    for (const entry of entries) {
      const destination = destinationPathFor(taskDir, entry.destination);
      if (entry.staging === null) {
        await atomicRemoveFile(destination);
      } else {
        await installStagedFile(taskDirPath(taskDir, entry.staging), destination);
      }
      emitFault(`after_replace:${entry.destination}`);
    }

    await atomicWriteJson(taskDirPath(taskDir, JOURNAL_FILE_NAME), journalPayload({
      transactionId,
      state: 'committed',
      entries,
    }));
    emitFault('after_journal_committed');
  } catch (error) {
    if (faulted) throw error;
    if (journalInstalled) {
      try {
        await recoverTaskArtifacts(taskDir);
      } catch {
        throw new TaskArtifactRecoveryError();
      }
      throw new TaskArtifactCommitError();
    }
    await cleanupPathsBestEffort(materialPaths);
    throw new TaskArtifactCommitError();
  }

  await removeJournalThenCleanup(taskDir, materialPaths, {required: false});
}

/** 在信任产物之前，先把上次留下的 journal 解决掉。 */
export async function recoverTaskArtifacts(taskDir: string): Promise<RecoveryOutcome> {
  try {
    await validateTaskDir(taskDir);
    const journalPath = taskDirPath(taskDir, JOURNAL_FILE_NAME);
    if (!(await pathExists(journalPath))) {
      await cleanupClosedOrphansBestEffort(taskDir);
      return 'none';
    }
    await validateRegularPath(journalPath);
    const raw = await readFile(journalPath);
    if (raw.byteLength > MAX_JOURNAL_BYTES) throw invalid();
    const journal = parseTransactionJournal(JSON.parse(raw.toString('utf8')) as unknown);
    await validateRecoveryPaths(taskDir, journal);

    if (journal.state === 'prepared') {
      // 先把所有回滚材料读齐：缺一份就整体拒绝，绝不「恢复一半」。
      const rollbacks = await loadAllRollbacks(taskDir, journal.entries);
      for (const entry of journal.entries) {
        const destination = destinationPathFor(taskDir, entry.destination);
        if (entry.existedBefore) {
          await atomicWriteBytes(destination, rollbacks.get(entry.destination) as Uint8Array);
        } else {
          await atomicRemoveFile(destination);
        }
      }
      await removeJournalThenCleanup(taskDir, materialPaths(taskDir, journal.entries), {
        required: true,
      });
      return 'rolled_back';
    }

    await removeJournalThenCleanup(taskDir, materialPaths(taskDir, journal.entries), {
      required: true,
    });
    return 'committed_cleaned';
  } catch (error) {
    if (error instanceof TaskArtifactRecoveryError) throw error;
    throw new TaskArtifactRecoveryError();
  }
}

/**
 * 严格解析 journal。契约里的 `validFixtures` / `invalidFixtures` 直接对这份实现断言，
 * 所以这里不接受任何「多一个字段应该没事」的宽容。
 */
export function parseTransactionJournal(payload: unknown): TransactionJournal {
  if (!isPlainObject(payload)) throw invalid();
  const keys = Object.keys(payload).sort();
  if (keys.join(',') !== ['entries', 'schema_version', 'state', 'transaction_id'].sort().join(',')) {
    throw invalid();
  }
  if (payload.schema_version !== SCHEMA_VERSION) throw invalid();
  const transactionId = payload.transaction_id;
  if (typeof transactionId !== 'string' || !TRANSACTION_ID_PATTERN.test(transactionId)) {
    throw invalid();
  }
  const state = payload.state;
  if (state !== 'prepared' && state !== 'committed') throw invalid();
  const rawEntries = payload.entries;
  if (!Array.isArray(rawEntries) || rawEntries.length < 1 || rawEntries.length > MAX_ENTRIES) {
    throw invalid();
  }

  const entries: TransactionEntry[] = [];
  const destinations = new Set<string>();
  rawEntries.forEach((rawEntry, index) => {
    const entry = parseEntry(rawEntry, transactionId, index);
    if (destinations.has(entry.destination)) throw invalid();
    destinations.add(entry.destination);
    entries.push(entry);
  });
  if (destinations.has(MANIFEST_DESTINATION)
    && entries[entries.length - 1]?.destination !== MANIFEST_DESTINATION) {
    throw invalid();
  }
  return {transactionId, state, entries};
}

function parseEntry(rawEntry: unknown, transactionId: string, index: number): TransactionEntry {
  if (!isPlainObject(rawEntry)) throw invalid();
  const keys = Object.keys(rawEntry).sort().join(',');
  if (keys !== ['destination', 'existed_before', 'rollback', 'staging'].sort().join(',')) {
    throw invalid();
  }
  const {destination, staging, rollback, existed_before: existedBefore} = rawEntry;
  if (typeof destination !== 'string' || !ALLOWED_DESTINATION_SET.has(destination)) {
    throw invalid();
  }
  if (staging !== null && typeof staging !== 'string') throw invalid();
  if (rollback !== null && typeof rollback !== 'string') throw invalid();
  if (typeof existedBefore !== 'boolean') throw invalid();

  const expectedStaging = internalRelativePath(destination, transactionId, index, 'staging');
  const expectedRollback = internalRelativePath(destination, transactionId, index, 'rollback');
  if (staging !== null && staging !== expectedStaging) throw invalid();
  if (existedBefore && rollback !== expectedRollback) throw invalid();
  if (!existedBefore && rollback !== null) throw invalid();

  return {destination, staging, rollback, existedBefore};
}

async function validateMutations(
  taskDir: string,
  mutations: Readonly<Record<string, Uint8Array | null>>,
): Promise<[string, Uint8Array | null][]> {
  const destinations = Object.keys(mutations);
  if (destinations.length < 1 || destinations.length > MAX_ENTRIES) throw invalid();

  const ordered: [string, Uint8Array | null][] = [];
  let manifest: [string, Uint8Array | null] | null = null;
  for (const destination of destinations) {
    const content = mutations[destination];
    if (!ALLOWED_DESTINATION_SET.has(destination)) throw invalid();
    if (content !== null && !(content instanceof Uint8Array)) throw invalid();
    await ensureDestinationParent(taskDir, destination);
    await validateOptionalRegularFile(destinationPathFor(taskDir, destination));
    const item: [string, Uint8Array | null] = [destination, content ?? null];
    if (destination === MANIFEST_DESTINATION) {
      manifest = item;
    } else {
      ordered.push(item);
    }
  }
  // 清单最后替换：它是「这一版产物是这套文件」的唯一凭据。
  if (manifest !== null) ordered.push(manifest);
  return ordered;
}

async function prepareMaterials(
  taskDir: string,
  entries: readonly TransactionEntry[],
  mutations: readonly [string, Uint8Array | null][],
): Promise<void> {
  const contentByDestination = new Map(mutations);
  for (const entry of entries) {
    const destination = destinationPathFor(taskDir, entry.destination);
    if (entry.staging !== null) {
      const content = contentByDestination.get(entry.destination);
      if (!(content instanceof Uint8Array)) throw invalid();
      await writeSyncedNewFile(taskDirPath(taskDir, entry.staging), content);
    }
    if (entry.rollback !== null) {
      await validateRegularPath(destination);
      await writeSyncedNewFile(taskDirPath(taskDir, entry.rollback), await readFile(destination));
    }
  }
}

async function validateRecoveryPaths(
  taskDir: string,
  journal: TransactionJournal,
): Promise<void> {
  for (const entry of journal.entries) {
    await ensureDestinationParent(taskDir, entry.destination);
    await validateOptionalRegularFile(destinationPathFor(taskDir, entry.destination));
    for (const relative of [entry.staging, entry.rollback]) {
      if (relative !== null) await validateOptionalRegularFile(taskDirPath(taskDir, relative));
    }
  }
}

async function loadAllRollbacks(
  taskDir: string,
  entries: readonly TransactionEntry[],
): Promise<Map<string, Uint8Array>> {
  const payloads = new Map<string, Uint8Array>();
  for (const entry of entries) {
    if (!entry.existedBefore) continue;
    if (entry.rollback === null) throw invalid();
    const rollbackPath = taskDirPath(taskDir, entry.rollback);
    await validateRegularPath(rollbackPath);
    payloads.set(entry.destination, await readFile(rollbackPath));
  }
  return payloads;
}

function journalPayload(journal: TransactionJournal): Record<string, unknown> {
  return {
    schema_version: SCHEMA_VERSION,
    transaction_id: journal.transactionId,
    state: journal.state,
    entries: journal.entries.map((entry) => ({
      destination: entry.destination,
      staging: entry.staging,
      rollback: entry.rollback,
      existed_before: entry.existedBefore,
    })),
  };
}

function materialPaths(taskDir: string, entries: readonly TransactionEntry[]): string[] {
  return entries.flatMap((entry) =>
    [entry.staging, entry.rollback]
      .filter((relative): relative is string => relative !== null)
      .map((relative) => taskDirPath(taskDir, relative)));
}

async function removeJournalThenCleanup(
  taskDir: string,
  paths: readonly string[],
  {required}: {required: boolean},
): Promise<void> {
  try {
    await atomicRemoveFile(taskDirPath(taskDir, JOURNAL_FILE_NAME));
  } catch (error) {
    if (error instanceof AtomicFileCommitError && !required) return;
    throw new TaskArtifactRecoveryError();
  }
  await cleanupPathsBestEffort(paths);
}

async function cleanupPathsBestEffort(paths: readonly string[]): Promise<void> {
  for (const target of paths) {
    await atomicRemoveFile(target).catch(() => {});
  }
}

/** 只删「闭集名字」的残留：别人的 `.app-*.staging` 之类不归事务管。 */
async function cleanupClosedOrphansBestEffort(taskDir: string): Promise<void> {
  for (const relativeParent of INTERNAL_PARENTS) {
    const directory = taskDirPath(taskDir, relativeParent);
    if (!(await pathExists(directory))) continue;
    let names: string[];
    try {
      await validateDirectoryPath(directory);
      names = await readdir(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!ORPHAN_NAME_PATTERN.test(name) && !JOURNAL_STAGING_NAME_PATTERN.test(name)) continue;
      const target = path.join(directory, name);
      try {
        await validateRegularPath(target);
        await atomicRemoveFile(target);
      } catch {
        // 残留清理是尽力而为，删不掉就留给下次。
      }
    }
  }
}

async function ensureDestinationParent(taskDir: string, destination: string): Promise<void> {
  if (!isCanonicalRelative(destination)) throw invalid();
  const parent = posixDirname(destination);
  if (parent === '.') return;
  let current = taskDir;
  for (const component of parent.split('/')) {
    current = path.join(current, component);
    try {
      await mkdir(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await validateDirectoryPath(current);
  }
}

function isCanonicalRelative(destination: string): boolean {
  return destination.length > 0
    && !destination.startsWith('/')
    && !destination.includes('\\')
    && path.posix.normalize(destination) === destination
    && !destination.split('/').includes('..');
}

function posixDirname(destination: string): string {
  const index = destination.lastIndexOf('/');
  return index === -1 ? '.' : destination.slice(0, index);
}

function destinationPathFor(taskDir: string, destination: string): string {
  return taskDirPath(taskDir, destination);
}

function taskDirPath(taskDir: string, relative: string): string {
  return relative === '.' ? taskDir : path.join(taskDir, ...relative.split('/'));
}

function internalRelativePath(
  destination: string,
  transactionId: string,
  index: number,
  kind: 'staging' | 'rollback',
): string {
  const parent = posixDirname(destination);
  const name = `.artifact-${transactionId}-${index}.${kind}`;
  return parent === '.' ? name : `${parent}/${name}`;
}

async function validateTaskDir(taskDir: string): Promise<void> {
  await validateDirectoryPath(taskDir);
}

async function validateDirectoryPath(target: string): Promise<void> {
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink()) throw invalid();
}

async function validateRegularPath(target: string): Promise<void> {
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw invalid();
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
