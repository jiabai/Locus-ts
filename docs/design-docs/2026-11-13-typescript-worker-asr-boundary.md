# TypeScript worker 的 ASR 适配边界

状态：接口、唯一适配器与模型准备已落地在 `worker-ts/src/asr/`，产物写入尚未实现。产品范围见 `docs/product-specs/2026-11-13-worker-typescript-rewrite.md`，任务和验收见 `docs/exec-plans/active/2026-11-13-worker-typescript-rewrite-plan.md`。当前生产代码仍为 Python。

## 代码位置

| 文件 | 职责 |
| --- | --- |
| `worker-ts/src/asr/index.ts` | 唯一公共入口：`createTranscriber`、`Transcriber`、`Transcript`、`ASRError` |
| `worker-ts/src/asr/types.ts` | 转写接口、结果类型、闭集模型列表 |
| `worker-ts/src/asr/errors.ts` | 稳定错误码与错误类 |
| `worker-ts/src/asr/model-assets.ts` | 模型文件哈希、下载来源与目录约定（唯一事实来源） |
| `worker-ts/src/asr/model-cache.ts` | 只读缓存定位与完整性校验 |
| `worker-ts/src/asr/model-download.ts` | 模型准备：按需下载、进度、取消、原子提交 |
| `worker-ts/src/asr/sensevoice.ts` | 唯一适配器：模型加载、VAD、分段、识别、结果转换 |
| `worker-ts/src/asr/{fbank,cmvn,vad-online,vad-state,ctc,audio,config}.ts` | 前端、VAD 状态机、解码与配置解析 |

只有 `sensevoice.ts` 可以直接依赖 `onnxruntime-node`；任务流程只能依赖 `index.ts`。这两条都由
`scripts/tests/asr-verification-assets.test.mjs` 静态守卫。推理等价性由
`scripts/asr-verification/` 用真实模型与固定语料验证，说明见该目录的 README。

## 目标

TypeScript worker 只交付 `iic/SenseVoiceSmall-onnx`。任务流程通过稳定的转写接口调用模型适配器，让以后的模型能够在同一边界内接入。模型选择、下载和对外契约是否扩展，留待引入具体模型时按产品规格与实际能力处理。

## 转写接口

沿用现有 `worker/worker_core/asr_runtime/types.py` 的 `Transcriber` 和 `Transcript` 语义，TypeScript 侧定义模型无关的 `Transcriber`：

- 输入：任务准备阶段已经校验并归一化的本地音频路径，以及现有语言参数。当前媒体归一化格式为 16 kHz、单声道、PCM WAV，语言缺省值沿用 `Chinese`。当前模型适配器将中文映射为 `zh`、英文映射为 `en`，其他值映射为 `auto`；其他模型的语言映射由各自适配器处理。
- 操作：`transcribe(audioPath, language)` 返回异步结果；适配器负责模型加载、语音分段、识别和模型输出清理。调用者不直接依赖 `onnxruntime-node` 类型、VAD 状态或模型张量。
- 输出：`Transcript` 包含完整 `text`、`language` 和 `segments`；每段包含 `id`、`start_ms`、`end_ms`、`text`，`speaker` 在实际存在时可选。时间戳以源音频起点为零点、以毫秒计；段落按时间排序，时间范围必须有效且不超出音频。当前适配器沿用 `seg-0001` 起递增的编号格式与现有文本拼接行为。
- 失败：无语音或没有有效文字使用现有 `ASR_EMPTY_TRANSCRIPT`；模型缺失、依赖缺失、加载或识别失败分别映射到既有对应错误。失败不得生成成功文字稿，模型文件损坏不得视为可用缓存。

错误码沿用现有 Python 与 worker 契约，不新造码：

