import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ALLOWED_DESTINATIONS,
  ARTIFACT_KEY_BY_RELATIVE_PATH,
  INTERNAL_PARENTS,
  JOURNAL_FILE_NAME,
  TaskArtifactCommitError,
  commitTaskArtifacts,
  parseTransactionJournal,
  recoverTaskArtifacts,
} from "../src/artifacts/task-transaction.ts";

const CONTRACT_URL = new URL("../../contracts/task-artifact-transaction-v1.json", import.meta.url);

// 事务语义的回归钉子：一次提交要么整体生效要么整体回滚，中途被杀之后必须能自我恢复。
// 这些用例不需要模型、不联网，只用临时目录与故障注入。

const bytes = (text) => new Uint8Array(Buffer.from(text));

async function makeTaskDir(t) {
  const root = mkdtempSync(join(tmpdir(), "locus-task-tx-"));
  const taskDir = join(root, "outputs", "tasks", "task-1");
  await mkdir(join(taskDir, "transcript"), { recursive: true });
  await mkdir(join(taskDir, "ai"), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return taskDir;
}

async function writeFiles(taskDir, payloads) {
  for (const [relative, content] of Object.entries(payloads)) {
    await writeFile(join(taskDir, ...relative.split("/")), content);
  }
}

async function readFiles(taskDir, relatives) {
  const result = {};
  for (const relative of relatives) {
    result[relative] = await readFile(join(taskDir, ...relative.split("/")), "utf8");
  }
  return result;
}

async function internalFiles(taskDir) {
  const found = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.startsWith(".artifact-") || entry.name === JOURNAL_FILE_NAME) {
        found.push(full.slice(taskDir.length + 1));
      }
    }
  };
  await walk(taskDir);
  return found.sort();
}

function crashOn(event) {
  return (name) => {
    if (name === event) throw new Error(`simulated crash at ${name}`);
  };
}

test("commit replaces the whole bundle and leaves no internals behind", async (t) => {
  const taskDir = await makeTaskDir(t);
  await writeFiles(taskDir, {
    "transcript/transcript.txt": "old text\n",
    "transcript/transcript.md": "# Old\n",
    "task.json": '{"status":"old"}\n',
  });

  await commitTaskArtifacts(taskDir, {
    "transcript/transcript.txt": bytes("new text\n"),
    "transcript/transcript.md": bytes("# New\n"),
    "task.json": bytes('{"status":"new"}\n'),
  });

  assert.deepEqual(
    await readFiles(taskDir, ["transcript/transcript.txt", "transcript/transcript.md", "task.json"]),
    {
      "transcript/transcript.txt": "new text\n",
      "transcript/transcript.md": "# New\n",
      "task.json": '{"status":"new"}\n',
    },
  );
  assert.deepEqual(await internalFiles(taskDir), []);
});

test("distinct destinations are accepted, unknown ones are rejected before any mutation", async (t) => {
  const taskDir = await makeTaskDir(t);
  await commitTaskArtifacts(taskDir, {
    "ai/dissection.json": bytes("{}\n"),
    "ai/dissection.md": bytes("# report\n"),
    "task.json": bytes("{}\n"),
  });
  assert.equal(await readFile(join(taskDir, "ai", "dissection.md"), "utf8"), "# report\n");

  const outside = join(taskDir, "..", "outside.txt");
  await writeFile(outside, "outside\n");

  await assert.rejects(
    () => commitTaskArtifacts(taskDir, { "../outside.txt": bytes("changed\n") }),
    (error) => {
      assert.ok(error instanceof TaskArtifactCommitError);
      assert.equal(error.code, "TASK_ARTIFACT_COMMIT_FAILED");
      assert.equal(error.message, "Task artifacts could not be stored safely.");
      return true;
    },
  );
  await assert.rejects(() => commitTaskArtifacts(taskDir, { "ai/custom.json": bytes("{}") }));
  assert.equal(await readFile(outside, "utf8"), "outside\n");
  assert.deepEqual(await internalFiles(taskDir), []);
});

test("the manifest is replaced last", async (t) => {
  const taskDir = await makeTaskDir(t);
  const order = [];
  await commitTaskArtifacts(
    taskDir,
    { "task.json": bytes("{}\n"), "transcript/transcript.txt": bytes("text\n") },
    { onFault: (event) => order.push(event) },
  );
  assert.deepEqual(order, [
    "after_journal_prepared",
    "after_replace:transcript/transcript.txt",
    "after_replace:task.json",
    "after_journal_committed",
  ]);
});

