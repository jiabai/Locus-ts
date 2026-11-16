"""Generate the cross-language golden for the Douyin transport layer.

Every case runs the Python production code in `worker_core.douyin` and records what
the TypeScript port must reproduce: parsed AWEME ids, share-page items, stream
candidates, selection order, progress events and the outcome of ordered downloads.
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "worker"))

from worker_core import douyin_fallback  # noqa: E402
from worker_core.douyin.page import parse_share_page_router_data  # noqa: E402
from worker_core.douyin.source import (  # noqa: E402
    build_share_page_url,
    extract_aweme_id,
)
from worker_core.douyin.streams import (  # noqa: E402
    PLAY_QUALITIES,
    build_play_url,
    collect_stream_candidates,
    select_stream_candidates,
)
from worker_core.douyin.types import (  # noqa: E402
    DouyinFallbackError,
    DouyinStreamCandidate,
    HttpResponse,
)
from worker_core.download_reliability import SafeDownloadError  # noqa: E402

FIXTURE = ROOT / "worker-ts" / "tests" / "fixtures" / "douyin-golden.json"
AWEME_ID = "7524373044106677544"
SHARE_URL = f"https://www.douyin.com/video/{AWEME_ID}"
VIDEO_URI = "v0300fg10000abcdefghijklmnop"


class FakeHttpClient:
    """Mirror of `worker/tests/test_douyin_fallback.py`'s fake, kept minimal."""

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
        timeout_seconds=15.0,
        no_progress_timeout_seconds=60.0,
        resume_from_bytes=0,
        total_bytes=None,
        on_progress=None,
    ):
        self.download_calls.append({"url": url, "resume_from_bytes": resume_from_bytes})
        items = self.downloads.get(url)
        if not items:
            raise AssertionError(f"Unexpected download URL: {url}")
        item = items.pop(0)
        part_path = destination.with_name(f"{destination.name}.part")
        if isinstance(item, StalledDownload):
            if item.part_bytes:
                part_path.write_bytes(item.part_bytes)
            else:
                part_path.unlink(missing_ok=True)
            raise SafeDownloadError(item.code, f"fake {item.code}")
        if isinstance(item, Exception):
            part_path.unlink(missing_ok=True)
            raise item
        payload = bytes(item)
        if resume_from_bytes > 0:
            if not part_path.is_file() or part_path.stat().st_size != resume_from_bytes:
                raise SafeDownloadError(
                    "DOWNLOAD_RESUME_INVALID",
                    "fake resume offset does not match the partial file",
                )
            with part_path.open("ab") as partial:
                partial.write(payload[resume_from_bytes:])
        else:
            part_path.unlink(missing_ok=True)
            part_path.write_bytes(payload)
        part_path.replace(destination)
        if callable(on_progress):
            emitted = resume_from_bytes
            while emitted < len(payload):
                emitted = min(len(payload), emitted + 4 * 1024 * 1024)
                on_progress(emitted, total_bytes if total_bytes is not None else emitted)
        return len(payload)


class StalledDownload:
    def __init__(self, code="DOWNLOAD_STALLED", part_bytes=b""):
        self.code = code
        self.part_bytes = part_bytes


def error_of(callable_):
    try:
        callable_()
    except DouyinFallbackError as exc:
        return {"code": exc.code, "message": str(exc)}
    return None


def page_html(payload: dict, *, marker="window._ROUTER_DATA") -> str:
    return f"<html><script>{marker} = {json.dumps(payload)};</script></html>"


def build_item(bit_rates=None, play_uri=None):
    video: dict = {}
    if bit_rates is not None:
        video["bit_rate"] = bit_rates
    if play_uri is not None:
        video["play_addr"] = {"uri": play_uri}
    return {"aweme_id": AWEME_ID, "video": video}


def bit_rate(quality: str, size: int, url: str, width=None, height=None):
    entry = {
        "gear_name": quality,
        "data_size": size,
        "play_addr": {"url_list": [url], "width": width, "height": height},
    }
    return entry


def id_cases():
    inputs = [
        SHARE_URL,
        f"https://www.douyin.com/video/{AWEME_ID}?previous_page=app_code_link",
        f"https://www.douyin.com/note/{AWEME_ID}",
        f"https://www.douyin.com/share/slides/{AWEME_ID}/",
        f"https://www.iesdouyin.com/share/video/{AWEME_ID}/?app=aweme",
        f"https://www.douyin.com/?modal_id={AWEME_ID}",
        f"https://www.douyin.com/?aweme_id={AWEME_ID}&x=1",
        "分享链接 https://v.douyin.com/iRabcdef/ 复制打开抖音",
        "https://www.douyin.com/video/12",
        "https://www.douyin.com/user/abc",
        "https://example.com/video/7524373044106677544",
        "no url at all",
        "https://www.douyin.com/video/7524373044106677544， 看这个",
    ]
    return [{"input": value, "result": extract_aweme_id(value)} for value in inputs]


