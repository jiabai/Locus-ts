// 预热/校验 ASR 模型缓存：把固定来源的模型文件下到指定目录，供离线安装、
// 门禁与 CI 在跑真实推理前准备资产。生产 worker 走同一条 `prepareModelCache`。
//
//   node --experimental-strip-types scripts/download-model.mjs --cache-dir <目录>
//   node --experimental-strip-types scripts/download-model.mjs --data-root <数据根>
//
// 退出码：0 缓存就绪（复用的或新下载的）；1 下载/校验失败，错误码打到 stderr。
import process from 'node:process';

import { isASRError, prepareModelCache } from '../src/asr/index.ts';

function parseArgs(argv) {
  const options = { cacheDir: undefined, dataRoot: undefined, quiet: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--cache-dir') options.cacheDir = argv[++index];
    else if (arg === '--data-root') options.dataRoot = argv[++index];
    else if (arg === '--quiet') options.quiet = true;
    else throw new Error(`未知参数：${arg}`);
  }
  if (options.cacheDir === undefined && options.dataRoot === undefined) {
    throw new Error('需要 --cache-dir 或 --data-root');
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
let lastPercent = -1;

const result = await prepareModelCache({
  ...(options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir }),
  ...(options.dataRoot === undefined ? {} : { dataRoot: options.dataRoot }),
  onProgress: (event) => {
    if (options.quiet) return;
    if (event.message_code === 'model.file.downloading') return;
    const percent = Math.floor(event.progress / 10) * 10;
    if (event.progress < 100 && percent === lastPercent) return;
    lastPercent = percent;
    process.stdout.write(`${String(event.progress).padStart(3, ' ')}%  ${event.message_code}${event.current_file === undefined ? '' : ` ${event.current_file}`}\n`);
  },
}).catch((error) => {
  if (isASRError(error)) {
    process.stderr.write(`${error.code}: ${error.message}${error.detail === undefined ? '' : ` (${error.detail})`}\n`);
  } else {
    process.stderr.write(`${String(error)}\n`);
  }
  process.exit(1);
});

process.stdout.write(
  `${result.downloaded ? 'downloaded' : 'reused'} ${result.cacheDir} (${result.bytesDownloaded} bytes)\n`,
);
