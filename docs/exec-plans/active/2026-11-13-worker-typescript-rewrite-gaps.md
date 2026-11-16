# Worker TypeScript 重写待验证事项

产品要求见 `docs/product-specs/2026-11-13-worker-typescript-rewrite.md`，实施和验收见 `docs/exec-plans/active/2026-11-13-worker-typescript-rewrite-plan.md`。本文记录当前尚缺的证据；完成后将结果写入执行计划并删除对应条目。

## ASR 实现方案

TypeScript worker 使用 `onnxruntime-node` 直接加载生产 `iic/SenseVoiceSmall-onnx` 资产，沿用用户数据根
`<根>/models/onnx/` 的缓存与 `iic/SenseVoiceSmall-onnx` 模型标识。模型权重、FSMN VAD 文件、
前端参数、CTC 解码与文本清理规则均由 TypeScript 侧实现，识别行为与现有 Python 生产路径保持一致。
升级后现有 ONNX 缓存直接可读取，用户无需重新下载模型，模型标识与任务契约保持不变。

生产 `model_quant.onnx` 的图输入为 `speech` [B,T,560]、`speech_lengths`、`language`、`textnorm`，
输出为 `ctc_logits` [B,T,25055]、`encoder_out_lens`；生产 FSMN VAD 图为有状态推理，输入
`speech` 与 `in_cache0..3`，输出 `logits` 与 `out_cache0..3`。`onnxruntime-node@1.29.0` 均已完成加载与推理验证，证据位于
`work/asr-spike/results/production-ort-node.json`、`work/asr-spike/probe/production-ort-node.mjs`。
这两份产物处于忽略目录，正式门禁须在仓库内重建等价检查并固定依赖版本、文件哈希与复现命令。

`onnxruntime-node` 固定为 `1.29.0`（ONNX Runtime 1.29.0），与生产基线 Python `onnxruntime 1.28.0`
的推理数值行为一致。2026-11-14 用同一份前端特征和 `monologue-pharma.wav` 前 3 秒完成链路验证：
逐帧 argmax、CTC greedy 解码后的 17 个 token、`tokens.json` 拼接文本、标签清理后的文本四项
全部一致；证据 `work/asr-spike/results/asr-golden.json` 与 `results/asr-node-decode.json`，
脚本 `work/asr-spike/probe/asr_golden.py` 与 `probe/asr_node_decode.mjs`。
运行时版本偏离会使低置信帧的 argmax 翻转并改变识别文本，版本须纳入依赖锁与两平台打包校验。

前端实现包含 Fbank 80 维特征（hamming 窗、25 ms 窗长、10 ms 帧移、0.97 预加重、去直流、
512 点实数 FFT、HTK mel 三角滤波器组、`FLT_EPSILON` 对数下限）、LFR 7/6 拼帧与 `am.mvn`
CMVN 归一化。生产 `WavFrontend` 的 `dither` 为 1.0，随机种子取自当前时间，同一段音频两次
Fbank 数值不同，因此采用两层验收：数值逐项比对在 `dither=0` 的确定性配置下进行，记录最大
绝对误差；生产 `dither=1.0` 配置用多次运行的识别文本集合比对。2026-11-14 已实测：
Fbank `298×80` 最大绝对误差 `1.54e-4`、平均 `4.82e-6`，LFR+CMVN `50×560` 最大 `2.31e-5`、
平均 `7.16e-7`；`dither=0` 端到端 17 个 token 与识别文本一致，`dither=1.0` 下 Node 与 Python
各 5 次运行的文本集合一致。误差来自 C++ float32 与 JavaScript double 的数值差异，以及
kiss_fftr 与标准 radix-2 FFT 的运算顺序。证据 `work/asr-spike/results/frontend-golden.json`、
`results/frontend-ts-compare.json`，脚本 `probe/frontend_golden.py`、`probe/frontend_ts.mjs`。

FSMN VAD 是 10 秒分块的有状态推理：VAD 图输入 `speech` [1,T,400] 与 `in_cache0..3`
[1,128,19,1]，输出 `logits` [1,T,248] 与 `out_cache0..3`；`Fsmn_vad_online` 跨块共享
`in_cache`、`WavFrontendOnline` 与 `E2EVadModel` 状态机。`config.yaml` 的 `model_conf`
（`detect_mode=1`、`max_end_silence_time=800`、`max_single_segment_time=20000`、
`speech_noise_thres=0.6`、`sil_pdf_ids=[0]`）和前端参数（`dither=0.0`、LFR 5/1）共同决定分段行为。
事件流是「块 → batch → 事件列表」三层，`-1` 表示未闭合的起点或终点，由
`_stream_onnx_vad_segments` 跨块配对为毫秒时间戳。2026-11-14 已在 Node 侧完整移植 ONNX 缓存传递、
`E2EVadModel` 状态机、事件合法性校验与跨块配对：`pharma-90s`（9 块 / 5 段）、
`music-30s`（3 块 / 6 段）、`silence-3s`（1 块 / 0 段）三个真实音频用例的逐块事件流与最终
分段时间戳全部一致，`logits` 与四组 `in_cache` / `out_cache` 的最大绝对误差均为 0；块 0 的
`out_cache0` 幅值 6.47 并逐值成为块 1 的 `in_cache0`，证明缓存状态确实跨块传递；13 项合法与
非法事件流校验全部符合生产规则。证据 `work/asr-spike/results/vad-golden.json`、
`results/vad-ts-compare.json` 与 `results/vad-golden/`，脚本 `probe/vad_golden.py`、
`probe/vad_ts.mjs`。

VAD 前端 `WavFrontendOnline` 与 ASR 前端参数不同（`dither=0.0`、LFR 5/1、80 维 Fbank 拼成
400 维 `speech`），并跨 10 秒块维护 `input_cache`、`lfr_splice_cache`、`reserve_waveforms`
与 `waveforms`。2026-11-14 已按同一实现移植并直接读取原始 WAV 逐块比对：`pharma-90s`、
`music-30s`、`silence-3s` 的每块 waveform 边界逐值一致（最大绝对误差 0），`feats` 帧数全部
一致，数值最大绝对误差分别为 `5.09e-5`、`1.66e-4`、`4.77e-7`；`is_final` 的尾帧补齐与
`cache_reset` 由各用例最后一个块覆盖。用 TypeScript 前端产出的 `feats` 直接驱动 VAD 推理与
状态机，逐块事件流与最终分段时间戳仍与 Python 基线一致（5 / 6 / 0 段），说明 float32 量级
误差未导致帧状态翻转。证据 `work/asr-spike/results/vad-frontend-ts-compare.json`，脚本
`probe/vad_frontend_ts.mjs`；状态机与事件逻辑抽取到 `probe/vad_state_machine.mjs`，
`probe/vad_ts.mjs` 复用同一模块。

2026-11-14 已把四个环节组装成 `OnnxTranscriber` 原型（`probe/asr_worker_port.mjs`）做端到端
比对：`pharma-90s`（5 段）与 `music-30s`（6 段）的 VAD 分段、切片样本数、每块 ≤20.5 秒
（最大 20.01 秒）、时间单调与音频边界全部与 Python 端到端基线一致，证据
`work/asr-spike/results/transcriber-ts-compare.json`。

文本无法逐字一致：`pharma-90s` 的 544 字中有 9 个字符差异（相对 Python 输出 1.65%）。用 Python
导出的同一份 `feats` 喂 `onnxruntime-node@1.29.0` 时，`ctc_logits` 最大绝对误差为 0、105 个
token 完全一致，说明运行时不是差异来源；改用 TypeScript 前端算出的 `feats`（误差 `2.8e-5`）后
`logits` 差 2.3、第 33 个 token 起不同。被 int8 量化模型放大是主因。`Math.fround` 模拟 float32
没有改善（`4.58e-5`），误差来自 kiss_fftr 的 radix-4 分解与标准 radix-2 FFT 的运算顺序差异。
逐位一致需要精确移植 kiss_fft，本轮不做；端到端质量须按产品规格的 CER 门槛与候选无关的独立参考
文本验收。证据 `results/transcriber-golden.json`、`results/asr-segment-diag.json`，脚本
`probe/transcriber_golden.py`、`probe/transcriber_ts.mjs`、`probe/asr_segment_diag.py`、
`probe/asr_segment_diag.mjs`、`probe/fbank_precision.mjs`。

2026-11-14 用架构独立的 Paraformer（`speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-onnx`，
int8，`dither=0`，与 SenseVoice 无共享权重）对 8 条 ground-truth 窗口（150～184 秒，合计 6277 个
归一化字符单位）生成独立参考，同一批窗口分别跑 Python 生产引擎与 TypeScript 原型：

| 用例 | 参考单位 | Python CER | TypeScript CER | 增量 |
|---|---|---|---|---|
| conversation-street | 569 | 11.60% | 11.25% | −0.35pp |
| discussion-tech | 554 | 30.51% | 30.14% | −0.36pp |
| interview-finance | 612 | 17.97% | 17.81% | −0.16pp |
| lecture-economics | 709 | 24.12% | 23.84% | −0.28pp |
| mixed-a16z | 1129 | 48.89% | 48.89% | 0.00pp |
| monologue-ai-code | 904 | 23.01% | 22.46% | −0.55pp |
| monologue-pharma | 910 | 12.09% | 12.20% | +0.11pp |
| monologue-social | 890 | 11.01% | 11.12% | +0.11pp |
| **合计** | **6277** | **23.64%** | **23.48%** | **−0.159pp** |

全量增量 `−0.159pp` 在产品门槛 `0.5pp` 内。`conversation-street` 的窗口是唯一 `status=proofread`
的人工校对真值，直接以它为分母时两侧都是 `1.92%`、编辑距离均为 11 字，增量 `0.000pp`。
146 个分段中 99 段文本完全相同（67.8%）。`TypeScript` 相对 `Python` 共 75 个差异字符，其中多字 23、
漏字 23、替换 29，多字与漏字完全对称，符合随机浮点扰动的特征而非系统性退化。按差异块逐处裁决
（用差异前后锚点在参考中定位、比较两侧与参考局部区间的编辑距离）：支持 TypeScript 12 处、
支持 Python 6 处、无法判定 39 处；支持 Python 的 6 处是 3 处多字、1 处漏字和 2 处音近替换，量级约
`0.08pp`。

参考本身有明确局限，结论须按此解读：Paraformer 与 SenseVoice 互比 CER 达 `23.64%`，参考噪声
远大于待测差异，`mixed-a16z`（中英混合、超出中文词表能力）为 `48.89%` 且增量 `0.00pp`，对判别
无贡献；两模型同属 FunASR 生态，只做到架构独立、训练数据不完全独立。因此这一项证明的是
**在当前参考与样本下未观察到系统性劣化、增量在门槛内**，不构成绝对等价证明。正式门禁仍须把参考
生成、语料窗口、单位归一化与测量脚本固定进仓库并冻结，不能沿用 `work/` 下的结果。
证据 `results/reference-paraformer.json`、`results/py-window-transcribe.json`、
`results/ts-window-transcribe.json`、`results/cer-reference-compare.json`、
`results/cer-truth-compare.json`，脚本 `probe/ref_paraformer.py`、`probe/py_window_transcribe.py`、
`probe/window_transcribe.mjs`、`probe/cer_reference.py`、`probe/cer_truth.py`。

据此不移植 `kiss_fftr`：端到端文本质量以 CER 门槛验收，不以「与 Python 逐字相同」作为通过条件。

### Deno 运行期与原生依赖（Windows x64 已验证）

2026-11-14 用安装包锁定的 Deno `2.9.1`（v8 `14.9.207.2-rusty`、TypeScript `6.0.3`）实测：

- **原生插件可用。** `onnxruntime-node@1.29.0` 的 `bin/napi-v6/win32/x64/onnxruntime_binding.node`
  在 Deno 下正常加载，生产 ASR 模型加载 2.4 秒、`ctc_logits` [1,104,25055]，生产 FSMN VAD 加载
  15 毫秒。零张量推理的 `sum` 与 `head` 与 Node 侧**逐值相同**（`sum=-15822308.185514761`），
  说明加载的是同一个 `onnxruntime.dll`，没有运行时差异。
