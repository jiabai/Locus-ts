"""Generate the cross-language golden for the Xiaohongshu transport layer.

Covers note ID and short-link resolution, page status mapping, response decoding,
initial-state extraction, stream candidate ranking, subtitle track selection and
the full download orchestration with a fake client.
"""

from __future__ import annotations

import gzip
import json
import sys
import tempfile
import zlib
from pathlib import Path

import brotli

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "worker"))

from worker_core.download_reliability import SafeDownloadError  # noqa: E402
from worker_core.xiaohongshu import subtitles  # noqa: E402
from worker_core.xiaohongshu.page import (  # noqa: E402
    XHS_MAX_HTML_BYTES,
    decode_response_body,
    extract_initial_state,
    is_image_only_note,
    js_to_json,
    lookup_note,
    raise_for_page_response,
)
from worker_core.xiaohongshu.source import (  # noqa: E402
    XHS_BASE_URL,
    XHS_MAX_REDIRECT_DEPTH,
    XHS_SHORT_HOSTS,
    XHS_TRAILING_URL_PUNCTUATION,
    build_explore_url,
    parse_xiaohongshu_source,
)
from worker_core.xiaohongshu.streams import (  # noqa: E402
    collect_download_urls,
    parse_video_streams,
)
from worker_core.xiaohongshu.subtitles import (  # noqa: E402
    PREFERRED_SUBTITLE_GROUPS,
    SUBTITLE_HOST_SUFFIXES,
    is_allowed_subtitle_url,
    select_preferred_subtitle_track,
)
from worker_core.xiaohongshu.transport import (  # noqa: E402
    XHS_DESKTOP_USER_AGENT,
    XHS_DOWNLOAD_CHUNK_BYTES,
    XHS_MAX_SUBTITLE_BYTES,
    XHS_MAX_VIDEO_BYTES,
    XHS_NO_PROGRESS_TIMEOUT_SECONDS,
    XHS_REFERER,
    XHS_SUBTITLE_CONTENT_TYPES,
    XHS_SUBTITLE_HOST_SUFFIXES,
    map_download_error,
    media_headers,
    page_headers,
)
from worker_core.xiaohongshu.types import (  # noqa: E402
    HttpResponse,
    XiaohongshuFallbackError,
)
from worker_core.xiaohongshu_fallback import (  # noqa: E402
    download_xiaohongshu_subtitle,
    download_xiaohongshu_video,
)

FIXTURE = ROOT / "worker-ts" / "tests" / "fixtures" / "xiaohongshu-golden.json"
NOTE_ID = "0123456789abcdef01234567"
OTHER_NOTE_ID = "fedcba9876543210fedcba98"
NOTE_URL = f"https://www.xiaohongshu.com/explore/{NOTE_ID}"
SHARE_TEXT = (
    "67 小红书发布了一篇笔记，快来看吧！ 😆 abc"
    f" {NOTE_URL}?xsec_token=ABCdef123&xsec_source=pc_share"
)


class FakeClient:
    def __init__(self, responses=None, downloads=None):
        self.responses = {url: list(items) for url, items in (responses or {}).items()}
        self.downloads = {url: list(items) for url, items in (downloads or {}).items()}
        self.calls = []
        self.download_calls = []

    def get(self, url, headers=None, timeout_seconds=10.0):
        self.calls.append({"url": url, "headers": dict(headers or {})})
        items = self.responses.get(url)
        if not items:
            raise AssertionError(f"Unexpected URL: {url}")
        item = items.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    def download_to_path(
        self,
        url,
        destination,
        headers=None,
        timeout_seconds=30.0,
        max_bytes=None,
        no_progress_timeout_seconds=None,
        allowed_content_types=None,
        allowed_host_suffixes=None,
    ):
        self.download_calls.append({
            "url": url,
            "destination": Path(destination).name,
            "headers": dict(headers or {}),
            "timeout_seconds": timeout_seconds,
            "max_bytes": max_bytes,
            "no_progress_timeout_seconds": no_progress_timeout_seconds,
            "allowed_content_types": list(allowed_content_types or []),
            "allowed_host_suffixes": list(allowed_host_suffixes or []),
        })
        items = self.downloads.get(url)
        if not items:
            raise AssertionError(f"Unexpected download URL: {url}")
        item = items.pop(0)
        if isinstance(item, Exception):
            raise item
        Path(destination).write_bytes(bytes(item))
        return len(item)