def play_url_cases():
    return [
        {"uri": uri, "quality": quality, "result": build_play_url(uri, quality)}
        for uri, quality in [
            (VIDEO_URI, "1080p"),
            ("a/b+c=d", "720p"),
            ("中文 uri", "540p"),
            ("keep-_.~", "360p"),
            ("bang!star*quote'paren(s)", "1080p"),
        ]
    ]


def page_cases():
    valid = page_html({"loaderData": {"video_(id)/page": {"videoInfoRes": {
        "item_list": [{"aweme_id": AWEME_ID, "video": {"play_addr": {"uri": VIDEO_URI}}}],
    }}}})
    nested = page_html({"loaderData": {"other": [{"x": {"videoInfoRes": {
        "item_list": [{"aweme_id": "1"}, {"aweme_id": "2"}],
    }}}]}})
    degraded = page_html({"loaderData": {"video_(id)/page": {"itemId": AWEME_ID}}})
    empty_items = page_html({"videoInfoRes": {"item_list": []}})
    scalar_item = page_html({"videoInfoRes": {"item_list": ["not-a-dict"]}})
    html_cases = [
        ("valid share page", valid),
        ("nested videoInfoRes", nested),
        ("degraded page without videoInfoRes", degraded),
        ("missing router marker", "<html>nothing here</html>"),
        ("marker without assignment", "<script>window._ROUTER_DATA</script>"),
        ("malformed json", "<script>window._ROUTER_DATA = {oops};</script>"),
        ("empty item list", empty_items),
        ("non-object first item", scalar_item),
    ]
    cases = []
    for label, html in html_cases:
        try:
            result = {"item": parse_share_page_router_data(html)}
        except DouyinFallbackError as exc:
            result = {"error": {"code": exc.code, "message": str(exc)}}
        cases.append({"label": label, "html": html, "result": result})
    return cases


def candidate_cases():
    declared = build_item(bit_rates=[
        bit_rate("720p", 3000, "https://cdn.example/720.mp4", 1280, 720),
        bit_rate("1080p", 5000, "https://cdn.example/1080.mp4", 1920, 1080),
        bit_rate("540p", 3000, "https://cdn.example/540.mp4"),
    ])
    declared_dupe_sizes = build_item(bit_rates=[
        bit_rate("1080p", 5000, "https://cdn.example/a.mp4"),
        bit_rate("720p", 5000, "https://cdn.example/b.mp4"),
        bit_rate("360p", 0, "https://cdn.example/zero.mp4"),
    ])
    declared_missing_size = build_item(bit_rates=[
        {"gear_name": "1080p", "play_addr": {"url": "https://cdn.example/u.mp4"}},
    ])
    no_video = {"aweme_id": AWEME_ID}

    probe_item = build_item(play_uri=VIDEO_URI)
    probe_responses = {}
    for index, quality in enumerate(PLAY_QUALITIES):
        probe_url = build_play_url(VIDEO_URI, quality)
        if index == 0:
            probe_responses[probe_url] = [HttpResponse(
                206,
                {"Content-Type": "video/mp4", "Content-Range": "bytes 0-1/5000"},
                b"ok",
                "https://cdn.example/1080.mp4",
            )]
        elif index == 1:
            probe_responses[probe_url] = [HttpResponse(
                206,
                {"Content-Type": "text/html", "Content-Range": "bytes 0-1/4000"},
                b"ok",
                "https://cdn.example/720.mp4",
            )]
        elif index == 2:
            probe_responses[probe_url] = [HttpResponse(200, {}, b"", probe_url)]
        elif index == 3:
            probe_responses[probe_url] = [DouyinFallbackError(
                "DOUYIN_SHARE_PAGE_UNAVAILABLE", "boom")]
        else:
            probe_responses[probe_url] = [HttpResponse(
                206,
                {"Content-Range": "bytes 0-1/2000"},
                b"ok",
                "https://cdn.example/360.mp4",
            )]

    cases = []
    for label, item, responses in [
        ("declared bit rates", declared, {}),
        ("duplicate sizes keep first ranked", declared_dupe_sizes, {}),
        ("bit rate without size is skipped", declared_missing_size, {}),
        ("item without video", no_video, {}),
        ("probe play_addr uri", probe_item, probe_responses),
    ]:
        client = FakeHttpClient(responses=responses)
        try:
            collected = collect_stream_candidates(item, client)
            outcome = {"candidates": [candidate_dict(value) for value in collected]}
        except DouyinFallbackError as exc:
            outcome = {"error": {"code": exc.code, "message": str(exc)}}
        cases.append({
            "label": label,
            "item": item,
            "probe_responses": {
                url: [response_dict(item_) for item_ in items]
                for url, items in responses.items()
            },
            "result": outcome,
            "probe_calls": [call["url"] for call in client.calls],
        })
    return cases


