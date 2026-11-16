// stdin 请求的读取与校验。
//
// 对齐 `worker/worker_core/cli.py` 的 `read_stdin_request`：先判字节上限再解码，
// 空输入、非 UTF-8、非 JSON、非对象一律拒止，不做「尽量解析」。
// 上限存在的意义是防止宿主把一个大文件塞进 stdin 把 worker 拖死。
import {MAX_STDIN_REQUEST_BYTES} from './contract.ts';

export class StdinRequestError extends Error {
  constructor() {
    super('Worker request stdin was invalid.');
    this.name = 'StdinRequestError';
  }
}

/** 从可读流读出整段请求；超限立即失败，不再继续读。 */
export async function readStdinRequest(
  stream: AsyncIterable<Uint8Array> = process.stdin,
  maxBytes: number = MAX_STDIN_REQUEST_BYTES,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > maxBytes) throw new StdinRequestError();
    chunks.push(Buffer.from(chunk));
  }
  if (total === 0) throw new StdinRequestError();

  let text: string;
  try {
    // `fatal` 让非法 UTF-8 直接失败，而不是替换成 U+FFFD 后当成合法请求。
    text = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks));
  } catch {
    throw new StdinRequestError();
  }
  if (text.trim().length === 0) throw new StdinRequestError();

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new StdinRequestError();
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new StdinRequestError();
  }
  return payload as Record<string, unknown>;
}