def error_dict(exc):
    return {"code": exc.code, "message": str(exc)}


def serialize_response(item):
    if isinstance(item, Exception):
        if isinstance(item, (XiaohongshuFallbackError, SafeDownloadError)):
            return {"error": error_dict(item)}
        return {"error": {"code": "UNEXPECTED", "message": str(item)}}
    return {
        "status": item.status,
        "headers": dict(item.headers),
        "body": item.body.decode("latin-1"),
        "url": item.url,
    }


def serialize_responses(responses):
    return {
        url: [serialize_response(item) for item in items]
        for url, items in (responses or {}).items()
    }


def serialize_downloads(downloads):
    return {
        url: [download_dict(item) for item in items]
        for url, items in (downloads or {}).items()
    }


def html_response(body, status=200, headers=None, url=""):
    data = body.encode("utf-8") if isinstance(body, str) else body
    return HttpResponse(
        status=status,
        headers=headers if headers is not None else {"Content-Type": "text/html"},
        body=data,
        url=url,
    )


def redirect_response(location, url):
    return HttpResponse(
        status=302,
        headers={"Location": location},
        body=b"",
        url=url,
    )


def stream_item(**overrides):
    item = {
        "masterUrl": "https://sns-video-bd.xhscdn.com/stream/1080.mp4",
        "backupUrls": ["https://sns-video-hw.xhscdn.com/stream/1080.mp4"],
        "streamType": 259,
        "qualityType": "hd",
        "size": 5_000_000,
        "width": 1080,
        "height": 1920,
        "videoCodec": "h264",
        "videoBitrate": 2_000_000,
        "weight": 10,
        "defaultStream": 1,
    }
    item.update(overrides)
    return item


def note_obj(
    *,
    stream=None,
    image_list=None,
    note_type="video",
    media_v2=None,
):
    video = {}
    if stream is not None:
        video["media"] = {"stream": stream}
    if media_v2 is not None:
        video["mediaV2"] = json.dumps(media_v2, ensure_ascii=False)
    note = {"type": note_type, "video": video}
    if image_list is not None:
        note["imageList"] = image_list
    return note


def page_html(note, note_id=NOTE_ID):
    state = {"note": {"noteDetailMap": {note_id: {"note": note}}}}
    return (
        "<html><head><title>小红书</title></head><body><script>"
        f"window.__INITIAL_STATE__ = {json.dumps(state, ensure_ascii=False)};"
        "</script></body></html>"
    )


def page_for(note, note_id=NOTE_ID):
    return html_response(page_html(note, note_id), url=build_explore_url(note_id))


def subtitle_track(url=None, language=None, fmt=None):
    track = {"url": url or "https://sns-subtitle.xhscdn.com/stream/subtitle/abc"}
    if language is not None:
        track["language"] = language
    if fmt is not None:
        track["format"] = fmt
    return track


def parse_case(label, raw_input, responses=None):
    client = FakeClient(responses=responses)
    try:
        parsed = parse_xiaohongshu_source(
            raw_input,
            http_client=client,
            client_factory=FakeClient,
        )
        result = {
            "parsed": {
                "note_id": parsed.note_id,
                "full_url": parsed.full_url,
                "xsec_token": parsed.xsec_token,
            },
        }
    except XiaohongshuFallbackError as exc:
        result = {"error": error_dict(exc)}
    return {
        "label": label,
        "input": raw_input,
        "result": result,
        "responses": serialize_responses(responses),
        "get_calls": client.calls,
    }