| 情况 | 码 |
| --- | --- |
| 无语音、识别结果全空 | `ASR_EMPTY_TRANSCRIPT` |
| 模型文件缺失、哈希不符、就绪标记不是同时记录两个模型 | `ASR_MODEL_NOT_DOWNLOADED` |
| 缓存目录不可读 | `ASR_MODEL_CACHE_UNAVAILABLE` |
| `onnxruntime-node` 缺失或原生模块加载失败 | `ASR_DEPENDENCY_MISSING` |
| 图加载失败、分段失败、单段识别失败、`dispose()` 后复用 | `ASR_RUNTIME_ERROR` |
| 模型标识不在闭集内（含历史标识被当作新任务输入） | `ASR_MODEL_UNSUPPORTED` |

取消不在接口内：按下面的职责划分，取消以 Rust 宿主终止完整进程树为准，异步返回值本身不承诺可中断
同步原生推理。

转写入口由 worker 的模型解析和组装代码创建当前唯一适配器，支持模型列表保持闭集。其他 worker 模块只依赖 `Transcriber`、公共结果类型和稳定错误语义。旧模型标识作为历史数据可读取；作为新任务输入须明确拒绝，不能悄悄映射到另一个模型。

## 职责划分

- **模型适配器**：使用已验证的模型文件，管理自身推理资源、VAD、分段、语言映射与结果转换。不同模型可采用各自的分段方式，但必须满足公共结果契约与对应验收要求。
- **模型准备**：负责按需获取、版本与完整性校验、缓存状态和安全提交；向适配器提供已验证的本地文件。模型加载和转写接口不隐式下载，也不接触账号或云端 LLM。
- **任务流程与产物**：负责选择模型、准备音频、发布已有进度、处理错误以及统一写入 `txt`、`md`、分段 JSON 和任务清单。产物写入继续使用来源校验和现有原子提交、事务恢复规则；适配器不得直接修改任务产物、历史或合集。
- **Rust 宿主**：继续管理受监督进程、超时、取消和进程树终止。接口返回异步结果本身不承诺可以中断同步原生推理；取消以宿主对完整进程树的实际终止和清理为准。

模型标识用于用户设置与现有任务契约；模型文件的来源、版本、哈希和缓存布局由模型准备记录。两者分别管理。

## 当前模型适配

TypeScript worker 使用 `onnxruntime-node@1.29.0` 直接加载生产 `iic/SenseVoiceSmall-onnx` 资产。缓存位于用户数据根
`<根>/models/onnx/`，沿用现有目录结构、`MODEL_VERSION.txt` 就绪标记、`ONNX_REQUIRED_ASSET_HASHES`
校验、按需下载与原子提交行为；模型标识、设置值和任务契约保持 `iic/SenseVoiceSmall-onnx`，升级后
现有缓存直接可读取，用户无需重新下载模型。

适配器内部按生产路径实现以下环节，范围与 `worker/worker_core/asr_runtime/sensevoice_onnx.py` 及
`funasr_onnx` 一致：

- 音频前端：Fbank 80 维特征（hamming 窗、25 ms 窗长、10 ms 帧移、0.97 预加重、去直流、
  512 点实数 FFT、HTK mel 三角滤波器组、`FLT_EPSILON` 对数下限）、LFR 7/6 拼帧、
  `am.mvn` CMVN 归一化，生成 `speech` [B,T,560] 与 `speech_lengths`。生产 `WavFrontend` 的
  `dither` 为 1.0，随机种子取自当前时间；数值逐项比对在 `dither=0` 的确定性配置下进行，
  生产配置按多次运行的识别文本集合验收。
- 识别：以 `language`、`textnorm` 为输入调用生产 `model_quant.onnx`，对 `ctc_logits` [B,T,25055]
  做 CTC greedy 解码（`blank_id` 为 0），经 `tokens.json` 映射、SentencePiece 拼接得到文本，
  并沿用现有 `_clean_sensevoice_text` 的标签清理规则。`language` 取 `zh`=3 / `en`=4 / `auto`=0，
  `textnorm` 取 `withitn`=14 / `woitn`=15；ITN 由 `textnorm` 输入控制，无需单独后处理。
