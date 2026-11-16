// 来源请求解析：复现 `worker/worker_core/source_resolution.py`。
//
// 直连识别失败时按适配器集合解析短链（xhslink / b23.tv / v.douyin.com），
// 适配器输出必须重过平台识别与平台校验，防止把解析结果当成可信来源。
// 平台短链适配器属于下载器迁移块（需要各平台传输层），当前默认解析器只有直连。
import {
  SourceIdentityError,
  extractUrlCandidates,
  identifySource,
  type SourceIdentity,
  type SourcePlatform,
} from './source-identity.ts';

export interface SourceRequest {
  /** 归一化（strip）后的下载 URL：仅限进程内使用，不进任何序列化输出。 */
  readonly downloadUrl: string;
  readonly identity: SourceIdentity;
}

export type ShortLinkResolve = (shortUrl: string) => Promise<string | null>;

export type SourceRequestResolver = (downloadUrl: string) => Promise<SourceRequest>;

export interface ShortLinkAdapter {
  readonly platform: SourcePlatform;
  readonly hosts: ReadonlySet<string>;
  readonly resolve: ShortLinkResolve;
}

function sourceHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/\.+$/u, '');
  } catch {
    return '';
  }
}

export class SourceResolver {
  readonly shortLinkAdapters: readonly ShortLinkAdapter[];

  constructor(shortLinkAdapters: readonly ShortLinkAdapter[] = []) {
    this.shortLinkAdapters = shortLinkAdapters;
  }

  async resolveRequest(downloadUrl: string, resolvedUrl?: string): Promise<SourceRequest> {
    const normalized = downloadUrl.trim();
    return {downloadUrl: normalized, identity: await this.identify(normalized, resolvedUrl)};
  }

  async identify(rawSource: string, resolvedUrl?: string): Promise<SourceIdentity> {
    const source = rawSource.trim();
    try {
      return identifySource(source, resolvedUrl);
    } catch (error) {
      if (!(error instanceof SourceIdentityError)) throw error;
      // 保留直连解析自己的错误：短链全部失败时抛的仍是它。
      const directError = error;
      const candidates = extractUrlCandidates(source);
      for (const adapter of this.shortLinkAdapters) {
        for (const candidate of candidates) {
          if (!adapter.hosts.has(sourceHost(candidate))) continue;
          const resolved = await adapter.resolve(candidate);
          if (!resolved) continue;
          let identity: SourceIdentity;
          try {
            identity = identifySource(resolved);
          } catch (adapterError) {
            if (adapterError instanceof SourceIdentityError) continue;
            throw adapterError;
          }
          if (identity.platform === adapter.platform) return identity;
        }
      }
      throw directError;
    }
  }
}

/** 与 Python `DIRECT_SOURCE_RESOLVER` 同位：无短链适配器的直连解析器。 */
export const DIRECT_SOURCE_RESOLVER = new SourceResolver();

export async function resolveSourceRequest(downloadUrl: string, resolvedUrl?: string): Promise<SourceRequest> {
  return DIRECT_SOURCE_RESOLVER.resolveRequest(downloadUrl, resolvedUrl);
}

/** 正文清洗：把文本里的来源 URL 换成规范 URL；认不出的整体移除。 */
export function sanitizeSourceText(text: string, sourceRequest: SourceRequest): string {
  let sanitized = text.replaceAll(sourceRequest.downloadUrl, sourceRequest.identity.canonicalUrl);
  for (const candidate of extractUrlCandidates(sanitized)) {
    let replacement: string;
    try {
      replacement = identifySource(candidate).canonicalUrl;
    } catch (error) {
      if (!(error instanceof SourceIdentityError)) throw error;
      replacement = '[source URL removed]';
    }
    sanitized = sanitized.replaceAll(candidate, replacement);
  }
  return sanitized;
}
