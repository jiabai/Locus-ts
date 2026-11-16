"""Generate the cross-language golden for URL media preparation.

The fixture comes from Python's production ``MediaPreparationFacade._prepare_url`` with
its external dependencies stubbed: progress events, error codes and error messages must
match the TypeScript implementation exactly. Everything that touches the network or
ffmpeg is replaced, so the fixture is deterministic on every platform.
"""

import contextlib
import json
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "worker"))

from worker_core import media_preparation as preparation  # noqa: E402
from worker_core import task_store  # noqa: E402
from worker_core.asr_runtime.types import TranscriptSegment  # noqa: E402
from worker_core.atomic_files import AtomicFileCommitError  # noqa: E402
from worker_core.media import (  # noqa: E402
    CommandExecutionError,
    CommandResult,
    MediaInfo,
)
from worker_core.models import ProcessRequest  # noqa: E402
from worker_core.progress_events import normalize_language_tag  # noqa: E402
from worker_core.source_resolution import resolve_source_request  # noqa: E402
from worker_core.subtitles import SubtitleTranscript  # noqa: E402

FIXTURE = ROOT / "worker-ts" / "tests" / "fixtures" / "url-media-golden.json"
URL = "https://www.douyin.com/video/7524373044106677544"
MODEL = "iic/SenseVoiceSmall-onnx"
CREATED = datetime(2026, 11, 14, 12, 0, 0, tzinfo=UTC)
SOURCE = resolve_source_request(URL)


def media_info(valid=True):
    duration = 1.0 if valid else 0.0
    return MediaInfo(
        has_video=True,
        has_audio=True,
        video_codec="h264",
        audio_codec="pcm_s16le",
        audio_sample_format="s16",
        audio_sample_rate=16000,
        audio_channels=1,
        width=64,
        height=64,
        duration_seconds=duration,
        size_bytes=1024 if valid else 0,
    )


SUBTITLE = SubtitleTranscript(
    text="First line\nSecond line",
    language="zh-Hans",
    segments=(
        TranscriptSegment(id="subtitle-1", start_ms=1000, end_ms=2000, text="First line"),
        TranscriptSegment(id="subtitle-2", start_ms=2000, end_ms=3000, text="Second line"),
    ),
)


@contextlib.contextmanager
def fake_staged_file(destination, *, validator=None):
    staging = destination.with_name(f".{destination.name}.staging")
    try:
        yield staging
        if validator is not None:
            validator(staging)
    finally:
        pass


