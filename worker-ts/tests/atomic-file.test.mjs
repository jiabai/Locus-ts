import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, open, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { EOL, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AtomicFileCommitError,
  atomicRemoveFile,
  atomicWriteBytes,
  atomicWriteJson,
  atomicWriteText,
  installStagedFile,
  platformTextBytes,
  writeSyncedNewFile,
} from "../src/artifacts/atomic-file.ts";

async function makeDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "locus-atomic-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function leftovers(dir) {
  return (await readdir(dir)).filter((name) => name.startsWith("."));
}

async function createSymlink(target, linkPath, type) {
  // Windows 上普通符号链接要开发者模式；目录联接（junction）不需要权限，
  // 而 Node 的 lstat 同样报 isSymbolicLink()，正好覆盖同一条拒绝路径。
  const types = process.platform === "win32" ? ["junction"] : [type];
  for (const candidate of types) {
    try {
      await symlink(target, linkPath, candidate);
      return true;
    } catch (error) {
      if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
    }
  }
  return false;
}

test("text writes replace existing bytes and leave no staging file", async (t) => {
  const dir = await makeDir(t);
  const destination = join(dir, "artifact.txt");
  await writeFile(destination, "previous bytes\n");

  await atomicWriteText(destination, "新内容\nsecond line\n");

  assert.equal(await readFile(destination, "utf8"), "新内容\nsecond line\n");
  assert.deepEqual(await leftovers(dir), []);
});

test("bytes and json writes create absent destinations", async (t) => {
  const dir = await makeDir(t);
  const binary = join(dir, "artifact.bin");
  await atomicWriteBytes(binary, new Uint8Array([0x00, 0x4c, 0x6f, 0x63, 0x75, 0x73]));
  assert.deepEqual([...await readFile(binary)], [0x00, 0x4c, 0x6f, 0x63, 0x75, 0x73]);

  const json = join(dir, "artifact.json");
  await atomicWriteJson(json, { schemaVersion: 1, title: "原子持久化" });
  assert.equal(await readFile(json, "utf8"), `${JSON.stringify({ schemaVersion: 1, title: "原子持久化" }, null, 2)}\n`);
});

test("json serialization failures are sanitized", async (t) => {
  const dir = await makeDir(t);
  const circular = {};
  circular.self = circular;

  await assert.rejects(
    () => atomicWriteJson(join(dir, "bad.json"), circular),
    (error) => {
      assert.ok(error instanceof AtomicFileCommitError);
      assert.equal(error.message, "Atomic file commit failed.");
      return true;
    },
  );
  assert.deepEqual(await leftovers(dir), []);
});

test("platform text bytes follow the OS newline", () => {
  assert.deepEqual(
    [...platformTextBytes("a\nb\n")],
    [...Buffer.from(`a${EOL}b${EOL}`, "utf8")],
  );
});

test("writing through a symlinked destination is refused", async (t) => {
  const dir = await makeDir(t);
  const target = join(dir, "outside.txt");
  await writeFile(target, "outside\n");
  const link = join(dir, "artifact.txt");
  if (!await createSymlink(target, link, "file")) {
    t.skip("当前环境不允许创建符号链接");
    return;
  }

  await assert.rejects(() => atomicWriteText(link, "overwritten\n"), AtomicFileCommitError);
  assert.equal(await readFile(target, "utf8"), "outside\n");
});

test("writing into a symlinked directory is refused", async (t) => {
  const dir = await makeDir(t);
  const outside = join(dir, "outside");
  await mkdir(outside);
  const link = join(dir, "linked");
  if (!await createSymlink(outside, link, "dir")) {
    t.skip("当前环境不允许创建符号链接");
    return;
  }

  await assert.rejects(
    () => atomicWriteText(join(link, "artifact.txt"), "escaped\n"),
    AtomicFileCommitError,
  );
  assert.deepEqual(await readdir(outside), []);
});

test("removal tolerates absence and clears regular files", async (t) => {
  const dir = await makeDir(t);
  const destination = join(dir, "artifact.txt");
  await atomicRemoveFile(destination);

  await writeFile(destination, "gone\n");
  await atomicRemoveFile(destination);
  await assert.rejects(() => readFile(destination));
});

test("installing a staged file requires the same directory", async (t) => {
  const dir = await makeDir(t);
  const staged = join(dir, "staged.bin");
  const elsewhere = join(dir, "nested");
  await mkdir(elsewhere);
  await writeFile(staged, "payload");

  await assert.rejects(
    () => installStagedFile(staged, join(elsewhere, "target.bin")),
    AtomicFileCommitError,
  );
  assert.equal(await readFile(staged, "utf8"), "payload");

  await installStagedFile(staged, join(dir, "target.bin"));
  assert.equal(await readFile(join(dir, "target.bin"), "utf8"), "payload");
});

test("synced new files refuse to overwrite", async (t) => {
  const dir = await makeDir(t);
  const destination = join(dir, "material.staging");
  await writeSyncedNewFile(destination, new Uint8Array(Buffer.from("first")));
  assert.equal(await readFile(destination, "utf8"), "first");

  await assert.rejects(
    () => writeSyncedNewFile(destination, new Uint8Array(Buffer.from("second"))),
    AtomicFileCommitError,
  );
  assert.equal(await readFile(destination, "utf8"), "first");
});

test("a locked destination keeps its bytes and hides the failure", async (t) => {
  const dir = await makeDir(t);
  const destination = join(dir, "artifact.txt");
  await writeFile(destination, "previous\n");

  // Windows 上独占打开会让 rename 失败，Unix 上 rename 会成功；这里只断言
  // 「失败必须是 AtomicFileCommitError 且旧内容可读」，不假定平台行为。
  let handle;
  try {
    handle = await open(destination, "r+");
  } catch {
    t.skip("无法打开目标文件");
    return;
  }
  try {
    await atomicWriteText(destination, "next\n").catch((error) => {
      assert.ok(error instanceof AtomicFileCommitError);
      assert.equal(error.message, "Atomic file commit failed.");
    });
  } finally {
    await handle.close();
  }
  assert.ok(["previous\n", "next\n"].includes(await readFile(destination, "utf8")));
  assert.deepEqual(await leftovers(dir), []);
});
