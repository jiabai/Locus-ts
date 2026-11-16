// `python -m worker_core.storage_validation` 的 TypeScript 等价入口：
// 宿主（Rust）在数据位置迁移的基线采集与核验两侧各调一次。
// stdout 恰好一行 JSON（成功）或为空（失败），退出码 0/1/2 语义见 storage-validation.ts。
import {runStorageValidationMain} from './storage-validation.ts';

const code = await runStorageValidationMain(
  process.argv.slice(2),
  (line) => process.stdout.write(`${line}\n`),
  (line) => process.stderr.write(`${line}\n`),
);
process.exitCode = code;