def run_case(label, *, download_error=None, download_stdout=None, download_command=None,
             probe_error=False, probe_invalid=False, audio_error=False, audio_reuse=False,
             subtitle=None, commit_error=False):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        context = task_store.create_task_context(
            ProcessRequest(url=URL, asr_model=MODEL),
            SOURCE.identity,
            output_root=root / "outputs",
            cache_root=root / "cache",
            now=CREATED,
        )
        task_store.ensure_task_dirs(context.paths)
        video_path = context.paths.download_dir / "video.mp4"
        if download_error is None and download_stdout == "__VIDEO__":
            video_path.write_bytes(b"video")
        events = []

        def fake_download(*_args, **_kwargs):
            if download_error is not None:
                raise download_error
            stdout = str(video_path) if download_stdout == "__VIDEO__" else (download_stdout or "")
            return CommandResult(
                command=download_command or ["yt-dlp", URL],
                returncode=0,
                stdout=stdout,
                stderr="",
            )

        def fake_probe(*_args, **_kwargs):
            if probe_error:
                raise CommandExecutionError(
                    CommandResult(command=["ffprobe"], returncode=1, stdout="", stderr="bad")
                )
            return media_info(valid=not probe_invalid)

        def fake_extract(*_args, **_kwargs):
            if audio_error:
                raise CommandExecutionError(
                    CommandResult(command=["ffmpeg"], returncode=1, stdout="", stderr="bad")
                )
            return CommandResult(command=["ffmpeg"], returncode=0, stdout="", stderr="")

        def fake_reuse(*_args, **_kwargs):
            return audio_reuse

        def fake_subtitle(*_args, **_kwargs):
            return subtitle

        def fake_copy(*_args, **_kwargs):
            return None

        def failing_staged_file(destination, *, validator=None):
            @contextlib.contextmanager
            def inner():
                raise AtomicFileCommitError()
                yield  # pragma: no cover
            return inner()

        originals = {
            name: getattr(preparation, name)
            for name in ("download_video", "probe_media_file", "extract_audio",
                         "can_reuse_audio", "find_subtitle_transcript", "staged_file", "shutil")
        }
        preparation.download_video = fake_download
        preparation.probe_media_file = fake_probe
        preparation.extract_audio = fake_extract
        preparation.can_reuse_audio = fake_reuse
        preparation.find_subtitle_transcript = fake_subtitle
        preparation.staged_file = failing_staged_file if commit_error else fake_staged_file
        preparation.shutil = SimpleNamespace(copy2=fake_copy)
        try:
            facade = preparation.MediaPreparationFacade(
                command_runner=lambda command: CommandResult(command, 1, "", "unused"),
                progress_callback=lambda event: events.append(event),
            )
            prepared = facade.prepare(preparation.UrlMediaSource(SOURCE), context)
            outcome = {
                "video_path": prepared.video_path.relative_to(context.paths.task_dir).as_posix(),
                "audio_path": prepared.audio_path.relative_to(context.paths.task_dir).as_posix(),
                "subtitle": None if prepared.subtitle_candidate is None else {
                    "text": prepared.subtitle_candidate.text,
                    "language": prepared.subtitle_candidate.language,
                    "segments": [
                        {"id": segment.id, "start_ms": segment.start_ms,
                         "end_ms": segment.end_ms, "text": segment.text}
                        for segment in prepared.subtitle_candidate.segments
                    ],
                },
            }
        except preparation.MediaPreparationError as exc:
            outcome = {"error": {"code": exc.code, "message": str(exc), "stage": exc.stage.value}}
        finally:
            for name, value in originals.items():
                setattr(preparation, name, value)
        return {"label": label, "events": events, "outcome": outcome}


def main():
    cases = [
        run_case("success without subtitle", download_stdout="__VIDEO__"),
        run_case("download failure is sanitized",
                 download_error=CommandExecutionError(CommandResult(
                     command=["yt-dlp"], returncode=1, stdout="",
                     stderr="network down"))),
        run_case("download produced no media", download_stdout=""),
        run_case("downloaded media is invalid", download_stdout="__VIDEO__", probe_invalid=True),
        run_case("media probe failed", download_stdout="__VIDEO__", probe_error=True),
        run_case("audio extraction failed", download_stdout="__VIDEO__", audio_error=True),
        run_case("existing audio is reused", download_stdout="__VIDEO__", audio_reuse=True),
        run_case("platform subtitle is used", download_stdout="__VIDEO__", subtitle=SUBTITLE),
        run_case("bilibili fallback skips subtitle detection", download_stdout="__VIDEO__",
                 download_command=["bilibili-fallback", URL], subtitle=SUBTITLE),
        run_case("video commit failed", download_stdout="__VIDEO__", commit_error=True),
    ]
    # stdout 里的路径在两侧都指向各自的临时目录：基准里用固定占位符。
    for case in cases:
        for event in case["events"]:
            event.pop("timestamp", None)
    payload = {
        "url": URL,
        "asr_model": MODEL,
        "cases": cases,
        "language_tags": [
            {"input": value, "result": normalize_language_tag(value)}
            for value in ["zh-Hans", "zh_CN", "en-US", "EN", "und", "unknown", "zh-Hans-CN-extra",
                          "a", "", "zh_Hans_CN", 5, "sr-Latn-RS"]
        ],
    }
    FIXTURE.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {FIXTURE} with {len(cases)} preparation cases")


if __name__ == "__main__":
    main()
