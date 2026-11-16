"""Generate the cross-language golden for the Bilibili transport layer.

Covers BV/av parsing, short-link resolution, `view` / `playurl` parsing, DASH
selection, response decoding and the full download orchestration with a fake
client and a fake ffmpeg runner.
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

from worker_core import bilibili_fallback  # noqa: E402
from worker_core.bilibili.artifacts import (  # noqa: E402
    download_first_available_url,
    merge_dash_files,
)
from worker_core.bilibili.playback import (  # noqa: E402
    build_playurl_url,
    build_video_info_url,
    parse_playurl_response,
    parse_view_response,
    select_dash_stream_pair,
)
from worker_core.bilibili.source import (  # noqa: E402
    BILIBILI_MAX_REDIRECT_DEPTH,
    parse_bilibili_input,
)
from worker_core.bilibili.transport import (  # noqa: E402
    BILIBILI_DESKTOP_USER_AGENT,
    BILIBILI_MAX_RESPONSE_BYTES,
    BILIBILI_MAX_STREAM_BYTES,
    decode_response_body,
)
from worker_core.bilibili.types import (  # noqa: E402
    BilibiliFallbackError,
    CommandResult,
    HttpResponse,
)
from worker_core.download_reliability import SafeDownloadError  # noqa: E402

FIXTURE = ROOT / "worker-ts" / "tests" / "fixtures" / "bilibili-golden.json"
BVID = "BV1xx411c7mD"
VIDEO_URL = f"https://www.bilibili.com/video/{BVID}?p=2"
SHORT_URL = "https://b23.tv/abc123"


class FakeClient:
    def __init__(self, responses=None, downloads=None):
        self.responses = {url: list(items) for url, items in (responses or {}).items()}
        self.downloads = {url: list(items) for url, items in (downloads or {}).items()}
        self.calls = []
        self.download_calls = []

    def get(self, url, headers=None, timeout_seconds=10.0):
        self.calls.append({"url": url, "headers": headers or {}})
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
    ):
        self.download_calls.append({"url": url})
        items = self.downloads.get(url)
        if not items:
            raise AssertionError(f"Unexpected download URL: {url}")
        item = items.pop(0)
        if isinstance(item, Exception):
            raise item
        Path(destination).write_bytes(bytes(item))
        return len(item)


def download_item(value):
    if isinstance(value, bytes):
        return {"payload": value.decode("latin-1")}
    if isinstance(value, SafeDownloadError):
        return {"kind": "safe", "code": value.code, "message": str(value)}
    if isinstance(value, BilibiliFallbackError):
        return {"kind": "bilibili", "code": value.code, "message": str(value)}
    return {"kind": "other", "message": str(value)}


def normalize_command(command, root):
    root_posix = Path(root).as_posix()
    return [str(item).replace(root_posix, "<tmp>") for item in command]


def error_dict(exc):
    return {"code": exc.code, "message": str(exc)}


def response_dict(response):
    if isinstance(response, Exception):
        if isinstance(response, BilibiliFallbackError):
            return {"error": error_dict(response)}
        return {"error": {"code": "UNEXPECTED", "message": str(response)}}
    return {
        "status": response.status,
        "headers": response.headers,
        "body": response.body.decode("latin-1"),
        "url": response.url,
    }


def json_response(payload, status=200, headers=None):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    return HttpResponse(status, headers or {"Content-Type": "application/json"}, body, "")


def html_response(body, status=200, headers=None, url=""):
    data = body.encode("utf-8") if isinstance(body, str) else body
    return HttpResponse(status, headers or {"Content-Type": "text/html"}, data, url)


def parse_case(label, raw_input, responses=None):
    client = FakeClient(responses=responses)
    try:
        parsed = parse_bilibili_input(raw_input, client)
        result = {"parsed": {
            "video_id": parsed.video_id,
            "id_kind": parsed.id_kind,
            "part_index": parsed.part_index,
            "full_url": parsed.full_url,
        }}
    except BilibiliFallbackError as exc:
        result = {"error": error_dict(exc)}
    return {
        "label": label,
        "input": raw_input,
        "responses": {
            url: [response_dict(item) for item in items]
            for url, items in (responses or {}).items()
        },
        "result": result,
        "get_calls": [call["url"] for call in client.calls],
    }


def parse_cases():
    location_target = f"https://www.bilibili.com/video/{BVID}"
    embedded_html = (
        f'<html><a href="https://www.bilibili.com/video/{BVID}?p=3">video</a></html>'
    )
    redirect = HttpResponse(302, {"Location": location_target}, b"", SHORT_URL)
    final = HttpResponse(200, {}, b"", f"https://www.bilibili.com/video/{BVID}")
    embedded = html_response(embedded_html, url=SHORT_URL)
    secure_redirect = HttpResponse(302, {"Location": location_target}, b"", SHORT_URL)

    return [
        parse_case("plain bvid", BVID),
        parse_case("plain avid", "av170001"),
        parse_case("uppercase bvid", "bv1xx411c7md"),
        parse_case("video url with part", VIDEO_URL),
        parse_case("video url without part", f"https://www.bilibili.com/video/{BVID}"),
        parse_case("video url with bad part", f"https://www.bilibili.com/video/{BVID}?p=abc"),
        parse_case("video url with zero part", f"https://www.bilibili.com/video/{BVID}?p=0"),
        parse_case("short link redirect", SHORT_URL, {SHORT_URL: [redirect]}),
        parse_case("short link final url", SHORT_URL, {SHORT_URL: [final]}),
        parse_case("short link embedded link", SHORT_URL, {SHORT_URL: [embedded]}),
        parse_case("short link http upgraded to https",
                   "http://b23.tv/abc123",
                   {"http://b23.tv/abc123": [BilibiliFallbackError(
                       "BILIBILI_VIDEO_INFO_UNAVAILABLE", "boom")],
                    "https://b23.tv/abc123": [secure_redirect]}),
        parse_case("short link unresolvable", SHORT_URL, {SHORT_URL: [html_response("nope")]}),
        parse_case("bangumi is unsupported",
                   "https://www.bilibili.com/bangumi/play/ep123"),
        parse_case("movie is unsupported",
                   "https://www.bilibili.com/movie/123"),
        parse_case("other host is rejected", "https://example.com/video/BV1xx411c7mD"),
        parse_case("ftp scheme is rejected", "ftp://www.bilibili.com/video/BV1xx411c7mD"),
        parse_case("no id in text", "just some text"),
        parse_case("text with trailing punctuation",
                   f"看这个 https://www.bilibili.com/video/{BVID}，很有意思"),
    ]


def url_cases():
    return [
        {"id_kind": "bvid", "video_id": BVID, "result": build_video_info_url("bvid", BVID)},
        {"id_kind": "aid", "video_id": "170001", "result": build_video_info_url("aid", "170001")},
        {"bvid": BVID, "cid": 12345, "result": build_playurl_url(BVID, 12345)},
        {"bvid": "BV中文", "cid": 1, "result": build_playurl_url("BV中文", 1)},
    ]


def view_payload():
    return {
        "code": 0,
        "data": {
            "bvid": BVID,
            "aid": 170001,
            "title": " 示例视频 ",
            "pages": [
                {"cid": 111, "page": 1, "part": " 第一话 ", "duration": 100},
                {"cid": 222, "page": 0, "part": "", "duration": 200},
                {"cid": 0, "page": 3, "part": "跳过", "duration": 300},
                {"not": "a page"},
            ],
        },
    }


def view_cases():
    cases = [
        ("valid view", json_response(view_payload())),
        ("login required status", json_response({}, status=403)),
        ("empty body", HttpResponse(200, {}, b"", "")),
        ("not json", html_response("{oops", headers={"Content-Type": "application/json"})),
        ("non-object payload", json_response([1, 2])),
        ("error code login", json_response({"code": -404, "message": "啥都看不见"})),
        ("error code vip message", json_response({"code": 87008, "message": "大会员专享"})),
        ("error code generic", json_response({"code": 1234, "message": "boom"})),
        ("incomplete data", json_response({"code": 0, "data": {"bvid": BVID, "aid": 1}})),
        ("gzip body", HttpResponse(
            200,
            {"Content-Type": "application/json", "Content-Encoding": "gzip"},
            gzip.compress(json.dumps(view_payload()).encode("utf-8")),
            "",
        )),
        ("brotli body", HttpResponse(
            200,
            {"Content-Type": "application/json", "Content-Encoding": "br"},
            brotli.compress(json.dumps(view_payload()).encode("utf-8")),
            "",
        )),
        ("deflate body", HttpResponse(
            200,
            {"Content-Type": "application/json", "Content-Encoding": "deflate"},
            zlib.compress(json.dumps(view_payload()).encode("utf-8")),
            "",
        )),
        ("raw deflate body", HttpResponse(
            200,
            {"Content-Type": "application/json", "Content-Encoding": "deflate"},
            zlib.compress(json.dumps(view_payload()).encode("utf-8"))[2:-4],
            "",
        )),
    ]
    result = []
    for label, response in cases:
        try:
            info = parse_view_response(response)
            outcome = {"video": {
                "bvid": info.bvid,
                "aid": info.aid,
                "title": info.title,
                "pages": [page.__dict__ for page in info.pages],
            }}
        except BilibiliFallbackError as exc:
            outcome = {"error": error_dict(exc)}
        result.append({"label": label, "response": response_dict(response), "result": outcome})
    return result


def dash_payload():
    return {
        "code": 0,
        "data": {
            "support_formats": [
                {"quality": 80, "new_description": "1080P 高清"},
                {"quality": 64, "display_desc": "720P"},
            ],
            "dash": {
                "video": [
                    {"id": 64, "codecid": 7, "bandwidth": 900, "width": 1280, "height": 720,
                     "baseUrl": "https://cdn.example/avc.mp4",
                     "backupUrl": ["https://cdn.example/avc-2.mp4"]},
                    {"id": 80, "codecid": 13, "bandwidth": 500, "width": 1920, "height": 1080,
                     "base_url": "https://cdn.example/av1.mp4",
                     "backup_url": "https://cdn.example/av1-2.mp4"},
                    {"id": 80, "codecid": 13, "bandwidth": 500, "width": 1920, "height": 1080,
                     "baseUrl": "https://cdn.example/av1-alt.mp4"},
                    {"id": 32, "codecid": 7, "bandwidth": 100, "width": 640, "height": 360},
                    "not-a-stream",
                ],
                "audio": [
                    {"id": 30280, "bandwidth": 320, "baseUrl": "https://cdn.example/a1.m4a",
                     "backupUrl": ["https://cdn.example/a1-2.m4a", "https://cdn.example/a1.m4a"]},
                    {"id": 30232, "bandwidth": 128, "base_url": "https://cdn.example/a2.m4a"},
                ],
            },
        },
    }


def dash_cases():
    payload = dash_payload()
    data = payload["data"]
    cases = [
        ("best av1 pair", data, 100),
        ("drm top level", {**data, "drm_tech_type": 1}, 100),
        ("drm stream", {"dash": {
            "video": [{"codecid": 7, "baseUrl": "https://x/1", "drm_tech_type": 1}],
            "audio": [{"baseUrl": "https://x/a"}],
        }}, 100),
        ("no dash", {"support_formats": []}, 100),
        ("empty dash", {"dash": {}}, 100),
        ("missing audio", {"dash": {"video": [{"baseUrl": "https://x/1"}]}}, 100),
        ("no playable urls", {"dash": {"video": [{"id": 1}], "audio": [{"id": 2}]}}, 100),
        ("unknown quality name", {"dash": data["dash"]}, 100),
    ]
    result = []
    for label, value, duration in cases:
        try:
            selection = select_dash_stream_pair(value, duration)
            outcome = {"selection": {
                "video_url": selection.video_url,
                "audio_url": selection.audio_url,
                "video_backup_urls": selection.video_backup_urls,
                "audio_backup_urls": selection.audio_backup_urls,
                "video_codec_id": selection.video_codec_id,
                "quality": selection.quality,
                "quality_name": selection.quality_name,
            }}
        except BilibiliFallbackError as exc:
            outcome = {"error": error_dict(exc)}
        result.append({"label": label, "data": value, "result": outcome})
    return result


def playurl_parse_cases():
    cases = [
        ("valid playurl", json_response(dash_payload())),
        ("playurl login", json_response({"code": -101, "message": "login"})),
        ("playurl malformed", json_response([1])),
    ]
    result = []
    for label, response in cases:
        try:
            data = parse_playurl_response(response)
            outcome = {"keys": sorted(data.keys())}
        except BilibiliFallbackError as exc:
            outcome = {"error": error_dict(exc)}
        result.append({"label": label, "response": response_dict(response), "result": outcome})
    return result


def decode_cases():
    text = json.dumps({"hello": "世界"}, ensure_ascii=False).encode("utf-8")
    cases = [
        ("plain", text, {}, 4096),
        ("gzip", gzip.compress(text), {"Content-Encoding": "gzip"}, 4096),
        ("brotli", brotli.compress(text), {"Content-Encoding": "br"}, 4096),
        ("deflate", zlib.compress(text), {"Content-Encoding": "deflate"}, 4096),
        ("raw deflate", zlib.compress(text)[2:-4], {"Content-Encoding": "deflate"}, 4096),
        ("unknown encoding", text, {"Content-Encoding": "zstd"}, 4096),
        ("oversize", text, {}, 4),
        ("invalid gzip", b"not gzip", {"Content-Encoding": "gzip"}, 4096),
    ]
    result = []
    for label, body, headers, max_bytes in cases:
        response = HttpResponse(200, headers, body, "")
        try:
            outcome = {"text": decode_response_body(response, max_bytes=max_bytes)}
        except BilibiliFallbackError as exc:
            outcome = {"error": error_dict(exc)}
        result.append({
            "label": label,
            "status": 200,
            "headers": headers,
            "body": body.decode("latin-1"),
            "max_bytes": max_bytes,
            "result": outcome,
        })
    return result


def download_script():
    video_url = "https://cdn.example/av1.mp4"
    backup_url = "https://cdn.example/av1-2.mp4"
    audio_url = "https://cdn.example/a1.m4a"
    audio_backup = "https://cdn.example/a1-2.m4a"
    return video_url, backup_url, audio_url, audio_backup


def full_download_cases():
    video_url, backup_url, audio_url, audio_backup = download_script()
    view_url = build_video_info_url("bvid", BVID)
    play_url = build_playurl_url(BVID, 222)
    payload = dash_payload()

    def responses_for(view=None, playurl=None):
        return {
            view_url: [view or json_response(view_payload())],
            play_url: [playurl or json_response(payload)],
        }

    scripts = [
        ("downloads and merges dash streams", VIDEO_URL,
         responses_for(),
         {video_url: [b"video-bytes"], audio_url: [b"audio-bytes"]},
         0, []),
        ("video primary fails then backup wins", VIDEO_URL,
         responses_for(),
         {video_url: [SafeDownloadError("DOWNLOAD_HTTP_STATUS_INVALID", "boom")],
          backup_url: [b"video-backup"], audio_url: [b"audio-bytes"]},
         0, []),
        ("audio fails entirely", VIDEO_URL,
         responses_for(),
         {video_url: [b"video-bytes"],
          audio_url: [SafeDownloadError("DOWNLOAD_HTTP_STATUS_INVALID", "network")],
          audio_backup: [SafeDownloadError("DOWNLOAD_STALLED", "boom")]},
         0, []),
        ("ffmpeg merge fails", VIDEO_URL,
         responses_for(),
         {video_url: [b"video-bytes"], audio_url: [b"audio-bytes"]},
         1, []),
        ("part does not exist", f"https://www.bilibili.com/video/{BVID}?p=9",
         responses_for(), {}, 0, []),
        ("login required", VIDEO_URL,
         {view_url: [json_response({"code": -101, "message": "login"})]},
         {}, 0, []),
        ("drm stream is rejected", VIDEO_URL,
         responses_for(playurl=json_response({"code": 0, "data": {
             "dash": {
                 "video": [{"baseUrl": "https://x/v", "drm_tech_type": 1}],
                 "audio": [{"baseUrl": "https://x/a"}],
             },
         }})),
         {}, 0, []),
    ]

    cases = []
    for label, url, responses, downloads, ffmpeg_code, _ in scripts:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            client = FakeClient(responses=responses, downloads=downloads)
            events = []
            commands = []

            def runner(command, code=ffmpeg_code, commands=commands):
                commands.append(list(command))
                if code == 0:
                    Path(command[-1]).write_bytes(b"merged-mp4")
                return CommandResult(command, code, "", "" if code == 0 else "boom")

            try:
                path = bilibili_fallback.download_bilibili_video(
                    url,
                    root,
                    http_client=client,
                    command_runner=runner,
                    progress_callback=events.append,
                )
                leftover = sorted(
                    item.name for item in root.iterdir() if item.suffix in {".m4s", ".part"}
                )
                outcome = {
                    "path": path.name,
                    "bytes": path.read_bytes().decode("latin-1"),
                    "leftover": leftover,
                }
            except BilibiliFallbackError as exc:
                leftover = sorted(
                    item.name for item in root.iterdir() if item.suffix in {".m4s", ".part"}
                )
                outcome = {"error": error_dict(exc), "leftover": leftover}
            except SafeDownloadError as exc:
                outcome = {"error": {"code": exc.code, "message": str(exc)}}
            cases.append({
                "label": label,
                "url": url,
                "responses": {
                    request_url: [response_dict(item) for item in items]
                    for request_url, items in responses.items()
                },
                "downloads": {
                    download_url: [download_item(item) for item in items]
                    for download_url, items in downloads.items()
                },
                "ffmpeg_returncode": ffmpeg_code,
                "outcome": outcome,
                "events": events,
                "get_calls": [call["url"] for call in client.calls],
                "download_calls": [call["url"] for call in client.download_calls],
                "ffmpeg_commands": [normalize_command(value, root) for value in commands],
            })
    return cases


def artifact_cases():
    video_url, backup_url, audio_url, _ = download_script()
    cases = [
        ("download first available", [video_url, backup_url],
         {video_url: [SafeDownloadError("DOWNLOAD_STALLED", "x")], backup_url: [b"data"]}),
        ("all download urls fail", [video_url, backup_url],
         {video_url: [SafeDownloadError("DOWNLOAD_STALLED", "x")],
          backup_url: [BilibiliFallbackError("BILIBILI_DASH_DOWNLOAD_FAILED", "y")]}),
    ]
    result = []
    for label, urls, downloads in cases:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "video.m4s"
            client = FakeClient(downloads=downloads)
            try:
                output = download_first_available_url(urls, target, client)
                outcome = {"path": output.name, "bytes": output.read_bytes().decode("latin-1")}
            except BilibiliFallbackError as exc:
                outcome = {"error": error_dict(exc)}
            result.append({
                "label": label,
                "urls": urls,
                "downloads": {
                    download_url: [download_item(item) for item in items]
                    for download_url, items in downloads.items()
                },
                "outcome": outcome,
                "download_calls": [call["url"] for call in client.download_calls],
            })
    return result


def merge_cases():
    cases = []
    for label, code, produce in [
        ("merge succeeds", 0, True),
        ("merge exits nonzero", 1, False),
        ("merge produces nothing", 0, False),
    ]:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            video = root / "v.m4s"
            audio = root / "a.m4s"
            merge = root / "out.mp4"
            video.write_bytes(b"v")
            audio.write_bytes(b"a")
            commands = []

            def runner(command, code=code, produce=produce, commands=commands):
                commands.append(list(command))
                if produce:
                    Path(command[-1]).write_bytes(b"merged")
                return CommandResult(command, code, "", "")

            try:
                merge_dash_files(video, audio, merge, runner)
                outcome = {"bytes": merge.read_bytes().decode("latin-1")}
            except BilibiliFallbackError as exc:
                outcome = {"error": error_dict(exc)}
            cases.append({
                "label": label,
                "ffmpeg_returncode": code,
                "produce": produce,
                "outcome": outcome,
                "commands": [normalize_command(value, root) for value in commands],
            })
    return cases


def main() -> None:
    payload = {
        "constants": {
            "api_base": "https://api.bilibili.com",
            "max_response_bytes": BILIBILI_MAX_RESPONSE_BYTES,
            "max_stream_bytes": BILIBILI_MAX_STREAM_BYTES,
            "redirect_depth": BILIBILI_MAX_REDIRECT_DEPTH,
            "desktop_user_agent": BILIBILI_DESKTOP_USER_AGENT,
        },
        "parse": parse_cases(),
        "urls": url_cases(),
        "views": view_cases(),
        "dash": dash_cases(),
        "playurl_parse": playurl_parse_cases(),
        "decode": decode_cases(),
        "artifacts": artifact_cases(),
        "merge": merge_cases(),
        "full_downloads": full_download_cases(),
    }
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {FIXTURE} with {len(payload['full_downloads'])} full download cases")


if __name__ == "__main__":
    main()
