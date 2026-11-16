"""生成文字稿整理的 Python 基准，供 TypeScript 侧逐字节比对。

用法：python scripts/tests/transcript-polish-golden.py

`worker_core.transcript_polish` 顶部的 import 会拉起发行包内的 `agent_runtime` 与
`worker_core.draft_agent`（本仓库没有前者），而本脚本只用到与供应商无关的纯函数：
常量、系统提示词、切块、段提示词、原稿摘要与进度归一化。因此给这两个模块放桩，
其余实现全部来自 Python 生产源码，不另写一份。
"""

from __future__ import annotations

import json
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "worker"))

for name in ("agent_runtime", "agent_runtime.provider", "agent_runtime.provider.sources"):
    sys.modules[name] = types.ModuleType(name)
_openai_source = types.ModuleType("agent_runtime.provider.sources.openai_source")
_openai_source.ProviderOpenAIOfficial = object
sys.modules["agent_runtime.provider.sources.openai_source"] = _openai_source
_draft_agent = types.ModuleType("worker_core.draft_agent")
_draft_agent.build_llm_provider = _draft_agent.resolve_draft_credentials = lambda *a, **k: None
sys.modules["worker_core.draft_agent"] = _draft_agent

from worker_core.transcript_polish import (  # noqa: E402
    POLISH_CHUNK_CHARS,
    POLISH_CONTEXT_CHARS,
    POLISH_MAX_CHUNKS,
    POLISH_META_SCHEMA_VERSION,
    POLISH_SYSTEM_PROMPT,
    _scaled_progress,
    build_polish_prompt,
    chunk_transcript,
    source_transcript_sha256,
)

SHORT = "第一段语音识别结果，有一个同音错误。\n\n第二段内容。"
PARAGRAPHS = "第一句。\n\n第二句。\n\n第三句。"
EMOJI = ("开头😀中段" * 220) + "结尾"  # 超过 200 字，且尾部上下文含代理对
LONG = "这是一段很长的文字稿，按语义切块。" * 120

bodies = [
    {"label": "short", "body": SHORT},
    {"label": "paragraphs", "body": PARAGRAPHS},
    {"label": "emoji", "body": EMOJI},
    {"label": "long", "body": LONG},
    {"label": "empty", "body": ""},
]

chunks = []
for case in bodies:
    # 长稿再按 11 字切会产生数百个碎片，golden 体积涨十倍却测不到新行为。
    widths = (POLISH_CHUNK_CHARS, 1000) if case["label"] == "long" else (POLISH_CHUNK_CHARS, 1000, 11)
    for max_chars in widths:
        chunks.append({
            "label": case["label"],
            "maxChars": max_chars,
            "expected": chunk_transcript(case["body"], max_chars=max_chars),
        })

prompts = []
for case in bodies:
    split = chunk_transcript(case["body"], max_chars=1000)
    for index in range(len(split)):
        prompts.append({
            "label": case["label"],
            "index": index,
            "expected": build_polish_prompt(index, split),
        })

hashes = [
    {"label": case["label"], "expected": source_transcript_sha256(case["body"])}
    for case in bodies
]

meta = [
    {
        "label": case["label"],
        "expected": json.dumps(
            {
                "schemaVersion": POLISH_META_SCHEMA_VERSION,
                "sourceTranscriptSha256": source_transcript_sha256(case["body"]),
            },
            ensure_ascii=False,
            indent=2,
        ) + "\n",
    }
    for case in bodies
]

progress = []
for count in (1, 3, 7, 24, 100, 120):
    attempt_for = _scaled_progress(count)
    total = max(1, min(100, count))
    events = [
        {
            "index": index,
            "progress": 70 + ((index * 20) // count),
            "attempt": attempt_for(index),
            "total": total,
        }
        for index in range(count)
    ]
    progress.append({"chunkCount": count, "events": events})

fixture = {
    "constants": {
        "polishChunkChars": POLISH_CHUNK_CHARS,
        "polishContextChars": POLISH_CONTEXT_CHARS,
        "polishMaxChunks": POLISH_MAX_CHUNKS,
        "polishMetaSchemaVersion": POLISH_META_SCHEMA_VERSION,
    },
    "systemPrompt": POLISH_SYSTEM_PROMPT,
    "bodies": {case["label"]: case["body"] for case in bodies},
    "chunks": chunks,
    "prompts": prompts,
    "hashes": hashes,
    "meta": meta,
    "progress": progress,
}

target = ROOT / "worker-ts" / "tests" / "fixtures" / "transcript-polish-golden.json"
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(
    f"wrote {target} ({target.stat().st_size} bytes, "
    f"{len(chunks)} chunk cases, {len(prompts)} prompts, {len(progress)} progress sets)"
)