for (const event of [
  "after_journal_prepared",
  "after_replace:ai/dissection.json",
  "after_replace:ai/dissection.md",
  "after_replace:task.json",
]) {
  test(`a crash at ${event} rolls the previous revision back`, async (t) => {
    const taskDir = await makeTaskDir(t);
    const oldPayloads = {
      "ai/dissection.json": '{"revision":"old"}\n',
      "ai/dissection.md": "# old\n",
      "task.json": '{"artifacts":{"dissection":"ai/dissection.json"}}\n',
    };
    await writeFiles(taskDir, oldPayloads);

    await assert.rejects(
      () => commitTaskArtifacts(
        taskDir,
        {
          "ai/dissection.json": bytes('{"revision":"new"}\n'),
          "ai/dissection.md": bytes("# new\n"),
          "task.json": bytes('{"artifacts":{"dissection":"ai/dissection.json"}}\n'),
        },
        { onFault: crashOn(event) },
      ),
      /simulated crash/,
    );

    assert.equal(await recoverTaskArtifacts(taskDir), "rolled_back");
    assert.deepEqual(await readFiles(taskDir, Object.keys(oldPayloads)), oldPayloads);
    assert.deepEqual(await internalFiles(taskDir), []);
  });
}

test("a crash mid-commit is recoverable and recovery is idempotent", async (t) => {
  const taskDir = await makeTaskDir(t);
  await writeFiles(taskDir, {
    "transcript/transcript.txt": "old text\n",
    "transcript/transcript.md": "# Old\n",
  });

  await assert.rejects(
    () => commitTaskArtifacts(
      taskDir,
      {
        "transcript/transcript.txt": bytes("new text\n"),
        "transcript/transcript.md": bytes("# New\n"),
      },
      { onFault: crashOn("after_replace:transcript/transcript.txt") },
    ),
    /simulated crash/,
  );

  // 现场：journal 还在，第一个文件是新的、第二个还是旧的。
  assert.deepEqual((await internalFiles(taskDir)).includes(JOURNAL_FILE_NAME), true);
  assert.equal(await readFile(join(taskDir, "transcript", "transcript.txt"), "utf8"), "new text\n");
  assert.equal(await readFile(join(taskDir, "transcript", "transcript.md"), "utf8"), "# Old\n");

  assert.equal(await recoverTaskArtifacts(taskDir), "rolled_back");
  assert.equal(await readFile(join(taskDir, "transcript", "transcript.txt"), "utf8"), "old text\n");
  assert.equal(await recoverTaskArtifacts(taskDir), "none");
  assert.deepEqual(await internalFiles(taskDir), []);
});

test("a crash after the commit point keeps the new revision", async (t) => {
  const taskDir = await makeTaskDir(t);
  await writeFiles(taskDir, {
    "transcript/transcript.txt": "old text\n",
    "transcript/transcript.md": "# Old\n",
  });

  await assert.rejects(
    () => commitTaskArtifacts(
      taskDir,
      {
        "transcript/transcript.txt": bytes("new text\n"),
        "transcript/transcript.md": bytes("# New\n"),
      },
      { onFault: crashOn("after_journal_committed") },
    ),
    /simulated crash/,
  );

  assert.equal(await recoverTaskArtifacts(taskDir), "committed_cleaned");
  assert.equal(await readFile(join(taskDir, "transcript", "transcript.txt"), "utf8"), "new text\n");
  assert.equal(await readFile(join(taskDir, "transcript", "transcript.md"), "utf8"), "# New\n");
  assert.equal(await recoverTaskArtifacts(taskDir), "none");
  assert.deepEqual(await internalFiles(taskDir), []);
});

test("a crash after deleting a destination can restore it", async (t) => {
  const taskDir = await makeTaskDir(t);
  await writeFiles(taskDir, {
    "transcript/segments.json": '{"segments":[{"id":"old"}]}\n',
    "transcript/transcript.txt": "old text\n",
  });

  await assert.rejects(
    () => commitTaskArtifacts(
      taskDir,
      { "transcript/segments.json": null, "transcript/transcript.txt": bytes("new text\n") },
      { onFault: crashOn("after_replace:transcript/segments.json") },
    ),
    /simulated crash/,
  );

  await assert.rejects(() => readFile(join(taskDir, "transcript", "segments.json")));
  assert.equal(await recoverTaskArtifacts(taskDir), "rolled_back");
  assert.equal(
    await readFile(join(taskDir, "transcript", "segments.json"), "utf8"),
    '{"segments":[{"id":"old"}]}\n',
  );
  assert.equal(await readFile(join(taskDir, "transcript", "transcript.txt"), "utf8"), "old text\n");
});