def run_source_cases():
    short_responses = {
        "https://xhslink.com/aBcDeF": [
            redirect_response(NOTE_URL, "https://xhslink.com/aBcDeF"),
        ],
        "http://xhslink.com/httpOnly": [
            SafeDownloadError("DOWNLOAD_HTTP_STATUS_INVALID", "insecure"),
        ],
        "https://xhslink.com/httpOnly": [
            redirect_response(f"{NOTE_URL}?xsec_token=tok123", "https://xhslink.com/httpOnly"),
        ],
        "https://xhslink.com/embedded": [
            html_response(
                f'<html><script>window.location.replace("{NOTE_URL}?xsec_token=emb")</script></html>',
                url="https://xhslink.com/embedded",
            ),
        ],
        "https://xhslink.com/foreign": [
            redirect_response(f"https://example.com/explore/{NOTE_ID}", "https://xhslink.com/foreign"),
        ],
        "https://xhslink.com/ftp": [
            redirect_response(f"ftp://www.xiaohongshu.com/explore/{NOTE_ID}", "https://xhslink.com/ftp"),
        ],
        "https://xhslink.com/noNote": [
            html_response("<html>nothing here</html>", url="https://xhslink.com/noNote"),
        ],
    }
    chain = ["https://xhslink.com/l0"]
    for index in range(1, 7):
        chain.append(f"https://xhslink.com/l{index}")
    chain_responses = {}
    for index in range(6):
        chain_responses[chain[index]] = [redirect_response(chain[index + 1], chain[index])]

    return [
        parse_case("bare note id", NOTE_ID),
        parse_case("upper case note id", NOTE_ID.upper()),
        parse_case("explore url", NOTE_URL),
        parse_case(
            "explore url with token",
            f"{NOTE_URL}?xsec_token=ABCdef123&xsec_source=pc_share",
        ),
        parse_case(
            "discovery item url",
            f"https://www.xiaohongshu.com/discovery/item/{NOTE_ID}?xsec_token=t",
        ),
        parse_case("share text", SHARE_TEXT),
        parse_case(
            "share text with chinese punctuation",
            f"看这个{NOTE_URL}，很有意思。",
        ),
        parse_case("html escaped ampersand", f"{NOTE_URL}?xsec_token=a&amp;b"),
        parse_case(
            "short link with location",
            "https://xhslink.com/aBcDeF",
            short_responses,
        ),
        parse_case(
            "short link http falls back to https",
            "http://xhslink.com/httpOnly",
            short_responses,
        ),
        parse_case(
            "short link with embedded url",
            "https://xhslink.com/embedded",
            short_responses,
        ),
        parse_case(
            "short link to foreign host",
            "https://xhslink.com/foreign",
            short_responses,
        ),
        parse_case(
            "short link to ftp scheme",
            "https://xhslink.com/ftp",
            short_responses,
        ),
        parse_case(
            "short link without note url",
            "https://xhslink.com/noNote",
            short_responses,
        ),
        parse_case("too many redirects", chain[0], chain_responses),
        parse_case("non xiaohongshu host", "https://example.com/explore/" + NOTE_ID),
        parse_case("ftp scheme", "ftp://www.xiaohongshu.com/explore/" + NOTE_ID),
        parse_case("url without note id", "https://www.xiaohongshu.com/user/profile/abc"),
        parse_case("plain text without url", "just some text"),
        parse_case("empty input", ""),
        parse_case("uppercase host", f"https://WWW.XIAOHONGSHU.COM/explore/{NOTE_ID}"),
        parse_case("trailing dot host", f"https://www.xiaohongshu.com./explore/{NOTE_ID}"),
    ]


def run_build_url_cases():
    return [
        {"label": "plain", "note_id": NOTE_ID, "token": "", "base_url": XHS_BASE_URL},
        {"label": "with token", "note_id": NOTE_ID, "token": "ABCdef123", "base_url": XHS_BASE_URL},
        {
            "label": "trailing slash base",
            "note_id": NOTE_ID,
            "token": " tok ",
            "base_url": "https://www.xiaohongshu.com/",
        },
    ]