- **端到端逐字一致。** 8 条真实窗口在 Deno 与 Node 下跑同一份 `OnnxTranscriber` 实现，字符数、
  段数与文本全部相同（666/637/682/811/1300/967/994/992 字，25/42/16/24/9/10/12/8 段）。
- **权限最小集是 `--allow-read --allow-write --allow-ffi`。** 去掉 `--allow-ffi` 立即失败
  （`Requires ffi access to ...onnxruntime_binding.node`）；`--allow-env` 与 `--allow-sys`
  都不需要；FFI 可收窄为 `--allow-ffi=<node_modules 目录>`。`node_modules` 解析用 `deno.json`
  的 `{"nodeModulesDir": "manual"}`，可被自动发现，无需命令行 flag。
- **单文件 `deno compile` 不可用。** 编译产物 357 MB，运行时内嵌的 `.node` 无法定位同目录的
  `onnxruntime.dll`，Windows 加载器回退到 `C:\Windows\system32\onnxruntime.dll`（**1.17.1**，
  API 版本上限 17），报 `The requested API version [29] is not available`。因此必须采用
  「随包 `deno.exe` + 外置 `node_modules`」布局，并把「加载到系统旧版 DLL」列为打包冒烟必须防住的风险。
- **体积可裁剪到约 27.6 MB。** 删除 `bin/napi-v6` 下 `darwin`、`linux`、`win32/arm64` 后，
  再删 Windows 侧 CPU 路径不需要的 `DirectML.dll`、`dxcompiler.dll`、`dxil.dll`，只保留
  `onnxruntime.dll`（28 MB）与 `onnxruntime_binding.node`（298 KB）；裁剪后零张量数值与 8 条
  端到端文本仍完全一致。`onnxruntime-node` 从 296 MB 降到 28 MB，`onnxruntime-common` 0.9 MB。
- **冷启动无劣势。** `deno eval` 与 `node -e` 各 4 次，中位数 51.5 ms 与 52.3 ms。

Windows x64 结论成立。macOS arm64 的原生二进制、`--allow-ffi` 行为与安装包冒烟仍需 macOS 主机；
Rust 监督进程下的启动、取消与进程树行为也待验证。证据 `work/asr-spike/results/deno-runtime-matrix.json`，
脚本 `probe/deno_ort_probe.mjs`、`probe/node_ort_baseline.mjs`、`probe/deno_transcribe.mjs`、
`probe/deno_runtime_summary.py`，裁剪布局与探针在 `work/asr-spike/deno-pack/`。

### 可复现门禁（Windows x64 已建立）

2026-11-14 把 `work/asr-spike/` 的探针固化成仓库内可执行门禁 `scripts/asr-verification/`，
不再以「本机验过」作为证据形式。同日把实现搬进生产包 `worker-ts/src/asr/`，门禁改为导入生产代码，
因此**不存在第二份实现**：

- **固定了什么。** `fixtures/manifest.json`（3 条音频窗，共 1.4 MB，入库并由 SHA-256 固定，含裁剪来源与
  偏移）、`worker-ts/src/asr/model-assets.ts`（7 个生产模型文件哈希 + VAD `config.yaml` / `am.mvn`、
  运行期版本）、`golden/production-reference.json`（生产 Python 基线）、`golden/win32-x64/*.json`
  （本平台 golden，含分段、逐段文本与全文）、`golden/policy.json`（`dither=0`、CER 阈值 `0.005`）。
  门禁不再自带 `onnxruntime-node`，复用 `worker-ts` 的依赖，避免两份原生库。
- **判定三层。** 资产哈希 → 分段与生产基线逐毫秒相同 → 文本与本机 golden 逐字相同且相对生产基线
  CER ≤ 0.5 个百分点。两条文本断言同时存在：只留 golden 会把生产差异固化成「正确」，只留 CER
  会放过逐字退化。
- **实测。** `speech-12s` 1 段 58 字、`dialogue-32s` 4 段 157 字，两者 CER **0.000%**；
  `silence-3s` 0 段并按预期抛 `ASR_EMPTY_TRANSCRIPT`。同一套代码在 Node v22.22.2 与 Deno 2.9.1 下
  分段、token 与文本**逐字相同**，即运行时差异不进入结论。
- **负例有效。** 把 `textnorm` 改成 15（`woitn`）后 `speech-12s` 降为 55 字、相对生产基线 CER
  `1.852%`，被第 3 层同时拦下；把 `assets.json` 的 VAD `config.yaml` 哈希改成全零，门禁以退出码 2
  拒绝运行并打印实际哈希。
- **门禁抓到两个真实缺陷。** ① `E2EVadModel` 漏了 `noiseAverageDecibel = -100.0` 初始化，噪声均值
  一路 NaN、`snr` 比较恒假，所有帧被判成静音、分段恒为空——分项数值比对（feats 误差 `2e-5`、
  `logits` 误差 0）完全看不出来。② 把实现改写成 TypeScript 后，`do_extend: 1` 这种数字形式的开关被
  当成布尔缺失，端点延展退化，`dialogue-32s` 分段从 `[[0,1600],…]` 变成 `[[0,1490],…]`、CER 升到
  `1.399%`。两次都是端到端结构断言先发现，逐项数值比对后知后觉。
- **失败语义可单测。** `worker-ts/tests/` 的 202 项断言不需要模型：模型缓存缺失/哈希不符/就绪标记不全
  分别映射到 `ASR_MODEL_NOT_DOWNLOADED`、非法音频映射到 `ASR_RUNTIME_ERROR`、闭集模型拒绝历史标识、
  VAD 事件流 6 类非法输入全部拒止、`do_extend` 数字开关、`dither` 默认值。`npm --prefix worker-ts test`
  即可运行。下载语义（重试、Range 续传、取消、磁盘空间、崩溃恢复、原子提交）用假 fetch
  驱动完整流程，不联网也不需要模型。
- **边界有守卫。** 静态测试断言只有 `worker-ts/src/asr/sensevoice.ts` 可以直接 import
  `onnxruntime-node`，且门禁只能经 `src/asr/index.ts` 公共入口导入 ASR，防止实现细节泄漏到任务流程。
- **fixture 选点标准是「边界稳健」，不是「有代表性」。** 同一窗口必须让两侧给出完全相同的分段。
  实测反例：`music-song` 与 `discussion-tech` 的若干窗口两侧相差 10~120 ms，甚至多出一个 500 ms
  短段，根因是前端 `1e-4` 量级浮点差异落在临界帧。这类窗口不得进入 fixture。
- **静态守卫。** `scripts/tests/asr-verification-assets.test.mjs` 的 6 项断言在 CI 上校验（不需要模型）：
  `worker-ts/src/asr/model-assets.ts` 与 `worker_core/model_download.py` 的 `ONNX_REQUIRED_ASSET_HASHES`
  逐项一致、`worker-ts` 与门禁的运行时版本及 Deno 权限固定、原生依赖只在适配器内、fixture 哈希与音频
  格式、golden 与生产基线及 fixture 互相绑定、模型下载进度编码与 Python `MODEL_PROGRESS_REGISTRY`
  逐项一致。另有 `scripts/tests/worker-protocol-contract.test.mjs`（8 项：前缀与版本、两张进度表、
  stage 表、请求字段与扩展名/模型闭集、CLI 只注册已实现模式、重算请求字段 ↔ Python 与目标/语言闭集）与 `scripts/tests/ai-error-codes.test.mjs`
  （2 项：AI 错误码与 Python 的 `_CHECKOUT_ERROR_MESSAGES` / `_GENERATION_ERROR_MESSAGES` 同集合，
  且都在闭集 union 里）。另有 `scripts/tests/note-title-contract.test.mjs`（4 项：系统提示词、
  12000 字符采样预算与失败文案固定在 Python 源码上，标题四个错误码与两条进度事件两侧齐备，
  `title` 已进入已实现 target 且重复键反例留在 golden 里）、
  `scripts/tests/transcript-polish-contract.test.mjs`（5 项：常量与系统提示词、七条失败文案、
  产物不进事务闭集、进度算式、两个入口）与 `scripts/tests/dissection-contract.test.mjs`
  （5 项：轮数与切块上限、系统提示词、工具反馈与三个错误码、进度算式与请求回调、
  报告来源字段与三语标签、已实现 target 闭集）与 `scripts/tests/draft-contract.test.mjs`
  （7 项：九个平台 id 与显示名、系统提示词与 40 轮上限、三份工具 schema、三个失败码、
  事务闭集与清单字段、检索 checkout 环境变量、六个 target 全实现）。

尚未完成：macOS arm64 的 golden 未生成（`golden/` 目前只有 `win32-x64`，缺失会明确失败而
不回退）；门禁尚未接入 CI workflow（逐平台 golden 仍需评审；CI 内的模型准备现在可用
`worker-ts/scripts/download-model.mjs` 解决，实测下载 242 MB 约 13 秒，但尚未接入缓存策略）；
`worker-ts` 目前有 ASR、产物写入、协议入口、媒体准备、任务存储、AI 生成与检索工作间七块：「本地文件 → 文字稿 →
清单」已端到端跑通（见「任务存储与本地任务管线」），「已转写任务 → 导图 + 摘要 / 启发灵感 /
笔记标题 / 整理稿 / 解剖报告 / 成稿」也已通过 `--retry-insights-stdin` 接成真实用户路径（
契约里的六个 target 全部可用，见「重新生成入口」）；
URL 下载器的确定性内核、URL 任务身份与清单、`--request-stdin` 全链与三平台传输层均已落地
（见「URL 下载器内核」「URL 任务身份与清单」「URL 任务管线」「抖音传输层」「B 站传输层」
「小红书传输层」）；两平台打包尚未完成，宿主切换已落地（见「发行包运行时与宿主接线」），网页任务已落地（见「网页任务」节）。

## 媒体准备（已落地并接入管线）

`worker-ts/src/media/` 已按 `worker_core/{media,media_preparation}.py` 的本地分支实现：命令执行、
ffprobe 探测、`ffmpeg -vn -ac 1 -ar 16000 -c:a pcm_s16le` 归一化、本地源文件受限复制与两个产物的
原子落盘。错误码取契约 `localMedia.errorCodes` 闭集。

- **已实测**：44.1 kHz 立体声 WAV → 16 kHz 单声道 PCM WAV；160×120 MP4 → `media/video.mp4` 字节一致 +
  归一化 `audio.wav`；四类失败码按预期触发；产物直接喂真实转写器得到 `ASR_EMPTY_TRANSCRIPT`。
- **已接入**：`--process-local-media-stdin` 模式的 `worker-ts/src/pipeline/local-media.ts` 直接调用它，
  产物路径来自任务存储的 `<output>/tasks/<id>/`、副本落 `<cache>/tasks/<id>/download/`，
  与 Python 的 `MediaPreparationFacade` 同一布局。
- **未覆盖**：受支持平台的 ffmpeg 资产核对（当前依赖宿主环境里的 `ffmpeg`/`ffprobe`，随包策略未定）。
  三平台 fallback 传输层均已落地（见对应小节）。`storage_validation` 探针已落地，
  见「存储校验探针」。
  URL 来源的媒体准备与任务管线已落地，见「URL 任务管线」。

## 协议入口（部分落地）

`worker-ts/src/protocol/` 与 `src/cli.ts` 复现宿主线协议：前缀与通道、事件校验、stdin 上限与退出码。
常量与两张进度表由 `scripts/tests/worker-protocol-contract.test.mjs` 对着
`contracts/desktop-worker-contract.json` 与 Python 进度注册表逐项校验。

- **已迁移**：`--download-asr-model --asr-model iic/SenseVoiceSmall-onnx`。真实网络实测 14 秒完成，
  stdout 恰好一行结果、stderr 144 行合法事件、退出码 0；PyTorch 标识返回 `ASR_MODEL_UNSUPPORTED`
  且退出码 1；缓存就绪时零事件、立即返回 `completed`。
- **已迁移**：`--process-local-media-stdin`。stdin 读取器按 1 MiB 上限、UTF-8 严格解码、单行 JSON 对象
  实现，非法输入返回 `WORKER_STDIN_INVALID` 且退出码 1；业务失败写在结果行里、退出码仍是 0
  （与 Python 的 `return 1 if is_model_download and failed else 0` 一致）。
