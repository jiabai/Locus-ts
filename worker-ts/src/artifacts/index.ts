// 产物写入的公共入口。任务流程只依赖这里；staging、journal 与校验细节都是实现。
export {
  AtomicFileCommitError,
  atomicRemoveFile,
  atomicWriteBytes,
  atomicWriteJson,
  atomicWriteText,
  installStagedFile,
  platformTextBytes,
  writeSyncedNewFile,
} from './atomic-file.ts';

export {
  ALLOWED_DESTINATIONS,
  ARTIFACT_KEY_BY_RELATIVE_PATH,
  INTERNAL_PARENTS,
  JOURNAL_FILE_NAME,
  SCHEMA_VERSION,
  TaskArtifactCommitError,
  TaskArtifactRecoveryError,
  commitTaskArtifacts,
  recoverTaskArtifacts,
} from './task-transaction.ts';
export type {
  CommitOptions,
  RecoveryOutcome,
  TransactionEntry,
  TransactionJournal,
} from './task-transaction.ts';

export {formatTranscriptMarkdown, writeTranscriptFiles} from './transcript-artifacts.ts';
export type {
  TranscriptArtifacts,
  TranscriptMetadata,
  TranscriptSegmentArtifact,
  WriteTranscriptOptions,
} from './transcript-artifacts.ts';