def run_page_cases():
    statuses = [
        ("ok", html_response("<html>hi</html>")),
        ("empty body", html_response(b"")),
        ("not found", html_response("<html>404</html>", status=404)),
        ("forbidden", html_response("<html>403</html>", status=403)),
        ("unauthorized", html_response("<html>401</html>", status=401)),
        ("rate limited", html_response("<html>429</html>", status=429)),
        ("server error", html_response("<html>500</html>", status=500)),
        ("redirect", html_response("<html>302</html>", status=302)),
    ]
    cases = []
    for label, response in statuses:
        try:
            raise_for_page_response(response)
            result = {"ok": True}
        except XiaohongshuFallbackError as exc:
            result = {"error": error_dict(exc)}
        cases.append({
            "label": label,
            "status": response.status,
            "body": response.body.decode("latin-1"),
            "headers": dict(response.headers),
            "result": result,
        })

    payload = "<html>解码内容</html>".encode()
    decode_cases = [
        ("plain", payload, {}),
        ("gzip", gzip.compress(payload), {"Content-Encoding": "gzip"}),
        ("br", brotli.compress(payload), {"Content-Encoding": "br"}),
        ("deflate", zlib.compress(payload), {"Content-Encoding": "deflate"}),
        ("raw deflate", zlib.compress(payload)[2:-4], {"Content-Encoding": "deflate"}),
        (
            "encoding list",
            gzip.compress(payload),
            {"Content-Encoding": "gzip, br"},
        ),
        ("broken gzip", b"not gzip", {"Content-Encoding": "gzip"}),
        ("unknown encoding", payload, {"Content-Encoding": "zstd"}),
        ("invalid utf8", b"\xff\xfe<html>", {}),
    ]
    decoded = []
    for label, body, headers in decode_cases:
        try:
            text = decode_response_body(html_response(body, headers=headers))
            result = {"text": text}
        except XiaohongshuFallbackError as exc:
            result = {"error": error_dict(exc)}
        decoded.append({
            "label": label,
            "body": body.decode("latin-1"),
            "headers": dict(headers),
            "result": result,
        })

    too_large = decode_response_body(html_response(b"x" * 8), max_bytes=16)
    try:
        decode_response_body(html_response(b"x" * 17), max_bytes=16)
        oversize = {"ok": True}
    except XiaohongshuFallbackError as exc:
        oversize = {"error": error_dict(exc)}

    return {
        "statuses": cases,
        "decodes": decoded,
        "limit": {
            "within": too_large,
            "within_body": (b"x" * 8).decode("latin-1"),
            "within_max_bytes": 16,
            "exceeded": oversize,
            "exceeded_body": (b"x" * 17).decode("latin-1"),
            "exceeded_max_bytes": 16,
        },
        "max_html_bytes": XHS_MAX_HTML_BYTES,
    }


def run_state_cases():
    note = note_obj(stream=[stream_item()])
    valid = page_html(note)
    cases = []

    def run(label, body, note_id=NOTE_ID):
        try:
            state = extract_initial_state(body)
            found = lookup_note(state, note_id)
            result = {"note_keys": sorted(found.keys()), "type": found.get("type")}
        except XiaohongshuFallbackError as exc:
            result = {"error": error_dict(exc)}
        cases.append({
            "label": label,
            "body": body,
            "note_id": note_id,
            "result": result,
        })

    run("valid", valid)
    run("missing marker", "<html><body>nothing</body></html>")
    run("error code marker", "<html>error_code: -100</html>")
    run("blocked text", "<html>当前笔记暂时无法浏览</html>")
    run("malformed json", "<html>window.__INITIAL_STATE__ = {oops}</html>")
    run("array state", "<html>window.__INITIAL_STATE__ = []</html>")
    run("incomplete object", "<html>window.__INITIAL_STATE__ = {\"note\": </html>")
    run("unknown note id", valid, OTHER_NOTE_ID)

    js_cases = [
        ("undefined value", '{"a": undefined, "b": 1}'),
        ("void expression", '{"a": void 0, "b": 1}'),
        ("undefined at end", '{"a": undefined}'),
        ("trailing comma", '{"a": 1, "b": [1, 2,], }'),
        ("string keeps text", '{"a": "undefined", "b": "void 0"}'),
    ]
    converted = []
    for label, raw in js_cases:
        converted.append({"label": label, "input": raw, "result": js_to_json(raw)})

    image_cases = [
        ("video note", note_obj(stream=[stream_item()])),
        ("image type", note_obj(note_type="image", image_list=[{"url": "x"}])),
        ("image list only", note_obj(note_type="video", image_list=[])),
        ("album type", note_obj(note_type="album")),
        ("unknown type", note_obj(note_type="")),
    ]
    images = [
        {"label": label, "note": value, "result": is_image_only_note(value)}
        for label, value in image_cases
    ]
    return {"states": cases, "js_to_json": converted, "is_image_only": images}