- **已迁移**：`--retry-insights-stdin`。请求字段集合与 Python `RETRY_REQUEST_FIELDS` 逐项一致、
  target 闭集与契约一致；六个 target 全部分发到各自的生成链，`INSIGHT_TARGET_UNSUPPORTED`
  临时分支已移除。`title` 的
  `title.generation.running` / `title.generation.completed`、`transcript` 的
  `ai.generation.running`（逐段一条）与 `dissection` 的 `ai.generation.running`
  （每次模型请求一条，attempt/total 固定 6）已按契约发到 stderr；`draft` 不注册进度事件，
  与 Python 一致。
- **已迁移**：`--save-web-page-stdin --web-operation-id <uuid>`。两个参数成对出现、
  `--web-operation-id` 必须是规范小写 UUID（否则用法错误退出 2）；stdin 上限 40 MiB；
  请求里的 `operation_id` 与命令行不一致返回 `WORKER_STDIN_INVALID`（stage `web_saving`）；
  请求校验与存储失败收敛 `WEB_PAGE_REQUEST_OR_STORAGE_INVALID` 且退出码仍为 0。
- **BYOK 探针已迁移**：`--probe-llm-stdin`（`src/ai/llm-probe.ts`）复现 `llm_probe.py`——
  请求是四键闭集校验，失败也回一行 `{ok, error_code, latency_ms}` 且退出码恒 0；错误分类沿用
  chat.ts 的类型化错误映射到探针封闭错误码；探针短路在配对校验之后、模式互斥之前（与 Python
  `cli.py` 分支次序一致）。双向冒烟 `work/interop/llm-probe-cli-smoke.mjs`：TS 实跑完整 HTTP
  矩阵（成功/401/404/429/500/连不上/响应不可读），Python 与 TS 在「连不上 + 请求非法」场景
  实跑比对一致（本沙箱 node 孙进程连不回脚本托管的环回监听，Python 的 HTTP 矩阵由
  `worker/tests/test_llm_probe.py` 覆盖）。
- **来源识别已迁移**：`--resolve-source-stdin`（`src/sources/`）复现
  `source_identity.py` + `source_resolution.py` + 应用层入口——四平台闭集与 ID 白名单、
  canonical URL 剥离全部分享 token、裸信封结果（`{status, source_url, source_identity}` /
  `{status, error:{code}}`）、业务失败退出码 0 而 stdin 失败退出 1（与 Python
  `stdin_failure_result` 的无 stage 分支一致）。平台短链适配器
  （xhslink/b23.tv/v.douyin.com）也已落地（`src/sources/platform-short-links.ts` +
  `short-link-http.ts`）：三平台各自的展开路径（bilibili/xhs 共用引擎——Location/最终 URL/
  正文内嵌 URL、深度 ≤5、http→https 重试、256 KiB 正文上限；douyin 独立流程——最终 URL 与
  正文提取 aweme id）、HTML 实体反转义（xhs 正文）、平台 UA（douyin 移动端），失败收敛
  null 并保留直连错误，展开结果重过平台识别与平台校验。刻意差异：页面 GET 不手发
  Accept-Encoding，由 undici 透明解压（Python 手动解压，拿到可读 HTML 层面等价）。
  双向冒烟 `work/interop/resolve-source-cli-smoke.mjs`：四个平台直连/裸 ID 的完成结果与
  三类业务失败、三类 stdin 失败，Python 与 TypeScript 逐字段（含退出码）一致；短链展开
  由 TS 单测（fake fetch 六场景）与 Python 自有测试覆盖——本沙箱里 Python 子进程连不回
  脚本托管的环回监听，网络场景不做两侧实跑冒烟。
- **已迁移（主路径）**：`--request-stdin`。请求解析层（`src/protocol/process-request.ts`）、
  下载器确定性内核（`src/media/{ytdlp,subtitles,download-output,download}.ts`）、URL 任务身份/清单
  （`src/tasks/`）、媒体准备（`src/media/url-media.ts`）与全链编排
  （`src/pipeline/url-media.ts`）已接通并注册参数，见「URL 任务管线」。stdin 上限 1 MiB，
  业务失败写在结果行里且退出码 0；随包下载器经 `APP_YTDLP_PATH` 注入，缺失即固定
  `VIDEO_DOWNLOAD_FAILED`。三平台 fallback 均已接通（见「抖音传输层」「B 站传输层」
  「小红书传输层」），小红书字幕探测也在 yt-dlp 成功路径上默认启用；反爬行为仍待真实公网回归。
- **不迁移**：`--download-runtime-component` 服务旧 PyTorch 运行时组件，新版本只提供 ONNX
  且不携带 Python，按产品规格不再提供该模式；用户数据目录里已下载的旧组件继续保留。
- **未迁移**：结构化诊断事件（`APP_DIAGNOSTIC`）的分类规则；崩溃目前以明文堆栈写 stderr。
- **仍缺的证据**：Python 的 `load_project_env` 会从项目根读 `.env`，TypeScript 入口只读进程环境
  （Rust 宿主是直接注入环境变量的，尚未验证其它启动方式）；`storage_validation` 探针已落地
  （独立脚本入口，不走线协议结果形状，见「存储校验探针」）；
  宿主侧切换到 TypeScript worker 的路径尚未接线。

## AI 生成（调用层 + 六条生成链 + 检索工作间已实现）

`worker-ts/src/ai/` 提供「怎么和模型说话」，并已提供要点总结的「说什么」：

- `config.ts`：BYOK（`APP_LLM_API_KEY`/`MODEL`/`BASE_URL`/`PROVIDER`/`TIMEOUT_SECONDS`/`MAX_TOKENS`）
  与托管（`APP_LLM_SOURCE=server` + checkout 三件套）两种来源；输出预算在任何 checkout 之前校验，
  托管模式每次调用换一次凭证、`request_id` 带调用序号。
- `chat.ts`：OpenAI 兼容的 `/chat/completions`，请求体与 Python SDK 的实际抓包逐字段一致
  （golden：`worker-ts/tests/fixtures/insight-request-golden.json`）。HTTP 401/403 → `AI_LLM_KEY_REJECTED`、
  404（或 400 且措辞指向模型）→ `AI_LLM_MODEL_UNAVAILABLE`、429 → `AI_LLM_RATE_LIMITED`、
  超时 → `AI_LLM_REQUEST_TIMEOUT`、连接失败 → `AI_LLM_NETWORK_FAILED`、响应不可读 →
  `AI_LLM_INVALID_RESPONSE`，其余 → `AI_LLM_REQUEST_FAILED`。供应商正文不进错误消息。
- `tool-loop.ts`：最小工具循环，覆盖现有 agent 真正用到的四样能力（多轮、function 调用、
  工具返回 `null` 即交付完成、轮间替换工具集），空回复重试一次，轮数与参数非法直接拒止。

**已落地**（与调用层同目录）：

- `output-language.ts`：三语语义表 25 个字段，逐字段与 Python `OUTPUT_LANGUAGE_SEMANTICS` 比对。
- `transcript-chunks.ts`：`MarkdownSplitter`，按码点计长（与 `len()` 同口径），三档长度下
  `content`/`summary`/`start_byte`/`end_byte`/`sha256` 与 Python 全部相同。
- `prompts.ts`：`sourcePromptInstruction`、`buildMindmapPrompt`、`buildSummaryPrompt`
  （transcript / article 两种来源，3 语言 × 2 来源逐字节比对）与 `buildInsightsAgentPrompt`
  （3 语言 × 2 来源 × 有无偏好快照共 12 例逐字节比对）。
- `preference-options.ts` / `preference-snapshot.ts`：两张偏好词表与 Python 逐字段比对；
  快照的解析判定由 Python 生成的 22 个正反例逐项比对，提示词 JSON 与落盘文件逐字节相同。
- `insights-agent.ts`：`validateInsightsDelivery`（块 id 闭集、1–12 条、话题去重）、
  `generateInsights`（单工具交付 + 校验失败重交）、`formatInsightsMarkdown` 与
  `writeInsightFiles`（三语 Markdown 产物与 Python 逐字节相同）。
- `summary-agent.ts`：`generateSummary`（导图→摘要两段交付、换工具时序、非法导图退回、点名催促、
  6 轮上限）、`normalizeSummaryMarkdown`、`normalizeMermaidMindmap`、`writeSummaryFiles`
  （任务内 `ai/` 走事务，导出目录逐文件原子写）。
- `artifacts.ts`：`commitInsightPayloads`，对齐 `ai_artifacts.py`。
- `note-title.ts`：单次文本补全的标题 agent。`sampleTranscript` 按码点取「头 / 正中 / 尾」三段
  共 12000 字符预算，`buildTitlePrompt` 连 `json.dumps` 的分隔符空格都对齐，`parseTitleResponse`
  用闭集 schema + 重复键拒止 + Unicode 类别检查；Python 生成的
  `worker-ts/tests/fixtures/note-title-golden.json`（4 例采样、3 语 × 2 稿提示词、22 个回复正反例）
  逐字节比对，生成器 `scripts/tests/note-title-golden.py` 已入库。请求体按需带
  `response_format={"type":"json_object"}`，不传时与既有抓包 golden 完全相同。
- `tasks/note-title-metadata.ts`：标题元数据的唯一一份校验规则，生成、落盘、清单读取三处共用；
  `tasks/note-title-store.ts` 复现 `read_note_title_transcript` / `save_note_title`（就地改
  `note_title` 与 `updated_at`，单事务写清单，保留前端写入的其它字段）。
- `transcript-polish.ts`：文字稿整理 agent。`POLISH_SYSTEM_PROMPT` 逐字复制；`chunkTranscript`
  复用 `MarkdownSplitter(2000)`；`buildPolishPrompt` 用码点切出上一段末尾 200 字符做衔接；
  `sourceTranscriptSha256` / `serializePolishMeta` 与 Python 的 `json.dumps(indent=2)` 逐字节相同。
  `polishTranscriptChunks` 逐段做单次 system+user 文本补全（无工具循环），空段退回原片段、
  全空才判失败；每段前发 `ai.generation.running`，`attempt` / `total` 归一化到 1–100。
  `createPolishLlm` 整次整理只 checkout 一次、所有分段共享同一 endpoint（Python
  `resolve_draft_credentials` + `build_llm_provider` 的计费语义），且未显式配置
  `APP_LLM_MAX_TOKENS` 时不发 `max_tokens`；golden
  `worker-ts/tests/fixtures/transcript-polish-golden.json`（5 稿 × 2–3 档切块、7 条段提示词、
  5 例摘要/元数据、6 组 1–120 段进度）由 `scripts/tests/transcript-polish-golden.py` 从 Python
  生产源码生成。
- `prompts.ts::buildDissectionAgentPrompt`：解剖提示词逐字复制 Python（schema example 用
  `JSON.stringify(..., null, 2)` 还原 `json.dumps(indent=2)`，chunks 段用紧凑分隔符）；
  `scripts/tests/dissection-golden.py` 生成的 3 语 × 2 来源共 6 份提示词逐字节相同。
- `dissection-report.ts`：报告数据模型、`dissectionToDict`、`parseDissectionReport`（闭集字段、
  文本长度与禁用片段、顺序段 id、来源块 id 升序去重、`highlights` 必须是原稿逐字子串、
  五种 `validation_category`）、`parsePersistedDissection`（用当前原稿重算来源摘要并比对整份
  文件）、三语 `formatDissectionMarkdown` 与 `buildDissectionArtifacts`（JSON / Markdown 字节）。
- `dissection-agent.ts`：`submit_dissection` 单工具交付、校验失败返回带 category 的反馈文本让模型
  重交、6 轮上限、16 块切分上限、每次模型请求前发 `ai.generation.running`。工具循环为此增加
  `onChatRequest` 回调，其余 agent 不传时不改变行为。
  golden `worker-ts/tests/fixtures/dissection-golden.json` 包含 6 份提示词、19 个报告正反例、
  6 组产物字节与 7 个持久化用例。

- `draft-platform.ts`：9 个平台 id 与显示名的唯一词表，请求解析在 checkout 之前用它校验
  `draft.platform`（此前「只校验非空字符串」的差异已消除）。
