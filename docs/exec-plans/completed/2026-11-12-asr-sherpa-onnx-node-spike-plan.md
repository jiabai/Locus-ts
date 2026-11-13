# ASR sherpa-onnx-node 可行性测量

> This ExecPlan is a living document. The sections Progress, Surprises & Discoveries, Decision Log, and Outcomes & Retrospective must be kept up to date as work proceeds.

2026-11-12 至 2026-11-13 的已完成测量记录。worker 重写的当前范围、验收条件和未完成事项分别见 `docs/product-specs/2026-11-13-worker-typescript-rewrite.md`、`docs/exec-plans/active/2026-11-13-worker-typescript-rewrite-plan.md` 与 `docs/exec-plans/active/2026-11-13-worker-typescript-rewrite-gaps.md`。

## Purpose / Big Picture

在真实音频上比较现有 Python ONNX ASR 与 `sherpa-onnx-node` 候选，检查本地加载、语音分段、识别、性能和三平台原生依赖。测量数据与用户音频保存在本地 `work/asr-spike/`；实验未修改生产 worker、桌面应用、契约或打包配置。

## Progress

- [x] 2026-11-12：核查生产路径、模型缓存、音频归一化、分段和识别参数；基线为 `funasr_onnx.SenseVoiceSmall` + FSMN VAD，模型标识为 `iic/SenseVoiceSmall-onnx`。Validation: `worker/worker_core/asr_runtime/registry.py`、`sensevoice_onnx.py`、`model_download.py`。
- [x] 2026-11-12 至 2026-11-13：使用 `sherpa-onnx-node@2.0.1`、SenseVoice int8 导出模型和 Silero VAD 完成真实音频对照；测试 max20、max30、hard20、hard20coarse、hard20preroll 五种配置。归一化命令保持 `-vn -ac 1 -ar 16000 -c:a pcm_s16le`。Validation: `work/asr-spike/results/normalization.json`、`candidate/`。
- [x] 2026-11-12：9 条本机音视频合计约 5.3 小时，8 条语音文件各取一个窗口进行质量对照；另对无语音动画单独进行边界测试。粤语不属于本次质量语料范围。Validation: `work/asr-spike/corpus/manifest.json`、`results/edge-no-speech.json`。
- [x] 2026-11-12：Windows x64 本机、macOS x64 和 macOS arm64 GitHub Actions 均完成 Node 原生插件加载和模型自带音频识别；模型与运行时尚未在正式安装包内验收。Validation: macOS run `43219925284`、`work/asr-spike/results/smoke-win-x64.json`、两份 macOS smoke JSON。
- [x] 2026-11-13：使用本地 Paraformer 参与自动对照，保存两种候选配置的文本、仲裁和聚合结果；核对参考文本依赖候选输出的限制。Validation: `work/asr-spike/arbiter.py`、`results/final-metrics.json`、`results/final-metrics-preroll.json`。

## Surprises & Discoveries

- Evidence: **文件和引擎。** 生产 `model_quant.onnx` 的 SHA-256 为 `21dc965f689a78d1604717bf561e40d5a236087c85a95584567835750549e822`（`worker/worker_core/model_download.py`）；实验 `model.int8.onnx` 为 `c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51`。2026-11-13 对两份本机文件执行 `Get-FileHash -Algorithm SHA256`，结果与上述值一致。两者同属 SenseVoice 模型家族，文件不同。模型文件的来源、加载兼容性与识别质量需分别验证。
- Evidence: **分段。** 生产使用 FSMN VAD，候选使用 Silero VAD。实验中 `maxSpeechDuration` 为软约束，max20 出现最长 123.77 秒的片段；hard20 强制切分后，记录的分段均不超过 20 秒，详见 `results/segment-shape.json`。
- Evidence: **句首。** Silero 起点与 FSMN 存在差异，部分语料出现句首丢词。hard20preroll 的 0.4 秒前置补边对部分样本有改善；实验实现存在重叠识别，总耗时约为基线 1.55 倍。分段、补边与性能需在正式实现中共同验收。见 `results/pairwise.json` 和 `results/arbiter-report-preroll.json`。
- Evidence: **性能。** hard20 整体耗时约为基线 0.788 倍，峰值内存约为基线 1.34 倍；`monologue-pharma` 单条候选与基线配对重复计时的中位数比值约为 1.37，超过 1.2 倍逐条门槛。单块识别计时约 410 ms 对 417 ms，只说明该次测试的耗时接近。见 `candidate/timing-pharma.mjs` 和 `baseline/timing-pharma.py`。
- Evidence: **无语音。** 单条约 5 秒的无语音动画中，基线产生一段幻觉文本，候选没有检测到语音。该结果仅覆盖该样本，见 `results/edge-no-speech.json`。
- Evidence: **下载。** 两个 ModelScope 镜像的候选模型与词表各自哈希一致；本机直连 GitHub 模型归档中断，尚无本机与官方完整归档的直接哈希比对。CI 流程记录哈希，具体执行结果需以实际产物核验。见 `results/mirror-cross-check.json`、`results/download-github-releases.json`。

## Decision Log

- Decision: 测量候选固定为 `sherpa-onnx-node@2.0.1`、`model.int8.onnx` 与 `silero_vad.onnx`，基线固定为现有 ONNX 生产路径。Rationale: 固定模型与引擎便于比较。Date/Author: 2026-11-12 / User + QwenWork。
- Decision: 测量采用自动化流程，音视频与转写留在本机；三平台加载测试使用模型归档自带音频。Rationale: 遵守用户要求和本地数据边界；第三模型仲裁用于衡量输出一致性。Date/Author: 2026-11-13 / User + QwenWork。
- Decision: 质量、性能和安装包验收由当前 worker 重写计划定义。Rationale: 实验参考文本与产物存在可复现性限制。Date/Author: 2026-11-13 / Codex。