def run_stream_cases():
    cases = []

    def run(label, note, note_id=NOTE_ID):
        try:
            candidates = parse_video_streams(note, candidate_headers=media_headers())
            result = {"candidates": [candidate_dict(value) for value in candidates]}
        except XiaohongshuFallbackError as exc:
            result = {"error": error_dict(exc)}
        cases.append({"label": label, "note": note, "result": result})

    run("single stream", note_obj(stream=[stream_item()]))
    run(
        "mapping form without codec",
        note_obj(
            stream={
                "h265": [stream_item(videoCodec="", streamType=115, qualityType="", size=9)],
                "avc": [stream_item(videoCodec="", streamType=259, size=4)],
            },
        ),
    )
    run(
        "same quality keeps better",
        note_obj(
            stream=[
                stream_item(size=1, videoBitrate=1, width=720, height=1280),
                stream_item(size=9, videoBitrate=9, width=1080, height=1920, weight=20),
            ],
        ),
    )
    run(
        "stream without url is dropped",
        note_obj(
            stream=[
                stream_item(masterUrl="   ", backupUrls=[]),
                stream_item(masterUrl="https://sns-video-bd.xhscdn.com/only.mp4"),
            ],
        ),
    )
    run("no video mapping", note_obj(note_type="image", image_list=[]))
    run("empty stream list", note_obj(stream=[]))
    run(
        "stream type without quality name",
        note_obj(stream=[stream_item(qualityType="", streamType=114, size=7)]),
    )
    run(
        "numeric like strings",
        note_obj(
            stream=[stream_item(size="123", width="1080", height=" 1920 ", weight=1.9)],
        ),
    )

    urls = [
        ("dedupe", "https://a/1.mp4", ["https://a/1.mp4", " https://b/2.mp4 ", "", "https://b/2.mp4"]),
        ("empty primary", "", ["https://b/2.mp4"]),
        ("none", "", []),
    ]
    collected = [
        {"label": label, "primary": primary, "backups": backups,
         "result": collect_download_urls(primary, backups)}
        for label, primary, backups in urls
    ]
    return {"candidates": cases, "collect": collected}


def candidate_dict(candidate):
    return {
        "quality_key": candidate.quality_key,
        "url": candidate.url,
        "backup_urls": list(candidate.backup_urls),
        "size_bytes": candidate.size_bytes,
        "width": candidate.width,
        "height": candidate.height,
        "video_codec": candidate.video_codec,
        "video_bitrate": candidate.video_bitrate,
        "stream_type": candidate.stream_type,
        "weight": candidate.weight,
        "default_stream": candidate.default_stream,
        "headers": dict(candidate.headers),
    }


