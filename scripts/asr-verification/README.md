# TypeScript ASR 门禁

TypeScript worker 的 ASR 路径在合并前必须能自证「和生产 Python 实现等价、且没有回归」。这个包把
`work/asr-spike/` 里的实验探针固化成仓库内的可执行门禁：固定音频窗、固定模型哈希、固定基线结果，
一条命令给出 PASS/FAIL。

**它跑的是生产代码，不是第二份实现。** 适配器、前端、VAD 状态机与解码都在
`worker-ts/src/asr/`；门禁只负责固定输入、冻结基线与判定。任何一侧改动都会立刻体现在这里。

覆盖范围是 ASR 算法链路（Fbank 前端 → CTC 解码 → FSMN VAD → 分段 → 逐段识别 → `Transcript`），
不覆盖下载、工作间、打包与 Rust 监督。

## 判定三层

任一层失败即非零退出：

1. **资产**：`worker-ts/src/asr/model-assets.ts` 固定的模型哈希必须与磁盘一致；`fixtures` 的哈希也必须一致。
2. **结构**：VAD 分段必须与 `golden/production-reference.json` 逐毫秒相同。
3. **文本**：
   - 必须与本机 `golden/<平台>/<case>.json` 逐字相同（回归）；
   - 相对生产基线的 CER 必须 ≤ `golden/policy.json` 的 `textCerTolerance`（0.5 个百分点）。

第 3 层两条同时存在是刻意的：只留 golden 会把生产差异固化成「正确」；只留 CER 会放过逐字退化——
0.5% 的额度足以吞掉几十个字。

## 前置：依赖与模型缓存

```bash
npm --prefix worker-ts install     # 首次：门禁复用 worker-ts 的 onnxruntime-node，不另装一份
```

模型缓存直接读生产 `<数据根>/models/onnx` 布局，不复制、不改写。任选一种：

- 指向已有的用户缓存：`--cache-dir "D:/LOCUS/models/onnx"`。
- 指向实验副本（本仓库开发时常用）：`--cache-dir work/asr-spike/models/production/onnx`。
- 从零下载（走仓库自己的下载器，带哈希校验）：

  ```bash
  PYTHONPATH=worker .venv/Scripts/python.exe -c "
  from pathlib import Path
  from worker_core.model_download import download_asr_model_cache, ONNX_SENSEVOICE_MODEL_ID
  print(download_asr_model_cache(Path('models/onnx'), ONNX_SENSEVOICE_MODEL_ID))
  "
  ```

缓存缺失或哈希不符时以退出码 2 结束，并打印具体是哪个文件、实际哈希是多少，不会降级为「跳过」。

## 运行

```bash
cd scripts/asr-verification
node --experimental-strip-types run.mjs --cache-dir <缓存目录>
node --experimental-strip-types run.mjs --cache-dir <缓存目录> --only speech-12s --json build/asr-report.json
```

`--experimental-strip-types` 是 Node 22 的必需项（Node ≥23.6 默认支持，可省略）；生产代码是
TypeScript，门禁直接导入源码而不走构建产物。

Deno 下等价运行（安装包锁定的 2.9.1，权限必须含 `--allow-ffi`）：

```bash
deno run --allow-read --allow-write --allow-ffi run.mjs --cache-dir <缓存目录>
```

两个运行时给出的分段与文本逐字相同；这一点本身也被验证过，见
`docs/exec-plans/active/2026-11-13-worker-typescript-rewrite-gaps.md`。

## fixture 选点

fixture 是 `tools/make-fixtures.mjs` 从本地语料裁出的固定窗口，语料本身不入库（体积与授权），
fixture 入库并由 SHA-256 固定，因此门禁运行不需要语料。

| fixture | 来源 | 覆盖 |
| --- | --- | --- |
| `speech-12s` | `monologue-pharma.wav` @10s | 连续语音、单段、跨越 10 秒 VAD 分块 |
| `dialogue-32s` | `interview-finance.wav` @0s | 对话、4 段、4 个分块、相邻段端点闭合 |
| `silence-3s` | 合成静音 | 无语音必须零段并抛 `ASR_EMPTY_TRANSCRIPT` |

**选点标准不是「有代表性」，而是「边界稳健」**：同一个窗口必须让 Python 生产实现与 TypeScript
实现给出完全相同的分段。实测反例——`music-song` 与 `discussion-tech` 的若干窗口，两侧分段相差
10~120 ms（多出一个 500 ms 短段或起点偏移），根因是前端 `1e-4` 量级的浮点差异落在临界帧上。
这类窗口不能进 fixture，否则门禁会周期性红。

所以新增 fixture 的流程是：先两边各跑一遍确认分段一致、CER 为 0，再 `--freeze`。

## 重建基线

```bash
# 1. 重做 fixture（会改变哈希，必须同时重建 2 和 3）
node tools/make-fixtures.mjs <语料目录>

# 2. 生产侧基线（需要 Python 环境，只用一次）
PYTHONPATH=worker ../../.venv/Scripts/python.exe tools/production_reference.py --cache-dir <缓存目录>

# 3. 本平台 golden（先确认输出正确，再冻结）
node --experimental-strip-types run.mjs --cache-dir <缓存目录> --freeze
```

`--freeze` 会把当前输出写成该平台的 golden，等于宣告「这是正确结果」。不要在失败状态下冻结。

## 新平台（macOS）

`golden/<平台>/` 按 `process.platform-process.arch` 分目录。缺失时会明确失败并提示，而不是
退回别的平台 golden——ONNX Runtime 的 CPU 内核在 x64 与 arm64 上可能给出不同的末位数值，进而
翻转临界帧的 argmax。

首次在 macOS 上跑的正确流程：先跑一次，确认分段与 `production-reference.json` 一致、CER 在阈值内、
文本差异是逐字级别且人工可解释，再 `--freeze`，并把该平台的 golden 与差异结论一起提交。

## 已知残余风险

- **分段不是跨平台恒等的**：临界帧上的 10 ms 级漂移是既有事实，靠 fixture 选点规避，不是靠代码
  修正。正式发布前若要覆盖更宽的音频类型，需要放宽为「±1 帧 + 段数一致」的断言，并重新论证。
- **dither 只覆盖确定性路径**：生产 ASR 前端 `dither=1.0` 用当前时间做随机种子，同一段音频每次
  结果都不同，因此不在逐字比对范围内。门禁固定 `dither=0`，生产随机路径的质量由 CER 门槛覆盖。
- **macOS Apple Silicon golden 尚未生成**（本仓库当前只有 `win32-x64`）。
- **参考文本噪声**：`production-reference.json` 由生产实现自身生成，因此它衡量的是「一致」，
  不是「准确」。准确度门槛靠独立的 Paraformer 参考，见 gaps 文档的三方 CER 结论。