## Outcomes & Retrospective

实验判定为**有条件可行**。候选模型和原生依赖完成了三平台加载与识别，分段时长、句首保留、逐条性能和最终包内运行仍需解决并验证。

实验的 `results/final-metrics.json` 对 hard20 八个窗口报告基线 CER 均值 0.0538、候选 0.0610，漏句次数 3 对 8、重复循环次数 9 对 12；`results/final-metrics-preroll.json` 对 hard20preroll 报告基线 0.0595、候选 0.0614，漏句 3 对 7、重复循环 9 对 12。这些数值来自自动仲裁生成的参考文本。仲裁过程会读取待比较的候选输出，因此两个变体的参考文本和基线 CER 并非同一基准，不能直接跨变体比较 CER；它们也不能证明真实识别质量没有下降。

`results/pairwise.json` 对 9 条音视频的文本比较记录为 3 条更好、6 条相当、0 条更差；其中仍记录了句首丢失和歌曲幻觉，不能替代逐项质量门槛。英文为主的混合语料使用中文 Paraformer 仲裁存在局限，须单独报告。

`work/asr-spike/results/final-summary-run.log` 保存了一次聚合脚本失败的记录；当前聚合 JSON 的完整生成链未重新验证。实验语料、脚本和结果位于忽略目录，不能直接作为跨机器可复现门禁；复算须冻结输入、参考文本与脚本版本并记录实际运行结果。

Residual risk: 模型文件兼容、独立质量参考、逐条性能、正式安装包及完整复算均待验证；三个平台的现有证据覆盖原生加载和模型自带音频。

## Context and Orientation

- 生产 ASR：`worker/worker_core/asr_runtime/registry.py`、`sensevoice_onnx.py`、`types.py`、`artifacts.py`；模型下载见 `worker/worker_core/model_download.py`。
- 实验脚本：`work/asr-spike/baseline/`、`work/asr-spike/candidate/`、`work/asr-spike/arbiter.py`、`work/asr-spike/metrics/`。
- 实验结果：`work/asr-spike/results/baseline/`、`candidate/`、`final-metrics.json`、`final-metrics-preroll.json`、`arbiter-comparison.json`、`segment-shape.json`、`pairwise.json`。
- 三平台证据：`work/asr-spike/results/smoke-win-x64.json`、`asr-spike-smoke-macos-x64/`、`asr-spike-smoke-macos-arm64/`；CI 配置为 `.github/workflows/asr-spike-macos.yml`。

## Plan of Work

1. 固定生产路径与候选依赖，准备并归一化真实语料。
2. 分别运行基线及候选配置，计算分段、耗时和自动仲裁指标。
3. 验证三平台加载及模型下载，汇总测量证据。实验配置、文件路径及复算入口保存在 `work/asr-spike/`，数据访问受本机权限与原始文件可用性约束。

### 实验配置与语料

- 基线由 `baseline/run.py` 构造真实 `SenseVoiceOnnxTranscriber`；VAD 使用生产默认实现，记录包装器只观察真实识别返回与语种标签。候选由 `candidate/run.mjs` 读取本地 WAV、模型和 VAD 文件，使用 CPU、4 个线程与 16 kHz 音频，识别语言为 `zh`、启用 ITN。
- Silero 配置为 `threshold=0.5`、`minSpeechDuration=0.25`、`minSilenceDuration=0.5`、`windowSize=512`。max20 与 max30 分别设置最大语音时长；hard20 在识别前强制切分，hard20coarse 调整 VAD 输入粒度，hard20preroll 在 hard20 上加 0.4 秒前置补边。
- `corpus/manifest.json` 列出 9 条完整音视频的类别、来源、语种与窗口；包括多人对话、口语独白、专业词汇、背景音乐和长静音。8 条语音材料各有一个质量窗口，英文为主的混合材料单列；歌曲只参与成对文本比较。单独的无语音动画不计入 9 条主语料。
- `arbiter.py` 读取同一窗口内基线、候选及 Paraformer 文本生成候选相关的参考文本；`results/arbiter-report.json` 与 `results/arbiter-report-preroll.json` 使用不同候选。`metrics/final-summary.py` 聚合单次报告，结果的复算状态见 Outcomes。
- macOS 测试使用 Node v26.13.1、`sherpa-onnx-node` 2.0.1 和 ONNX Runtime 1.28.2，x64 模型加载 3493 ms、arm64 2047 ms；GitHub Actions run `43219925284` 的两条任务使用模型包自带音频。Windows 本地 `smoke-ci-script-win-x64.json` 记录 Node v24.5.0 的加载与识别结果。

## Validation and Acceptance

实验验证完成，记录的结果及局限如上。正式重写按 `docs/exec-plans/active/2026-11-13-worker-typescript-rewrite-plan.md` 执行自动化验收，包括固定独立参考、分段与无语音行为、逐条性能、旧数据兼容及三平台安装包；未通过的项目保持未验证状态。

历史脚本门禁记录：`node --test scripts/tests/*.test.mjs` 为 57 通过、1 跳过，`pytest scripts/tests` 为 1 通过，`pytest worker/tests/test_sensevoice_onnx.py` 为 20 通过。当前文档校验使用项目虚拟环境：`.\.venv\Scripts\python.exe scripts/validate_agents_docs.py --level ERROR` 与 `.\.venv\Scripts\python.exe scripts/validate_agents_docs.py --level WARN`。实验脚本的复算需先核对本机模型、语料、依赖和输出路径，不覆盖既有证据。
