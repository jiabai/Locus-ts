"""生成生产侧基线：用 worker 现有的 Python 转写器跑同一批 fixture。

这一步只在需要重建或复核基线时运行，门禁本身（run.mjs）不依赖 Python。
dither 固定为 0，与 golden/policy.json 一致；生产默认的 1.0 用时间做随机种子，
每次结果都不同，不能作为固定基线。

用法（仓库根目录）：
    PYTHONPATH=worker .venv/Scripts/python.exe scripts/asr-verification/tools/production_reference.py \
        --cache-dir work/asr-spike/models/production/onnx
"""
from __future__ import annotations

import argparse
import json
import sys
import wave
from dataclasses import asdict
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
FIXTURE_DIR = PACKAGE_ROOT / "fixtures"
GOLDEN_DIR = PACKAGE_ROOT / "golden"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache-dir", required=True, help="模型缓存目录，形如 <数据根>/models/onnx")
    parser.add_argument("--dither", type=float, default=0.0)
    args = parser.parse_args()

    cache_dir = Path(args.cache_dir).resolve()
    asr_dir = cache_dir / "models/iic/SenseVoiceSmall-onnx"
    vad_dir = cache_dir / "models/iic/speech_fsmn_vad_zh-cn-16k-common-onnx"
    for required in (asr_dir / "model_quant.onnx", vad_dir / "model_quant.onnx"):
        if not required.is_file():
            print(f"缺少模型文件：{required}", file=sys.stderr)
            return 2

    from worker_core.asr_runtime.sensevoice_onnx import SenseVoiceOnnxTranscriber
    from worker_core.asr_runtime.types import ASREmptyTranscriptError

    manifest = json.loads((FIXTURE_DIR / "manifest.json").read_text(encoding="utf-8"))
    payload = {
        "source": "worker_core.asr_runtime.sensevoice_onnx.SenseVoiceOnnxTranscriber",
        "asr_config": {"language": "Chinese", "textnorm": "withitn", "dither": args.dither},
        "model_cache": str(cache_dir),
        "cases": {},
    }

    transcriber = SenseVoiceOnnxTranscriber(asr_model_dir=asr_dir, vad_model_dir=vad_dir)
    transcriber._get_asr().frontend.opts.frame_opts.dither = args.dither

    for fixture in manifest["fixtures"]:
        audio = FIXTURE_DIR / fixture["file"]
        with wave.open(str(audio), "rb") as handle:
            sample_count = handle.getnframes()
        case = {"wav_sha256": fixture["sha256"], "sample_count": sample_count}
        try:
            transcript = transcriber.transcribe(audio, language="Chinese")
        except ASREmptyTranscriptError:
            case["empty"] = True
            payload["cases"][fixture["id"]] = case
            print(f"{fixture['id']:<16} 空转写（期望行为）")
            continue
        case["segments"] = [[segment.start_ms, segment.end_ms] for segment in transcript.segments]
        case["segment_texts"] = [segment.text for segment in transcript.segments]
        case["text"] = transcript.text
        case["segments_detail"] = [asdict(segment) for segment in transcript.segments]
        payload["cases"][fixture["id"]] = case
        print(f"{fixture['id']:<16} 段 {len(case['segments']):>2}  字符 {len(case['text']):>4}  {case['text'][:32]}")

    out = GOLDEN_DIR / "production-reference.json"
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("已写入", out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
