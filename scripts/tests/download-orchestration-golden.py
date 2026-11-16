# `media.download_video` 编排的 Python 基准生成器。
# runner、三平台下载函数与字幕探测函数按生产代码的注入点替换；记录命令序列、
# 调用序列与最终 CommandResult（或 CommandExecutionError），供 TypeScript 逐项比对。
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "worker"))

from worker_core import media  # noqa: E402
from worker_core.bilibili.types import BilibiliFallbackError  # noqa: E402
from worker_core.douyin.types import DouyinFallbackError  # noqa: E402
from worker_core.media import DownloadStrategy  # noqa: E402
from worker_core.xiaohongshu.types import XiaohongshuFallbackError  # noqa: E402

FIXTURE = ROOT / "worker-ts" / "tests" / "fixtures" / "download-orchestration-golden.json"

YOUTUBE = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
DOUYIN = "https://www.douyin.com/video/7524373044106677544"
XHS = "https://www.xiaohongshu.com/explore/0123456789abcdef01234568"
BILIBILI = "https://www.bilibili.com/video/BV1Aa411c7mD"
GENERIC = "https://example.com/video/123"

ERROR_TYPES = {
    "douyin-fallback": DouyinFallbackError,
    "xiaohongshu-fallback": XiaohongshuFallbackError,
    "bilibili-fallback": BilibiliFallbackError,
}

# runner_returns 是按调用次序给出的 (returncode, stdout, stderr)。
# fallback 的 `outcome` 为 ok（写入文件并返回路径）或 error（抛出带码异常）。
SCENARIOS = [
    ("yt-dlp succeeds for a generic url", GENERIC, [(0, "", "")], [], {}, "ok"),
    ("yt-dlp succeeds for xiaohongshu and probes subtitles", XHS, [(0, "", "")], [], {}, "ok"),
    (
        "plain failure without fallback",
        "https://example.com/v",
        [(1, "", "ERROR: network down")],
        [], {}, "ok",
    ),
    ("structured timeout stops immediately", GENERIC,
     [(1, "", "VIDEO_DOWNLOAD_TIMEOUT: Media download command exceeded its time budget.")],
     [], {}, "ok"),
    ("youtube subtitle failure reuses downloaded media", YOUTUBE,
     [(1, "", "ERROR: Unable to download video subtitles")], ["clip.mp4"], {}, "ok"),
    ("youtube subtitle failure retries without subtitles", YOUTUBE,
     [(1, "", "ERROR: Unable to download video subtitles"), (0, "", "")], [], {}, "ok"),
    ("youtube retryable failure retries once", YOUTUBE,
     [(1, "", "ERROR: random transient error"), (0, "", "")], [], {}, "ok"),
    ("youtube retryable failure still fails", YOUTUBE,
     [(1, "", "ERROR: random transient error"),
      (1, "", "ERROR: random transient error")], [], {}, "ok"),
    ("douyin fallback downloads after json failure", DOUYIN,
     [(1, "", "ERROR: Expecting value: line 1")], [], {}, "ok"),
    ("douyin fallback error is structured", DOUYIN,
     [(1, "", "ERROR: Expecting value: line 1")], [], {}, "error"),
    ("bilibili fallback downloads after failure", BILIBILI,
     [(1, "", "ERROR: unsupported")], [], {}, "ok"),
    ("xiaohongshu fallback downloads after failure", XHS,
     [(1, "", "ERROR: unsupported")], [], {}, "ok"),
    ("youtube unmatched failure falls into generic retry", YOUTUBE,
     [(1, "", "ERROR: This video is private")], [], {}, "ok"),
    ("youtube 403 is retried and classified", YOUTUBE,
     [(1, "", "ERROR: HTTP Error 403: Forbidden"), (1, "", "ERROR: HTTP Error 403: Forbidden")],
     [], {}, "ok"),
]


