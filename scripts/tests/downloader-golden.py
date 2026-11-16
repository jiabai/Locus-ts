# 下载器确定性内核的 Python 基准生成器。
# 命令前缀归一化成占位符：TypeScript 侧调用官方独立可执行文件，Python 侧调用
# sys.executable -m yt_dlp，两者除前缀外的参数必须逐项相同。
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "worker"))

from worker_core import media  # noqa: E402

FIXTURE = ROOT / "worker-ts" / "tests" / "fixtures" / "downloader-golden.json"

YOUTUBE_WATCH = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
YOUTUBE_SHORT = "https://www.youtube.com/shorts/dQw4w9WgXcQ"
YOUTUBE_SHORT_HOST = "https://youtu.be/dQw4w9WgXcQ"
DOUYIN_VIDEO = "https://www.douyin.com/video/7524373044106677544"
BILIBILI_VIDEO = "https://www.bilibili.com/video/BV1Aa411c7mD"
XHS_NOTE = "https://www.xiaohongshu.com/explore/0123456789abcdef01234568"

COMMAND_CASES = [
    ("generic https", "https://example.com/watch/123", "outputs", True),
    ("douyin video", DOUYIN_VIDEO, "outputs", True),
    ("bilibili gets subtitle args", BILIBILI_VIDEO, "outputs", True),
    ("bilibili short host gets subtitle args", "https://b23.tv/BV1Aa411c7mD", "outputs", True),
    ("xiaohongshu has no subtitle args", XHS_NOTE, "outputs", True),
    ("youtube watch", YOUTUBE_WATCH, "outputs", True),
    ("youtube shorts", YOUTUBE_SHORT, "outputs", True),
    ("youtube short host", YOUTUBE_SHORT_HOST, "outputs", True),
    ("youtube without subtitles", YOUTUBE_WATCH, "outputs", False),
    ("bilibili without subtitles", BILIBILI_VIDEO, "outputs", False),
    ("output dir with trailing slash", "https://example.com/v", "outputs/", True),
    ("output dir with spaces", "https://example.com/v", "C:/Program Data/locus out", True),
    ("output dir windows backslash", "https://example.com/v", "C:\\Users\\locus\\outputs", True),
    ("url with query", "https://example.com/v?id=7&lang=zh", "outputs", True),
    ("uppercase scheme", "HTTPS://WWW.YOUTUBE.COM/WATCH?V=dQw4w9WgXcQ", "outputs", True),
    ("share text with two urls", f"看这个 {DOUYIN_VIDEO} 还有 {BILIBILI_VIDEO}。", "outputs", True),
]