- `draft-prompt.ts`：系统提示词与种子提示词逐字复制 Python；`draft-agent.ts` 实现
  `submit_draft` 接收槽、40 轮工具循环、单次托管 checkout、进度注入与 `Skill` /
  `write_todos` / 检索工具的装配。`draft-step.ts` 在打开任务后先按 `insight_id` 校验种子
  （不消耗额度），读回偏好快照与要点总结，再把 `ai/draft.md` 与清单放进同一事务，
  同时删掉 `ai/original/draft.md`。
- `src/ai/workspace/`：官方 `@modelcontextprotocol/sdk` 的 streamable-http 客户端把
  `tools/list` 的动态工具并入工具循环；`yaml` 解析随包 `skills/viral-writer/SKILL.md` 的
  frontmatter，生成技能清单与 `Skill` 工具；`planning.ts` 复现 `write_todos`、计划状态注入
  与最多两次的完成否决提醒。两个 hook 用各自的注释哨兵整段替换 system 消息，不随轮数累积。
  golden `worker-ts/tests/fixtures/draft-golden.json` 由 `scripts/tests/draft-golden.py` 从
  Python 生产源码生成，含 18 份系统提示词、7 份种子提示词、三份工具 schema、技能清单与全文、
  计划提示词与提醒文案，TypeScript 输出逐字节相同。

**仍有的差异**：`validateInsightsDelivery` 的重复话题判定用 `toLowerCase()` 近似 Python 的
`casefold()`，只影响极少数 Unicode 特例；`mcpResultToText` 把 MCP `content` 块按文本拼接，
Python 运行器走的是 `CallToolResult` 到 tool 消息的转换，两者在纯文本检索结果上等价。

**验证的边界**：所有测试都在假服务器/假传输上跑，没有真实调用任何模型供应商或 anysearch
端点——请求形状与错误映射可验证，输出质量不能。真实调用的验收要有可用的 BYOK 或托管凭证，
以及真实的检索端点。`work/interop/draft-cli-smoke.mjs` 用 Python 官方 `mcp` 包起的真实
streamable-http 服务端验证过跨语言协议往返。

## 重新生成入口（六个 target 全部落地）

`worker-ts/src/protocol/retry-request.ts`、`worker-ts/src/pipeline/insight-retry.ts`、
`src/tasks/{load,source-file,source-text,note-title-metadata,note-title-store,existing-artifacts}.ts`、
`src/ai/{insights-agent,note-title,transcript-polish,dissection-agent,dissection-report,draft-platform,draft-prompt,draft-agent}.ts`、
`src/ai/workspace/{mcp-client,skills,planning,system-block}.ts` 与
`src/pipeline/{transcript-polish-step,draft-step}.ts` 复现 `worker_application/insight_retry.py`
的六个分支：

- **请求**：字段集合、6 个 target、`title` 的字段约束、`preference_snapshot` / `platform` 的目标绑定、
  `draft.insight_id` 的整数校验与 `draft.platform` 的 9 个 id 闭集都与 Python 一致，并有静态守卫
  逐项比对。偏好快照按 Python 的字段闭集严格解析（22 个正反例判定一致）。
- **读任务**：清单加载按 Python 的五层严格校验（单层 id、链接与 nlink、realpath 边界、事务恢复、
  schema/来源/标题/产物闭集）；权威源文本只在清单声明 `transcript_txt` 指向
  `transcript/transcript.txt` 时读取，并且文件与其父目录不得是链接、读取期间身份不得变化。
- **写回**：导图、摘要或 `insights.json` / `insights.md` 都不单独落盘，而是和 `task.json` 进同一个
  事务（`finalizeTaskWithPayloads`）；已有洞察、摘要、解剖报告从磁盘读回合并，`insights_count`、
  `note_title` 不因「只重算一项」而丢失。`insights` 成功后 `draft_seed_insight_id` 必须清空（洞察换
  id 会让旧草稿种子失效），生成失败则沿用旧值，与 Python 一致。
- **偏好快照**：`target=insights` 带快照时，在模型调用之前恢复残留事务并原子写
  `ai/preference-snapshot.json`；托管 checkout 的 `request_id` 带
  `-summary` / `-insights` / `-title` / `-transcript` / `-dissection` 后缀。
- **标题分支**：与另两条不同，它不写产物文件、也不重写整份清单。`runTitleRetry` 复现
  `note_title.py::run_note_title_step`：读权威稿 → 原子写 `note_title.status=generating`
  （保留旧标题文字）→ 发 `title.generation.running`（`title_generating` / 5%）→ 单次 JSON 补全
  → 原子写 `completed` 或 `failed`（错误码取模型异常 / `TITLE_OUTPUT_INVALID` /
  `TITLE_GENERATION_FAILED`）→ 成功时发 `title.generation.completed`（100%）。两次写清单都是
  `saveNoteTitle` 的单事务，就地改 `note_title` 与 `updated_at`，前端写入的未知字段保持不变；
  结果只挂 `task_id` / `task_dir` / `artifacts`，清单的 `status` 不被改成 `partial_completed`。
  失败码 `TITLE_TRANSCRIPT_UNAVAILABLE` / `TITLE_SAVE_FAILED` 落在 `title_generating` 阶段，
  文案与 Python 逐字相同。静态守卫 `scripts/tests/note-title-contract.test.mjs` 把系统提示词、
  采样预算、失败文案、四个错误码与两条事件钉在 Python 源码上。
- **整理稿分支**：`runTranscriptPolishStep` 复现 `transcript_polish.py::run_transcript_polish_step`：
  自己严格读官方 `transcript/transcript.txt`（原稿全程只读）→ 切块并检查 24 段上限
  （超限不调用模型、不消耗额度）→ 逐段单次补全（每段前发 `ai.generation.running`，
  `progress=70+⌊index×20/段数⌋`，`attempt`/`total` 归一化）→ 空段退回原片段、全空判失败 →
  两次独立原子写 `transcript/polished.txt` 与 `transcript/polished.meta.json`（后者记
  `schemaVersion=1` 与原稿 SHA-256，供桌面端判过期）。这两份文件**不在事务闭集**里，
  Python 也是逐个 `atomic_write_text`；清单另由 `finalizeTask` 提交，草稿种子沿用旧值。
  七个失败码 `TRANSCRIPT_TEXT_PATH_INVALID` / `TRANSCRIPT_TEXT_NOT_FOUND` /
  `POLISH_EMPTY_TRANSCRIPT` / `POLISH_TRANSCRIPT_TOO_LONG` / `POLISH_FAILED` /
  `POLISH_LLM_EMPTY_RESULT` / `POLISH_ARTIFACT_WRITE_FAILED` 与阶段
  `insights_generating` 逐项对齐；`POLISH_FAILED` 的 Python `str(exc)` 收敛成稳定文案，
  不把供应商异常正文带进结果行。静态守卫 `scripts/tests/transcript-polish-contract.test.mjs`
  把常量、系统提示词、七条文案、进度算式、产物路径与两个入口固定在 Python 源码上。
- **解剖分支**：`runGeneration` 的 `dissection` 走与 `summary` / `insights` 相同的事务提交，
  产物 `ai/dissection.json` 与 `ai/dissection.md` 都在闭集里。传给 agent 的是**未裁剪的权威原稿**
  （Python `run_dissection_generation(official_transcript_body, ...)` 同样如此），来源摘要的
  SHA-256 与 2000 码点切块都按它算；`sourceLanguage` 取清单的 `transcript.language`。
  结果行的 `dissection` 带完整报告，`finalizeTaskWithPayloads` 把两个文件与清单一起提交，
  `draft_seed_insight_id` 沿用旧值。三个独立错误码 `DISSECTION_EMPTY_TRANSCRIPT` /
  `DISSECTION_TRANSCRIPT_TOO_LARGE` / `DISSECTION_INVALID_RESULT` 与供应商错误码按 Python 分流。
  有清单时空稿在 `read_source_text` 一层就归到 `SOURCE_TEXT_INVALID`，与 Python 的调用顺序一致；
  `DISSECTION_EMPTY_TRANSCRIPT` 由 agent 的直接调用路径负责。
- **已有解剖报告**：`readExistingDissection` 现在调用 `parsePersistedDissection`，用磁盘上的当前
  原稿重算来源摘要并逐字段比对整份文件；原稿被改过、字段被篡改或结构不合规都退化成 `null`。
  此前「原样透传」的差异已消除。静态守卫 `scripts/tests/dissection-contract.test.mjs` 把轮数、
  切块上限、系统提示词、工具反馈、五个校验分类、错误码、三语标签、来源字段与两个产物路径
  固定在 Python 源码与契约上。
- **草稿分支**：`runDraftRetry` 在读取权威文字稿之前派发，只读 `ai/insights.json` 的种子、
  `ai/preference-snapshot.json` 与 `ai/summary.md`；种子 id 找不到时返回 `DRAFT_SEED_INVALID`，
  且任何 checkout / 模型调用都不会发生。成稿循环整次只 checkout 一次托管凭证，检索工具由
  anysearch MCP 的 `tools/list` 动态注入，技能清单与计划状态在每次模型请求前重新注入 system
  消息。成功时 `ai/draft.md` 与清单一并提交、`ai/original/draft.md` 在同一事务里删除，
  清单写入本次 `draft_seed_insight_id` 并按产物映射刷新 `draft_path` / `has_draft`。
  三个失败码 `DRAFT_SEED_INVALID` / `DRAFT_GENERATION_FAILED` / `DRAFT_EMPTY_RESULT`
  落在 `draft_generating` 阶段，供应商异常正文不进结果行。静态守卫
  `scripts/tests/draft-contract.test.mjs` 把九个平台 id、工具 schema、失败文案、
  检索环境变量、事务闭集与「六个 target 全实现」固定在 Python 源码与契约上。
- **失败**：非法请求 / 任务读不出来 / 源文本不可用 / 生成失败分别落在
  `INVALID_RETRY_JSON`、`INVALID_RETRY_PAYLOAD`、`TASK_MANIFEST_NOT_FOUND`、`SOURCE_TEXT_INVALID` 与
  agent 自己的错误码上；`summary` / `insights` / `transcript` / `dissection` / `draft` 在任务打开后的
  源文本不可用与生成失败都写 `status=partial_completed` 的清单（与 Python 一致），只有「连任务都没打开」才返回不带 `task_id`
  的结果。`title` 的失败状态写在 `note_title` 里，清单 `status` 不动。
- **已实测**：真实 CLI + 本地假 OpenAI 服务跑通 `summary` 的两段交付、`insights` 的单工具交付、
  `title` 的单次 JSON 对象补全、`transcript` 的 4 段逐段整理、`dissection` 的单工具报告交付与
  `draft` 的「检索 → 交付 → 收尾」三轮循环；Python 的 `load_task_manifest`、
  `parse_preference_snapshot`、`read_existing_insights` 都能严格读回 TypeScript 写出的产物与
  `note_title`，Python 写的任务被重算后 `note_title` 与 `draft_seed_insight_id=9` 按规则保留。
  `title` 的 CLI 冒烟（`work/interop/title-cli-smoke.mjs`）实测 stdout 恰好一行 `completed`、
  退出码 0、stderr 两条合法进度事件、模型只收到一次带 `response_format` 的请求；
  `transcript` 的 CLI 冒烟（`work/interop/transcript-cli-smoke.mjs`）实测 4 段 4 条
  `ai.generation.running`、请求体无 tools / 无 `max_tokens`、原稿字节不变、
  `polished.meta.json` 的 SHA-256 与 Python 用同一份原稿算出的值相同，且
  `recover_task_artifacts` 不会删掉整理稿；`dissection` 的 CLI 冒烟
  （`work/interop/dissection-cli-smoke.mjs`）实测 1 次 `submit_dissection` 交付、
  1 条 `ai.generation.running`（attempt 1 / total 6）、原稿字节不变，Python 的
  `parse_persisted_dissection` 严格读回报告，且用 `platform_text_bytes` 重算的
  `dissection.json` / `dissection.md` 与磁盘字节完全相同；`draft` 的 CLI 冒烟
  （`work/interop/draft-cli-smoke.mjs`）用 Python 官方 `mcp` 包起的 streamable-http 服务端，
  实测 3 次模型请求、1 次真实 `tools/call` 往返、请求体带四个本地工具加两个检索工具且无
  `max_tokens`，Python `load_task_manifest` 严格读回 `draft_path` / `has_draft` /
  `draft_seed_insight_id=5`，`recover_task_artifacts` 后成稿仍在、旧稿已删。
