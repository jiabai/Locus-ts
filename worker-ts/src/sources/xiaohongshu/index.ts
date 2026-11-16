// 小红书模块出口：下载器、字幕探测与解析函数都从这里取，外部不直接引用子模块。
export {
  downloadXiaohongshuSubtitle,
  downloadXiaohongshuVideo,
  emitStreamRetry,
  parseVideoStreamCandidates,
  parseXiaohongshuInput,
} from './fallback.ts';
export type {
  DownloadXiaohongshuSubtitleOptions,
  DownloadXiaohongshuVideoOptions,
} from './fallback.ts';
export {
  XHS_BASE_URL,
  XHS_MAX_REDIRECT_DEPTH,
  XHS_SHORT_LINK_BODY_BYTES,
  XHS_SHORT_HOSTS,
  XHS_TRAILING_URL_PUNCTUATION,
  buildExploreUrl,
  extractXhsUrls,
  parseXiaohongshuSource,
} from './source.ts';
export {
  XHS_MAX_HTML_BYTES,
  decodeResponseBody,
  extractInitialState,
  isImageOnlyNote,
  jsToJson,
  lookupNote,
  raiseForPageResponse,
} from './page.ts';
export {
  PREFERRED_SUBTITLE_GROUPS,
  SUBTITLE_HOST_SUFFIXES,
  isAllowedSubtitleUrl,
  normalizeSubtitleLanguage,
  selectPreferredSubtitleTrack,
} from './subtitles.ts';
export {collectDownloadUrls, parseVideoStreams, pythonInt} from './streams.ts';
export {
  FetchXiaohongshuHttpClient,
  XHS_DESKTOP_USER_AGENT,
  XHS_DOWNLOAD_CHUNK_BYTES,
  XHS_MAX_SUBTITLE_BYTES,
  XHS_MAX_VIDEO_BYTES,
  XHS_NO_PROGRESS_TIMEOUT_SECONDS,
  XHS_REFERER,
  XHS_SUBTITLE_CONTENT_TYPES,
  XHS_SUBTITLE_HOST_SUFFIXES,
  downloadStreamToPath,
  downloadSubtitleToPath,
  isDownloadAttemptError,
  mapDownloadError,
  mediaHeaders,
  pageHeaders,
  recordHeaders,
} from './transport.ts';
export {XiaohongshuFallbackError} from './types.ts';
export type {
  DownloadToPathOptions,
  HttpResponse,
  XiaohongshuHttpClient,
  XiaohongshuParseResult,
  XiaohongshuStreamCandidate,
  XiaohongshuSubtitleTrack,
} from './types.ts';
