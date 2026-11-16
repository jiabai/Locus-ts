# 生成文字稿解剖的 Python 基准，供 TypeScript 侧逐字节比对。
# 用法：python scripts/tests/dissection-golden.py
# 常量、提示词、报告校验、三语 Markdown 与产物字节全部取自 Python 生产源码。

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "worker"))

from worker_core.ai_prompts import build_dissection_agent_prompt  # noqa: E402
from worker_core.dissection_report import (  # noqa: E402
    DissectionGenerationError,
    build_dissection_artifacts,
    format_dissection_markdown,
    parse_dissection_report,
    parse_persisted_dissection,
)
from worker_core.transcript_chunks import MarkdownSplitter  # noqa: E402

LANGUAGES = ("zh-CN", "zh-TW", "en-US")
SHORT = "第一段🙂。\r\n第二段。\r\n"
ENGLISH = "First paragraph.\r\nSecond paragraph.\r\n"
PROMPT_BODY = "开头钩子。中段论证。结尾行动。"


def semantic_report(quote):
    return {
        "overallNarrative": {
            "openingHook": "Question",
            "structureType": "Problem and solution",
            "turningPoint": "The proposed solution",
            "closingType": "Call to action",
        },
        "segments": [{
            "id": 1,
            "title": "Opening",
            "sourceChunkIds": [1],
            "coreClaim": "第一段",
            "supportingPoints": ["第二段"],
            "rhetoricalDevices": ["Question"],
            "rhythmNote": "Fast",
            "reusablePattern": "Introduce [problem], then explain [solution]",
            "riskFlags": ["The claim needs verification"],
        }],
        "highlights": [quote],
        "reusableTemplate": {
            "name": "Problem and solution",
            "skeleton": ["Introduce [problem]", "Explain [evidence]", "Offer [action]"],
        },
        "audienceFit": [
            {"audience": "Beginners", "fit": "high", "note": "Accessible"},
            {"audience": "Practitioners", "fit": "medium", "note": "Concise"},
            {"audience": "Experts", "fit": "low", "note": "Limited depth"},
        ],
        "strengths": ["Clear"],
        "weaknesses": ["Brief"],
    }


def parse(transcript, payload=None, source_language="zh-CN"):
    return parse_dissection_report(
        payload if payload is not None else semantic_report("第一段" if "第一段" in transcript else "First paragraph."),
        transcript=transcript,
        chunks=MarkdownSplitter().split(transcript),
        source_language=source_language,
    )


prompts = []
for language in LANGUAGES:
    for source_kind in ("transcript", "article"):
        chunks = MarkdownSplitter(max_length=8).split(PROMPT_BODY)
        prompts.append({
            "language": language,
            "sourceKind": source_kind,
            "chunks": [{"id": chunk.id, "content": chunk.content} for chunk in chunks],
            "expected": build_dissection_agent_prompt(chunks, language, source_kind),
        })

report_cases = []
report_cases.append({"label": "valid-short", "transcript": SHORT, "payload": semantic_report("第一段"), "sourceLanguage": "zh-CN"})
report_cases.append({"label": "valid-english", "transcript": ENGLISH, "payload": semantic_report("First paragraph."), "sourceLanguage": "en-US"})
report_cases.append({"label": "optional-null", "transcript": SHORT, "payload": {
    **semantic_report("第一段"),
    "overallNarrative": {"openingHook": None, "structureType": "Structure only", "turningPoint": None, "closingType": None},
    "audienceFit": [], "strengths": [], "weaknesses": [], "highlights": [],
}, "sourceLanguage": None})