YOUTUBE_CASES = [
    ("watch", YOUTUBE_WATCH),
    ("watch with extra query", "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42"),
    ("shorts", YOUTUBE_SHORT),
    ("short host", YOUTUBE_SHORT_HOST),
    ("short host with www", "https://www.youtu.be/dQw4w9WgXcQ"),
    ("mobile host", "https://m.youtube.com/watch?v=dQw4w9WgXcQ"),
    ("bare youtube.com", "https://youtube.com/watch?v=dQw4w9WgXcQ"),
    ("host with trailing dot", "https://www.youtube.com./watch?v=dQw4w9WgXcQ"),
    ("uppercase host", "https://WWW.YOUTUBE.COM/watch?v=dQw4w9WgXcQ"),
    ("unknown subdomain", "https://music.youtube.com/watch?v=dQw4w9WgXcQ"),
    ("no video id", "https://www.youtube.com/watch?v="),
    ("id with illegal char", "https://www.youtube.com/watch?v=abc$def"),
    ("id with slash", "https://www.youtube.com/watch?v=abc/def"),
    ("short host with two segments", "https://youtu.be/abc/def"),
    ("shorts with three segments", "https://www.youtube.com/shorts/id/extra"),
    ("empty v plus valid v", "https://www.youtube.com/watch?v=&v=dQw4w9WgXcQ"),
    ("douyin video", DOUYIN_VIDEO),
    ("bilibili video", BILIBILI_VIDEO),
    ("not http", "ftp://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    ("plain id", "dQw4w9WgXcQ"),
    ("embedded in share text", f"推荐 {YOUTUBE_WATCH} 给大家，。"),
    ("embedded with trailing punctuation", "https://youtu.be/dQw4w9WgXcQ)"),
    ("two urls one youtube", f"{DOUYIN_VIDEO} {YOUTUBE_SHORT_HOST}"),
    ("empty", ""),
]

FAILURE_CASES = [
    ("age restricted", "ERROR: This video is age-restricted.", ""),
    ("confirm your age", "Please confirm your age before watching.", ""),
    ("http 429", "ERROR: HTTP Error 429: Too Many Requests", ""),
    ("too many requests", "ERROR: too many requests", ""),
    ("sign in", "ERROR: Please sign in to continue", ""),
    ("not a bot", "ERROR: Sign in to confirm you’re not a bot", ""),
    ("captcha hint", "ERROR: Use --cookies-from-browser chrome to pass the captcha", ""),
    ("no video formats", "ERROR: No video formats found", ""),
    ("format not available", "ERROR: Requested format is not available", ""),
    ("private video", "ERROR: This is a private video", ""),
    ("unavailable", "ERROR: Video unavailable", ""),
    ("403", "ERROR: HTTP Error 403: Forbidden", ""),
    ("403 forbidden text", "ERROR: 403: Forbidden", ""),
    ("unknown failure", "ERROR: Something else went wrong", ""),
    ("empty stderr falls back to stdout", "", "plain stdout failure"),
    ("both empty", "", ""),
    ("uppercase marker", "ERROR: AGE-RESTRICTED VIDEO", ""),
    ("cookie hint removal", "ERROR: Try --cookies cookies.txt. Then retry.", ""),
    (
        "signed media url removal",
        "ERROR: https://r1.googlevideo.com/videoplayback?ip=1.2.3.4 failed",
        "",
    ),
]

SANITIZE_CASES = [
    ("plain", "  ERROR:   plain\nmessage  "),
    ("signed url", "https://rr.googlevideo.com/videoplayback?x=1&y=2 failed"),
    ("cookie hint", "Use --cookies-from-browser firefox. Then retry."),
    ("cookie hint no period", "Try --cookies cookies.txt and retry again"),
    ("multiple spaces", "a\t\tb   c"),
    ("empty", ""),
    ("only whitespace", " \t\r\n "),
    ("media url plus words", "before https://x.googlevideo.com/videoplayback?a=b after"),
]

FALLBACK_CASES = [
    ("douyin with aweme id empty failure", DOUYIN_VIDEO, ""),
    ("douyin with aweme id json failure", DOUYIN_VIDEO, "ERROR: Expecting value: line 1"),
    ("douyin short host no id", "https://v.douyin.com/iRabcdef/", "ERROR: empty response"),
    ("douyin fresh cookies", DOUYIN_VIDEO, "fresh cookies required"),
    ("douyin unrelated failure", DOUYIN_VIDEO, "ERROR: network unreachable"),
    ("douyin other host", BILIBILI_VIDEO, "ERROR: Expecting value"),
    (
        "douyin embedded short text",
        "分享 https://v.douyin.com/iRabcdef/ 给你",
        "ERROR: web detail json",
    ),
    ("xhs with failure", XHS_NOTE, "ERROR: unsupported url"),
    ("xhs no failure", XHS_NOTE, ""),
    ("xhs short host", "https://xhslink.com/a/abcdef", "ERROR: failed"),
    ("xhs cn short host", "https://xhslink.cn/a/abcdef", "  "),
    ("bilibili with failure", BILIBILI_VIDEO, "ERROR: failed"),
    ("bilibili no failure", BILIBILI_VIDEO, "   "),
    ("bilibili short host", "https://b23.tv/abcdef", "ERROR: failed"),
    ("unrelated host", "https://example.com/v", "ERROR: failed"),
    ("youtube", YOUTUBE_WATCH, "ERROR: failed"),
]

URL_CANDIDATE_CASES = [
    ("single", DOUYIN_VIDEO),
    ("two urls", f"{DOUYIN_VIDEO} {BILIBILI_VIDEO}"),
    ("trailing chinese punctuation", f"{DOUYIN_VIDEO}。！？"),
    ("trailing ascii punctuation", f"{DOUYIN_VIDEO},.;:!?"),
    ("trailing closing paren", f"{DOUYIN_VIDEO})"),
    ("trailing quote", f'"{DOUYIN_VIDEO}"'),
    ("uppercase scheme", "HTTPS://EXAMPLE.COM/V"),
    ("no url", "just some text"),
    ("empty", ""),
]

ID_CASES = [
    ("douyin video path", DOUYIN_VIDEO),
    ("douyin note path", "https://www.douyin.com/note/7524373044106677544"),
    ("douyin modal_id query", "https://www.douyin.com/?modal_id=7524373044106677544"),
    ("douyin slides", "https://www.douyin.com/share/slides/7524373044106677544"),
    ("douyin short digits", "https://www.douyin.com/video/12345"),
    ("douyin no id", "https://www.douyin.com/user/abc"),
    ("xhs explore", XHS_NOTE),
    ("xhs discovery item", "https://www.xiaohongshu.com/discovery/item/0123456789ABCDEF01234568"),
    ("xhs uppercase", "ABCDEF0123456789ABCDEF01"),
    ("xhs too short", "0123456789abcdef"),
    ("plain text", "nothing here"),
]


def normalized_command(url, output_dir, include_subtitles):
    command = media.build_ytdlp_command(
        url, Path(output_dir), include_subtitles=include_subtitles
    )
    assert command[:3] == [sys.executable, "-m", "yt_dlp"], command[:3]
    return ["<launcher>", *command[3:]]


def classify(stderr, stdout):
    result = media.classify_youtube_download_failure(
        media.CommandResult(command=["yt-dlp"], returncode=1, stdout=stdout, stderr=stderr)
    )
    return {"returncode": result.returncode, "stdout": result.stdout, "stderr": result.stderr}


def main():
    result = {
        "constants": {
            "youtube_format_selector": media.YOUTUBE_FORMAT_SELECTOR,
            "youtube_js_runtimes": list(media.YOUTUBE_JS_RUNTIMES),
            "platform_subtitle_args": list(media.PLATFORM_SUBTITLE_ARGS),
            "youtube_hosts": list(media.YOUTUBE_HOSTS),
            "youtube_short_hosts": list(media.YOUTUBE_SHORT_HOSTS),
            "douyin_host_suffixes": list(media.DOUYIN_HOST_SUFFIXES),
            "xiaohongshu_host_suffixes": list(media.XIAOHONGSHU_HOST_SUFFIXES),
            "bilibili_host_suffixes": list(media.BILIBILI_HOST_SUFFIXES),
            "downloaded_media_suffixes": list(media.DOWNLOADED_MEDIA_SUFFIXES),
            "ytdlp_timeout_seconds": media.YTDLP_DOWNLOAD_TIMEOUT_SECONDS,
            "ytdlp_timeout_code": media.YTDLP_DOWNLOAD_TIMEOUT_CODE,
            "url_trailing_punctuation": media.URL_TRAILING_PUNCTUATION,
            "youtube_video_id_pattern": media.YOUTUBE_VIDEO_ID_PATTERN.pattern,
        },
        "commands": [
            {"label": label, "url": url, "output_dir": output_dir,
             "include_subtitles": include, "command": normalized_command(url, output_dir, include)}
            for label, url, output_dir, include in COMMAND_CASES
        ],
        "youtube_processing": [
            {"label": label, "url": url, "result": media.should_attempt_youtube_processing(url)}
            for label, url in YOUTUBE_CASES
        ],
        "failures": [
            {"label": label, "stderr": stderr, "stdout": stdout, "result": classify(stderr, stdout)}
            for label, stderr, stdout in FAILURE_CASES
        ],
        "sanitize": [
            {"label": label, "message": message, "result": media.sanitize_youtube_error(message)}
            for label, message in SANITIZE_CASES
        ],
        "fallback_attempts": [
            {"label": label, "url": url, "failure_message": message,
             "douyin": media.should_attempt_douyin_fallback(url, message),
             "xiaohongshu": media.should_attempt_xiaohongshu_fallback(url, message),
             "bilibili": media.should_attempt_bilibili_fallback(url, message)}
            for label, url, message in FALLBACK_CASES
        ],
        "url_candidates": [
            {"label": label, "raw": raw, "result": media._iter_url_candidates(raw)}
            for label, raw in URL_CANDIDATE_CASES
        ],
        "ids": [
            {"label": label, "text": text,
             "douyin_id": media.extract_douyin_video_id(text),
             "xhs_note_id": media.extract_xiaohongshu_note_id(text)}
            for label, text in ID_CASES
        ],
    }
    FIXTURE.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {FIXTURE} with {len(result['commands'])} commands")


if __name__ == "__main__":
    main()