- **未覆盖**：`load_project_env` 的 `.env` 读取；`record_note_title_cancellation` 按契约属宿主侧
  （`workerInvocation:false`），不在 worker 迁移范围。网页任务分支已落地：重算入口按清单来源注入
  `APP_AI_SOURCE_KIND=article`，网页任务拒绝 `title` / `transcript`
  （`WEB_PAGE_RETRY_TARGET_INVALID`），摘要 / 洞察 / 解剖 / 草稿以 `article/article.txt` 为权威源
  （见「网页任务」）。

## 任务存储与任务来源（已落地）

`worker-ts/src/tasks/` 与 `worker-ts/src/pipeline/local-media.ts` 复现
`worker_core/task_store.py` 与 `pipeline_runtime/orchestration.py` 的
`run_local_media_pipeline`。任务来源现在有三支：`local_file`、`web_page` 与 `url`；
URL 分支只覆盖身份与清单，下载与文字稿由「URL 任务管线」负责。

- **目录布局**：产物落 `<APP_OUTPUT_DIR>/tasks/<id>`（`media/`、`transcript/`、`ai/`、`task.json`），
  源文件副本落 `<APP_CACHE_DIR>/tasks/<id>/download/`，任务成功或失败都会清掉副本（与 Python 一致，
  `download/` 最终为空）。
- **任务 id**：`<YYYYMMDD>-<HHMMSS>-local-<16 hex>`（UTC），可由调用方注入时间与随机尾缀，单测因此能
  逐字段断言清单。
- **清单**：字段集合、顺序、`schema_version=3`、`source_privacy_migration_version=2`、
  `local_source{display_name,media_kind,extension}`、`platform="local"`、`text_preview`（按码点截断 180）、
  `artifacts` 闭集校验、LF 换行，全部与 Python 的 `serialize_task_manifest` 一致。
- **失败也要留痕**：媒体准备失败、模型未下载、识别失败都会写 `status=failed` 的清单并带上
  `error{code,message,stage}`；只有「任务目录都建不出来」才返回不带 `task_id` 的失败结果。
- **跨语言互读（双向实测）**：TypeScript 写出的清单被 Python 的 `load_task_manifest` /
  `TaskContext` / `transcript_metadata_from_manifest` 完整读出（严格校验全过）；Python 写出的清单被
  TypeScript 读回 `note_title` 与 `draft_seed_insight_id` 并原样保留。探针
  `work/interop/{py-read-task.py,py-write-task.py,ts-read-task.mjs}`。
- **真实端到端**：`--process-local-media-stdin` + 真实 ffmpeg + 真实 ONNX 模型跑
  `scripts/asr-verification/fixtures/speech-12s.wav`，产出 `media/audio.wav`（16 kHz 单声道 PCM）、
  `transcript.txt`/`transcript.md` 与 `status=completed` 的清单；识别文本与
  `golden/win32-x64/speech-12s.json` 的期望文本逐字相同。
- **未覆盖**：宿主侧的 `record_note_title_cancellation`（契约 `workerInvocation:false`）。
  `storage_validation` 探针已落地，见「存储校验探针」。`TaskStoreFacade.open/finalize` 的网页任务分支已落地（`schema_version=4`
  清单、`open` 跳过目录补建、网页产物闭集，见「网页任务」）；标题与偏好快照的读写分支已落地
  （见「重新生成入口」）。

## 存储校验探针（已落地）

`worker-ts/src/storage-validation.ts` + `storage-validation-main.ts`，复现
`worker_core/storage_validation.py` + `runtime_component.py`：

- **入口形状**：独立脚本（`node --experimental-strip-types storage-validation-main.ts
  [--import-component]`），不是 `cli.ts` 的线协议模式——与 Python 的
  `python -m worker_core.storage_validation` 一样，输出一行紧凑 JSON
  （`schema_version`/`ready_models`/`component_state`/`component_fingerprint`/
  `component_imported`），成功退出 0；失败写 stderr、退出 1 且 stdout 为空；
  未知参数退出 2。Rust 按 `StorageValidationTerminalResult` 解析这份形状。
- **组件状态矩阵**：包内 `runtime-manifest.json`（`APP_BUNDLED_RUNTIME_MANIFEST` 覆盖 →
  `APP_RESOURCE_DIR` 的 `python/` 子目录优先 → 项目根）缺失即 `ungated`；组件目录
  （`APP_PYTORCH_RUNTIME_DIR`）不存在或 manifest 损坏 → `missing`；指纹与包内不一致 →
  `stale`；一致 → `ready`。
- **就绪模型**：ONNX 缓存（`<模型根>/onnx` 的固定哈希 + 标记）复用 `asr/model-cache.ts`；
  PyTorch 缓存按 Python 规则复刻（`MODEL_VERSION.txt` 含两个模型标识 + `iic/<id>/model.pt`
  以 torch zip 魔数开头，`models/` 子层也接受），全程只读、绝不规范化坏标记。
  `APP_MODEL_DIR` 缺失按 Python 的 KeyError 失败退出。
- **与 Python 的刻意差异**：按计划第 6 条，TypeScript worker 不导入 PyTorch——
  `--import-component` 一律按失败路径收敛（`Storage component is unavailable`，
  非零退出、无 stdout）。宿主 `capture_for_sources` 捕获该失败后把组件记为
  `unavailable`，后续 verify 不再要求导入，迁移语义自洽。
- **测试与守卫**：`worker-ts/tests/storage-validation.test.mjs`（状态矩阵、查找顺序、
  指纹容错、就绪模型、真实 CLI 的退出码与 JSON 形状）；跨语言守卫
  `scripts/tests/storage-validation-contract.test.mjs`（键集合、状态闭集、环境变量、
  模型标识、失败文案两侧互钉）；双向真实冒烟
  `work/interop/storage-validation-cli-smoke.mjs`（五种夹具下 Python 与 TypeScript
  探针的 stdout 逐字节一致，`--import-component` 两侧同败）。

## 网页任务（契约、保存与重算分支已落地）

`worker-ts/src/web/web-page-contract.ts`、`src/pipeline/web-page-save.ts` 与重算入口的网页分支，
复现 `worker_core/web_page_contract.py`、`web_page_storage.py` 与 `insight_retry.py` 的网页行为：

- **URL 规范化逐字节一致**：`validate_web_url` / `canonical_web_url` 的 Python 语义（`urlsplit` 的
  hostinfo 与方括号规则、IDNA 三段式 ToASCII 含 nameprep 后 ASCII 直通、punycode、IPv4/IPv6
  私有网段表、查询参数白名单、点路径消除、RFC 3986 quote/unquote）全部复刻；
  `scripts/tests/web-page-golden.py` 生成 66 个 URL 用例 + article / 请求 / 来源 / 任务 id /
  saved Markdown 的逐字节 golden（`worker-ts/tests/fixtures/web-page-golden.json`），
  `worker-ts/tests/web-page-contract.test.mjs` 逐项比对。
- **保存入口**：`saveWebPage` 校验 → `buildSavedMarkdown`（标题 Markdown 标点转义）→ 新任务目录
  （`mkdir exist_ok=false`，任务 id 冲突也收敛失败）→ 单事务提交 `article/article.txt`、
  `article/article.md` 与 `schema_version=4` 清单（`source_kind=web_page`、`platform=web`、
  `model=null`、`transcript=null`、`web_source{title,extracted_at}`、无 `note_title`/`local_source`）。
  全部失败收敛 `WEB_PAGE_REQUEST_OR_STORAGE_INVALID`（stage `web_saving`，文案
  `Web page saving failed.`）。
- **CLI**：`--save-web-page-stdin --web-operation-id <uuid>` 成对出现（否则用法错误退出 2），
  stdin 上限 40 MiB，请求里的 `operation_id` 与命令行不一致返回 `WORKER_STDIN_INVALID`
  （stage `web_saving`，退出码 1）。
- **重算分支**：打开任务后注入 `APP_AI_SOURCE_KIND=article`（摘要 / 洞察 / 解剖提示词与草稿
  `sourceKind` 即生效）；网页任务对 `title` / `transcript` 返回
  `WEB_PAGE_RETRY_TARGET_INVALID`（结果仍带任务标识，正文与 Markdown 从 `article/` 读回）；
  `open` 网页分支跳过目录补建；权威源文本读 `article/article.txt`（2 MiB 上限）；
  解剖读回按 article 变体（`schemaVersion=2`、`sourceTextSha256`）严格校验；
  解析目标为空稿时与 Python 一致区分 `DISSECTION_EMPTY_TRANSCRIPT` / `AI_EMPTY_TRANSCRIPT`。
- **测试与冒烟**：`worker-ts/tests/web-page-retry.test.mjs`（拒止 / 摘要重算 / 空稿 / 草稿
  sourceKind）、`web-page-save.test.mjs`（成功事务 / 五类失败收敛）、CLI 用例并入
  `cli.test.mjs`；跨语言静态守卫 `scripts/tests/web-page-contract.test.mjs`（常量、白名单、
  正则体、失败码、进度事件、清单形状两侧互钉）；真实 CLI 双向冒烟
  `work/interop/web-page-cli-smoke.mjs`（TS 保存 → Python `load_task_manifest` +
  `read_source_text` 严格读回；Python `save_web_page_once` → TS 重算摘要（假 OpenAI 服务验证
  `saved web article` 提示词变体）→ Python 再读回重算后的清单，原文字节不变）。

## 产物写入（已落地在 `worker-ts/src/artifacts/`）

`atomic-file.ts`、`task-transaction.ts`、`transcript-artifacts.ts` 三块，沿用
`worker/worker_core/{atomic_files,task_transaction}.py` 与
`worker_core/asr_runtime/artifacts.py` 的行为，并受 `contracts/task-artifact-transaction-v1.json`
约束：

- **同样收敛失败**：任何文件系统错误都变成不含路径的 `AtomicFileCommitError` / `TASK_ARTIFACT_COMMIT_FAILED`
  / `TASK_ARTIFACT_RECOVERY_FAILED`，异常消息不出现用户路径。
- **同样的提交点与恢复语义**：`prepared` 回滚、`committed` 只清材料、回滚材料先读齐再动手、
  残留清理只认闭集名字。
- **同样的产物字节**：文件名、Markdown 结构、平台换行（Windows CRLF）、无分段时删旧
  `segments.json`、空文本报 `ASR_EMPTY_TRANSCRIPT`。
- **跨语言互读**：2026-11-14 用崩溃注入实测两个方向——TypeScript 留下的 `prepared` journal 由 Python
  恢复为 `rolled_back` 并还原旧内容，反向亦然；探针 `work/interop/{ts-step.mjs,py-step.py}`。
  契约里的合法/非法 journal 被直接当作单测输入。
- 已知差异：`JSON.parse` 对重复键取后者（Python 拒止，只能来自手工篡改且解析结果仍须通过全部校验）；
  `writeSyncedNewFile` 只清理本次自己创建的文件（Python 会删掉已存在的文件，材料名带 uuid 实际不会撞名）。
- 已接线：`finalizeTask` 与 `writeTranscriptFiles` 在真实任务流程里被调用，清单的 `artifacts` 由磁盘现状
  重建，见「任务存储与本地任务管线」。

## URL 下载器与官方发行资产