def candidate_dict(candidate: DouyinStreamCandidate) -> dict:
    return {
        "quality": candidate.quality,
        "url": candidate.url,
        "size_bytes": candidate.size_bytes,
        "width": candidate.width,
        "height": candidate.height,
        "headers": candidate.headers,
    }


def response_dict(response) -> dict:
    if isinstance(response, Exception):
        if isinstance(response, DouyinFallbackError):
            return {"error": {"code": response.code, "message": str(response)}}
        return {"error": {"code": "UNEXPECTED", "message": str(response)}}
    return {
        "status": response.status,
        "headers": response.headers,
        "body": response.body.decode("latin-1"),
        "url": response.url,
    }


def selection_cases():
    candidates = [
        DouyinStreamCandidate("720p", "https://cdn.example/720.mp4", 3000),
        DouyinStreamCandidate("unknown", "https://cdn.example/x.mp4", 3000),
        DouyinStreamCandidate("1080p", "https://cdn.example/1080.mp4", 5000),
        DouyinStreamCandidate("360p", "https://cdn.example/zero.mp4", 0),
        DouyinStreamCandidate("480p", "https://cdn.example/dup.mp4", 5000),
    ]
    return [{
        "candidates": [candidate_dict(value) for value in candidates],
        "result": [candidate_dict(value) for value in select_stream_candidates(candidates)],
    }]


def progress_emitter_cases():
    scripts = [
        [(0, 100)],
        [(1, 0), (8 * 1024 * 1024, 0)],
        [(8 * 1024 * 1024, 32 * 1024 * 1024)],
        [(8 * 1024 * 1024, 16 * 1024 * 1024),
         (16 * 1024 * 1024, 16 * 1024 * 1024),
         (24 * 1024 * 1024, 32 * 1024 * 1024),
         (32 * 1024 * 1024, 32 * 1024 * 1024)],
        [(4 * 1024 * 1024, 100), (8 * 1024 * 1024, 100)],
    ]
    cases = []
    for steps in scripts:
        events = []
        emitter = douyin_fallback._stream_progress_emitter(events.append)
        for downloaded, total in steps:
            emitter(downloaded, total)
        cases.append({
            "steps": [list(step) for step in steps],
            "events": events,
        })
    return cases


def retry_event_cases():
    cases = []
    for failed_index, total in [(0, 2), (0, 1), (1, 3), (2, 3), (0, 101), (0, 0)]:
        events = []
        douyin_fallback._emit_stream_retry(events.append, failed_index, total)
        cases.append({
            "failed_index": failed_index,
            "total": total,
            "events": events,
        })
    return cases


def ordered_download_cases():
    first = DouyinStreamCandidate("1080p", "https://cdn.example/1080.mp4", 6)
    second = DouyinStreamCandidate("720p", "https://cdn.example/720.mp4", 5)
    scripts = [
        (
            "single candidate succeeds",
            [first],
            {first.url: [b"abcdef"]},
        ),
        (
            "stalled candidate resumes once",
            [first],
            {first.url: [StalledDownload("DOWNLOAD_STALLED", b"ab"), b"abcdef"]},
        ),
        (
            "stalled candidate then next stream",
            [first, second],
            {
                first.url: [StalledDownload("DOWNLOAD_STALLED", b"ab"),
                            StalledDownload("DOWNLOAD_STALLED", b"abcd")],
                second.url: [b"vwxyz"],
            },
        ),
        (
            "first fails, second succeeds",
            [first, second],
            {first.url: [RuntimeError("network")], second.url: [b"hello"]},
        ),
        (
            "all candidates fail",
            [first, second],
            {
                first.url: [RuntimeError("network")],
                second.url: [StalledDownload("DOWNLOAD_STALLED", b"xy"),
                             StalledDownload("DOWNLOAD_INCOMPLETE", b"xy")],
            },
        ),
    ]
    cases = []
    for label, candidates, downloads in scripts:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            client = FakeHttpClient(downloads=downloads)
            events = []
            try:
                path = douyin_fallback.download_first_available_candidate(
                    AWEME_ID,
                    list(candidates),
                    root,
                    client,
                    progress_callback=events.append,
                )
                outcome = {"path": path.name, "bytes": path.read_bytes().decode("latin-1")}
            except DouyinFallbackError as exc:
                outcome = {
                    "error": {"code": exc.code, "message": str(exc)},
                    "bytes": (root / f"{AWEME_ID}.mp4").read_bytes().decode("latin-1")
                    if (root / f"{AWEME_ID}.mp4").exists() else None,
                    "part": (root / f"{AWEME_ID}.mp4.part").read_bytes().decode("latin-1")
                    if (root / f"{AWEME_ID}.mp4.part").exists() else None,
                }
            cases.append({
                "label": label,
                "candidates": [candidate_dict(value) for value in candidates],
                "downloads": {
                    url: [
                        {"payload": item.decode("latin-1")}
                        if isinstance(item, bytes)
                        else {"stalled": item.code, "part": item.part_bytes.decode("latin-1")}
                        if isinstance(item, StalledDownload)
                        else {"error": str(item)}
                        for item in items
                    ]
                    for url, items in downloads.items()
                },
                "outcome": outcome,
                "download_calls": client.download_calls,
                "events": events,
            })
    return cases


