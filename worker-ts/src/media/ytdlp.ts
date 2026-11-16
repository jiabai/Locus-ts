// 下载命令构造、URL 判定与 YouTube 失败分类。
//
// 对齐 `worker/worker_core/media.py`：命令参数、URL 候选、host 后缀、字幕参数、
// 失败码与错误文案逐项一致。唯一有意差异是命令前缀——Python 通过解释器模块入口
// 启动下载器，这里由调用方注入官方独立可执行文件的路径；产品规格禁止回退到
// 系统 Python 的模块实现。
import {parseQsl, splitUrl} from '../web/web-page-contract.ts';
import {stripPythonSpace} from '../protocol/process-request.ts';
import type {CommandResult} from './command.ts';
import {structuredErrorCode} from './command.ts';

export const YOUTUBE_FORMAT_SELECTOR =
  'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/'
  + 'best[height<=720][ext=mp4]/'
  + 'bestvideo[height<=720]+bestaudio/'
  + 'best[height<=720]/best';
export const YOUTUBE_JS_RUNTIMES: readonly string[] = ['deno', 'node', 'quickjs', 'bun'];
export const PLATFORM_SUBTITLE_ARGS: readonly string[] = [
  '--write-subs',
  '--write-auto-subs',
  '--sub-langs',
  'zh-Hans,zh-CN,zh-Hant,zh,en,ja,ko',
  '--sub-format',
  'best',
];
export const YOUTUBE_HOSTS: readonly string[] = ['youtube.com', 'www.youtube.com', 'm.youtube.com'];
export const YOUTUBE_SHORT_HOSTS: readonly string[] = ['youtu.be', 'www.youtu.be'];
export const DOUYIN_HOST_SUFFIXES: readonly string[] = ['douyin.com', 'iesdouyin.com'];
export const XIAOHONGSHU_HOST_SUFFIXES: readonly string[] = [
  'xiaohongshu.com', 'xhslink.com', 'xhslink.cn',
];
export const BILIBILI_HOST_SUFFIXES: readonly string[] = ['bilibili.com', 'b23.tv'];
export const DOWNLOADED_MEDIA_SUFFIXES: readonly string[] = ['.mp4', '.mkv', '.webm', '.mov', '.m4v'];
export const YTDLP_DOWNLOAD_TIMEOUT_SECONDS = 20 * 60;
export const YTDLP_DOWNLOAD_TIMEOUT_CODE = 'VIDEO_DOWNLOAD_TIMEOUT';
export const YOUTUBE_DOWNLOAD_FAILED_MESSAGE = 'yt-dlp failed to download the YouTube video.';