mutations = [
    ("extra-field", lambda payload: payload.update({"prompt": "Unexpected field"})),
    ("chunk-id-unknown", lambda payload: payload["segments"][0].update({"sourceChunkIds": [2]})),
    ("chunk-id-duplicate", lambda payload: payload["segments"][0].update({"sourceChunkIds": [1, 1]})),
    ("chunk-id-bool", lambda payload: payload["segments"][0].update({"sourceChunkIds": [True]})),
    ("segment-id-wrong", lambda payload: payload["segments"][0].update({"id": 2})),
    ("highlight-invented", lambda payload: payload.update({"highlights": ["Absent quotation"]})),
    ("highlight-too-many", lambda payload: payload.update({"highlights": ["第一段"] * 9})),
    ("strengths-too-many", lambda payload: payload.update({"strengths": ["Point"] * 7})),
    ("weaknesses-too-many", lambda payload: payload.update({"weaknesses": ["Point"] * 7})),
    ("fit-unknown", lambda payload: payload["audienceFit"][0].update({"fit": "perfect"})),
    ("script-tag", lambda payload: payload["segments"][0].update({"title": "<script>alert(1)</script>"})),
    ("javascript-url", lambda payload: payload["segments"][0].update({"title": "javascript:alert(1)"})),
    ("skeleton-short", lambda payload: payload["reusableTemplate"].update({"skeleton": ["Too short"]})),
    ("segments-empty", lambda payload: payload.update({"segments": []})),
    ("missing-key", lambda payload: payload["overallNarrative"].pop("structureType")),
    ("empty-text", lambda payload: payload["segments"][0].update({"coreClaim": "   "})),
]
for label, mutate in mutations:
    payload = semantic_report("第一段")
    mutate(payload)
    report_cases.append({"label": label, "transcript": SHORT, "payload": payload, "sourceLanguage": None})

reports = []
for case in report_cases:
    try:
        report = parse_dissection_report(
            case["payload"], transcript=case["transcript"],
            chunks=MarkdownSplitter().split(case["transcript"]),
            source_language=case["sourceLanguage"],
        )
        expected = report.to_dict()
        category = None
        error_code = None
    except DissectionGenerationError as exc:
        expected = None
        category = exc.validation_category
        error_code = exc.code
    reports.append({
        "label": case["label"],
        "transcript": case["transcript"],
        "payload": case["payload"],
        "sourceLanguage": case["sourceLanguage"],
        "expected": expected,
        "validationCategory": category,
        "errorCode": error_code,
    })

artifacts = []
for transcript in (SHORT, ENGLISH):
    payload = semantic_report("第一段" if "第一段" in transcript else "First paragraph.")
    report = parse_dissection_report(
        payload, transcript=transcript, chunks=MarkdownSplitter().split(transcript),
        source_language="zh-CN",
    )
    for language in LANGUAGES:
        built = build_dissection_artifacts(report, output_dir=Path("unused"), output_language=language)
        artifacts.append({
            "transcript": transcript,
            "language": language,
            "payload": payload,
            "sourceLanguage": "zh-CN",
            "jsonText": built.json_bytes.decode("utf-8"),
            "markdownText": built.markdown_bytes.decode("utf-8"),
            "markdownLf": format_dissection_markdown(report, language),
        })

valid_payload = parse(SHORT).to_dict()
tampered_end_byte = json.loads(json.dumps(valid_payload))
tampered_end_byte["sourceChunks"][0]["endByte"] += 1
tampered_schema = json.loads(json.dumps(valid_payload))
tampered_schema["schemaVersion"] = 2
tampered_extra = json.loads(json.dumps(valid_payload))
tampered_extra["injected"] = True
tampered_language = json.loads(json.dumps(valid_payload))
tampered_language["sourceLanguage"] = "  "

persisted_cases = []
for label, payload, transcript in [
    ("valid", valid_payload, SHORT),
    ("provenance-end-byte", tampered_end_byte, SHORT),
    ("schema-version", tampered_schema, SHORT),
    ("extra-field", tampered_extra, SHORT),
    ("blank-language", tampered_language, SHORT),
    ("stale-transcript", valid_payload, ENGLISH),
    ("not-an-object", [], SHORT),
]:
    try:
        expected = parse_persisted_dissection(payload, transcript=transcript).to_dict()
        error_code = None
    except (DissectionGenerationError, ValueError, KeyError, TypeError) as exc:
        expected = None
        error_code = getattr(exc, "code", "DISSECTION_INVALID_RESULT")
    persisted_cases.append({
        "label": label, "payload": payload, "transcript": transcript,
        "expected": expected, "errorCode": error_code,
    })

fixture = {
    "promptBody": PROMPT_BODY,
    "prompts": prompts,
    "reports": reports,
    "artifacts": artifacts,
    "persisted": persisted_cases,
}

target = ROOT / "worker-ts" / "tests" / "fixtures" / "dissection-golden.json"
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(
    f"wrote {target} ({target.stat().st_size} bytes, "
    f"{len(prompts)} prompts, {len(reports)} report cases, "
    f"{len(artifacts)} artifact sets, {len(persisted_cases)} persisted cases)"
)
