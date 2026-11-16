// 外部命令执行。媒体探测与转码都靠 ffmpeg/ffprobe，这里只做一件事：
// 把「起进程、收 stdout/stderr、按退出码判定」包成可替换的 runner，测试与诊断可以注入。
import {spawn} from 'node:child_process';

export interface CommandResult {
  readonly command: readonly string[];
  readonly returncode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunOptions {
  readonly timeoutMs?: number;
}

export type CommandRunner = (
  command: readonly string[],
  options?: CommandRunOptions,
) => Promise<CommandResult>;

/** 与 Python 的 `YTDLP_DOWNLOAD_TIMEOUT_CODE` 同码，超时也走结构化前缀。 */
export const COMMAND_TIMEOUT_CODE = 'VIDEO_DOWNLOAD_TIMEOUT';

/** stderr 形如 `SOME_CODE: 说明` 时取出 `SOME_CODE`，否则 null。 */
export function structuredErrorCode(message: string): string | null {
  const prefix = message.split(':')[0]?.trim() ?? '';
  return /^[A-Z][A-Z0-9_]+$/.test(prefix) ? prefix : null;
}

export class CommandExecutionError extends Error {
  readonly result: CommandResult;

  constructor(result: CommandResult) {
    const code = structuredErrorCode(result.stderr);
    super(code
      ? `${code}: Media download command failed.`
      : `Media command failed with exit code ${result.returncode}.`);
    this.name = 'CommandExecutionError';
    this.result = result;
  }
}

/**
 * 跑一次命令并等到退出。不经过 shell，避免路径里的空格与元字符被解释。
 * 超时按「命令超时」处理：返回非零结果而不是抛错，让上层与真实失败走同一条映射。
 */
export const runCommand: CommandRunner = (command, options = {}) => new Promise<CommandResult>((resolve) => {
  if (command.length === 0) {
    resolve({command, returncode: 1, stdout: '', stderr: 'empty command'});
    return;
  }
  const [executable, ...args] = command;
  const child = spawn(executable, args, {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '';
  let stderr = '';
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const finish = (result: CommandResult): void => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    resolve(result);
  };

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });

  child.on('error', (error: NodeJS.ErrnoException) => {
    finish({
      command,
      returncode: 1,
      stdout,
      stderr: `${error.code ?? 'ENOENT'}: ${error.message}`,
    });
  });

  child.on('close', (code) => {
    finish({command, returncode: code ?? 1, stdout, stderr});
  });

  if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({
        command,
        returncode: 1,
        stdout,
        stderr: `${COMMAND_TIMEOUT_CODE}: Media download command exceeded its time budget.`,
      });
    }, options.timeoutMs);
  }
});
