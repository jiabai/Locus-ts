"""生成笔记标题的 Python 基准，供 TypeScript 侧逐字节比对。

用法：python scripts/tests/note-title-golden.py

`worker_core.note_title` 顶部的 import 会拉起发行包内的 `agent_runtime`（本仓库没有），
而本脚本只用到与供应商无关的纯函数。因此这里为 `worker_core.ai_runtime` 放一个桩，
让 import 链走通；常量、采样、提示词与解析规则全部来自 Python 生产源码，不另写一份实现。
"""

from __future__ import annotations

import json
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "worker"))

_stub = types.ModuleType("worker_core.ai_runtime")
_stub.agent_error = _stub.build_insight_provider = _stub.insight_target_env = lambda *a, **k: None
sys.modules["worker_core.ai_runtime"] = _stub

from worker_core.note_title import (  # noqa: E402
    TITLE_SAMPLE_CHARACTERS,
    _SYSTEM_PROMPT,
    build_title_prompt,
    parse_title_response,
    sample_transcript,
)

SHORT = "谈论人工智能与沟通。"
SPECIAL = '他说："先做流程，再谈平台。"\n\t第二行 😀 与 U+2028 之前。'
LONG = "开始" + "甲" * 7000 + "中间" + "乙" * 7000 + "结尾"
EDGE = "a" * TITLE_SAMPLE_CHARACTERS

samples = [
    {"body": body, "expected": sample_transcript(body)}
    for body in (SHORT, SPECIAL, EDGE, LONG)
]

prompts = [
    {"body": body, "language": language, "expected": build_title_prompt(body, language)}
    for language in ("zh-CN", "zh-TW", "en-US")
    for body in (SHORT, SPECIAL)
]

raw_responses = [
    (json.dumps({"title": "理解人工智能时代的沟通能力"}), None),
    (json.dumps({"title": "  理解人工智能时代的沟通能力  "}), None),
    (json.dumps({"title": "😀" * 60}), None),
    (json.dumps({"title": "one two three four five six seven eight nine ten"}), "en-US"),
    (json.dumps({"title": "one two three four five six seven eight nine ten"}), "zh-CN"),
    (json.dumps({"title": "one two three four five six seven eight nine ten more"}), "en-US"),
    ('{"title":"valid","extra":true}', None),
    ('["title"]', None),
    ('"title"', None),
    ('```json\n{"title":"valid"}\n```', None),
    ('{"title":"a","title":"b"}', None),
    ('{"title":{"nested":"a","nested":"b"}}', None),
    (json.dumps({"title": ""}), None),
    (json.dumps({"title": "   "}), None),
    (json.dumps({"title": "甲" * 61}), None),
    (json.dumps({"title": "one\ntwo"}), None),
    (json.dumps({"title": "a\u202eb"}), None),
    (json.dumps({"title": "a\u200bb"}), None),
    (json.dumps({"title": "\nvalid\n"}), None),
    (json.dumps({"title": 12}), None),
    ("{}", None),
    ("not json", None),
]
responses = []
for body, language in raw_responses:
    try:
        expected = parse_title_response(body, language)
    except (ValueError, TypeError):
        expected = None
    responses.append({"body": body, "language": language, "expected": expected})

fixture = {
    "systemPrompt": _SYSTEM_PROMPT,
    "sampleCharacters": TITLE_SAMPLE_CHARACTERS,
    "samples": samples,
    "prompts": prompts,
    "responses": responses,
}
target = ROOT / "worker-ts" / "tests" / "fixtures" / "note-title-golden.json"
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"wrote {target} ({target.stat().st_size} bytes, {len(responses)} response cases)")