test("an invalid journal fails closed without touching authoritative files", async (t) => {
  const taskDir = await makeTaskDir(t);
  await writeFiles(taskDir, { "transcript/transcript.txt": "mixed but untouched\n" });
  const outside = join(taskDir, "..", "outside.txt");
  await writeFile(outside, "outside\n");
  await writeFile(
    join(taskDir, JOURNAL_FILE_NAME),
    JSON.stringify({
      schema_version: 1,
      transaction_id: "a".repeat(32),
      state: "prepared",
      entries: [{
        destination: "../outside.txt",
        staging: `.artifact-${"a".repeat(32)}-0.staging`,
        rollback: null,
        existed_before: false,
      }],
    }),
  );

  await assert.rejects(
    () => recoverTaskArtifacts(taskDir),
    (error) => {
      assert.equal(error.code, "TASK_ARTIFACT_RECOVERY_FAILED");
      assert.equal(error.message, "Task artifacts could not be recovered safely.");
      return true;
    },
  );
  assert.equal(await readFile(join(taskDir, "transcript", "transcript.txt"), "utf8"), "mixed but untouched\n");
  assert.equal(await readFile(outside, "utf8"), "outside\n");
  assert.ok((await internalFiles(taskDir)).includes(JOURNAL_FILE_NAME));
});

test("a missing rollback aborts recovery before restoring anything", async (t) => {
  const taskDir = await makeTaskDir(t);
  await writeFiles(taskDir, {
    "transcript/transcript.txt": "mixed new text\n",
    "transcript/transcript.md": "mixed new markdown\n",
  });
  const transactionId = "b".repeat(32);
  await writeFile(
    join(taskDir, JOURNAL_FILE_NAME),
    JSON.stringify({
      schema_version: 1,
      transaction_id: transactionId,
      state: "prepared",
      entries: [
        {
          destination: "transcript/transcript.txt",
          staging: `transcript/.artifact-${transactionId}-0.staging`,
          rollback: `transcript/.artifact-${transactionId}-0.rollback`,
          existed_before: true,
        },
        {
          destination: "transcript/transcript.md",
          staging: `transcript/.artifact-${transactionId}-1.staging`,
          rollback: `transcript/.artifact-${transactionId}-1.rollback`,
          existed_before: true,
        },
      ],
    }),
  );
  await writeFile(
    join(taskDir, "transcript", `.artifact-${transactionId}-0.rollback`),
    "old text\n",
  );

  await assert.rejects(() => recoverTaskArtifacts(taskDir), (error) => {
    assert.equal(error.code, "TASK_ARTIFACT_RECOVERY_FAILED");
    return true;
  });
  // 只有一份回滚材料时，绝不能「恢复一半」。
  assert.equal(await readFile(join(taskDir, "transcript", "transcript.txt"), "utf8"), "mixed new text\n");
  assert.equal(await readFile(join(taskDir, "transcript", "transcript.md"), "utf8"), "mixed new markdown\n");
});

test("orphan cleanup only touches closed transaction names", async (t) => {
  const taskDir = await makeTaskDir(t);
  const orphan = join(taskDir, "ai", `.artifact-${"c".repeat(32)}-0.staging`);
  const journalStaging = join(taskDir, `.artifact-transaction.${"d".repeat(32)}.part.json`);
  const unrelated = join(taskDir, "ai", ".app-user-note.staging");
  await writeFile(orphan, "orphan");
  await writeFile(journalStaging, "incomplete journal");
  await writeFile(unrelated, "keep");

  assert.equal(await recoverTaskArtifacts(taskDir), "none");
  await assert.rejects(() => readFile(orphan));
  await assert.rejects(() => readFile(journalStaging));
  assert.equal(await readFile(unrelated, "utf8"), "keep");
});

test("the journal parser agrees with the shared contract fixtures", async () => {
  // 三份实现互读同一个 journal：Python 写、Rust 读，或反过来。契约里的正反例是
  // 唯一的共同判定标准，任何一处放宽都会让别的实现把不可信状态当成已提交。
  const contract = JSON.parse(await readFile(CONTRACT_URL, "utf8"));

  for (const fixture of contract.validFixtures) {
    assert.doesNotThrow(
      () => parseTransactionJournal(fixture),
      `合法 journal 被拒绝：${JSON.stringify(fixture).slice(0, 80)}`,
    );
  }
  for (const fixture of contract.invalidFixtures) {
    assert.throws(
      () => parseTransactionJournal(fixture.journal),
      `非法 journal 被接受：${fixture.name}`,
    );
  }
});

test("the closed destination set matches the shared contract", async () => {
  const contract = JSON.parse(await readFile(CONTRACT_URL, "utf8"));

  assert.equal(contract.journalFileName, JOURNAL_FILE_NAME);
  assert.deepEqual(
    ALLOWED_DESTINATIONS.slice().sort(),
    contract.allowedDestinations.slice().sort(),
  );
  assert.deepEqual(ARTIFACT_KEY_BY_RELATIVE_PATH, contract.artifactKeysByDestination);
  assert.deepEqual(INTERNAL_PARENTS.slice().sort(), contract.internalParents.slice().sort());
  assert.deepEqual(
    contract.nonArtifactDestinations,
    ALLOWED_DESTINATIONS.filter((item) => !(item in ARTIFACT_KEY_BY_RELATIVE_PATH)),
  );
});