def run_subtitle_cases():
    allowed = [
        ("cdn https", "https://sns-subtitle.xhscdn.com/a.srt"),
        ("xiaohongshu https", "https://www.xiaohongshu.com/a.srt"),
        ("http", "http://sns-subtitle.xhscdn.com/a.srt"),
        ("other host", "https://example.com/a.srt"),
        ("userinfo", "https://user:pw@sns-subtitle.xhscdn.com/a.srt"),
        ("malformed", "https://[::1/a.srt"),
        ("relative", "/a.srt"),
    ]
    allowed_cases = [
        {"label": label, "url": url, "result": is_allowed_subtitle_url(url)}
        for label, url in allowed
    ]

    languages = ["zh-Hans", "zh_CN", "EN-us", "en", "zh-Hant", "ja", "ko", "x", "toolongcode",
                 "zh-Hans-CN-x", "src", "", None]
    language_cases = [
        {"input": value, "result": subtitles._normalise_language(value)} for value in languages
    ]

    def selection(label, note):
        try:
            track = select_preferred_subtitle_track(note)
            result = None if track is None else {
                "language": track.language,
                "url": track.url,
                "suffix": track.suffix,
            }
        except XiaohongshuFallbackError as exc:
            result = {"error": error_dict(exc)}
        return {"label": label, "note": note, "result": result}

    cases = [
        selection("no mediaV2", note_obj(stream=[stream_item()])),
        selection(
            "broken mediaV2",
            note_obj(stream=[stream_item()], media_v2="not json"),
        ),
        selection(
            "preferred order",
            note_obj(
                stream=[stream_item()],
                media_v2={
                    "video": {
                        "subtitles": {
                            "zh-Hans": [subtitle_track(language="zh-Hans")],
                            "source": [subtitle_track(language="en-US", fmt="vtt")],
                        },
                    },
                },
            ),
        ),
        selection(
            "source group without language",
            note_obj(
                stream=[stream_item()],
                media_v2={"video": {"subtitles": {"source": [subtitle_track()]}}},
            ),
        ),
        selection(
            "group name as language",
            note_obj(
                stream=[stream_item()],
                media_v2={"video": {"subtitles": {"ja": [subtitle_track()]}}},
            ),
        ),
        selection(
            "explicit unsupported format",
            note_obj(
                stream=[stream_item()],
                media_v2={
                    "video": {
                        "subtitles": {"zh": [subtitle_track(fmt="ass"),
                                             subtitle_track(fmt="srt")]},
                    },
                },
            ),
        ),
        selection(
            "format zero falls back to path",
            note_obj(
                stream=[stream_item()],
                media_v2={
                    "video": {
                        "subtitles": {"zh": [subtitle_track(fmt=0)]},
                    },
                },
            ),
        ),
        selection(
            "path with other extension",
            note_obj(
                stream=[stream_item()],
                media_v2={
                    "video": {
                        "subtitles": {"zh": [subtitle_track(url="https://sns-subtitle.xhscdn.com/a.json")]},
                    },
                },
            ),
        ),
        selection(
            "disallowed host is skipped",
            note_obj(
                stream=[stream_item()],
                media_v2={
                    "video": {
                        "subtitles": {
                            "zh": [subtitle_track(url="https://example.com/a.srt")],
                            "en": [subtitle_track(url="https://sns-subtitle.xhscdn.com/b.srt")],
                        },
                    },
                },
            ),
        ),
    ]
    return {
        "allowed_urls": allowed_cases,
        "languages": language_cases,
        "selection": cases,
        "preferred_groups": list(PREFERRED_SUBTITLE_GROUPS),
        "host_suffixes": list(SUBTITLE_HOST_SUFFIXES),
    }


def download_dict(value):
    if isinstance(value, bytes):
        return {"payload": value.decode("latin-1")}
    if isinstance(value, SafeDownloadError):
        return {"kind": "safe", "code": value.code, "message": str(value)}
    if isinstance(value, XiaohongshuFallbackError):
        return {"kind": "xiaohongshu", "code": value.code, "message": str(value)}
    return {"kind": "other", "message": str(value)}


