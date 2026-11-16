"""Generate the cross-language golden for `download_reliability`.

Cases cover response validation, atomic promotion, resume validation, stall and
incomplete detection. Each case records the error code, bytes written and the
final state of the destination and `.part` files.
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "worker"))

from worker_core.douyin.types import HttpResponse  # noqa: E402
from worker_core.download_reliability import (  # noqa: E402
    RESUMABLE_DOWNLOAD_ERROR_CODES,
    SafeDownloadError,
    write_http_response_atomically,
    write_http_stream_atomically,
)

FIXTURE = ROOT / "worker-ts" / "tests" / "fixtures" / "download-reliability-golden.json"
NON_MEDIA_MESSAGE = "Download response returned a non-media content type."


def response(status, headers, body):
    return HttpResponse(status, headers, body.encode("latin-1"), "https://cdn.example/video.mp4")


def files_of(root: Path):
    destination = root / "video.mp4"
    part = root / "video.mp4.part"
    return {
        "destination": destination.read_bytes().decode("latin-1")
        if destination.exists() else None,
        "part": part.read_bytes().decode("latin-1") if part.exists() else None,
    }


def record(kind, label, response_data, expected, *, chunks=None, options=None,
           destination=None, part=None):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        if destination is not None:
            (root / "video.mp4").write_bytes(destination.encode("latin-1"))
        if part is not None:
            (root / "video.mp4.part").write_bytes(part.encode("latin-1"))
        target = root / "video.mp4"
        try:
            if kind == "response":
                written = write_http_response_atomically(
                    response_data,
                    target,
                    max_bytes=(options or {}).get("max_bytes"),
                )
            else:
                tick_values = (options or {}).get("ticks")
                tick_iter = iter(tick_values or [])
                written = write_http_stream_atomically(
                    response_data,
                    [chunk.encode("latin-1") for chunk in chunks or []],
                    target,
                    max_bytes=(options or {}).get("max_bytes"),
                    no_progress_timeout_seconds=(options or {}).get("no_progress_timeout_seconds"),
                    monotonic=(lambda: next(tick_iter)) if tick_values else None,
                    resume_from_bytes=(options or {}).get("resume_from_bytes", 0),
                )
            outcome = {"written": written}
        except SafeDownloadError as exc:
            outcome = {"error": {"code": exc.code, "message": str(exc)}}
        actual = {"outcome": outcome, "files": files_of(root)}
    assert actual == expected, f"{label}: {actual} != {expected}"
    return {
        "kind": kind,
        "label": label,
        "response": {
            "status": response_data.status,
            "headers": response_data.headers,
            "body": response_data.body.decode("latin-1"),
        },
        "chunks": chunks,
        "options": options,
        "destination_preexisting": destination,
        "part_preexisting": part,
        "expected": expected,
    }


def response_cases():
    return [
        record(
            "response",
            "promotes part file",
            response(206, {"Content-Range": "bytes 0-3/4", "Content-Type": "video/mp4"}, "data"),
            {"outcome": {"written": 4}, "files": {"destination": "data", "part": None}},
        ),
        record(
            "response",
            "rejects non-media content type",
            response(200, {"Content-Type": "text/html", "Content-Length": "12"}, "<html></html>"),
            {"outcome": {"error": {"code": "DOWNLOAD_CONTENT_TYPE_INVALID",
                                   "message": NON_MEDIA_MESSAGE}},
             "files": {"destination": "existing", "part": None}},
            destination="existing",
        ),
        record(
            "response",
            "rejects partial without total",
            response(206, {"Content-Type": "video/mp4"}, "data"),
            {"outcome": {"error": {
                "code": "DOWNLOAD_CONTENT_RANGE_INVALID",
                "message": "Partial download response must include a valid Content-Range total."}},
             "files": {"destination": None, "part": None}},
        ),
        record(
            "response",
            "rejects oversized response",
            response(200, {"Content-Type": "video/mp4", "Content-Length": "5"}, "12345"),
            {"outcome": {"error": {
                "code": "DOWNLOAD_SIZE_EXCEEDED",
                "message": "Download response exceeds the configured size limit."}},
             "files": {"destination": None, "part": None}},
            options={"max_bytes": 4},
        ),
        record(
            "response",
            "rejects empty body",
            response(200, {"Content-Type": "video/mp4", "Content-Length": "5"}, ""),
            {"outcome": {"error": {"code": "DOWNLOAD_EMPTY_BODY",
                                   "message": "Download response body is empty."}},
             "files": {"destination": None, "part": None}},
        ),
        record(
            "response",
            "rejects unexpected status",
            response(302, {"Location": "https://cdn.example/x"}, "body"),
            {"outcome": {"error": {"code": "DOWNLOAD_HTTP_STATUS_INVALID",
                                   "message": "Unexpected HTTP status: 302"}},
             "files": {"destination": None, "part": None}},
        ),
        record(
            "response",
            "accepts octet-stream",
            response(200, {"Content-Type": "application/octet-stream; charset=binary"}, "abc"),
            {"outcome": {"written": 3}, "files": {"destination": "abc", "part": None}},
        ),
    ]


def stream_cases():
    return [
        record(
            "stream",
            "streams chunks to part then promotes",
            response(200, {"Content-Type": "video/mp4", "Content-Length": "10"}, ""),
            {"outcome": {"written": 10}, "files": {"destination": "stream mp4", "part": None}},
            chunks=["stream", " mp4"],
            options={"max_bytes": 16},
        ),
        record(
            "stream",
            "appends a valid range part",
            response(206, {"Content-Type": "video/mp4", "Content-Range": "bytes 3-6/7"}, ""),
            {"outcome": {"written": 7}, "files": {"destination": "olddata", "part": None}},
            chunks=["data"],
            options={"max_bytes": 16, "resume_from_bytes": 3},
            part="old",
        ),
        record(
            "stream",
            "rejects stalled download and keeps part",
            response(200, {"Content-Type": "video/mp4", "Content-Length": "4"}, ""),
            {"outcome": {"error": {"code": "DOWNLOAD_STALLED",
                                   "message": "Download made no progress before the timeout."}},
             "files": {"destination": "existing", "part": ""}},
            chunks=["data"],
            options={"no_progress_timeout_seconds": 1.0, "ticks": [0.0, 5.0]},
            destination="existing",
        ),
        record(
            "stream",
            "rejects incomplete stream and keeps part",
            response(200, {"Content-Type": "video/mp4", "Content-Length": "10"}, ""),
            {"outcome": {"error": {"code": "DOWNLOAD_INCOMPLETE",
                                   "message": "Download response ended before the declared size."}},
             "files": {"destination": None, "part": "stream"}},
            chunks=["stream"],
        ),
        record(
            "stream",
            "accepts undeclared complete stream",
            response(200, {"Content-Type": "video/mp4"}, ""),
            {"outcome": {"written": 13}, "files": {"destination": "chunked media", "part": None}},
            chunks=["chunked", " media"],
        ),
        record(
            "stream",
            "deletes part on validation failure",
            response(200, {"Content-Type": "text/html", "Content-Length": "5"}, ""),
            {"outcome": {"error": {
                "code": "DOWNLOAD_CONTENT_TYPE_INVALID",
                "message": NON_MEDIA_MESSAGE}},
             "files": {"destination": None, "part": None}},
            chunks=["data"],
        ),
        record(
            "stream",
            "rejects resume without matching part",
            response(206, {"Content-Type": "video/mp4", "Content-Range": "bytes 3-6/7"}, ""),
            {"outcome": {"error": {
                "code": "DOWNLOAD_RESUME_INVALID",
                "message": "Partial download file does not match the expected resume offset."}},
             "files": {"destination": None, "part": None}},
            chunks=["data"],
            options={"resume_from_bytes": 3},
        ),
        record(
            "stream",
            "rejects oversized stream while writing",
            response(200, {"Content-Type": "video/mp4"}, ""),
            {"outcome": {"error": {
                "code": "DOWNLOAD_SIZE_EXCEEDED",
                "message": "Download response exceeds the configured size limit."}},
             "files": {"destination": None, "part": None}},
            chunks=["abc", "def"],
            options={"max_bytes": 4},
        ),
        record(
            "stream",
            "resume response must be 206",
            response(200, {"Content-Type": "video/mp4", "Content-Length": "7"}, ""),
            {"outcome": {"error": {
                "code": "DOWNLOAD_CONTENT_RANGE_INVALID",
                "message": "Resume response must start at the existing partial file size."}},
             "files": {"destination": None, "part": "old"}},
            chunks=["data"],
            options={"resume_from_bytes": 3},
            part="old",
        ),
    ]


def main() -> None:
    payload = {
        "resumable_codes": sorted(RESUMABLE_DOWNLOAD_ERROR_CODES),
        "response_cases": response_cases(),
        "stream_cases": stream_cases(),
    }
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {FIXTURE} with {len(payload['response_cases'])} response "
          f"and {len(payload['stream_cases'])} stream cases")


if __name__ == "__main__":
    main()