// Python `str.rstrip(chars)` 的字符集。这里逐码点处理，避免把代理对拆开。
const URL_TRAILING_PUNCTUATION = new Set([
  ...' \t\r\n"\'<>[]{}()，。！？；：、,.;:!?',
]);
const SHARE_TEXT_TRAILING_PUNCTUATION = new Set([...'，。,.、!！?？)']);
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/giu;
const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]+$/u;
const XIAOHONGSHU_NOTE_ID_PATTERN = /[0-9a-f]{24}/iu;
const YOUTUBE_MEDIA_URL_PATTERN =
  /https?:\/\/[^\s"'<>]*(?:googlevideo\.com|videoplayback)[^\s"'<>]*/giu;
const YOUTUBE_COOKIE_HINT_PATTERN =
  /\s*(?:use|using|try|pass)?\s*--cookies(?:-from-browser)?[^.\n]*(?:\.|$)/giu;
const PYTHON_WHITESPACE_RUN = /[\u0009-\u000d\u001c-\u001f\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu;
const AWEME_ID_PATTERNS: readonly RegExp[] = [
  /[?&](?:modal_id|aweme_id)=(\d+)(?:[&#]|$)/u,
  /(?:^|\/)(?:video|note)\/(\d+)(?:[/?#]|$)/u,
  /(?:^|\/)share\/slides\/(\d+)(?:[/?#]|$)/u,
  /[?&]aweme_id=(\d+)(?:[&#]|$)/u,
];

const DOUYIN_FALLBACK_MARKERS: readonly string[] = [
  'expecting value',
  'fresh cookies',
  'aweme/v1/web/aweme/detail',
  'web detail',
  'webpage detail',
  'empty',
  'json',
];

const FAILURE_CLASSIFICATIONS: readonly {
  readonly code: string;
  readonly markers: readonly string[];
}[] = [
  {
    code: 'YOUTUBE_AGE_RESTRICTED',
    markers: ['age-restricted', 'age restricted', 'confirm your age', 'age verification'],
  },
  {code: 'YOUTUBE_RATE_LIMITED', markers: ['http error 429', 'too many requests']},
  {
    code: 'YOUTUBE_LOGIN_REQUIRED',
    markers: [
      'sign in', 'login', 'logged in', 'not a bot', 'captcha', 'cookie', 'cookies',
      'authentication', 'verify you are',
    ],
  },
  {
    code: 'YOUTUBE_NO_PLAYABLE_STREAM',
    markers: [
      'no video formats', 'no formats found', 'no playable',
      'requested format is not available', 'format is not available',
    ],
  },
  {
    code: 'YOUTUBE_PRIVATE_OR_UNAVAILABLE',
    markers: [
      'private video', 'video unavailable', 'unavailable', 'has been removed',
      'members-only', 'member-only', 'not available',
    ],
  },
  {code: 'YOUTUBE_STREAM_FORBIDDEN', markers: ['http error 403', '403: forbidden']},
];

function rstripChars(value: string, characters: ReadonlySet<string>): string {
  const points = [...value];
  while (points.length > 0 && characters.has(points[points.length - 1])) points.pop();
  return points.join('');
}

/** `media._iter_url_candidates`：两次 rstrip 的顺序与字符集不能合并。 */
export function iterUrlCandidates(rawInput: string): string[] {
  const matches = rawInput.matchAll(URL_PATTERN);
  const result: string[] = [];
  for (const match of matches) {
    result.push(rstripChars(
      rstripChars(match[0], SHARE_TEXT_TRAILING_PUNCTUATION),
      URL_TRAILING_PUNCTUATION,
    ));
  }
  return result;
}

function candidateHost(candidate: string): string {
  // Python 的 `urlparse(...).hostname` 不校验端口；解析失败时按空 host 处理，
  // 与宿主里既有的 `sourceHost` 一致。
  try {
    return (splitUrl(candidate).hostname ?? '').toLowerCase().replace(/\.+$/u, '');
  } catch {
    return '';
  }
}

function hostMatchesSuffixes(host: string, suffixes: readonly string[]): boolean {
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export function containsSupportedUrl(rawInput: string, hostSuffixes: readonly string[]): boolean {
  for (const candidate of iterUrlCandidates(rawInput)) {
    if (hostMatchesSuffixes(candidateHost(candidate), hostSuffixes)) return true;
  }
  return false;
}

/** Python `parse_qs` 默认丢弃空值项，与 `parseQsl(keep_blank_values=True)` 的差别在这里收敛。 */
function firstQueryValue(query: string, key: string): string {
  for (const item of parseQsl(query, Number.MAX_SAFE_INTEGER)) {
    if (item.key === key && item.value !== '') return item.value;
  }
  return '';
}

function isYoutubeVideoId(value: string): boolean {
  return value.length > 0 && YOUTUBE_VIDEO_ID_PATTERN.test(value);
}

function isSupportedYoutubeVideoUrl(candidate: string): boolean {
  const parsed = splitUrl(candidate);
  if (parsed.scheme !== 'http' && parsed.scheme !== 'https') return false;
  const host = (parsed.hostname ?? '').toLowerCase().replace(/\.+$/u, '');
  const normalizedPath = parsed.path.replace(/\/+$/u, '');
  const segments = normalizedPath.split('/').filter((segment) => segment.length > 0);
  if (YOUTUBE_SHORT_HOSTS.includes(host)) {
    return segments.length === 1 && isYoutubeVideoId(segments[0]);
  }
  if (!YOUTUBE_HOSTS.includes(host)) return false;
  if (normalizedPath === '/watch') {
    return isYoutubeVideoId(firstQueryValue(parsed.query, 'v'));
  }
  return segments.length === 2 && segments[0] === 'shorts' && isYoutubeVideoId(segments[1]);
}

export function shouldAttemptYoutubeProcessing(url: string): boolean {
  return iterUrlCandidates(url).some(isSupportedYoutubeVideoUrl);
}

/** `Path(output_dir) / "%(id)s.%(ext)s"` 后取 `as_posix()`：折叠 `.` 与重复斜杠，保留 `..`。 */
export function outputTemplate(outputDir: string): string {
  const posix = outputDir.replaceAll('\\', '/');
  const absolute = posix.startsWith('/');
  const parts = posix.split('/').filter((part) => part.length > 0 && part !== '.');
  let prefix = '';
  if (absolute) {
    prefix = '/';
  } else if (/^[A-Za-z]:$/u.test(parts[0] ?? '')) {
    prefix = `${parts.shift()}/`;
  }
  const base = `${prefix}${parts.join('/')}`;
  const file = '%(id)s.%(ext)s';
  if (base === '') return file;
  if (base.endsWith('/')) return `${base}${file}`;
  return `${base}/${file}`;
}

export interface BuildYtdlpCommandOptions {
  readonly url: string;
  readonly outputDir: string;
  /** 官方独立 yt-dlp 可执行文件及其前置参数，由宿主注入。 */
  readonly launcher: readonly string[];
  readonly includeSubtitles?: boolean;
}

export function buildYtdlpCommand(options: BuildYtdlpCommandOptions): string[] {
  const {url, outputDir, launcher} = options;
  const includeSubtitles = options.includeSubtitles ?? true;
  const template = outputTemplate(outputDir);
  if (shouldAttemptYoutubeProcessing(url)) {
    const subtitleArgs = includeSubtitles ? PLATFORM_SUBTITLE_ARGS : [];
    return [
      ...launcher,
      '--no-playlist',
      '-f',
      YOUTUBE_FORMAT_SELECTOR,
      '--merge-output-format',
      'mp4',
      ...YOUTUBE_JS_RUNTIMES.flatMap((runtime) => ['--js-runtimes', runtime]),
      ...subtitleArgs,
      '-o',
      template,
      url,
    ];
  }
  const subtitleArgs = includeSubtitles && containsSupportedUrl(url, BILIBILI_HOST_SUFFIXES)
    ? PLATFORM_SUBTITLE_ARGS
    : [];
  return [...launcher, '--no-playlist', ...subtitleArgs, '-o', template, url];
}

export function extractDouyinVideoId(url: string): string | null {
  for (const pattern of AWEME_ID_PATTERNS) {
    const match = pattern.exec(url);
    if (match) return match[1];
  }
  return null;
}

export function extractXiaohongshuNoteId(source: string): string | null {
  const match = XIAOHONGSHU_NOTE_ID_PATTERN.exec(source);
  return match ? match[0].toLowerCase() : null;
}

function containsSupportedDouyinAwemeId(rawInput: string): boolean {
  for (const match of rawInput.matchAll(URL_PATTERN)) {
    const candidate = rstripChars(match[0], URL_TRAILING_PUNCTUATION);
    if (!hostMatchesSuffixes(candidateHost(candidate), DOUYIN_HOST_SUFFIXES)) continue;
    if (extractDouyinVideoId(candidate) !== null) return true;
  }
  return false;
}

export function shouldAttemptDouyinFallback(url: string, failureMessage: string): boolean {
  if (!containsSupportedUrl(url, DOUYIN_HOST_SUFFIXES)) return false;
  if (containsSupportedDouyinAwemeId(url)) return true;
  const normalized = failureMessage.toLowerCase();
  return DOUYIN_FALLBACK_MARKERS.some((marker) => normalized.includes(marker));
}

export function shouldAttemptXiaohongshuFallback(url: string, failureMessage: string): boolean {
  return stripPythonSpace(failureMessage).length > 0
    && containsSupportedUrl(url, XIAOHONGSHU_HOST_SUFFIXES);
}

export function shouldAttemptBilibiliFallback(url: string, failureMessage: string): boolean {
  return stripPythonSpace(failureMessage).length > 0
    && containsSupportedUrl(url, BILIBILI_HOST_SUFFIXES);
}

export function sanitizeYoutubeError(message: string): string {
  const withoutMediaUrls = message.replaceAll(
    YOUTUBE_MEDIA_URL_PATTERN,
    '[youtube media url removed]',
  );
  const withoutCookieHints = withoutMediaUrls.replaceAll(YOUTUBE_COOKIE_HINT_PATTERN, ' ');
  return stripPythonSpace(withoutCookieHints.replaceAll(PYTHON_WHITESPACE_RUN, ' '));
}

export function classifyYoutubeDownloadFailure(result: CommandResult): CommandResult {
  const rawMessage = result.stderr || result.stdout || YOUTUBE_DOWNLOAD_FAILED_MESSAGE;
  const normalized = rawMessage.toLowerCase();
  const code = FAILURE_CLASSIFICATIONS.find(
    (entry) => entry.markers.some((marker) => normalized.includes(marker)),
  )?.code ?? 'YOUTUBE_DOWNLOAD_FAILED';
  const sanitized = sanitizeYoutubeError(rawMessage) || YOUTUBE_DOWNLOAD_FAILED_MESSAGE;
  return {...result, stderr: `${code}: ${sanitized}`};
}

export function isYoutubeSubtitleDownloadFailure(message: string): boolean {
  return message.toLowerCase().includes('unable to download video subtitles');
}

export function isRetryableYoutubeFailure(result: CommandResult): boolean {
  const code = structuredErrorCode(classifyYoutubeDownloadFailure(result).stderr);
  return code === 'YOUTUBE_DOWNLOAD_FAILED' || code === 'YOUTUBE_STREAM_FORBIDDEN';
}
