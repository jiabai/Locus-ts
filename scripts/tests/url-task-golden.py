"""Generate the cross-language golden for URL task identity and manifests.

The fixture is produced by the Python production code in ``worker_core.task_store``:
``create_task_context`` decides the task id, ``serialize_task_manifest`` decides every
byte of ``task.json``, and ``_task_source_from_manifest`` decides whether a manifest
can be read back. The TypeScript side must match all three byte-for-byte / case-for-case.
"""

import copy
import json
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "worker"))

from worker_core import task_store  # noqa: E402
from worker_core.models import (  # noqa: E402
    JobStage,
    ProcessRequest,
    ProcessResult,
    TranscriptMetadata,
)
from worker_core.source_identity import identify_source  # noqa: E402

FIXTURE = ROOT / "worker-ts" / "tests" / "fixtures" / "url-task-golden.json"
ASR_MODEL = "iic/SenseVoiceSmall-onnx"
CREATED = datetime(2026, 11, 14, 12, 0, 0, tzinfo=UTC)
UPDATED = datetime(2026, 11, 14, 12, 34, 56, tzinfo=UTC)


class FixedDateTime(datetime):
    """Pin ``serialize_task_manifest``'s ``datetime.now(UTC)`` to UPDATED."""

    @classmethod
    def now(cls, tz=None):
        return datetime(2026, 11, 14, 12, 34, 56, tzinfo=tz)


task_store.datetime = FixedDateTime

CASES = [
    ("douyin direct", "https://www.douyin.com/video/7524373044106677544"),
    ("xiaohongshu note", "https://www.xiaohongshu.com/explore/abcdef0123456789abcdef01"),
    ("bilibili part 3", "https://www.bilibili.com/video/BV1xx411c7mD/?p=3"),
    ("youtube watch", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    ("youtube short link", "https://youtu.be/dQw4w9WgXcQ?t=9"),
]

RESULT = ProcessResult(
    status=JobStage.COMPLETED,
    text="  视频文字稿示例  ",
    transcript=TranscriptMetadata(source="asr", language=None, engine=ASR_MODEL),
    artifacts={"transcript_txt": "transcript/transcript.txt"},
)


def build_case(label, url):
    identity = identify_source(url)
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        context = task_store.create_task_context(
            ProcessRequest(url=url, asr_model=ASR_MODEL),
            identity,
            output_root=root / "outputs",
            cache_root=root / "cache",
            now=CREATED,
        )
        manifest = task_store.serialize_task_manifest(context, RESULT).decode("utf-8")
    return {
        "label": label,
        "url": url,
        "asr_model": ASR_MODEL,
        "identity": identity.to_manifest_dict(),
        "task_id": context.task_id,
        "created_at": context.created_at,
        "manifest": manifest,
    }


def readback_cases(base_manifest):
    """Source-boundary mutations, judged by Python's production manifest reader."""
    def mutated(label, change):
        candidate = copy.deepcopy(base_manifest)
        change(candidate)
        try:
            task_store._task_source_from_manifest(candidate)
            accept = True
        except (ValueError, TypeError):
            accept = False
        return {"label": label, "manifest": candidate, "accept": accept}

    return [
        mutated("unmodified manifest", lambda value: None),
        mutated("explicit url source kind", lambda value: value.update(source_kind="url")),
        mutated("null source kind", lambda value: value.update(source_kind=None)),
        mutated("local_file source kind", lambda value: value.update(source_kind="local_file")),
        mutated("web_page source kind", lambda value: value.update(source_kind="web_page")),
        mutated("web schema version", lambda value: value.update(schema_version=4)),
        mutated("missing source identity", lambda value: value.pop("source_identity")),
        mutated("null source identity", lambda value: value.update(source_identity=None)),
        mutated("source url mismatch", lambda value: value.update(source_url="https://example.com/other")),
        mutated("empty source url", lambda value: value.update(source_url="")),
        mutated("local source also present",
                lambda value: value.update(local_source={"display_name": "a.mp4"})),
        mutated("web source also present", lambda value: value.update(web_source={"title": "x"})),
        mutated("identity extra key",
                lambda value: value["source_identity"].update(extra="ignored")),
        mutated("identity version drift", lambda value: value["source_identity"].update(version=2)),
        mutated("identity stable id drift",
                lambda value: value["source_identity"].update(stable_id="other")),
        mutated("identity platform drift",
                lambda value: value["source_identity"].update(platform="youtube")),
        mutated("identity canonical url drift",
                lambda value: value["source_identity"].update(canonical_url="https://example.com/other")),
        mutated("identity effective part drift",
                lambda value: value["source_identity"].update(effective_part=7)),
        mutated("identity effective part null",
                lambda value: value["source_identity"].update(effective_part=None)),
        mutated("identity effective part bool",
                lambda value: value["source_identity"].update(effective_part=True)),
    ]


def main():
    cases = [build_case(label, url) for label, url in CASES]
    # 用带分 P 的 B 站身份做读回基准：effective_part 的三态都能被真正检验。
    base = json.loads(cases[2]["manifest"])
    payload = {
        "constants": {
            "schema_version": task_store.TASK_SCHEMA_VERSION,
            "source_privacy_migration_version": task_store.SOURCE_PRIVACY_MIGRATION_VERSION,
            "created_at": "2026-11-14T12:00:00Z",
            "updated_at": UPDATED.isoformat(timespec="seconds").replace("+00:00", "Z"),
        },
        "cases": cases,
        "readback": readback_cases(base),
    }
    FIXTURE.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {FIXTURE} with {len(cases)} cases and {len(payload['readback'])} readback cases")


if __name__ == "__main__":
    main()
