// 严格读取一个文件。
//
// 对齐 `worker/worker_core/source_text.py` 的 `read_source_file`：重新生成摘要会把新内容
// 写进同一个目录，如果源文件可以被链接替换，读到的东西与清单承诺的可能不是同一份。
//
// 与 Python 的一处有意差异：只从目标往上检查到任务目录（含）为止，不再一路查到根。
// 原因是 macOS 的 `/var` 是指向 `/private/var` 的符号链接，查到根会把临时目录下的
// 正常任务判成「被链接」；任务目录以上属于宿主配置，不归这里管。
import {constants} from 'node:fs';
import {lstat, open} from 'node:fs/promises';
import path from 'node:path';


/** 存储层不满足要求：被链接、不是普通文件、读不动、内容为空。 */
export class SourceTextUnavailableError extends Error {
  constructor() {
    super('Authoritative source text is unavailable.');
    this.name = 'SourceTextUnavailableError';
  }
}

function unavailable(): SourceTextUnavailableError {
  return new SourceTextUnavailableError();
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * 读一个「必须是普通文件、不能被链接、读取期间不许变」的文件。
 *
 * 检查顺序有意为之：先确认位置本身干净（一路无链接），再打开并比对 inode，
 * 最后核对长度与修改时间。任何一步不符都当作不可读，而不是「尽力读一点」。
 */
export async function readSourceFile(
  target: string,
  maximumBytes: number,
  boundaryDir: string,
): Promise<Uint8Array> {
  if (target !== boundaryDir && !isInside(boundaryDir, target)) throw unavailable();

  const chain: string[] = [];
  for (let current = target; ; current = path.dirname(current)) {
    chain.push(current);
    if (current === boundaryDir || path.dirname(current) === current) break;
  }

  const parentIdentities = new Map<string, {readonly dev: bigint; readonly ino: bigint}>();
  for (const entry of chain) {
    let info;
    try {
      info = await lstat(entry, {bigint: true});
    } catch {
      throw unavailable();
    }
    // Node 把 Windows 目录联接也报成符号链接，因此一条判断覆盖两种情况。
    if (info.isSymbolicLink()) throw unavailable();
    if (entry !== target) parentIdentities.set(entry, {dev: info.dev, ino: info.ino});
  }

  let before;
  try {
    before = await lstat(target, {bigint: true});
  } catch {
    throw unavailable();
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw unavailable();
  if (before.size > BigInt(maximumBytes)) throw unavailable();

  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  let bytes: Uint8Array;
  try {
    const handle = await open(target, constants.O_RDONLY | noFollow);
    try {
      const opened = await handle.stat({bigint: true});
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1n) {
        throw unavailable();
      }
      const data = await handle.readFile();
      const after = await handle.stat({bigint: true});
      if (
        data.byteLength > maximumBytes
        || BigInt(data.byteLength) !== after.size
        || after.size !== before.size
        || after.mtimeNs !== before.mtimeNs
        || after.nlink !== 1n
        || after.ino !== before.ino
      ) {
        throw unavailable();
      }
      bytes = data;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof SourceTextUnavailableError) throw error;
    throw unavailable();
  }

  // 打开之后再看一眼路径本身：防止读取期间被换成另一个 inode。
  const current = await lstat(target, {bigint: true}).catch(() => null);
  if (current === null || current.ino !== before.ino || current.dev !== before.dev) throw unavailable();
  for (const [entry, expected] of parentIdentities) {
    const info = await lstat(entry, {bigint: true}).catch(() => null);
    if (info === null || info.isSymbolicLink() || info.ino !== expected.ino || info.dev !== expected.dev) {
      throw unavailable();
    }
  }
  return bytes;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    throw unavailable();
  }
}
