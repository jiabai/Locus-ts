// 产物写入的原子文件原语。
//
// 对齐 `worker/worker_core/atomic_files.py`：同一目录 staging → fsync → 校验目标不是
// 链接 → `rename` 替换 → 目录 fsync。失败一律收敛成不含路径的 `AtomicFileCommitError`，
// 因为异常消息会进日志甚至用户可见的错误提示，里面不能出现 `D:/客户/…` 这类路径。
//
// 与 Python 的一处差异：Python 用 `st_file_attributes` 判重解析点，Node 没有对应字段；
// 实测 Node 的 `lstat` 把 Windows 目录联接（junction）报成 `isSymbolicLink() === true`，
// 与符号链接同一条路径，因此这里用 `isSymbolicLink()` 统一拒止。
import {randomUUID} from 'node:crypto';
import {lstat, mkdir, open, rename, unlink} from 'node:fs/promises';
import {EOL} from 'node:os';
import path from 'node:path';

export class AtomicFileCommitError extends Error {
  constructor() {
    super('Atomic file commit failed.');
    this.name = 'AtomicFileCommitError';
  }
}

function commitFailed(): AtomicFileCommitError {
  return new AtomicFileCommitError();
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/** Node 的文件系统错误都带 `syscall`；领域错误（如媒体准备失败）没有。 */
function isFileSystemError(error: unknown): boolean {
  return typeof (error as NodeJS.ErrnoException | null)?.syscall === 'string';
}

/**
 * 只有文件系统层与原子性相关的错误才收敛成 `AtomicFileCommitError`。
 * 校验器抛出的领域错误必须原样上抛——调用方靠它区分「复制失败」和「视频不合规」。
 */
function sanitize(error: unknown): never {
  if (error instanceof AtomicFileCommitError) throw error;
  if (isFileSystemError(error)) throw commitFailed();
  throw error;
}

/** 文本落盘时按平台换行：产物文件给人看，Windows 上要 CRLF。 */
export function platformTextBytes(content: string): Uint8Array {
  return Buffer.from(content.replaceAll('\n', EOL), 'utf8');
}

function textBytes(content: string): Uint8Array {
  return Buffer.from(content, 'utf8');
}

/**
 * 同目录 staging 路径。隐藏名 + 随机后缀，且保留原扩展名——杀毒软件与编辑器
 * 对扩展名有假设，`.part` 放最后不会破坏它。
 */
function stagingPathFor(destination: string): string {
  const parsed = path.parse(destination);
  const stem = parsed.name.replace(/^\.+/, '');
  return path.join(parsed.dir, `.${stem}.${randomUUID().replaceAll('-', '')}.part${parsed.ext}`);
}

async function validateRegularFile(target: string): Promise<void> {
  let info;
  try {
    info = await lstat(target);
  } catch {
    throw commitFailed();
  }
  if (!info.isFile() || info.isSymbolicLink()) throw commitFailed();
}

export async function validateOptionalRegularFile(target: string): Promise<void> {
  if (await isAbsent(target)) return;
  await validateRegularFile(target);
}

async function isAbsent(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return false;
  } catch (error) {
    return isMissing(error);
  }
}

/** 目标必须在一个真目录里，且自身（若已存在）必须是普通文件而不是链接。 */
async function validateDestination(destination: string): Promise<void> {
  let parent;
  try {
    parent = await lstat(path.dirname(destination));
  } catch {
    throw commitFailed();
  }
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw commitFailed();

  let existing;
  try {
    existing = await lstat(destination);
  } catch (error) {
    if (isMissing(error)) return;
    throw commitFailed();
  }
  if (!existing.isFile() || existing.isSymbolicLink()) throw commitFailed();
}

async function syncRegularFile(target: string): Promise<void> {
  await validateRegularFile(target);
  let handle;
  try {
    handle = await open(target, 'r+');
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** 目录 fsync 是「尽量」：Windows 打不开目录句柄，失败不能拖垮已经成功的替换。 */
async function syncDirectoryBestEffort(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, 'r');
  } catch {
    return;
  }
  try {
    await handle.sync();
  } catch {
    // 目录 fsync 不被支持：忽略。
  } finally {
    await handle.close().catch(() => {});
  }
}

/** 同目录 staging 的公开原语：对应 Python 的 `staged_file` 上下文管理器。 */
export async function stagedFile(
  destination: string,
  write: (stagingPath: string) => Promise<void>,
  validator?: (stagingPath: string) => Promise<void>,
): Promise<void> {
  try {
    await mkdir(path.dirname(destination), {recursive: true});
    await validateDestination(destination);
  } catch {
    throw commitFailed();
  }

  const stagingPath = stagingPathFor(destination);
  try {
    await write(stagingPath);
    await syncRegularFile(stagingPath);
    await validator?.(stagingPath);
    await installStagedFile(stagingPath, destination);
  } catch (error) {
    sanitize(error);
  } finally {
    await unlink(stagingPath).catch(() => {});
  }
}

export async function atomicWriteBytes(destination: string, content: Uint8Array): Promise<void> {
  await stagedFile(destination, async (stagingPath) => {
    const handle = await open(stagingPath, 'wx');
    try {
      await handle.write(content);
    } finally {
      await handle.close();
    }
  });
}

export async function atomicWriteText(destination: string, content: string): Promise<void> {
  await atomicWriteBytes(destination, textBytes(content));
}

export async function atomicWriteJson(destination: string, payload: unknown): Promise<void> {
  let content: string;
  try {
    content = `${JSON.stringify(payload, null, 2)}\n`;
  } catch {
    // 循环引用、BigInt、toJSON 抛错：序列化失败不能越过原子性边界。
    throw commitFailed();
  }
  await atomicWriteText(destination, content);
}

/**
 * 新建一个并不同步复制的文件并 fsync。事务的 staging / rollback 材料走这条，
 * 因为它们在同一个事务里被反复读取，必须真的落盘。
 */
export async function writeSyncedNewFile(target: string, content: Uint8Array): Promise<void> {
  let created = false;
  try {
    await mkdir(path.dirname(target), {recursive: true});
    await validateDestination(target);
    const handle = await open(target, 'wx');
    created = true;
    try {
      await handle.write(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await validateRegularFile(target);
  } catch (error) {
    // 只清理「这次自己创建」的文件：材料名带 uuid，理论上不会撞名，
    // 但真撞上时删掉别人的文件比报错更糟。
    if (created) await unlink(target).catch(() => {});
    sanitize(error);
  }
}

/** `rename` 是这里唯一的「提交」动作：同目录、同卷，替换是原子的。 */
export async function installStagedFile(stagingPath: string, destination: string): Promise<void> {
  try {
    if (path.dirname(stagingPath) !== path.dirname(destination)) throw commitFailed();
    await validateRegularFile(stagingPath);
    await validateDestination(destination);
    await rename(stagingPath, destination);
    await syncDirectoryBestEffort(path.dirname(destination));
  } catch (error) {
    sanitize(error);
  }
}

export async function atomicRemoveFile(target: string): Promise<void> {
  try {
    await validateDestination(target);
    try {
      await unlink(target);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    await syncDirectoryBestEffort(path.dirname(target));
  } catch (error) {
    sanitize(error);
  }
}