- 分段：VAD 使用独立的 `WavFrontendOnline` 前端（`dither=0.0`、LFR 5/1、80 维 Fbank 拼成
  400 维 `speech`），与 ASR 前端的 LFR 7/6、560 维不同，不能共用同一套参数。以生产
  FSMN VAD ONNX 做 10 秒分块的有状态推理，维护 `in_cache0..3` / `out_cache0..3`，
  按 `config.yaml` 的 `model_conf` 复现 `E2EVadModel` 的窗口检测、每帧分贝、最大段长
  与端点检测。事件流为「块 → batch → 事件列表」三层，`-1` 表示未闭合的起点或终点，
  沿用 `_decode_onnx_vad_events` 的合法性校验与 `_stream_onnx_vad_segments` 的跨块配对，
  再按 `_slice_audio_by_milliseconds` 切片；每块不超过 20.5 秒，补边不得重叠重复识别。
  2026-11-14 已在 Node 侧验证缓存传递、状态机、事件校验与分段时间戳；`WavFrontendOnline`
  的 `input_cache` / `lfr_splice_cache` / `reserve_waveforms` 跨块边界与 `is_final` 尾帧
  补齐也已逐块比对，每块 waveform 边界逐值一致、`feats` 最大绝对误差 ≤ `1.66e-4`。

模型准备在缓存缺失时按现有可观察路径报告下载进度、取消、校验失败和离线状态，不能生成成功结果或
复用未完成文件。旧 PyTorch 缓存与运行组件保留在数据目录，模型准备不读取、不执行、不删除这些资产。

## 模型准备

`worker-ts/src/asr/model-download.ts` 的 `prepareModelCache` 是唯一的下载入口，语义对齐
`worker/worker_core/model_download.py` 的 ONNX 分支：

- **来源固定，完整性只认哈希。** Python 用 `modelscope` SDK 拉 `iic/SenseVoiceSmall-onnx`、
  VAD 仓库和 `iic/SenseVoiceSmall` 的 BPE 文件；TypeScript 不做 SDK 移植，直接请求 ModelScope
  的公开文件端点（`.../api/v1/models/<id>/repo?Revision=master&FilePath=<file>`，服务端 302 到
  CDN）。端点只是搬运工，放错一个字节由 `model-assets.ts` 里逐文件固定的 SHA-256 拦下。
  `MODEL_DOWNLOAD_SOURCES` 记录「哪个缓存文件来自哪个仓库的哪个路径」，与固定哈希表必须覆盖同一组
  文件，由单测守卫。不接受自定义 URL、镜像或修订——与 Python 对 ONNX 分支的拒止一致。
- **提交是整目录替换。** 下载写入 `<models>/.onnx-staging-<hex>/models/...`，写完
  `MODEL_VERSION.txt`、用与运行时相同的校验通过后才 `rename` 到 `models/onnx`；旧目录先挪成
  `.onnx-backup-<hex>`，替换失败则挪回。启动时先清理 staging；发现就绪目录缺失但存在 backup，
  先把 backup 复原再校验——那是上一次替换被打断时唯一完好的副本，直接删掉等于让用户重下 241 MB。
- **续传只用于重试，不跨进程。** 每次尝试按残片大小发 `Range: bytes=N-`；服务端忽略 `Range`
  （返回 200）时从头写，返回 416 时丢掉残片重来。`content-length` 已知却没读满按短读处理、
  走重试，不当成「文件就是这样」。网络错误、5xx、超时、短读退避重试；4xx 与体积超限立即失败；
  哈希不符且这次是续传时丢掉残片从零重下一次，全新下载仍不符才报
  `ASR_MODEL_ARCHIVE_INVALID`。
- **失败语义。** 网络/HTTP/空间不足 → `ASR_MODEL_DOWNLOAD_FAILED`；下载内容不对 →
  `ASR_MODEL_ARCHIVE_INVALID`。剩余空间要求 2 GiB，与 Python 同值：两侧判定不同会让「同一台
  机器上 Python 能下、TypeScript 不能下」变成用户可见差异；`statfs` 不可用时放行，宁可让下载去撞
  ENOSPC 也不要凭空拒绝。
