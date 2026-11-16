// AI 产物写入。
//
// 对齐 `worker/worker_core/ai_artifacts.py` 的 `commit_insight_payloads`：
// 目标正好是任务目录下的 `ai/` 且没有 stem 时，走多文件事务——摘要、导图与任务清单
// 要么一起生效，要么一起回滚；导出等其它目录逐文件原子写，没有「同一版产物」的语义。
import {mkdir} from 'node:fs/promises';
import path from 'node:path';

import {AtomicFileCommitError, atomicWriteBytes} from '../artifacts/atomic-file.ts';
import {
  commitTaskArtifacts,
  TaskArtifactCommitError,
  TaskArtifactRecoveryError,
} from '../artifacts/task-transaction.ts';
import {toPosixPath} from '../tasks/paths.ts';

export interface InsightPayload {
  /** 绝对路径；事务里会被换算成任务目录下的相对路径。 */
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface CommitInsightPayloadsOptions {
  readonly outputDir: string;
  /** 空串表示任务的标准 `ai/` 目录；非空时文件名带 `${stem}_` 前缀。 */
  readonly outputStem: string;
  readonly payloads: readonly InsightPayload[];
}

export async function commitInsightPayloads(
  options: CommitInsightPayloadsOptions,
): Promise<void> {
  const {outputDir, outputStem, payloads} = options;
  await mkdir(outputDir, {recursive: true});

  if (outputStem === '' && path.basename(outputDir) === 'ai') {
    const taskDir = path.dirname(outputDir);
    const staged: Record<string, Uint8Array> = {};
    for (const payload of payloads) {
      staged[toPosixPath(path.relative(taskDir, payload.path))] = payload.bytes;
    }
    try {
      await commitTaskArtifacts(taskDir, staged);
    } catch (error) {
      // 事务层的两种错误都收敛成「产物没能安全落盘」，不把内部路径抛给上层。
      if (error instanceof TaskArtifactCommitError || error instanceof TaskArtifactRecoveryError) {
        throw new AtomicFileCommitError();
      }
      throw error;
    }
    return;
  }

  for (const payload of payloads) {
    await atomicWriteBytes(payload.path, payload.bytes);
  }
}
