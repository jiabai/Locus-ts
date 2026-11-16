// B 站 fallback 的稳定入口：对齐 Python 的 `worker_core.bilibili_fallback` 导出面。
export {downloadBilibiliVideo} from './fallback.ts';
export {
  parseBilibiliInput,
  parseBilibiliVideoUrl,
  parseDirectId,
} from './source.ts';
export {
  buildPlayurlUrl,
  buildVideoInfoUrl,
  parsePlayurlResponse,
  parseViewResponse,
  selectDashStreamPair,
} from './playback.ts';
export {
  BILIBILI_DESKTOP_USER_AGENT,
  FetchBilibiliHttpClient,
  apiHeaders,
  decodeResponseBody,
  mediaHeaders,
  pageHeaders,
} from './transport.ts';
export {cleanupCompletedDashFiles, cleanupTransientArtifacts, mergeDashFiles} from './artifacts.ts';
export {BilibiliFallbackError} from './types.ts';
export type {
  BilibiliDashSelection,
  BilibiliPage,
  BilibiliParseResult,
  BilibiliRequestClient,
  BilibiliVideoInfo,
  CommandRunner,
  CommandResult,
  DownloadToPathOptions,
  HttpResponse,
} from './types.ts';