- **进度与取消沿用现有编码。** 事件码、状态、`current_file` 约束和 `message_args` 白名单与 Python
  的 `MODEL_PROGRESS_REGISTRY` 逐项一致（`scripts/tests/asr-verification-assets.test.mjs` 比对），
  进度单调不减、按 100 ms / 1% 节流。取消以 `AbortSignal` 为输入，清掉 staging、不发
  `model.download.completed`、发出 `model.download.cancelled`，抛 `AbortError` 形状的错误而不是
  新造错误码——取消不是失败，宿主仍以终止进程树为准。
- **复用现有缓存。** 校验通过就直接返回，不发任何请求；用户已有的 `<根>/models/onnx` 不需要重新
  下载。损坏的缓存按「未下载」重下，不降级使用。

`worker-ts/scripts/download-model.mjs` 是同一入口的命令行封装，用于预热缓存、离线安装和门禁/CI
准备资产。

## 扩展与验证

接入后续模型时，实现相同转写接口，并明确该模型的文件、下载、语言、分段、时间戳、错误和质量要求；由模型解析处接入，同时按需要更新桌面受支持模型列表、设置、契约、打包与迁移。此次只实现一个适配器，不增加动态加载第三方插件、插件市场或尚无调用方的模型管理框架。

使用当前真实模型和固定语料验证接口与完整流程：检查语言参数、`dither=0` 配置下 ASR 前端张量与
Python 基线的数值一致性、CTC 解码结果、VAD 的逐块张量与缓存、事件流合法性、分段及时间戳、
成功产物、无语音错误、模型缺失和损坏、长音频、取消与资源清理。VAD 的 `WavFrontendOnline`
跨块特征在移植时单独逐块比对，不能用状态机验证代替；正式验收仍须在仓库内重建等价检查。
2026-11-14 的端到端原型已复现分段、切片、块上限与 `Transcript` 结构，但 TypeScript 前端与
`kaldi-native-fbank` 存在 `1e-5` 量级的浮点差异，会被 int8 模型放大为个别 token 差异；
因此接口验收检查结构与失败语义，文本质量按 CER 门槛与独立参考文本评估，不能要求与 Python
逐字相同。同一份 `feats` 下运行时 `ctc_logits` 必须一致，用于区分运行时与前端差异。同日已按此口径
在 8 条真实窗口（6277 个字符单位）上实测：相对架构独立的 Paraformer 参考，Python 与 TypeScript 的
CER 分别为 `23.64%` 与 `23.48%`，增量 `−0.159pp`（门槛 `0.5pp`）；唯一人工校对真值用例两侧均为
`1.92%`、编辑距离同为 11 字；146 段中 99 段文本完全相同，75 个差异字符为多字 23 / 漏字 23 / 替换 29。
参考与主候选互比 CER 达 `23.64%`，其中中英混合窗口超出中文参考词表能力，报告须同时给出参考噪声基准。
静态依赖检查确保任务流程不直接依赖具体模型库；完整质量和三平台门槛以执行计划为准。
不得通过假模型或模拟推理结果代替真实模型验证。

2026-11-14 落地后的验证状态：接口、错误码映射、闭集模型拒止、无语音、模型缺失/损坏、非法音频与
VAD 非法事件流已有单测（`worker-ts/tests/`，不需要模型）；端到端结构与文本由
`scripts/asr-verification/run.mjs` 对固定 fixture 判定（3 例，CER `0.000%`）。仍未覆盖真实注入的
失败路径：单段识别失败（需要构造坏块）、`dispose()` 后复用（有断言但未在真实会话上跑过）、进程树
取消（属 Rust 宿主）。模型准备与产物写入模块尚未开始，因此「按需下载失败」「产物写入失败」两类
语义目前只有设计描述。