def normalize_command(command, output_root):
    normalized = []
    for value in command:
        text = str(value)
        text = text.replace(output_root.as_posix(), "<OUT>")
        normalized.append(text)
    if normalized[:3] == [sys.executable, "-m", "yt_dlp"]:
        normalized = ["<launcher>", *normalized[3:]]
    return normalized


def normalize_text(text, output_root):
    return str(text).replace(output_root.as_posix(), "<OUT>")


def run_scenario(label, url, runner_returns, existing_files, _options, fallback_outcome, root):
    output_dir = root / "out"
    output_dir.mkdir(parents=True, exist_ok=True)
    for name in existing_files:
        (output_dir / name).write_bytes(b"video")

    calls = []
    fallback_calls = []
    probe_calls = []
    returns = list(runner_returns)

    def runner(command):
        calls.append(command)
        index = len(calls) - 1
        code, stdout, stderr = returns[min(index, len(returns) - 1)]
        return media.CommandResult(command=command, returncode=code, stdout=stdout, stderr=stderr)

    def fallback(name):
        def download(fallback_url, fallback_dir, _runner, _progress):
            fallback_calls.append(name)
            if fallback_outcome == "error":
                raise ERROR_TYPES[name]("PLATFORM_FALLBACK_FAILED", "platform rejected the request")
            video = fallback_dir / "fallback.mp4"
            video.write_bytes(b"fallback")
            return video
        return download

    strategies = tuple(
        DownloadStrategy(
            name=name,
            command_name=name,
            should_attempt=getattr(media, {
                "douyin-fallback": "should_attempt_douyin_fallback",
                "xiaohongshu-fallback": "should_attempt_xiaohongshu_fallback",
                "bilibili-fallback": "should_attempt_bilibili_fallback",
            }[name]),
            download=fallback(name),
            error_type=ERROR_TYPES[name],
            map_error=media._map_fallback_error,
        )
        for name, _, _, _ in [
            ("douyin-fallback", None, None, None),
            ("xiaohongshu-fallback", None, None, None),
            ("bilibili-fallback", None, None, None),
        ]
    )

    original_strategies = media.FALLBACK_DOWNLOAD_STRATEGIES
    original_probe = media.download_xiaohongshu_subtitle
    media.FALLBACK_DOWNLOAD_STRATEGIES = strategies
    def probe_subtitle(probe_url, probe_dir):
        probe_calls.append(probe_url)
        return None

    media.download_xiaohongshu_subtitle = probe_subtitle
    try:
        try:
            result = media.download_video(url, output_dir, runner=runner)
            outcome = {
                "status": "ok",
                "result": {
                    "command": normalize_command(result.command, output_dir),
                    "returncode": result.returncode,
                    "stdout": normalize_text(result.stdout, output_dir),
                    "stderr": normalize_text(result.stderr, output_dir),
                },
            }
        except media.CommandExecutionError as exc:
            outcome = {"status": "error", "message": normalize_text(str(exc), output_dir)}
    finally:
        media.FALLBACK_DOWNLOAD_STRATEGIES = original_strategies
        media.download_xiaohongshu_subtitle = original_probe

    return {
        "label": label,
        "url": url,
        "runner_returns": [
            {"returncode": code, "stdout": normalize_text(stdout, output_dir),
             "stderr": normalize_text(stderr, output_dir)}
            for code, stdout, stderr in runner_returns
        ],
        "existing_files": existing_files,
        "fallback_outcome": fallback_outcome,
        "expected": {
            "runner_commands": [normalize_command(command, output_dir) for command in calls],
            "fallback_calls": fallback_calls,
            "probe_calls": [normalize_text(call, output_dir) for call in probe_calls],
            **outcome,
        },
    }


def main():
    import tempfile

    cases = []
    for scenario in SCENARIOS:
        with tempfile.TemporaryDirectory() as directory:
            cases.append(run_scenario(*scenario, root=Path(directory)))
    FIXTURE.write_text(json.dumps(cases, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {FIXTURE} with {len(cases)} scenarios")


if __name__ == "__main__":
    main()
