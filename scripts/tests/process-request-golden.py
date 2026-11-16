# URL 任务请求的 Python 基准生成器。
# 把 `worker_core.requests.parse_process_request` 跑在同一批正反例上，输出成 JSON
# 供 TypeScript 侧逐项比对；改了任何一侧的规则就重新生成并评审差异。
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))

from worker_core.desktop_contract import PROCESS_VIDEO_CONTRACT_VERSION  # noqa: E402
from worker_core.requests import (  # noqa: E402
    DESKTOP_ASR_MODELS,
    INVALID_PROCESS_PAYLOAD_MESSAGE,
    PROCESS_VIDEO_REQUEST_FIELDS,
    parse_process_request,
)

FIXTURE = (
    Path(__file__).resolve().parents[2] / "worker-ts" / "tests" / "fixtures" / "process-request-golden.json"
)

BASE = {
    "contract_version": 3,
    "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "asr_model": "iic/SenseVoiceSmall-onnx",
}

CASES = [
    ("valid onnx", dict(BASE)),
    ("valid pytorch model", {**BASE, "asr_model": "iic/SenseVoiceSmall"}),
    ("url trims ascii whitespace", {**BASE, "url": " \t\n https://example.com/v \r\n "}),
    ("url trims unicode whitespace", {**BASE, "url": "\u3000\u00a0https://example.com/v\u2003\u2028"}),
    ("url trims python-only separators", {**BASE, "url": "\u001c\u0085https://example.com/v\u001f"}),
    ("url keeps U+FEFF", {**BASE, "url": "\ufeffhttps://example.com/v\ufeff"}),
    ("url keeps interior whitespace", {**BASE, "url": "https://example.com/a b"}),
    ("missing contract_version", {"url": BASE["url"], "asr_model": BASE["asr_model"]}),
    ("missing url", {"contract_version": 3, "asr_model": BASE["asr_model"]}),
    ("missing asr_model", {"contract_version": 3, "url": BASE["url"]}),
    ("empty object", {}),
    ("extra field", {**BASE, "output_language": "zh"}),
    ("contract_version as string", {**BASE, "contract_version": "3"}),
    ("contract_version as bool", {**BASE, "contract_version": True}),
    ("contract_version as null", {**BASE, "contract_version": None}),
    ("contract_version as float equal", {**BASE, "contract_version": 3.0}),
    ("contract_version as float unequal", {**BASE, "contract_version": 3.5}),
    ("contract_version one less", {**BASE, "contract_version": 2}),
    ("contract_version one more", {**BASE, "contract_version": 4}),
    ("url as number", {**BASE, "url": 123}),
    ("url as null", {**BASE, "url": None}),
    ("url as list", {**BASE, "url": ["https://example.com/v"]}),
    ("url empty", {**BASE, "url": ""}),
    ("url only ascii whitespace", {**BASE, "url": " \t\r\n "}),
    ("url only unicode whitespace", {**BASE, "url": "\u3000\u00a0\u2028"}),
    ("url only python-only separators", {**BASE, "url": "\u001c\u0085\u001f"}),
    ("url only U+FEFF", {**BASE, "url": "\ufeff"}),
    ("asr_model unknown", {**BASE, "asr_model": "iic/Other"}),
    ("asr_model as null", {**BASE, "asr_model": None}),
    ("asr_model as number", {**BASE, "asr_model": 7}),
    ("payload null", None),
    ("payload list", [3, "https://example.com/v", "iic/SenseVoiceSmall-onnx"]),
    ("payload string", "https://example.com/v"),
    ("payload number", 3),
    ("payload bool", True),
]


def run(payload):
    try:
        request = parse_process_request(payload)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "url": request.url, "asr_model": request.asr_model}


def main():
    result = {
        "fields": sorted(PROCESS_VIDEO_REQUEST_FIELDS),
        "contract_version": PROCESS_VIDEO_CONTRACT_VERSION,
        "message": INVALID_PROCESS_PAYLOAD_MESSAGE,
        "models": sorted(DESKTOP_ASR_MODELS),
        "cases": [
            {"label": label, "payload": payload, "result": run(payload)}
            for label, payload in CASES
        ],
    }
    FIXTURE.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(CASES)} cases to {FIXTURE}")


if __name__ == "__main__":
    main()
