// 抖音 fallback 的稳定入口：对齐 Python 的 `worker_core.douyin_fallback` 导出面，
// 只暴露下载编排与解析/候选函数，传输细节留在内部模块。
export {
  downloadDouyinVideo,
  downloadFirstAvailableCandidate,
  resolveSharePageItem,
  streamProgressEmitter,
} from './fallback.ts';
export {extractAwemeId, buildSharePageUrl, resolveAwemeIdFromInput} from './source.ts';
export {parseSharePageRouterData} from './page.ts';
export {
  PLAY_QUALITIES,
  buildPlayUrl,
  collectStreamCandidates,
  selectStreamCandidates,
} from './streams.ts';
export {
  DOUYIN_MOBILE_USER_AGENT,
  FetchDouyinHttpClient,
  downloadOrderedCandidates,
  publicHeaders,
} from './transport.ts';
export {DouyinFallbackError} from './types.ts';
export type {
  DouyinHttpClient,
  DouyinStreamCandidate,
  DownloadToPathOptions,
  HttpResponse,
} from './types.ts';