官方 [release files](https://github.com/yt-dlp/yt-dlp#release-files) 与
`2026.10.26` 发行版的核对结果：

- Windows x64 使用 `yt-dlp.exe`（Win10+ 独立可执行文件），官方 SHA-256
  `f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d`。
- macOS 使用 `yt-dlp_macos`（10.15+ universal），官方 SHA-256
  `0f922c15ccc0b83eefa1c8bc9104e434318c4bf16e408e1ee93b7745a6efe0aa`。官方没有分别提供
  x64 与 arm64 文件，两个架构共用同一份 universal 文件。
- 校验材料：`SHA2-256SUMS` / `SHA2-512SUMS` 覆盖 19 个发行文件，均带 `.sig` GPG 签名，
  公钥在官方仓库 `public.key`。随包资产按固定版本与固定哈希分发，禁止运行时 `-U` 自动更新。
- 许可：yt-dlp 源码为 Unlicense；PyInstaller 打包的可执行文件含 GPLv3+ 代码，组合作品按
  GPLv3+ 分发；zipimport 版 `yt-dlp` 与源码 tarball 只含 Unlicense / ISC / MIT 代码。发行包须
  随附 `THIRD_PARTY_LICENSES.txt`、`LICENSE` 与 GPLv3+ 文本，并写明对应源码的获取方式。
- 请求解析层 `src/protocol/process-request.ts` 已复现 `parse_process_request`：三键闭集、
  契约版本 3、模型白名单、URL 按 Python `str.isspace()` 闭集裁剪（U+001C..U+001F 与 U+0085
  裁掉、U+FEFF 保留）、固定失败文案与 `INVALID_REQUEST_PAYLOAD` 码。
  `scripts/tests/process-request-golden.py` 生成 35 个正反例的
  `tests/fixtures/process-request-golden.json`，`scripts/tests/process-request-contract.test.mjs`
  钉住字段集合、失败文案、裁剪规则与「管线接通前不注册 CLI 参数」。
- 本机核验：Windows x64 文件实算 SHA-256 与官方一致，`--version` 输出 `2026.10.26`，并用它
  下载一条 788493 字节的公开 mp4 成功；macOS universal 文件实算 SHA-256 与官方一致
  （37466304 字节），在 Windows 环境不能启动，实际启动须在 Mac 环境完成。

## URL 下载器内核（已落地，未接入任务管线）

`worker-ts/src/media/` 新增四个模块，复现 `worker_core/{media,subtitles,media_preparation}.py`
里不依赖平台网络行为的确定性部分：

- `ytdlp.ts`：命令参数构造（独立可执行文件作为可注入前缀）、URL 候选与 host 后缀判定、
  YouTube 链接闭集识别、失败分类与错误清洗、三平台 fallback 触发条件、抖音/小红书 ID 提取、
  超时常量。`scripts/tests/downloader-golden.py` 生成 16 组命令、24 组 YouTube 判定、
  19 组失败分类、8 组清洗、16 组触发判定、9 组候选与 11 组 ID 提取，TypeScript 逐项相同。
- `subtitles.ts`：SRT/VTT 解析、语言优先序、滚动去重、内联时间戳与标签清洗、HTML5 实体解码。
  HTML5 实体表交给 `entities@6.0.0`（BSD-2-Clause），不在仓库内复制 2231 条实体表；
  该依赖已实测能在随包 Deno `2.9.1` 的 `nodeModulesDir: "manual"` 布局下加载。
  `scripts/tests/downloader-files-golden.py` 的 12 组字幕用例逐字段相同。
- `download-output.ts`：视频文件定位（按修改时间、稳定 ID、下载 stdout、快照差异）与音频复用判定。
  8 组文件系统用例逐项相同，含绝对路径越界拒绝与快照未变化返回空。
- `download.ts`：`download_video` 编排——字幕失败复用已下载媒体、无字幕参数重试、可重试失败
  单次重试、三平台策略触发与错误映射、小红书成功后的字幕探测、结构化超时中断。
  14 个场景的命令序列、策略调用、探测调用与结果/异常逐项相同。

刻意差异：命令前缀由调用方注入官方独立可执行文件路径，Python 使用解释器模块入口；
产品规格禁止回退到系统 Python 的下载器模块。三平台下载函数与字幕探测仍是可注入参数，
但生产装配已提供默认实现（`createPlatformFallbackStrategies` 与真实的字幕探测）。

验证：真实官方 `yt-dlp.exe` 进程下载一条公开 mp4（788493 字节）成功，命令形状与基准一致；
`scripts/tests/downloader-contract.test.mjs`（6 项）钉住命令参数、失败码、字幕规则、
编排结构、许可决定与「只调用官方独立可执行文件」的边界。

随包官方独立 yt-dlp 已由 `scripts/build-installer.mjs` 下载、校验并落到 `resources/bin/`，
宿主在随包资产存在时注入 `APP_YTDLP_PATH`；仍缺两平台打包与许可随附。
三平台传输层、`_prepare_url` 媒体准备编排、`run_worker_pipeline` 全链与 `--request-stdin`
均已落地，真实公网结果见「真实公网冒烟结果」。

## URL 任务身份与清单（已落地，已接入管线）

`worker-ts/src/tasks/` 补齐 `UrlTaskSource`，复现 `worker_core/task_store.py` 的
`create_task_context` / `_manifest_source_fields` / `_task_source_from_manifest` 三个 URL 分支：

- **任务 id**：`<YYYYMMDD>-<HHMMSS>-<平台>-<稳定 ID>[-p<分P>]`；稳定 ID 上限 80 字符，
  分 P 后缀先占位。建任务前先跑 `canonicalUrlForPersistence` 重新验算身份，不可持久化的
  身份在建目录之前就抛错。
- **清单字段**：URL 分支只写 `source_url` / `source_identity` / `platform`，
  **不写 `source_kind`**（Python 也不写；历史清单里显式写 `"url"` 或 `null` 都按 URL 读回）。
  `source_url` 恒等于身份里的规范 URL，分享链接里的 token 不会进持久化状态。
- **严格读回**：`source_identity` 必须重新通过平台识别验算，`source_url` 必须相等，
  `local_source` / `web_source` 不得出现；`effective_part` 的三态、版本漂移、平台漂移都以
  同一个「清单不可用」收敛。URL 任务允许 `note_title`，与本地媒体任务一致。
- **产物路径**：URL 任务用默认 `media/video.mp4`，不套用本地来源的扩展名。

验证：`scripts/tests/url-task-golden.py` 从 Python 生产代码生成 5 组身份（抖音、小红书、
B 站分 P、YouTube 直连与短链）的任务 id 与**完整 `task.json` 文本**，以及 20 个来源字段
正反读回用例；`worker-ts/tests/url-task.test.mjs` 9 项测试逐字节/逐用例相同；五份清单字节另由 Python
`load_task_manifest` / `task_context_from_loaded_manifest` 严格读回，均还原为 `UrlTaskSource`；
`scripts/tests/url-task-contract.test.mjs` 5 项守卫钉住 id 模板、字段闭集、读回规则与
CLI 已注册的边界。

## URL 任务管线（主路径已落地）

`worker-ts/src/media/url-media.ts` + `src/pipeline/url-media.ts` + `worker-service.ts` +
`cli.ts` 接通 `--request-stdin` 的完整链路：

```text
--request-stdin
  └─ parseProcessVideoRequest    三键闭集 / 契约版本 3 / 模型白名单
      └─ SourceResolver          直连 + 三平台短链展开
          └─ createUrlTaskContext
              └─ prepareUrlMedia  downloadVideo → 四级定位 → 流校验 → video.mp4 / audio.wav
                                  → SRT/VTT 字幕探测（B 站 fallback 时跳过）
                  ├─ 有字幕：writeTranscriptFiles(subtitle) → subtitle.detect.found → 清单
                  └─ 无字幕：模型缓存 → Transcriber → writeTranscriptFiles(asr) → 清单
```

- **媒体准备**复现 `MediaPreparationFacade._prepare_url` 的 5 类事件、四级视频定位、
  视频原子提交、音频复用/归一化与 4 个失败码；下载器报错经 `sanitizeSourceText` 清洗后再进清单。
  `scripts/tests/url-media-golden.py` 用 Python 生产代码生成 10 个场景（含音频复用、
  B 站 fallback 跳过字幕、提交失败）与 13 个语言标签规范化用例，TypeScript 逐项相同。
- **文字稿**：URL 任务的 `transcript.md` 带 `- Source URL: <规范 URL>`，字幕分支写
  `segments.json` 且按 `source=subtitle` 短路 ASR，ASR 分支写 `source=asr` 与模型标识。
- **下载器路径**：契约新增 `env.ytdlpPath=APP_YTDLP_PATH`；未注入时按平台回落到
  `<项目根>/bin/yt-dlp.exe` 或 `yt-dlp_macos`，找不到就返回固定 `VIDEO_DOWNLOAD_FAILED`，
  不把路径或 ENOENT 写进结果行，也绝不回退系统 Python。
- **真实全链验证**：`worker-ts/tests/url-pipeline.test.mjs` 用假 yt-dlp + 真实
  ffmpeg/ffprobe + 假转写器跑通 ASR 分支、字幕分支、下载失败与非法请求；清单
  `schema_version=3`、无 `source_kind`、`artifacts` 含视频/音频/文字稿；7 条进度事件的
  顺序与阶段逐项断言。CLI 单测覆盖 stdin 失败、模式互斥、非法请求与缺下载器。

**边界**：三平台 fallback 与小红书字幕探测均已接通，真实公网冒烟见「真实公网冒烟结果」；
登录受限内容按不支持登录态下载处理。macOS 实启动、完整安装包构建、许可随附与体积核验仍未完成。

## 抖音传输层（已落地并接入默认策略）

`worker-ts/src/download-reliability.ts` + `src/sources/douyin/` 复现
`worker_core/download_reliability.py` 与 `worker_core/douyin*`：

```text
downloadDouyinVideo
  ├─ resolveAwemeIdFromInput   原文 ID → 抖音链接 → 短链跟随（Cookie 记忆）
  ├─ resolveSharePageItem      iesdouyin 分享页，3 次重试 + 3–10s 随机退避
  ├─ collectStreamCandidates   bit_rate 优先；缺省时按 1080p→360p 探测 play_addr.uri
  ├─ selectStreamCandidates    按声明大小降序、档位名次序、同大小去重
  └─ downloadOrderedCandidates 每候选两次尝试（原始 + 续传），失败换下一个
```

- **可靠下载**：`SafeDownloadError` 的 9 个 `DOWNLOAD_*` 码、`DOWNLOAD_STALLED` /
  `DOWNLOAD_INCOMPLETE` 的可续传集合、Content-Range 起点校验、停滞看门狗与
  `.part` 原子改名都按 Python 判定顺序实现。`scripts/tests/download-reliability-golden.py`
  生成 7 个响应场景与 9 个流式场景（含续传、停滞、提前结束、超限），TypeScript 逐字节相同。
- **传输层**：`FetchDouyinHttpClient` 跟随重定向并保留最终 URL，按主机记忆 `Set-Cookie`；
  下载按 256 KB 分块、60s 无进展掐断，`Range` 续传。Cookie 只按主机名存取（不区分
  path/过期），是本轮唯一刻意差异，不影响解析与失败语义。
- **跨语言基准**：`scripts/tests/douyin-golden.py` 生成 13 个 ID 输入、5 个播放地址、
  8 个分享页、5 组候选（含探测响应脚本）、选择/进度/重试事件，以及 5 个有序下载脚本与
  6 个完整下载场景；`worker-ts/tests/douyin.test.mjs` 逐项相同。
- **真实进程冒烟**：`worker-ts/tests/douyin-transport.test.mjs` 用本机 HTTP 服务验证
  Cookie 透传、`bytes=4-` 续传与停滞保留 `.part`，全程不触公网。
- **装配**：`createFallbackStrategies` 接受部分实现，只返回已提供的平台；
  `src/media/platform-strategies.ts` 注册抖音与 B 站，`pipeline/url-media.ts` 默认使用它。
  小红书随后单独接通，见「小红书传输层」。
- `scripts/tests/douyin-contract.test.mjs` 7 项守卫钉住常量、请求头、错误码与文案、
  可重试集合、进度码、可靠下载码集与「三平台全部接通」这条边界。

**仍缺**：限流与并发下的行为（匿名分享页间歇返回精简文档，见「真实公网冒烟结果」）；登录受限内容按公开路径失败，确认失败码与提示；macOS 实启动与两平台打包。

## B 站传输层（已落地并接入默认策略）

`worker-ts/src/sources/bilibili/` 复现 `worker_core/bilibili*`：

```text
downloadBilibiliVideo
  ├─ parseBilibiliInput      BV/av → 链接 → b23.tv 短链（最多 5 层，http 失败换 https）
  ├─ view API                分 P、cid、标题、时长
  ├─ playurl API             DASH 音视频轨
  ├─ selectDashStreamPair    编码偏好 → 带宽 → 像素 → 画质 id → 备用地址数；DRM 拒绝
  ├─ 分片下载                 主地址 + 备用地址，共享可靠下载（2 GiB 上限、120s 无进展）
  └─ ffmpeg -c copy 合并      `.m4s` → `.merge.mp4` → 原子改名，临时文件必清
```

- **输入解析**：纯 BV/av、普通视频链接、`b23.tv` 短链；番剧/影视/课程/纪录片入口与
  非 `http(s)` scheme 明确拒绝。`p` 参数按 Python `int()` 语义取分 P，非法值回落第 1 P。
- **API 解析**：401/403 与 `code ∈ {-101,-102,-104,-404,-403}` 或含 `login/登录/权限/会员/vip`
  文案都归为 `BILIBILI_LOGIN_REQUIRED`；正文支持 gzip/br/deflate，解码前后都校验 4 MiB 上限。
- **下载**：`FetchBilibiliHttpClient` 跟随重定向、正文按上限截断读取；媒体流先看 `.part` 大小发
  `Range`，服务端忽略续传（返回 200 或起点不符）时删掉部分文件从头再来一次，与 Python 一致。
- **合并**：`ffmpeg -y -i <video> -i <audio> -c copy <merge>`，路径统一用 POSIX 形式；
  非零退出或产物缺失都报 `BILIBILI_FFMPEG_MERGE_FAILED`，失败时保留已下载的 `.m4s`（与 Python 相同）。
- **进度**：`bilibili.metadata.resolving(22)` → `stream.probing(26)` → `video.downloading(30)` →
  `audio.downloading(32)` → `media.merging(34)`，阶段固定 `video_extracting`。
- **装配**：`platform-strategies.ts` 注册抖音与 B 站；B 站合并复用主路径的 runner
  （`FallbackDownloadContext.runner`），小红书在后续一轮接通。
- **验收**：`scripts/tests/bilibili-golden.py` 生成 18 个输入解析、4 个 URL、13 个 view、
  8 个 DASH 选择、3 个 playurl、8 个解码、2 个分片下载、3 个合并与 7 个完整下载场景，
  `worker-ts/tests/bilibili.test.mjs` 逐项相同；`worker-ts/tests/bilibili-transport.test.mjs`
  用本机 HTTP 服务验证正文上限、Range 续传与「服务端忽略 Range 时重下一次」，不触公网。
- `scripts/tests/bilibili-contract.test.mjs` 8 项守卫钉住常量、请求头、错误码与文案、
  选择顺序、解码分支、进度码、runner 接线与 ffmpeg 参数。

**仍缺**：限流与并发下的行为；登录、会员与 DRM 内容按不支持登录态下载处理，确认返回 `BILIBILI_LOGIN_REQUIRED` 与对应提示；macOS 实启动、两平台打包。

## 小红书传输层（已落地并接入默认策略）

`worker-ts/src/sources/xiaohongshu/` 复现 `worker_core/xiaohongshu/` 与 `xiaohongshu_fallback.py`：

- **`url.ts`**：`urllib.parse` 的最小复刻——保留主机大小写与尾随点（`geturl()` 只小写 scheme）、
  `parse_qs` 丢空值后取第一个、`quote(safe="")` 连 `!'()*` 一起转义。`new URL` 会改写这些值，
  而 `source_url` 要按用户输入原样进清单。
- **`source.ts`**：24 位十六进制笔记 ID、`explore`/`discovery/item` 路径、`xhslink.com`/`xhslink.cn`
  短链（最多 5 层、http 失败换 https、响应内嵌链接兜底）；短链跳到外站或 `ftp` 时明确
  `XHS_URL_INVALID`，不把外站地址当笔记。
- **`page.ts`**：404/401/403/429 与空正文的状态映射；gzip/br/deflate（含裸 deflate）解码、
  10 MiB 上限、UTF-8 替换解码；`window.__INITIAL_STATE__` 的括号配对、`undefined`/`void 0`/
  末尾逗号改写与 `note` 查找；`error_code` 与「当前笔记暂时无法浏览」归 `XHS_NOTE_BLOCKED`。
- **`streams.ts`**：候选流九元组打分（URL 是否存在、编码偏好、weight、streamType 序、默认流、
  像素、码率、大小、备用地址数），同画质保留更优者，按分数降序尝试；`int()` 语义单独实现
  （数字截断、布尔 0/1、字符串只认十进制整数）。
- **`subtitles.ts`**：`mediaV2` JSON 解析、`source → zh-Hans → zh-CN → zh-Hant → zh → en-US →
  en → ja → ko` 优先序、语言标签规范化、只接受 `xhscdn.com`/`xiaohongshu.com` 的 https 地址、
  `format` 为 `srt`/`vtt` 或按 URL 后缀推断。
- **`transport.ts`**：页面与媒体共用一个 `FetchXiaohongshuHttpClient`（按主机记忆 Cookie）；
  视频 2 GiB、30 秒超时、120 秒无进展判停滞；字幕 2 MiB、20 秒超时、30 秒无进展，且带内容
  类型与主机白名单；Range 续传在服务端忽略时删部分文件重下一次。
- **`fallback.ts`**：`下载 → 候选有序尝试 → 尽力抓一条字幕`；进度
  `xiaohongshu.page.resolving(22)` → `video.saving(30)` → `stream.retrying(30)`，阶段固定
  `video_extracting`。字幕探测任何失败都收敛成 `null`。
- **装配**：`platform-strategies.ts` 注册小红书，错误码原样映射成 `CODE: 文案`；
  `pipeline/url-media.ts` 的 `probeXiaohongshuSubtitle` 默认指向真实实现。

验证：`scripts/tests/xiaohongshu-golden.py` 由 Python 生产代码生成 22 个输入解析、3 个 explore URL、
8 个页面状态、9 个解码、16 个初始状态与 JS 改写、8 组候选流、13 个字幕语言、9 个字幕选择、
8 个完整下载与 4 个字幕探测场景，`worker-ts/tests/xiaohongshu.test.mjs` 逐项相同；
`worker-ts/tests/xiaohongshu-transport.test.mjs` 用本机 HTTP 服务验证 Cookie 透传、`bytes=4-` 续传、
忽略 Range 的重下、字幕主机白名单与停滞保留 `.part`，不触公网；
`scripts/tests/xiaohongshu-contract.test.mjs` 6 项守卫钉住常量、请求头、错误码闭集、失败文案、
进度码与「探测已接线」这条边界。

**仍缺**：分享令牌的过期与缺失行为（页面只回客户端外壳，见「真实公网冒烟结果」）；登录受限内容按不支持登录态下载处理，确认返回 `XHS_NOTE_BLOCKED` 与对应提示；macOS 实启动与两平台打包。

## 真实公网冒烟结果（2026-11-16）

两侧用同一组地址、同一入口跑生产代码：`work/interop/py_platform_download_smoke.py` 走
`MediaPreparationFacade` 与各平台 `download_*`，`work/interop/platform-download-smoke.mjs`
走 `prepareUrlMedia` 与 `src/sources/*`。用例标签与输出字段一一对应，结果按 JSONL 对照。

| 用例 | Python | TypeScript | 产物 |
|---|---|---|---|
| 抖音分享页 | 成功（重试后） | 成功（重试后） | 两侧均 6281768 字节 |
| B 站 BV | 成功 | 成功 | 两侧均 10373366 字节 |
| 小红书（带分享令牌，3 条） | 成功 | 成功 | 25496066 / 21917437 / 31465321 字节，两侧相同 |
| 小红书（不带令牌，含旧测试链接） | `XHS_NOTE_NOT_FOUND` | `XHS_NOTE_NOT_FOUND` | 无 |
| 小红书字幕探测 | 无字幕 | 无字幕 | 无 |
| B 站整链媒体准备 | 成功 | 成功 | 视频 21498132、音频 6793976 字节，两侧相同 |
| yt-dlp 主路径（B 站） | 成功 | 成功 | — |
| yt-dlp 主路径（抖音） | 成功（连跑三次） | 成功（连跑三次） | 两侧均 6281768 字节 |
| yt-dlp 主路径（小红书，不带令牌） | `XHS_NOTE_NOT_FOUND: Media download command failed.` | 同左 | 无 |

- **调用次序**：两侧都是先跑 yt-dlp，返回非零且失败文案命中平台标记时才走平台 fallback。
  抖音与小红书的实际下载通常由 fallback 完成，yt-dlp 进程仍会先启动一次；命令序列由
  `work/interop/probe-call-order.py` 与 `probe-call-order.mjs` 的桩策略记录，两侧同为
  「yt-dlp 命令 → 平台 fallback」。
- **小红书需要分享令牌**：不带 `xsec_token` 的地址只拿到客户端外壳（`noteDetailMap: {}`），
  带 App 分享链接里的令牌时三条笔记两侧都下载成功且产物逐字节相同。令牌随分享链接下发，
  过期或缺失时页面不再返回笔记数据，失败码统一为 `XHS_NOTE_NOT_FOUND`。
- **抖音间歇**：分享页有时返回精简文档（没有 `videoInfoRes`），两侧都重试 3 次后报
  `DOUYIN_ROUTER_DATA_MISSING`；成功时两侧产物逐字节相同。整链 yt-dlp 主路径各连跑三次
  两侧全部成功且同为 6281768 字节，同一时段里偶发的一次失败与分享页精简文档属同一类
  服务端按请求放行，不构成实现差异。
- **B 站**：匿名可下，DASH 选择与 ffmpeg 合并的两侧产物逐字节相同。
- **真实缺陷（已修）**：B 站 view API 返回 `Content-Encoding: gzip`，Node 22.22.2 的 undici 与
  Deno 2.9.1 都会在读取正文时解压，却把该响应头原样保留。`FetchBilibiliHttpClient` 记录了这个头，
  `decodeResponseBody` 于是对已解压的 JSON 再解一次，全部 B 站下载都以
  `BILIBILI_VIDEO_INFO_UNAVAILABLE`（正文无法解码）失败。修法是 `dropContentEncoding`：
  两个 fetch 客户端（B 站、小红书）记录响应头时删掉 `Content-Encoding`；解压分支保留给直接
  传压缩正文的调用方。回归用例「a gzip response is decoded once and loses its encoding header」与
  「a gzip page is decoded once and loses its encoding header」跑真实 fetch 路径，去掉修法后
  两条都会失败（已实测）。
- **产品边界**：不支持需要登录态、会员或 DRM 的下载；登录受限内容按公开路径失败，错误码与提示需要逐平台回归。**未覆盖**：限流、并发与取消需要长时间压测，本轮不做。

## 发行包运行时与宿主接线（2026-11-16）

`scripts/build-worker-ts.mjs` 把 `worker-ts/` 组装成 `resources/worker-ts/`，由
`scripts/build-installer.mjs` 在下载完随包 Deno 之后调用；`tauri.conf.json` 的
`bundle.resources` 增加 `resources/worker-ts/**/*`（仓库里放一个被 `-f` 加入的 `.gitkeep`，
否则 `tauri-build` 会因为 glob 匹配不到文件而直接失败）。布局与已确认的产品决定一致：
「随包 `deno.exe` + 外置 `node_modules`」，不做 `deno compile` 单文件。

组装在过渡期是「依赖在就装」：`worker-ts/node_modules` 不存在时（CI 未安装依赖）跳过并打印
`this package will use the Python worker`，宿主按资产缺失回落 Python；正式发布要切换时在
发布任务里加 `npm ci --prefix worker-ts` 与 `--require-worker-ts`，后者把「依赖没装」变成
硬失败，避免悄悄发出只带 Python 的包。

- **目录**：`src/`（源码树，Deno 直接跑 `.ts`）、`skills/`（`src/pipeline/draft-step.ts`
  按 `../../skills/` 定位）、`deno.json`（`nodeModulesDir: manual`，外置 `node_modules`
  能被解析的前提）、`package.json`、`node_modules/`。
- **裁剪**：`node_modules` 按声明裁剪——`package.json` 的 `devDependencies` 与 `@types` 整体
  不进包（`typescript` 单独 23 MB）；`onnxruntime-node/bin/napi-v6` 只留目标平台目录，
  Windows 再删 `DirectML.dll`、`dxcompiler.dll`、`dxil.dll`（CPU 会话不需要）。
  组装后实测 **46.8 MB**（未裁剪 336 MB），组装+启动冒烟 11 秒。
- **构建期冒烟**：组装完立刻用随包 Deno 跑 `--resolve-source-stdin`，与协议结果逐字比较。
  这一步覆盖 `cli.ts → worker-service → 平台解析` 整条模块图，把「Deno 能启动、`node_modules`
  能解析、结果行一致」变成构建失败而不是用户机上的失败。同一份组装产物在 Windows x64 上用
  与宿主完全相同的命令行跑通了两条真实链路：本地媒体（`ffmpeg` 归一化 + 真实 ONNX 推理，以
  `ASR_EMPTY_TRANSCRIPT` 正常收敛）与 URL 任务（B 站 fallback 下载 → 归一化 → 真实 ASR →
  文字稿三件产物 + 清单，`status=completed`，任务目录与 `artifacts` 齐全）。
- **权限最小集（实测）**：`--allow-read --allow-write --allow-ffi --allow-run --allow-net
  --allow-env`。逐项去掉的后果：无 `--allow-env` → `TASK_STORAGE_UNAVAILABLE`（读不到 `APP_*`）；
  无 `--allow-ffi` → `ASR_DEPENDENCY_MISSING`（ONNX 原生模块加载失败）；无 `--allow-run` →
  `LOCAL_MEDIA_VALIDATION_FAILED`（ffprobe 起不来）。`--allow-run` 目前不按程序名收窄，
  原因是 `APP_YTDLP_PATH` 指向任意绝对路径，收窄需要在宿主侧解析后再注入白名单，记入剩余项。
- **宿主解析**：`runtime::worker_launch` 在 `resources/bin/deno[.exe]`、
  `resources/worker-ts/src/cli.ts`、`resources/worker-ts/deno.json` 与
  `resources/worker-ts/node_modules/` 四件资产齐全时选 Deno，否则回落 Python。
  已切换的入口：`--request-stdin`、`--process-local-media-stdin`、`--retry-insights-stdin`、
  `--resolve-source-stdin`、`--save-web-page-stdin`、`--download-asr-model`、存储校验探针
  （独立入口 `src/storage-validation-main.ts`）与 BYOK 探针（`--probe-llm-stdin`）。
  Deno 分支注入 `DENO_DIR=<用户数据>/deno`、`DENO_NO_UPDATE_CHECK=1` 与 `APP_YTDLP_PATH`
  （随包资产存在时），不再注入任何 `PYTHON*`。
- **随包下载器**：`scripts/build-installer.mjs` 按固定版本 `2026.10.26` 下载
  `yt-dlp.exe`（Windows x64）或 `yt-dlp_macos`（macOS universal），校验固定 SHA-256 后落到
  `resources/bin/`；`--skip-downloads` 也要求该资产已存在。镜像或离线环境可用 `--ytdlp-url`
  或 `APP_YTDLP_URL` 替换来源，内容仍按固定 SHA-256 校验。Windows 实测真实 23575744 字节文件
  通过校验并可直接 `--version`；宿主用同一路径注入 `APP_YTDLP_PATH`，在组装后的运行时上跑通
  一条 B 站 `--request-stdin`（`status=completed`，视频 21498132 字节）。开发环境没有该资产时
  不注入，保留外部 `APP_YTDLP_PATH`。
- **仍未切换**：`--download-runtime-component`（PyTorch 按需组件，TS 没有该模式，继续走随包
  Python）；`web_page/session.rs` 把 `bundled_python_path` 的身份写进 native session 的 owner
  记录（用于跨重启识别同一运行时），撤掉随包 Python 之前必须改成指纹 Deno/TS worker。

### 平台范围与打包前必须处理的一件事

macOS Intel 已停止支持（2026-11-16）。`onnxruntime-node@1.29.0` 的 `bin/napi-v6` 只有
`darwin/arm64`、`linux/{arm64,x64}`、`win32/{arm64,x64}`，维持 Intel 需要换用 `1.20.1`
并长期并行 napi-v3 的第二套版本策略。发行目标收窄为 Windows x64 与 macOS Apple Silicon；
`scripts/build-worker-ts.mjs`、`build-installer.mjs` 与 `make-macos-dmg.sh` 对 `macos-x64`
直接判为不支持。

**许可随附**：Deno（MIT）、`onnxruntime-node`（MIT，随附 `onnxruntime.dll` 的 MIT 声明）、
`@modelcontextprotocol/sdk`（MIT）、`entities`（BSD-2-Clause）、`yaml`（ISC）需要进入发行包的
第三方声明，与既有 yt-dlp（GPLv3+，独立可执行文件）分开列出。

## 实施前验证
1. **ONNX 运行时与原生依赖（macOS 与安装包部分）。** `onnxruntime-node` 版本固定为 `1.29.0`，
   Windows x64 下的原生插件加载、Deno 运行期、权限、体积裁剪与端到端一致性已验证（见上）。仍需
   核验 macOS arm64 的原生二进制来源、许可证、完整性、加载与 `--allow-ffi` 行为；核验
   随包 `deno.exe` 在 Rust 监督进程下的启动、取消与进程树；核验安装包体积与启动链，并把
   「加载到 `C:\Windows\system32\onnxruntime.dll` 旧版」写成冒烟断言（真实推理成功 + DLL 哈希校验）。
   记录两平台实测结果，不依据通用兼容说明推断插件可用。
2. **ASR 适配接口与模型准备（已落地）。** `worker-ts/src/asr/` 已按
   `docs/design-docs/2026-11-13-typescript-worker-asr-boundary.md` 拆分：`types.ts` 公共
   `Transcriber` / `Transcript`、`errors.ts` 稳定错误码、`model-assets.ts` + `model-cache.ts`
   只读校验、`model-download.ts` 模型准备、`sensevoice.ts` 唯一适配器、`index.ts` 唯一入口。
   门禁已改为导入这套生产代码。模型准备按需下载、进度、取消、原子提交与崩溃恢复均已实现，
   `ASR_MODEL_DOWNLOAD_FAILED` / `ASR_MODEL_ARCHIVE_INVALID` 已进入生产错误语义；2026-11-14 用真实
   网络下载 9 个文件（242474788 字节）逐文件哈希相符，且这份新缓存直接通过门禁三例（CER
   `0.000%`）。产物写入已作为独立模块落地（见「产物写入」段）。单段识别失败（需构造坏块）与
   `dispose()` 后复用仍只有单元断言，没有真实注入；进程树取消属 Rust 宿主。
3. **下载器（内核完成，接入未完成）。** 用户允许官方独立 yt-dlp 内置 Python，作为唯一第三方例外。
   文件清单、版本、SHA-256 与许可已核对；Windows 本机实跑 `--version` 与一条公开视频下载成功，
   结论见「URL 下载器与官方发行资产」。确定性命令、字幕、产物定位与编排已复刻并有跨语言基准，
   见「URL 下载器内核」。URL 任务的身份、任务 id、清单序列化/读回与全链编排也已复刻并有
   跨语言基准，见「URL 任务身份与清单」「URL 任务管线」「抖音传输层」「B 站传输层」
   「小红书传输层」。三平台真实公网冒烟已完成，见「真实公网冒烟结果」。随包 yt-dlp 已接入安装
   脚本并由宿主注入 `APP_YTDLP_PATH`；仍须 macOS 实际启动，核验两平台打包后的体积与许可随附。
4. **工作间运行器。** `agent_runtime` 为 Python 依赖。草稿链所需的能力已迁移到
   `worker-ts/src/ai/workspace/`：官方 `@modelcontextprotocol/sdk` 的 streamable-http 客户端、
   `tools/list` 动态工具、随包 `SKILL.md` 的渐进式披露、计划工具与状态注入、单次 checkout 与
   BYOK，`work/interop/draft-cli-smoke.mjs` 用 Python 官方 `mcp` 包起真实端点验证了跨语言往返。
   仍须验证：真实托管 checkout 与 BYOK 的计费边界（尤其超时后不重复扣费）、进程树取消下
   MCP 会话的关闭，以及 `agent_runtime` 运行器里
   尚未迁移的重复工具提示、上下文压缩与 skills-like 二次请求行为。网页来源的
   `APP_AI_SOURCE_KIND=article` 分支已落地并由 `work/interop/web-page-cli-smoke.mjs` 覆盖
   （假 OpenAI 服务验证文章变体提示词；真实托管 checkout 计费仍待验证）。
5. **基线与数据（剩余部分）。** 门禁已在 `scripts/asr-verification/` 建立并固定模型、VAD 与 audio
   哈希、运行参数、`onnxruntime-node` 版本与逐平台 golden（见上）。仍须：为 macOS arm64 生成并
   评审 golden；把门禁接入 CI（含模型下载与缓存策略）；补齐适用的英文或中英混合独立参考文本后，
   才能对这两个语种声明质量门槛；被裁掉原始语料的授权与来源记录须随 fixture 一并留档。

## 实施与验收期间完成

- **可复现基线：** `scripts/asr-verification/` 已承载 fixture、资产哈希与逐平台 golden，任何改动都必须
  能让 `node run.mjs` 通过。新增或替换 fixture 时，私有音视频与文字稿不得未经授权入库，须只保留裁出的
  短窗口并核对不含敏感内容；同时记录语料来源与授权。发行包不携带 Python 环境，Python 侧只在重建基线时
  使用。
- **自动质量评价：** 独立参考模型及其文本、语料窗口、单位归一化、漏句和重复判定规则必须在候选测量前
  冻结；参考文本不能读取或使用候选输出。中文与英文分别验证，缺少适用的独立英文参考时保持未验证；
  自动参考文本只能作为质量代理指标。本轮用的 Paraformer 参考与 Python 生产引擎互比 CER 为 `23.64%`，
  `mixed-a16z` 等中英混合窗口超出其中文词表能力，正式门禁须补齐适用的英文/中英参考，并记录参考与
  主候选的互比 CER 作为噪声基准，避免把参考噪声当作候选退化。
- **协议与宿主：** 迁移仍受支持的 worker 模式和 `storage_validation` 入口（已落地，见「存储校验探针」），包括 BYOK 测试；保持 stdin
  限额、单条 stdout 结果、stderr 事件、错误语义以及 Rust 监督和进程树取消。现状：线协议常量与事件校验
  已落地并有静态守卫，「模型下载」模式已在真实网络跑通；其余模式与结构化诊断事件待迁移，见「协议入口」。同步
  `contracts/desktop-worker-contract.json`、前端、Rust 和 worker 的模型枚举与版本；新任务只接受 ONNX，
  历史记录中的旧模型标识仍可读取。
- **设置与旧数据：** 旧 PyTorch 选择一次性迁移到 ONNX 并向用户提示；现有 ONNX 设置及其他设置保持不变，
  未知值报错。真实旧媒体任务和网页笔记须能读取、续写和恢复；旧模型、缓存及组件文件不能自动删除。
  升级时旧数据迁移控制记录可能包含 PyTorch 资产，必须验证不加载旧运行时的完整性检查和中断恢复；
  无法核验时保留源数据和恢复状态。验证现有 `models/onnx/` 缓存经 TypeScript worker 直接读取，
  缓存缺失时按需下载，且现有 SHA-256 校验与原子提交行为不变。
- **测试与发行：** 将 Python 专属边界测试替换为适合 TypeScript 的等价检查；更新构建资源、运行时指纹、
  CI、两平台原生依赖及发布冒烟。核实实际安装包体积和现有发布流程，不额外引入双实现常驻或灰度系统。

## 已确认的产品决定

- 只实现现有 ONNX 模型；ASR 使用可替换的模型适配接口。
- ASR 运行时采用 `onnxruntime-node` 直接加载生产模型文件，沿用现有 ONNX 缓存与模型标识。
- TypeScript worker 运行期采用随包 `deno.exe`（锁定 `2.9.1`）+ 外置 `node_modules`，不使用
  `deno compile` 单文件，也不改为随包 Node；按 `--allow-read --allow-write --allow-ffi` 启动。
- 验收全程自动化。
- 自有 worker 不再随发行包携带 Python；官方独立 yt-dlp 内置 Python 获准作为唯一第三方例外。
- 沿用既有本地优先、用户数据、安全、隐私、计费与取消边界。
