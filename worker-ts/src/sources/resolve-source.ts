// `--resolve-source-stdin` 的应用层入口：复现
// `worker/worker_core/worker_application/source_identity.py`。
//
// 结果是裸信封（没有 task_id / artifacts），输出键序与 Python 的 dict 一致；
// 任何失败都收敛成 failed 结果行而不是异常——探针式的「正常结束」语义。
import {SourceIdentityError, sourceIdentityToManifestDict} from './source-identity.ts';
import {buildDefaultSourceResolver} from './platform-short-links.ts';
import {SourceResolver, type SourceRequestResolver} from './source-resolution.ts';

export interface ResolveSourceResult {
  readonly status: 'completed' | 'failed';
  readonly source_url?: string;
  readonly source_identity?: Record<string, unknown>;
  readonly error?: {readonly code: string};
}

/** Python 的失败分支键序：先 status 后 error。 */
function failed(code: string): ResolveSourceResult {
  return {status: 'failed', error: {code}};
}

/** 与 Python `defaults.DEFAULT_SOURCE_RESOLVER` 同位：带三平台短链适配器。 */
const DEFAULT_RESOLVER = new SourceResolver(buildDefaultSourceResolver());

function defaultSourceRequestResolver(): SourceRequestResolver {
  return (downloadUrl: string) => DEFAULT_RESOLVER.resolveRequest(downloadUrl);
}

export async function resolveSourceIdentityOnce(
  requestJson: string,
  sourceRequestResolver: SourceRequestResolver = defaultSourceRequestResolver(),
): Promise<ResolveSourceResult> {
  let payload: unknown;
  try {
    payload = JSON.parse(requestJson);
  } catch {
    return failed('INVALID_SOURCE_IDENTITY_JSON');
  }
  const rawUrl = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)['url']
    : undefined;
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    return failed('INVALID_SOURCE_IDENTITY_PAYLOAD');
  }
  let identity;
  try {
    identity = (await sourceRequestResolver(rawUrl)).identity;
  } catch (error) {
    if (!(error instanceof SourceIdentityError)) throw error;
    return failed('SOURCE_IDENTITY_UNAVAILABLE');
  }
  return {
    status: 'completed',
    source_url: identity.canonicalUrl,
    source_identity: sourceIdentityToManifestDict(identity),
  };
}