def full_download_cases():
    item = build_item(bit_rates=[
        bit_rate("1080p", 6, "https://cdn.example/1080.mp4"),
        bit_rate("720p", 5, "https://cdn.example/720.mp4"),
    ])
    degraded = page_html({"loaderData": {"video_(id)/page": {"itemId": AWEME_ID}}})
    valid = page_html({"videoRes": {"videoInfoRes": {"item_list": [item]}}})
    cases = []
    scripts = [
        ("direct url downloads largest stream", SHARE_URL,
         {build_share_page_url(AWEME_ID): [text_response(valid)]},
         {"https://cdn.example/1080.mp4": [b"abcdef"]}),
        ("degraded page retries then succeeds", SHARE_URL,
         {build_share_page_url(AWEME_ID): [
             text_response(degraded), text_response(degraded), text_response(valid)]},
         {"https://cdn.example/1080.mp4": [b"abcdef"]}),
        ("degraded page exhausts attempts", SHARE_URL,
         {build_share_page_url(AWEME_ID): [text_response(degraded) for _ in range(3)]},
         {}),
        ("page without playable item fails", SHARE_URL,
         {build_share_page_url(AWEME_ID): [
             text_response(page_html({"x": {}})) for _ in range(3)]},
         {}),
        ("unparseable input has no id", "no link here", {}, {}),
        ("first stream fails then second wins", SHARE_URL,
         {build_share_page_url(AWEME_ID): [text_response(valid)]},
         {"https://cdn.example/1080.mp4": [RuntimeError("network")],
          "https://cdn.example/720.mp4": [b"vwxyz"]}),
    ]
    for label, url, responses, downloads in scripts:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            client = FakeHttpClient(responses=responses, downloads=downloads)
            events = []
            sleeps = []
            try:
                path = douyin_fallback.download_douyin_video(
                    url,
                    root,
                    http_client=client,
                    progress_callback=events.append,
                    sleeper=sleeps.append,
                )
                outcome = {"path": path.name, "bytes": path.read_bytes().decode("latin-1")}
            except DouyinFallbackError as exc:
                outcome = {"error": {"code": exc.code, "message": str(exc)}}
            cases.append({
                "label": label,
                "url": url,
                "responses": {
                    request_url: [response_dict(value) for value in items]
                    for request_url, items in responses.items()
                },
                "downloads": {
                    download_url: [
                        {"payload": value.decode("latin-1")}
                        if isinstance(value, bytes)
                        else {"error": str(value)}
                        for value in items
                    ]
                    for download_url, items in downloads.items()
                },
                "outcome": outcome,
                "events": events,
                "sleeps": sleeps,
                "get_calls": [call["url"] for call in client.calls],
            })
    return cases


def text_response(html: str) -> HttpResponse:
    return HttpResponse(200, {"Content-Type": "text/html"}, html.encode(), "share")


def main() -> None:
    payload = {
        "constants": {
            "share_page_attempts": douyin_fallback.SHARE_PAGE_ATTEMPTS,
            "retry_delay_range": list(douyin_fallback.SHARE_PAGE_RETRY_DELAY_RANGE_SECONDS),
            "retryable_codes": sorted(douyin_fallback.SHARE_PAGE_RETRYABLE_ERROR_CODES),
            "progress_interval_bytes": douyin_fallback.STREAM_PROGRESS_EMIT_INTERVAL_BYTES,
            "progress_max_step": douyin_fallback.STREAM_PROGRESS_MAX_STEP,
            "play_qualities": list(PLAY_QUALITIES),
            "share_url": build_share_page_url(AWEME_ID),
        },
        "aweme_ids": id_cases(),
        "play_urls": play_url_cases(),
        "pages": page_cases(),
        "candidates": candidate_cases(),
        "selection": selection_cases(),
        "progress_emitter": progress_emitter_cases(),
        "retry_events": retry_event_cases(),
        "ordered_downloads": ordered_download_cases(),
        "full_downloads": full_download_cases(),
    }
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {FIXTURE}")


if __name__ == "__main__":
    main()