def run_full_downloads():
    video_bytes = b"fake-video-bytes"
    subtitle_bytes = b"1\n00:00:01,000 --> 00:00:02,000\nhello\n"
    primary = "https://sns-video-bd.xhscdn.com/stream/1080.mp4"
    backup = "https://sns-video-hw.xhscdn.com/stream/1080.mp4"
    second = "https://sns-video-bd.xhscdn.com/stream/720.mp4"
    subtitle_url = "https://sns-subtitle.xhscdn.com/stream/subtitle/abc"

    def build(label, note, downloads=None, with_subtitle=False, note_id=NOTE_ID):
        payload = json.loads(json.dumps(note))
        if with_subtitle:
            payload.setdefault("video", {})["mediaV2"] = json.dumps({
                "video": {
                    "subtitles": {
                        "zh-Hans": [subtitle_track(url=subtitle_url, language="zh-Hans")],
                    },
                },
            })
        responses = {build_explore_url(note_id): [page_for(payload, note_id)]}
        client = FakeClient(responses=responses, downloads=downloads or {})
        events = []
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            try:
                path = download_xiaohongshu_video(
                    NOTE_URL,
                    root,
                    http_client=client,
                    progress_callback=events.append,
                )
                files = sorted(item.name for item in root.iterdir())
                result = {"video": path.name, "files": files}
            except XiaohongshuFallbackError as exc:
                result = {"error": error_dict(exc)}
            except SafeDownloadError as exc:
                result = {"error": {"code": exc.code, "message": str(exc)}}
        return {
            "label": label,
            "result": result,
            "events": events,
            "responses": serialize_responses(responses),
            "downloads": serialize_downloads(downloads),
            "download_calls": client.download_calls,
        }

    single_stream = note_obj(stream=[stream_item()])
    two_candidates = note_obj(
        stream=[
            stream_item(masterUrl=primary, backupUrls=[backup], size=len(video_bytes)),
            stream_item(
                masterUrl=second,
                backupUrls=[],
                size=len(video_bytes),
                width=720,
                height=1280,
                qualityType="sd",
            ),
        ],
    )

    cases = [
        build(
            "happy path",
            single_stream,
            downloads={
                primary: [video_bytes],
                subtitle_url: [subtitle_bytes],
            },
            with_subtitle=True,
        ),
        build(
            "image only",
            note_obj(note_type="image", image_list=[]),
        ),
        build(
            "no playable stream",
            note_obj(note_type="video"),
        ),
        build(
            "all streams fail",
            single_stream,
            downloads={
                primary: [SafeDownloadError("DOWNLOAD_HTTP_STATUS_INVALID", "bad status")],
                backup: [SafeDownloadError("DOWNLOAD_INCOMPLETE", "short")],
            },
        ),
        build(
            "size exceeded",
            single_stream,
            downloads={
                primary: [SafeDownloadError("DOWNLOAD_SIZE_EXCEEDED", "too big")],
                backup: [SafeDownloadError("DOWNLOAD_SIZE_EXCEEDED", "too big")],
            },
        ),
        build(
            "stalled",
            single_stream,
            downloads={
                primary: [SafeDownloadError("DOWNLOAD_STALLED", "stalled")],
                backup: [SafeDownloadError("DOWNLOAD_STALLED", "stalled")],
            },
        ),
        build(
            "second candidate succeeds",
            two_candidates,
            downloads={
                primary: [SafeDownloadError("DOWNLOAD_HTTP_STATUS_INVALID", "bad status")],
                backup: [SafeDownloadError("DOWNLOAD_HTTP_STATUS_INVALID", "bad status")],
                second: [video_bytes],
            },
        ),
        build(
            "subtitle download fails silently",
            single_stream,
            downloads={
                primary: [video_bytes],
                subtitle_url: [SafeDownloadError("DOWNLOAD_SIZE_EXCEEDED", "too big")],
            },
            with_subtitle=True,
        ),
    ]
    return cases


def run_subtitle_probe():
    subtitle_bytes = b"1\n00:00:01,000 --> 00:00:02,000\nprobe\n"
    subtitle_url = "https://sns-subtitle.xhscdn.com/stream/subtitle/abc"
    note = note_obj(
        stream=[stream_item()],
        media_v2={
            "video": {
                "subtitles": {"zh-Hans": [subtitle_track(url=subtitle_url, language="zh-Hans")]},
            },
        },
    )
    cases = []
    for label, responses, downloads in [
        (
            "downloads preferred track",
            {build_explore_url(NOTE_ID): [page_for(note)]},
            {subtitle_url: [subtitle_bytes]},
        ),
        (
            "page blocked returns none",
            {build_explore_url(NOTE_ID): [html_response("<html>403</html>", status=403)]},
            {},
        ),
        (
            "note without subtitles returns none",
            {build_explore_url(NOTE_ID): [page_for(note_obj(stream=[stream_item()]))]},
            {},
        ),
        (
            "subtitle download failure returns none",
            {build_explore_url(NOTE_ID): [page_for(note)]},
            {subtitle_url: [SafeDownloadError("DOWNLOAD_HTTP_STATUS_INVALID", "bad status")]},
        ),
    ]:
        client = FakeClient(responses=responses, downloads=downloads)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = download_xiaohongshu_subtitle(NOTE_URL, root, http_client=client)
            result = None if path is None else {
                "name": path.name,
                "exists": path.is_file(),
                "text": path.read_text(encoding="utf-8") if path.is_file() else None,
            }
        cases.append({
            "label": label,
            "result": result,
            "responses": serialize_responses(responses),
            "downloads": serialize_downloads(downloads),
            "download_calls": client.download_calls,
            "get_calls": client.calls,
        })
    return cases


def run_download_error_mapping():
    cases = [
        ("size exceeded", SafeDownloadError("DOWNLOAD_SIZE_EXCEEDED", "big")),
        ("stalled", SafeDownloadError("DOWNLOAD_STALLED", "no progress")),
        ("invalid status", SafeDownloadError("DOWNLOAD_HTTP_STATUS_INVALID", "500")),
        ("incomplete", SafeDownloadError("DOWNLOAD_INCOMPLETE", "short")),
        ("no error", None),
        ("other error", RuntimeError("boom")),
    ]
    return [
        {"label": label, "source": None if error is None else {
            "code": getattr(error, "code", ""),
            "message": str(error),
        }, "result": error_dict(map_download_error(error))}
        for label, error in cases
    ]


def main():
    payload = {
        "constants": {
            "base_url": XHS_BASE_URL,
            "note_id": NOTE_ID,
            "note_url": NOTE_URL,
            "max_redirect_depth": XHS_MAX_REDIRECT_DEPTH,
            "short_hosts": sorted(XHS_SHORT_HOSTS),
            "trailing_url_punctuation": XHS_TRAILING_URL_PUNCTUATION,
            "max_html_bytes": XHS_MAX_HTML_BYTES,
            "max_video_bytes": XHS_MAX_VIDEO_BYTES,
            "max_subtitle_bytes": XHS_MAX_SUBTITLE_BYTES,
            "download_chunk_bytes": XHS_DOWNLOAD_CHUNK_BYTES,
            "no_progress_timeout_seconds": XHS_NO_PROGRESS_TIMEOUT_SECONDS,
            "desktop_user_agent": XHS_DESKTOP_USER_AGENT,
            "referer": XHS_REFERER,
            "subtitle_content_types": list(XHS_SUBTITLE_CONTENT_TYPES),
            "subtitle_host_suffixes": list(XHS_SUBTITLE_HOST_SUFFIXES),
            "preferred_subtitle_groups": list(PREFERRED_SUBTITLE_GROUPS),
            "page_headers": page_headers(),
            "media_headers": media_headers(),
        },
        "source": run_source_cases(),
        "build_urls": [
            {
                "label": case["label"],
                "note_id": case["note_id"],
                "token": case["token"],
                "base_url": case["base_url"],
                "result": build_explore_url(
                    case["note_id"],
                    case["token"],
                    base_url=case["base_url"],
                ),
            }
            for case in run_build_url_cases()
        ],
        "page": run_page_cases(),
        "state": run_state_cases(),
        "streams": run_stream_cases(),
        "subtitles": run_subtitle_cases(),
        "full_downloads": run_full_downloads(),
        "subtitle_probe": run_subtitle_probe(),
        "download_errors": run_download_error_mapping(),
    }
    FIXTURE.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"wrote {FIXTURE} with {len(payload['source'])} source cases")


if __name__ == "__main__":
    main()
