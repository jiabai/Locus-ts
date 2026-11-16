# Worker TypeScript Rewrite Plan

> This ExecPlan is a living document. The sections Progress, Surprises & Discoveries, Decision Log, and Outcomes & Retrospective must be kept up to date as work proceeds.

状态：生产实现已基本完成，宿主已优先启动随包 Deno 上的 TypeScript worker，并在资产缺失时回落 Python。ASR 使用 `onnxruntime-node@1.29.0` 直接加载生产模型文件，沿用 `<根>/models/onnx/` 缓存与 `iic/SenseVoiceSmall-onnx` 标识；用户已于 2026-11-14 确认该方案。Python 与 Node 两侧的加载、推理、CTC 解码、ASR 前端、FSMN VAD 状态机与 VAD 在线前端均已完成实测比对；三平台真实公网冒烟已完成。发布目标已收窄为 Windows x64 与 macOS Apple Silicon，macOS Intel 于 2026-11-16 停止支持。剩余工作集中在 macOS 实启动、安装包资产与许可、最后两处 Python 入口以及运行边界回归。产品规格见 `docs/product-specs/2026-11-13-worker-typescript-rewrite.md`，目标架构见 `docs/design-docs/2026-11-13-typescript-worker-architecture.md`，ASR 接口设计见 `docs/design-docs/2026-11-13-typescript-worker-asr-boundary.md`。

## Purpose / Big Picture

用户继续在本地处理视频、音频和网页，读取已有笔记并使用工作间；处理阶段、用户数据和安全边界保持现有约定。worker 改用 TypeScript，模型选择调整为当前 ONNX 模型。规格与 ASR 设计分别定义用户可见行为和适配边界。

- 将自有 Python worker 换成 TypeScript，保留当前媒体、网页笔记、存储、工作间及 BYOK 行为；具体范围和用户数据保护见产品规格。
- 只交付当前默认的 `iic/SenseVoiceSmall-onnx` 模型选项，并通过模型无关的 `Transcriber` 接口隔离 ASR 实现。新版本不提供 PyTorch 选项及其运行时组件；其他模型的实现不属于本次范围。
- 现有 PyTorch 设置一次性迁移到 ONNX 并提示用户；历史任务与原模型文件、运行组件保留。验收全程自动化；粤语按原可行性测量决定排除在本次 ASR 质量语料之外。
- 用户允许官方独立 yt-dlp 程序内置 Python，作为发行包内唯一第三方例外；自有 worker 不保留 Python 运行时。
- 单独维护 TypeScript worker 包，沿用项目现有包管理方式，不为迁移引入根级 workspace 或前后端共享框架。代码共用仅在确有重复的稳定契约时考虑。
- 不引入双运行时常驻、远程开关或更新通道；验证时在开发环境使用固定的旧版本作为对照。出现问题通过现有发布流程修复，数据兼容和原子恢复须独立验证。

## Progress

- [x] 2026-11-13：完成默认 ONNX 路径的基线测量，记录生产参数、分段行为与语料结果，正式质量、性能与打包验收在重写阶段执行。Validation: `work/asr-spike/results/` 的基线与分段报告，以及 `docs/exec-plans/completed/` 中 2026-11-12 的可行性测量记录。
- [x] 2026-11-13：明确单一 ONNX 模型、可替换 ASR 适配接口、自动化验收和独立 yt-dlp 例外；更新产品规格、接口设计、计划及待验证事项，生产代码未改动。Validation: 项目 `.venv` 执行 `scripts/validate_agents_docs.py --level ERROR` 和 `--level WARN` 均为 0 个错误、0 个警告；`git diff --check` 通过。
- [x] 2026-11-13：核对历史实验结果、自动仲裁脚本与模型文件哈希，统一已完成实验记录及索引；正式验收使用候选输出之外生成的固定参考文本。Validation: `final-metrics*.json`、`arbiter.py`、`mirror-cross-check.json`，以及生产和实验模型的 SHA-256 实测。
- [x] 2026-11-13：记录 TypeScript 目标架构图、Python 版本对比、数据边界和待验证事项。Validation: `docs/design-docs/2026-11-13-typescript-worker-architecture.md`；文档治理 ERROR 与 WARN 均为 0 个错误、0 个警告；`git diff --check` 通过。
- [x] 2026-11-14：确定 ASR 运行时方案为 `onnxruntime-node` 直接加载生产模型文件，完成 Python 与 Node 两侧的加载、推理验证；现有 ONNX 缓存、就绪标记与模型标识保持不变。Validation: 生产 `model_quant.onnx` 的 SHA-256 `21dc965f689a78d1604717bf561e40d5a236087c85a95584567835750549e822` 与 `worker/worker_core/model_download.py` 一致；`onnxruntime 1.28.0` 得到 `speech/speech_lengths/language/textnorm → ctc_logits/encoder_out_lens`；`node work/asr-spike/probe/production-ort-node.mjs`（`onnxruntime-node@1.31.1`）加载 4037 ms、推理得 `ctc_logits` [1,104,25055]，生产 FSMN VAD ONNX 加载 49 ms；证据 `work/asr-spike/results/production-ort-node.json`；产品规格、接口设计、计划与待验证事项已同步，文档治理 ERROR 与 WARN 均为 0 个错误、0 个警告。
- [x] 2026-11-14：完成生产模型在 Node 侧的推理与解码等价性验证，确定 `onnxruntime-node@1.29.0` 与生产基线数值行为一致。Validation: `work/asr-spike/probe/asr_golden.py` 生成 3 秒真实音频的前端特征与 Python 基线；`node work/asr-spike/probe/asr_node_decode.mjs` 在同一份特征上逐帧 argmax、CTC greedy 解码、`tokens.json` 拼接与标签清理，17 个 token 及四个比对项全部一致；证据 `work/asr-spike/results/asr-golden.json`、`results/asr-node-decode.json`；`onnxruntime-node@1.29.0` 两次独立安装复测结果稳定。
- [x] 2026-11-14：完成 TypeScript 前端实现与两层验收，Fbank、LFR、CMVN 的数值误差和端到端识别文本均在实测范围内。Validation: `work/asr-spike/probe/frontend_golden.py` 生成 `dither=0` 的确定性基线，`node work/asr-spike/probe/frontend_ts.mjs` 比对 `298×80` Fbank（最大绝对误差 `1.54e-4`、平均 `4.82e-6`）与 `50×560` LFR+CMVN（最大 `2.31e-5`、平均 `7.16e-7`）；`dither=0` 端到端 17 个 token 与文本一致，`dither=1.0` 下 Node 与 Python 各 5 次运行的文本集合一致；证据 `work/asr-spike/results/frontend-golden.json`、`results/frontend-ts-compare.json`。
- [x] 2026-11-14：完成 FSMN VAD 的 TypeScript 侧状态机移植与分段等价性验证，缓存传递、事件流、无语音与非法事件处理全部与生产一致。Validation: `work/asr-spike/probe/vad_golden.py` 用 `Fsmn_vad_online` 与 `_stream_onnx_vad_segments` 导出 `pharma-90s`（9 块 / 5 段）、`music-30s`（3 块 / 6 段）、`silence-3s`（1 块 / 0 段）的逐块张量与事件流；`node work/asr-spike/probe/vad_ts.mjs`（`onnxruntime-node@1.29.0`）自行维护 `in_cache0..3` 并移植 `E2EVadModel`、事件校验与跨块配对，三个用例的逐块事件与分段时间戳全部一致，`logits` 和四组缓存最大绝对误差 0；13 项事件流合法/非法校验 13/13 通过；证据 `work/asr-spike/results/vad-golden.json`、`results/vad-ts-compare.json`、`results/vad-golden/`。
- [x] 2026-11-14：完成 `WavFrontendOnline` 的 TypeScript 移植与端到端验证，VAD 跨块特征缓存和分段时间戳均可复现。Validation: `node work/asr-spike/probe/vad_frontend_ts.mjs` 直接读取三个用例的原始 WAV 逐块跑前端：`pharma-90s`（9 块）、`music-30s`（3 块）、`silence-3s`（1 块）的 waveform 边界逐值一致（最大绝对误差 0）、`feats` 帧数一致、数值最大绝对误差 `5.09e-5` / `1.66e-4` / `4.77e-7`；用 TypeScript 前端产出的 `feats` 驱动 VAD 推理与状态机，逐块事件流与最终分段仍与基线一致（5 / 6 / 0 段）；证据 `work/asr-spike/results/vad-frontend-ts-compare.json`，状态机模块 `probe/vad_state_machine.mjs`。
- [x] 2026-11-14：把四个已验证环节组装成 TypeScript `OnnxTranscriber` 原型并做端到端比对，分段、切片与结构约束全部一致，文本差异定位到前端 FFT 数值。Validation: `node work/asr-spike/probe/transcriber_ts.mjs` 对 `pharma-90s`（5 段）与 `music-30s`（6 段）复现 VAD 分段、切片样本数、每块 ≤20.5 秒（最大 20.01 秒）、时间单调与音频边界；`pharma-90s` 544 字中 9 字不同（1.65%）；用 Python 导出的同一份 `feats` 喂 `onnxruntime-node@1.29.0` 时 `ctc_logits` 误差 0、105 个 token 一致，证明差异来自前端 `2.8e-5` 的 `feats` 误差被 int8 模型放大；`Math.fround` 模拟无改善；证据 `work/asr-spike/results/transcriber-ts-compare.json`、`results/asr-segment-diag.json`。
- [x] 2026-11-14：用架构独立的 Paraformer 生成 8 条窗口参考文本，按产品 CER 门槛判定 TypeScript 端到端质量通过，确认无需移植 kiss_fftr。Validation: `work/asr-spike/probe/ref_paraformer.py` 以 `speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-onnx`（int8、`dither=0`）转写 8 条 `ground-truth/*.window.wav`（150～184 秒）；`probe/py_window_transcribe.py` 与 `probe/window_transcribe.mjs` 在同一批窗口分别跑 Python 生产引擎与 TypeScript 原型；`probe/cer_reference.py` 得 CER `23.64%` vs `23.48%`、增量 `−0.159pp`（门槛 `0.5pp`），146 段中 99 段文本相同，75 个差异字符为多字 23 / 漏字 23 / 替换 29；`probe/cer_truth.py` 用唯一 `status=proofread` 的 `conversation-street` 真值得两侧均 `1.92%`、编辑距离均 11 字；证据 `work/asr-spike/results/reference-paraformer.json`、`results/py-window-transcribe.json`、`results/ts-window-transcribe.json`、`results/cer-reference-compare.json`、`results/cer-truth-compare.json`。
- [x] 2026-11-14：验证安装包锁定的 Deno `2.9.1` 可作为 worker 运行期加载 `onnxruntime-node@1.29.0` 原生插件，确定外置 `node_modules` 布局与最小权限集，并排除 `deno compile` 单文件路线。Validation: `work/asr-spike/probe/deno_ort_probe.mjs` 在 Deno 下加载生产 ASR（2.4 秒）与 FSMN VAD（15 毫秒），零张量 `sum=-15822308.185514761`、`head` 与 `probe/node_ort_baseline.mjs` 的 Node 结果逐值相同；`probe/deno_transcribe.mjs` 与裁剪布局 `deno-pack/` 跑 8 条真实窗口，字符数、段数与文本与 Node 完全相同；权限实测最小集为 `--allow-read --allow-write --allow-ffi`（无 FFI 直接失败，`env`/`sys` 不需要，FFI 可限定目录）；`deno compile` 产物 357 MB 且加载到 `C:\Windows\system32\onnxruntime.dll` 1.17.1 报 API 版本错；删除非本平台 `bin` 与 `DirectML.dll`/`dxcompiler.dll`/`dxil.dll` 后 `node_modules` 为 27.6 MB 且结果不变；证据 `work/asr-spike/results/deno-runtime-matrix.json`。
- [x] 2026-11-14：把 ASR 链路固化成仓库内可执行门禁 `scripts/asr-verification/`（fixture、资产哈希、生产基线、逐平台 golden、三层判定），并用负例证明它真的会失败。Validation: `node scripts/asr-verification/run.mjs --cache-dir work/asr-spike/models/production/onnx` 在 Node v22.22.2 与 Deno 2.9.1 下均为 `speech-12s` 1 段 58 字、`dialogue-32s` 4 段 157 字、`silence-3s` 0 段且抛 `ASR_EMPTY_TRANSCRIPT`，两者 CER 均 `0.000%`，分段与 `golden/production-reference.json` 逐毫秒相同；负例一：`textnorm` 改 15 后降为 55 字、CER `1.852%` 被拦下；负例二：篡改 VAD `config.yaml` 哈希后退出码 2；`node --test scripts/tests/asr-verification-assets.test.mjs` 4/4 通过；门禁同时暴露了 `E2EVadModel` 漏初始化 `noiseAverageDecibel` 的真实缺陷。
- [x] 2026-11-14：把 ASR 实现搬进生产包 `worker-ts/src/asr/`，落地公共 `Transcriber`/`Transcript` 接口、稳定错误码与只读模型缓存校验，门禁改为导入该实现（不再有第二份代码），并补齐失败语义单测。Validation: `npm --prefix worker-ts run typecheck`（13 个源文件、`strict`）通过；`npm --prefix worker-ts test` 20/20 通过（模型缓存缺失/哈希不符/就绪标记不全、非法音频、闭集模型拒绝历史标识、VAD 事件流 6 类非法输入、`do_extend` 数字开关、`dither` 默认值，均不需要模型）；`node --experimental-strip-types scripts/asr-verification/run.mjs --cache-dir ...` 与 `deno run --allow-read --allow-write --allow-ffi ...` 均三例 PASS、CER `0.000%`；`node --test scripts/tests/asr-verification-assets.test.mjs` 5/5 通过（含「只有适配器可 import onnxruntime-node」「门禁只经公共入口导入 ASR」）。
- [x] 2026-11-14：落地模型准备模块 `worker-ts/src/asr/model-download.ts`，补齐下载态的 `ASR_MODEL_DOWNLOAD_FAILED` / `ASR_MODEL_ARCHIVE_INVALID`，并把缓存校验的哈希读取改为流式。Validation: 真实网络执行 `node --experimental-strip-types worker-ts/scripts/download-model.mjs --data-root <临时目录>`，13 秒下载 9 个文件共 242474788 字节，staging 自校验（逐文件 SHA-256 与生产固定值一致）通过后才原子提交，目录内无 staging/backup 残留；二次调用输出 `reused` 且不发任何请求；用这份全新缓存跑 `node --experimental-strip-types scripts/asr-verification/run.mjs --cache-dir ...` 三例 PASS、CER `0.000%`，证明下载产物可直接推理；`npm --prefix worker-ts test` 31/31（新增 11 项：整目录提交与进度单调、复用已有缓存、损坏缓存替换、哈希不符报 `ASR_MODEL_ARCHIVE_INVALID` 且不留半份缓存、503 重试并在第二次带 `Range: bytes=5-` 续传、404 不重试、取消清理 staging 且只发一次 `model.download.cancelled`、磁盘不足先失败且零请求、替换中断后从 backup 复原、文件系统失败也落在下载码上、下载来源表与固定哈希同集合）；真实网络取消实测抛 `AbortError`、末条事件 `model.download.cancelled:48`、未创建 `models/onnx` 且无 staging 残留；`node --test scripts/tests/asr-verification-assets.test.mjs` 6/6（新增 TypeScript 进度表与 Python `MODEL_PROGRESS_REGISTRY` 的码、状态、`current_file` 与 `message_args` 逐项比对）。
- [x] 2026-11-14：落地产物写入模块 `worker-ts/src/artifacts/`——原子文件原语、多文件事务（journal、回滚、残留清理）与文字稿产物（`transcript.txt`/`.md`/`segments.json`），沿用现有存储格式与恢复规则。Validation: `npm --prefix worker-ts run typecheck` 通过；`npm --prefix worker-ts test` 61/61（新增 30 项：原子写替换与失败收敛、JSON 序列化失败、符号链接目标与父目录拒止、同目录安装约束、synced 新文件不覆盖、崩溃点回滚、提交点后保留新版本、删除后可恢复、非法 journal 拒止且不动权威文件、缺回滚材料时不做半恢复、闭集残留清理、契约正反例与目的地集合比对、文字稿文件名/Markdown/平台换行/无分段删旧文件/空文本报 `ASR_EMPTY_TRANSCRIPT`）；跨语言互读实测：TypeScript 在 `after_replace:transcript/transcript.txt` 注入崩溃（journal 为 `prepared`、第一个文件已替换），Python `recover_task_artifacts` 返回 `rolled_back` 并还原旧内容；反向由 Python 注入崩溃、TypeScript 恢复同样返回 `rolled_back` 且材料清理干净；探针脚本 `work/interop/{ts-step.mjs,py-step.py}`；文档治理 ERROR/WARN 0/0，`git diff --check` 通过。
- [x] 2026-11-14：落地协议入口 `worker-ts/src/protocol/` 与 `src/cli.ts`，迁移 `--download-asr-model` 模式：前缀与通道、事件校验、stdin 上限、退出码按契约实现，其余模式不注册参数（用法错误退出码 2，不静默成功）。Validation: 真实网络执行 `node --experimental-strip-types worker-ts/src/cli.ts --download-asr-model --asr-model iic/SenseVoiceSmall-onnx`（`APP_MODEL_DIR` 指向临时目录），14 秒完成，stdout **恰好一行** `{"status":"completed","model":"iic/SenseVoiceSmall-onnx"}`、退出码 0、stderr 144 行均为带 `APP_MODEL_DOWNLOAD ` 前缀的合法事件；二次执行复用缓存、stderr 零事件、退出码 0；用这份缓存跑 `scripts/asr-verification/run.mjs` 三例 PASS、CER `0.000%`；`npm --prefix worker-ts test` 77/77（新增 16 项：协议事件 7、业务入口 6、CLI 3）；`node --test scripts/tests/worker-protocol-contract.test.mjs` 4/4（前缀、契约版本、worker 进度表 ↔ 契约 ↔ Python 注册表、模型进度表 ↔ 契约、stage 表）；`--asr-model iic/SenseVoiceSmall` 返回 `ASR_MODEL_UNSUPPORTED` 且退出码 1。
- [x] 2026-11-14：落地媒体准备模块 `worker-ts/src/media/`（命令执行、ffprobe 探测、音频归一化、本地视频/音频准备），错误码取契约 `localMedia.errorCodes` 闭集。Validation: 用真实 ffmpeg 生成 44.1 kHz 立体声 WAV 与 160×120 MP4，`prepareLocalMedia` 产出 16 kHz 单声道 16 位 PCM WAV（`isNormalizedPcmWav` 为真）、视频按原扩展名复制且字节与源一致、`download/` 与 `media/` 均无 staging 或 `.part` 残留；失败码实测：WAV 按视频提交 → `LOCAL_MEDIA_KIND_MISMATCH`、无音轨视频 → `LOCAL_VIDEO_AUDIO_STREAM_MISSING`、文本文件冒充音频 → `LOCAL_MEDIA_VALIDATION_FAILED`、源文件缺失 → `AUDIO_NORMALIZATION_FAILED`；媒体产物直接喂真实转写器（`work/asr-spike/models/production/onnx` 缓存）得到 `ASR_EMPTY_TRANSCRIPT`，证明「归一化产物 → 转写器」的格式交接成立而非格式错误；`npm --prefix worker-ts test` 89/89（新增 12 项：探测判定 6、本地准备 6，后者在本机无 ffmpeg 时整组跳过）。
- [x] 2026-11-14：落地任务存储 `worker-ts/src/tasks/` 与本地任务管线 `worker-ts/src/pipeline/local-media.ts`，迁移 `--process-local-media-stdin`，「本地文件 → 文字稿 → task.json」首次端到端跑通。Validation: 真实 ffmpeg + 真实 ONNX 模型（`work/asr-spike/models/production`）跑 `scripts/asr-verification/fixtures/speech-12s.wav`，stdout 一行 `{"status":"completed","task_id":"20261114-142132-local-25b39b4daea66c5a",…}`、退出码 0、stderr 5 行 `APP_PROGRESS` 事件（18/34/58/58/68），产出 `media/audio.wav`（ffprobe 实测 `pcm_s16le,s16,16000,1`）、`transcript.txt`/`transcript.md` 与 `status=completed` 的 `task.json`（`artifacts` 三项、`transcript.engine=iic/SenseVoiceSmall-onnx`），识别文本与 `golden/win32-x64/speech-12s.json` 的期望文本逐字相同；`download/` 与 `media/` 无残留副本；跨语言互读双向实测——Python 的 `load_task_manifest`/`TaskStoreFacade.open` 完整读出 TypeScript 写的任务（严格校验全过、`LocalFileTaskSource`、`transcript` 元数据、`artifacts`、`text_preview` 均正确），Python 写的清单被 TypeScript 读回 `note_title` 与 `draft_seed_insight_id=9` 并原样保留，两份实现的清单字段顺序逐项相同；探针 `work/interop/{py-read-task.py,py-write-task.py,ts-read-task.mjs}`；`npm --prefix worker-ts test` 119/119（新增 30 项：清单序列化/闭集/标题与种子保留/任务 id 与路径/来源校验 9 项、请求解析与 stdin 9 项、管线端到端 9 项、CLI 3 项）；`node --test scripts/tests/*.test.mjs` 67/68（1 项为既有跳过）。
- [x] 2026-11-14：落地 AI 生成调用层 `worker-ts/src/ai/`——BYOK 与托管凭证兑换、OpenAI 兼容对话调用、最小工具循环、错误码闭集；同时确认不引入 Python 的 `agent_runtime` SDK。Validation: 抓包对齐——`work/ai-spike/capture_py_request.py` 驱动 `ProviderOpenAIOfficial` 打本地服务器，抓到真实请求体并落为 golden `worker-ts/tests/fixtures/insight-request-golden.json`，TypeScript 组装的请求与之逐字段相同（`model` / `stream:false` / `messages` / `tool_choice:"auto"` / `tools` / `max_tokens`）；`npm --prefix worker-ts test` 150/150（新增 31 项：对话调用 11、工具循环 10、配置与托管 10），其中一项用真实 `node:http` 服务器跑通「checkout → 模型调用 → 工具交付」全链（`/v1/chat/completions`、`Bearer` 头、`tool_choice` 正确），另一项验证托管模式每次调用换一次凭证且 `request_id` 递增（`req-1-call-0001` / `-0002`）、输出预算取本地 `APP_LLM_MAX_TOKENS` 不被 checkout 响应覆盖；错误映射覆盖 401/403/404/429/500、400-未知模型（按响应措辞判）、超时、连接失败与非法响应；文档治理 ERROR/WARN 0/0，`git diff --check` 通过。
- [x] 2026-11-14：把 AI 侧从「调用层」推进到「第一条完整生成链」——三语输出语义表、文字稿分块、导图/摘要提示词、要点总结 agent（导图→摘要两段交付）与 AI 产物事务写入。Validation: 提示词与分块用 Python 渲染的基准逐字节比对（`work/ai-spike/prompts_golden.py` 生成 `worker-ts/tests/fixtures/{summary-prompts,transcript-chunks,output-language}-golden.json`）：3 语言 × 2 来源的导图/摘要提示词全部相同；分块在 `max_length` 2000/300/80 三档下 `content`、`summary`、`start_byte`/`end_byte`、`sha256` 全部相同（含标题被切断时的摘要归属）；三语语义表 25 个字段逐项相同；`npm --prefix worker-ts test` 166/166（新增 16 项：提示词与分块 6、摘要 agent 与产物写入 10），其中摘要 agent 用假模型驱动真实工具循环，验证「先导图后摘要」的换工具时序、非法导图被退回重交、纯文本回复被点名催促、未交付时报 `AI_INVALID_MINDMAP`/`AI_EMPTY_SUMMARY`、空文字稿与非法轮数在调用模型前失败；产物写入验证任务内 `ai/` 走事务（无残留、可覆盖）与导出目录逐文件原子写。
- [x] 2026-11-14：迁移 `--retry-insights-stdin`（先只放开 `target=summary`），把「已转写任务 → 导图 + 摘要」接成第一条 AI 用户路径；同时补齐任务清单的严格读取、权威源文本读取、请求解析与「产物 + 清单」一次事务提交。Validation: 真实 CLI 全链——先用 `--process-local-media-stdin` + 真实 ffmpeg + 真实 ONNX 模型处理 `fixtures/speech-12s.wav` 建任务，再用本地 `node:http` 假 OpenAI 服务（BYOK 环境变量）跑 `--retry-insights-stdin`：两次工具调用依次 `submit_mindmap` / `submit_summary`（请求体 `stream:false`、`Bearer` 头、工具名均实测），stdout 恰好一行 `status=completed`、退出码 0、stderr 0 行，产出 `ai/summary.md`、`ai/mindmap.mmd` 与 `artifacts` 含这两项的 `task.json`，Python 的 `load_task_manifest` / `TaskStoreFacade.open` 完整读回；反向由 Python 写一份带 `note_title` 与 `draft_seed_insight_id=9` 的任务，TypeScript 重算后两项原样保留、Python 再次读回全过；`npm --prefix worker-ts test` 185/185（新增 19 项：清单严格读取 5、请求解析 6、管线端到端 6、CLI 2）；`node --test scripts/tests/*.test.mjs` 73 通过 / 1 既有跳过（新增协议守卫：字段集合 ↔ Python、target 闭集 ↔ 契约、已实现 target ⊆ 闭集、三语闭集、CLI 三个模式）；文档治理 ERROR/WARN 0/0，`git diff --check` 通过。
- [x] 2026-11-14：把 `--retry-insights-stdin` 从 1 个 target 扩到 2 个——新增 `insights`（启发灵感）：偏好词表与快照严格解析、启发提示词、`submit_insights` 交付校验、洞察 JSON/Markdown 产物与偏好快照落盘；`summary` 与 `insights` 共用同一套「打开任务 → 读权威稿 → 生成 → 合并 → 一次事务提交」骨架。Validation: Python 渲染的基准逐字节比对——`insights-prompts-golden.json` 12 例（3 语言 × 2 来源 × 有无偏好快照）提示词全同、`insights-markdown-golden.json` 三语产物全同、`preference-options-golden.json` 两张词表全同、`preference-parser-golden.json` 22 个正反例的接受/拒止判定与 Python `parse_preference_snapshot` 逐项相同、快照落盘文件与提示词里的紧凑 JSON 逐字节相同；`npm --prefix worker-ts test` 202/202（新增 17 项：提示词与词表 3、偏好解析 3、启发 agent 7、管线端到端 4），`node --test scripts/tests/*.test.mjs` 73 通过 / 1 项既有跳过；真实 CLI + 本地假 OpenAI 服务跑 `target=insights`（带偏好快照）：stdout 一行 `completed`、退出码 0、stderr 0 行、模型只收到 `submit_insights` 一次工具调用，产出 `ai/insights.json`、`ai/insights.md`、`ai/preference-snapshot.json` 与 `insights_count=1` / `draft_seed_insight_id=null` 的清单，Python 的 `load_task_manifest`、`parse_preference_snapshot`、`read_existing_insights` 全部严格读回；`insight_target_env` 实测 `req-1-summary` / `req-1-insights`；文档治理 ERROR/WARN 0/0，`git diff --check` 通过。
- [x] 2026-11-15：把 `--retry-insights-stdin` 从 2 个 target 扩到 3 个——新增 `title`（笔记标题）：标题采样与提示词、`{"title": ...}` 闭集解析（重复键拒止、Unicode 类别、英文 10 词上限）、标题元数据唯一校验规则、`read_note_title_transcript` / `save_note_title` 的两次单事务清单写入、`title.generation.*` 两条进度事件与标题专用失败码。Validation: `scripts/tests/note-title-golden.py`（生成器入库，只为满足 import 链给 `worker_core.ai_runtime` 放桩，常量与纯函数全部取自 Python 生产源码）生成 `worker-ts/tests/fixtures/note-title-golden.json`：4 例采样（含 12000 码点边界与头/中/尾三段）、3 语 × 2 稿提示词逐字节相同、22 个回复正反例判定与 `parse_title_response` 逐项相同；`npm --prefix worker-ts test` 216/216（新增 14 项：标题 agent 7、管线端到端 7），`npm --prefix worker-ts run typecheck` 通过，`node --test scripts/tests/*.test.mjs` 77 通过 / 1 既有跳过（新增 `note-title-contract.test.mjs` 4 项守卫）；真实 CLI + 本地假 OpenAI 服务（`work/interop/title-cli-smoke.mjs`）：stdout 恰好一行 `status=completed`、退出码 0、stderr 两条合法 `APP_PROGRESS`（running 5% / completed 100%）、模型只收到一次带 `response_format={"type":"json_object"}` 且无 tools 的请求、请求体含 `transcript_sample`；清单 `note_title` 为 `completed` 且 `status` 仍为 `completed`、前端写入的 `custom_local_field` 原样保留，Python `load_task_manifest` 严格读回；失败路径单测覆盖 `TITLE_OUTPUT_INVALID`、供应商错误码、`AI_CONFIG_MISSING`、`TITLE_TRANSCRIPT_UNAVAILABLE`、`TITLE_SAVE_FAILED` 与旧标题保留；文档治理 ERROR/WARN 0/0，`git diff --check` 通过。
- [x] 2026-11-15：把 `--retry-insights-stdin` 从 3 个 target 扩到 4 个——新增 `transcript`（文字稿整理）：`transcript-polish.ts`（系统提示词、2000 字切块、上一段 200 码点衔接、原稿 SHA-256 与 `polished.meta.json`）、只 checkout 一次的 `createPolishLlm`、`ai.generation.running` 逐段进度归一化、`transcript-polish-step.ts`（7 个失败码 + 两次独立原子写产物）与共用 `finalizeMergedResult` 的管线分支。Validation: `scripts/tests/transcript-polish-golden.py`（生成器入库，为 `agent_runtime` 与 `draft_agent` 放桩，常量与纯函数全部取自 Python 生产源码）生成 `worker-ts/tests/fixtures/transcript-polish-golden.json`：5 稿 × 2–3 档切块共 14 例、7 条段提示词、5 例 SHA-256 与元数据、6 组 1–120 段进度事件，TypeScript 输出逐字节/逐项相同；`npm --prefix worker-ts test` 228/228（新增 12 项：整理稿 agent 7、step 与管线端到端 5），`npm --prefix worker-ts run typecheck` 通过，`node --test scripts/tests/*.test.mjs` 82 通过 / 1 既有跳过（新增 `transcript-polish-contract.test.mjs` 5 项守卫：常量与系统提示词、7 条错误码与文案、产物不进事务闭集、进度算式、两个入口接线）；真实 CLI + 本地假 OpenAI 服务（`work/interop/transcript-cli-smoke.mjs`）跑 4 段整理：stdout 恰好一行 `status=completed`、退出码 0、stderr 4 条合法 `ai.generation.running`（attempt 1..4 / total 4）、模型收到 4 次无 tools / 无 `max_tokens` 的 system+user 请求、原稿字节不变、`polished.txt` 为 4 段拼接；Python `load_task_manifest` 严格读回 `status=completed` / `error=null` / `text_preview` / `draft_seed_insight_id=9` / `note_title`，用 `read_bytes().decode().strip()` 重算的 SHA-256 与 `polished.meta.json` 一致，`recover_task_artifacts` 不删整理稿；失败路径单测覆盖 7 个错误码、超长稿零模型调用、清单写 `partial_completed` 与 `text_preview` 保留；文档治理 ERROR/WARN 0/0，`git diff --check` 通过。
- [x] 2026-11-15：把 `--retry-insights-stdin` 从 4 个 target 扩到 5 个——新增 `dissection`（文字稿解剖）：`dissection-report.ts`（报告模型、闭集校验与五种分类、来源摘要重算、三语 Markdown、JSON/Markdown 字节）、`prompts.ts::buildDissectionAgentPrompt`、`dissection-agent.ts`（`submit_dissection` 单工具交付、6 轮上限、16 块上限、每次请求前发进度事件）、`readExistingDissection` 改用 `parsePersistedDissection` 严格校验以消除既有差异。Validation: `scripts/tests/dissection-golden.py`（生成器入库，常量与纯函数全部取自 Python 生产源码）生成 `worker-ts/tests/fixtures/dissection-golden.json`：3 语 × 2 来源共 6 份提示词逐字节相同、19 个报告正反例（含 `validation_category`）判定相同、6 组 JSON/Markdown 产物字节逐个相同、7 个持久化用例（含 provenance 篡改与过期原稿）判定相同；`npm --prefix worker-ts test` 244/244（新增 11 项：报告与提示词 5、agent 6、管线端到端 5，另有 5 项既有测试改为用 `draft` 作为未实现 target），`npm --prefix worker-ts run typecheck` 通过，`node --test scripts/tests/*.test.mjs` 87 通过 / 1 既有跳过（新增 `dissection-contract.test.mjs` 5 项守卫：轮数与切块上限、系统提示词、工具反馈与三个错误码、进度算式与请求回调、报告来源字段与三语标签、已实现 target 闭集）；真实 CLI + 本地假 OpenAI 服务（`work/interop/dissection-cli-smoke.mjs`）跑 1 次 `submit_dissection` 交付：stdout 恰好一行 `status=completed`、退出码 0、stderr 1 条合法 `ai.generation.running`（attempt 1 / total 6）、原稿字节不变；Python `parse_persisted_dissection` 严格读回报告，用 `platform_text_bytes` 重算的 `dissection.json` / `dissection.md` 与磁盘字节完全相同，`load_task_manifest` 读回两个 `artifacts` 键与 `draft_seed_insight_id=9` / `note_title`，`recover_task_artifacts` 后两个文件仍在；单测覆盖校验失败重交、6 轮未交付、空稿与超长稿零模型调用、旧报告篡改与原稿变更后被拒止、清单写 `partial_completed`；文档治理 ERROR/WARN 0/0，`git diff --check` 通过。
- [x] 2026-11-15：把 `--retry-insights-stdin` 从 5 个 target 扩到契约里的全部 6 个——新增 `draft`（成稿）：9 个平台 id 词表与请求闭集校验、系统/种子两份提示词、`submit_draft` 接收槽与 40 轮工具循环、单次 checkout 的 `createDraftLlm`、`src/ai/workspace/`（官方 MCP SDK 的 streamable-http 客户端、随包 `SKILL.md` 渐进式披露、`write_todos` 与计划状态注入）、`draft-step.ts`（种子校验在读回快照/摘要与任何 checkout 之前、三个失败码、`ai/draft.md` 与清单同一事务、删除 `ai/original/draft.md`），并删除 `INSIGHT_TARGET_UNSUPPORTED` 临时分支；清单的 `draft_path` / `has_draft` 改为按产物映射判定。Validation: `scripts/tests/draft-golden.py`（生成器入库，常量、提示词与工具 schema 全部取自 Python 生产源码）生成 `worker-ts/tests/fixtures/draft-golden.json`：9 个 id 与显示名、18 份系统提示词、7 份种子提示词、技能清单与全文、三份工具 schema、计划提示词与提醒文案，TypeScript 输出逐字节相同；`npm --prefix worker-ts test` 262/262（新增 15 项：平台/提示词 3、agent 5、管线端到端 4、工作间 3），`npm --prefix worker-ts run typecheck` 通过，`node --test scripts/tests/*.test.mjs` 94 通过 / 1 既有跳过（新增 `draft-contract.test.mjs` 7 项守卫）；真实 CLI 冒烟（`work/interop/draft-cli-smoke.mjs`）用 Python 官方 `mcp` 包起的 streamable-http 服务端 + 本地假 OpenAI 服务跑「检索 → 交付 → 收尾」：stdout 一行 `completed`、退出码 0、3 次模型请求、1 次真实 MCP `tools/call` 往返、请求体带 4 个本地工具与 2 个检索工具且无 `max_tokens`，Python `load_task_manifest` 严格读回 `draft_path` / `has_draft` / `draft_seed_insight_id=5`，`recover_task_artifacts` 后成稿仍在、旧稿已删；单测覆盖种子无效零额度消耗、三个失败码、计划否决上限、技能与计划哨兵整段替换不累积；文档治理 ERROR/WARN 0/0，`git diff --check` 通过。
- [x] 2026-11-15：核对官方独立 yt-dlp `2026.10.26` 的发行资产与许可，并落地 `--request-stdin` 的请求解析层。Validation: 官方 `SHA2-256SUMS` 与本机实算逐字相符——Windows x64 `yt-dlp.exe`（23575744 字节、`f5389d36…d177a7d`）、macOS universal `yt-dlp_macos`（37466304 字节、`0f922c15…efe0aa`）；Windows 文件实跑 `--version` 输出 `2026.10.26`，并用它下载一条 788493 字节的公开 mp4 成功。`src/protocol/process-request.ts` 复现三键闭集、契约版本 3、模型白名单、固定失败文案与 Python `str.isspace()` 裁剪；`scripts/tests/process-request-golden.py` 生成 35 个正反例，`npm --prefix worker-ts test` 314/314、`typecheck` 0 错、`node --test scripts/tests/*.test.mjs` 113/113、文档治理 ERROR/WARN 0/0、`git diff --check` 通过。
- [x] 2026-11-15：落地 URL 下载器的确定性内核——`src/media/ytdlp.ts`（命令参数、YouTube 判定与失败分类、三平台 fallback 触发条件、ID 提取）、`src/media/subtitles.ts`（SRT/VTT 解析与 HTML5 实体解码）、`src/media/download-output.ts`（产物定位与音频复用）、`src/media/download.ts`（`download_video` 编排，策略与字幕探测由调用方注入）。Validation: 三个基准生成器 `scripts/tests/{downloader,downloader-files,download-orchestration}-golden.py` 由 Python 生产代码生成 16 组命令、24 组 YouTube 判定、19 组失败分类、8 组清洗、16 组触发判定、9 组 URL 候选、11 组 ID 提取、12 组字幕、8 组产物定位与 14 个编排场景，TypeScript 逐项相同；`npm --prefix worker-ts test` 333/333、`typecheck` 0 错、`node --test scripts/tests/*.test.mjs` 119/119（新增 `downloader-contract.test.mjs` 6 项守卫）；真实官方 `yt-dlp.exe` 进程下载一条公开 mp4（788493 字节）成功且命令形状与基准一致；`entities@6.0.0` 在随包 Deno `2.9.1` 的 `nodeModulesDir: "manual"` 布局下实测可加载；`--request-stdin` 仍未注册，静态守卫钉住该边界。
- [x] 2026-11-15：落地 URL 任务身份与清单——`src/tasks/` 新增 `UrlTaskSource`、`createUrlTaskContext`（`时间戳-平台-稳定 ID[-p分P]`、80 字符上限、建目录前验算规范 URL）、清单 URL 来源字段与严格读回分支，`src/tasks/load.ts` 不再拒止 URL 任务，URL 任务用默认 `media/video.mp4` 产物路径。Validation: `scripts/tests/url-task-golden.py` 从 Python 生产代码（`create_task_context` / `serialize_task_manifest` / `_task_source_from_manifest`）生成 5 组身份的任务 id 与完整 `task.json` 文本、20 个来源字段正反读回用例（含 `source_kind` 缺失/显式 `url`/`null`、`effective_part` 三态、token 漂移、版本与平台漂移）；`worker-ts/tests/url-task.test.mjs` 9 项逐字节/逐用例相同；把 5 份清单字节写入临时目录后由 Python `load_task_manifest` / `task_context_from_loaded_manifest` 严格读回，全部还原成 `UrlTaskSource` 且模型一致；`npm --prefix worker-ts test` 342/342、`typecheck` 0 错、`node --test scripts/tests/*.test.mjs` 124/124（新增 `url-task-contract.test.mjs` 5 项守卫）；`--request-stdin` 仍未注册。刻意保留的差异：URL 清单不写 `source_kind`，与 Python 一致；历史清单里 `"url"` / `null` 也按 URL 读回。
- [x] 2026-11-15：接通 URL 任务全链并注册 `--request-stdin`——`src/media/errors.ts` 抽出共享 `MediaPreparationError`；`src/media/url-media.ts` 复刻 `_prepare_url`（四级视频定位、流校验、视频原子提交、音频复用/归一化、字幕探测、进度事件与失败码）；`src/pipeline/url-media.ts` 复刻 `run_worker_pipeline`（来源解析 → 建任务 → 字幕或 ASR → 清单，含 `normalize_language_tag` 与规范 URL 写入文字稿）；`worker-service.ts` 增 `runProcessVideoOnce` 与 `resolveYtdlpLauncher`（契约新增 `env.ytdlpPath=APP_YTDLP_PATH`）；`cli.ts` 注册参数。Validation: `scripts/tests/url-media-golden.py` 从 Python 生产代码生成 10 个准备场景（成功/下载失败/无产物/流非法/探测失败/音频失败/音频复用/字幕/B 站 fallback/提交失败）的进度事件、错误码与产物定位，以及 13 个语言标签规范化用例，TypeScript 逐项相同；`worker-ts/tests/url-pipeline.test.mjs` 用假 yt-dlp + 真实 ffmpeg/ffprobe + 假转写器跑通全链：ASR 分支产出 `media/video.mp4`、`media/audio.wav`、`transcript.{txt,md,segments.json}` 与 `status=completed` 的清单（无 `source_kind`、`source_url` 为规范 URL、Markdown 带 `- Source URL:`），7 条进度事件顺序与阶段一致；字幕分支短路 ASR 并写两段 `segments.json`、发 `subtitle.detect.found(language=zh-Hans)`；下载失败写 `status=failed` 清单且带 `task_id`；CLI 单测覆盖 stdin 失败、模式互斥、非法请求与缺下载器。`npm --prefix worker-ts test` 350/350、`typecheck` 0 错、`node --test scripts/tests/*.test.mjs` 129/129（新增 `url-pipeline-contract.test.mjs` 5 项守卫，并把四份旧守卫从「未注册」改为「已接线」）。**刻意边界**：三平台 fallback 策略与小红书字幕探测默认不启用，抖音/B 站/小红书反爬失败下的兜底仍待迁移；macOS 实启动与随包路径接线未完成。
- [x] 2026-11-16：接通抖音 fallback 传输层——`src/download-reliability.ts` 复刻可靠下载（9 个 `DOWNLOAD_*` 码、Content-Range/Content-Type/大小校验、`.part` 原子改名、停滞与提前结束保留部分文件）；`src/sources/douyin/{types,source,page,streams,transport,fallback,index}.ts` 复刻 AWEME ID 解析、分享页 SSR 解析、bit_rate/探测候选、按大小去重排序、有序下载续传重试、8 MB 档位进度与 3 次分享页重试；`FetchDouyinHttpClient` 用 fetch 跟随重定向、按主机记忆 Cookie、Range 续传与 60s 无进展看门狗；`createFallbackStrategies` 改为接受部分实现，`src/media/platform-strategies.ts` 只注册抖音并成为 URL 管线的默认策略。Validation: `scripts/tests/{download-reliability,douyin}-golden.py` 由 Python 生产代码生成 7 个响应、9 个流式场景与 13 个 ID、5 个播放地址、8 个分享页、5 组候选、选择/进度/重试事件、5 个有序下载、6 个完整下载场景，TypeScript 逐项相同；`worker-ts/tests/douyin-transport.test.mjs` 用本机 HTTP 服务验证 Cookie 透传、`bytes=4-` 续传与停滞保留 `.part`，不触公网；`npm --prefix worker-ts test` 366/366、`typecheck` 0 错、`node --test scripts/tests/*.test.mjs` 136/136（新增 `douyin-contract.test.mjs` 7 项守卫）。**当时仍缺**：小红书（含字幕探测）与 B 站传输层、真实公网冒烟、macOS 实启动与三平台打包。
- [x] 2026-11-16：接通 B 站 fallback 传输层——`src/sources/bilibili/` 复刻 `worker_core/bilibili*`：BV/av 与 `b23.tv` 短链解析（最多 5 层、http 失败换 https）、`view`/`playurl` 解析与登录/DRM 判定、DASH 音视频轨按「编码偏好 → 带宽 → 像素 → 画质 id → 备用地址数」选择、分片主备地址下载、`ffmpeg -c copy` 合并与临时文件清理、五条进度事件；`FetchBilibiliHttpClient` 支持 gzip/br/deflate 解码、4 MiB 正文上限、Range 续传与「服务端忽略 Range 时重下」回退。`createPlatformFallbackStrategies` 注册 B 站，合并复用主路径 runner（`FallbackDownloadContext.runner`）。Validation: `scripts/tests/bilibili-golden.py` 由 Python 生产代码生成 18 个输入解析、4 个 URL、13 个 view、8 个 DASH 选择、3 个 playurl、8 个解码、2 个分片下载、3 个合并与 7 个完整下载场景，TypeScript 逐项相同；`worker-ts/tests/bilibili-transport.test.mjs` 用本机 HTTP 服务验证正文上限、Range 续传与忽略 Range 的回退，不触公网；`npm --prefix worker-ts test` 378/378、`typecheck` 0 错、`node --test scripts/tests/*.test.mjs` 144/144（新增 `bilibili-contract.test.mjs` 8 项守卫）。**仍缺**：小红书传输层与字幕探测、抖音/B 站真实公网冒烟、macOS 实启动与三平台打包。
- [x] 2026-11-16：接通小红书 fallback 传输层与字幕探测——`src/sources/xiaohongshu/` 复刻 `worker_core/xiaohongshu*`：24 位笔记 ID、`explore`/`discovery/item` 路径、`xhslink.com`/`xhslink.cn` 短链（最多 5 层、http 失败换 https、页面内嵌链接兜底）、公开笔记页 `__INITIAL_STATE__` 括号配对与 `undefined`/`void 0`/末尾逗号改写、候选流九元组打分与同画质去重、字幕按「source → zh-Hans → … → ko」优先序选择、主备地址有序下载与候选重试进度事件；`FetchXiaohongshuHttpClient` 记忆 Cookie、Range 续传与「服务端忽略 Range 时重下」回退。`createPlatformFallbackStrategies` 注册小红书，`pipeline/url-media.ts` 的 `probeXiaohongshuSubtitle` 默认接真实实现。Validation: `scripts/tests/xiaohongshu-golden.py` 由 Python 生产代码生成 22 个输入解析（含外站跳转与 ftp 拒绝）、3 个 explore URL、8 个页面状态、9 个解码、16 个初始状态与 JS 改写、8 组候选流、13 个字幕语言、9 个字幕选择、8 个完整下载与 4 个字幕探测场景，TypeScript 逐项相同；`worker-ts/tests/xiaohongshu-transport.test.mjs` 用本机 HTTP 服务验证 Cookie 透传、`bytes=4-` 续传、忽略 Range 的重下、字幕主机白名单与停滞保留 `.part`，不触公网；`npm --prefix worker-ts test` 399/399、`typecheck` 0 错、`node --test scripts/tests/*.test.mjs` 150/150（新增 `xiaohongshu-contract.test.mjs` 6 项守卫，三份旧守卫改为「三平台全部接通」）。
- [x] 2026-11-16：三平台真实公网冒烟——`work/interop/platform-download-smoke.mjs` 与 `work/interop/py_platform_download_smoke.py` 用同一组地址、同一入口跑两侧生产代码（平台 fallback、yt-dlp 主路径、`prepareUrlMedia` / `MediaPreparationFacade` 整链准备），9 个用例按 JSONL 逐项对照。Validation: B 站 fallback 两侧产物逐字节相同（10373366 字节），整链准备视频 21498132、音频 6793976 字节也相同；抖音分享页两侧均 6281768 字节，失败时同为 `DOUYIN_ROUTER_DATA_MISSING`，整链 yt-dlp 主路径各连跑三次两侧全部成功；带分享令牌的小红书三条两侧均成功且产物逐字节相同（25496066 / 21917437 / 31465321 字节），不带 `xsec_token` 的链接两侧同为 `XHS_NOTE_NOT_FOUND`，yt-dlp 也是同一句 `XHS_NOTE_NOT_FOUND: Media download command failed.`；调用次序两侧都是先跑 yt-dlp 再进平台 fallback（桩策略探针记录）；发现并修复 B 站与小红书的 `Content-Encoding` 二次解压缺陷——`fetch` 已解压正文却保留响应头，`decodeResponseBody` 再解一次导致 `BILIBILI_VIDEO_INFO_UNAVAILABLE`，新增 `dropContentEncoding` 并补两条真实 `fetch` 回归用例（去掉修法两条都失败），依据 Node 22.22.2 与 Deno 2.9.1 实测；`npm --prefix worker-ts test` 401/401、`typecheck` 0 错。**剩余**：登录受限内容的失败语义（不支持登录态下载）、限流、并发与取消；macOS 实启动与三平台打包；宿主切换。
- [x] 2026-11-16：发行包运行时组装与宿主解析——`scripts/build-worker-ts.mjs` 把 `worker-ts/` 组装成 `resources/worker-ts/`（`src` + `skills` + `deno.json` + `package.json` + 裁剪后的 `node_modules`），`scripts/build-installer.mjs` 在随包 Deno 就绪后调用它并立刻用该 Deno 跑一次 `--resolve-source-stdin` 与协议结果逐字比较；`tauri.conf.json` 增加 `resources/worker-ts/**/*`。裁剪规则：`devDependencies` 与 `@types` 不进包、`onnxruntime-node` 只留目标平台目录、Windows 再删 DirectML/dxcompiler/dxil。Rust 侧新增 `runtime::worker_launch`：Deno、`src/cli.ts`、`deno.json`、`node_modules` 四件资产齐全时用 `deno run --config … --allow-read --allow-write --allow-ffi --allow-run --allow-net --allow-env <entry>`，否则回落 Python；已切换到 Deno 的入口是任务四模式、网页保存、模型下载、存储校验探针与 BYOK 探针。Validation: 组装后 **46.8 MB**（未裁剪 336 MB），组装+冒烟 11 秒；同一份组装产物在 Windows x64 跑通整条本地媒体管线（ffmpeg 归一化 + 真实 ONNX 推理，以 `ASR_EMPTY_TRANSCRIPT` 正常收敛）；权限逐项实测——无 `--allow-env` → `TASK_STORAGE_UNAVAILABLE`、无 `--allow-ffi` → `ASR_DEPENDENCY_MISSING`、无 `--allow-run` → `LOCAL_MEDIA_VALIDATION_FAILED`；`node --test scripts/tests/*.test.mjs` 163/163（新增 `worker-ts-runtime.test.mjs` 13 项）。**发现**：`onnxruntime-node@1.29.0` 不提供 `darwin/x64`（上游包内清单核对），macOS Intel 无法加载 ONNX，组装脚本对 `macos-x64` 构建期失败。**剩余**：`--download-runtime-component` 与 `web_page/session.rs` 的运行时指纹仍在 Python；macOS 实启动与取消、三平台打包体积与许可随附。
- [x] 2026-11-16：**随包下载器与宿主注入**——`scripts/build-installer.mjs` 按固定版本 `2026.10.26` 下载 `yt-dlp.exe` / `yt-dlp_macos`，校验固定 SHA-256 后落到 `resources/bin/`；`runtime::worker_runtime_bootstrap_env` 在随包资产存在时向 Deno worker 注入 `APP_YTDLP_PATH`，开发环境保留外部变量。Validation: 真实 23575744 字节 Windows 资产通过 `copyYtdlpAsset` 校验并输出 `2026.10.26`；`cargo test` 的 2 项 bootstrap 用例与 19 项 command 用例通过；组装后的运行时用宿主同形命令行跑通 B 站 `--request-stdin`，`status=completed`、视频 21498132 字节；`node --test scripts/tests/build-installer.test.mjs` 20/20、`worker-ts-runtime.test.mjs` 15/15。完整安装包构建归入「打包验收」。
- [x] 2026-11-16：停止支持 macOS Intel——发布工作流删除 Intel 作业与 `build_macos_x64` 输入，macOS 验收工作流收窄为 Apple Silicon 并改名 `macos-acceptance.yml`，`build-installer` / `build-worker-ts` / `build-system-webview-host` / `make-macos-dmg.sh` 的 target 闭集只保留 `windows-x64` 与 `macos-arm64`，Rust 的 `macos-x64` 资源标识删除、非受支持平台在编译期失败，Intel 验收设计文档删除。Validation: `node --test scripts/tests/*.test.mjs` 171/171；`app/tests/tauri-window-config.test.ts` 30/30；文档治理 ERROR/WARN 0/0。
- [ ] **macOS 实启动与原生依赖**：核验随包 Deno 在 Rust 监督进程下的启动、取消与进程树；核验 `onnxruntime-node` 的 macOS arm64 原生二进制、`--allow-ffi` 与 ASR golden。
- [ ] **打包验收**：核验 Windows x64 与 macOS Apple Silicon 的原生依赖、官方下载器启动/取消、工作间依赖、安装包体积与第三方许可随附（Deno、onnxruntime、MCP SDK、entities、yaml，yt-dlp GPLv3+ 单列）。
- [ ] **移除最后两处 Python 入口**：`--download-runtime-component` 与 `web_page/session.rs` 的 native session 运行时指纹；迁走后从发行包删除 Python。
- [ ] **运行边界与完整验收**：限流、并发与取消；登录受限内容按不支持登录态下载处理，确认返回稳定失败码与提示；小红书分享令牌过期/缺失；工作间真实 checkout/BYOK 计费边界与 MCP 取消；为 macOS 生成并评审 golden，把门禁接入 CI。

## Surprises & Discoveries

- Evidence: **生产 ONNX 图的输入输出与运行时要求。** `onnxruntime 1.28.0` 与 `onnxruntime-node@1.31.1`
  均能加载生产 `model_quant.onnx`：输入 `speech` [B,T,560]、`speech_lengths`、`language`、
  `textnorm`，输出 `ctc_logits` [B,T,25055]、`encoder_out_lens`，`custom_metadata_map` 仅
  `onnx.infer=onnxruntime.quant`；生产 FSMN VAD ONNX 为有状态图，含 `in_cache0..3` /
  `out_cache0..3`。证据 `work/asr-spike/results/production-ort-node.json`。这些字段决定 TypeScript 侧
  前端、CTC 解码与分段状态机的实现范围。
- Evidence: 生产 `model_quant.onnx` 的 SHA-256 为 `21dc965f689a78d1604717bf561e40d5a236087c85a95584567835750549e822`，与 `worker/worker_core/model_download.py` 的 `ONNX_REQUIRED_ASSET_HASHES` 一致；`<根>/models/onnx/` 的就绪标记与六项哈希校验可直接沿用。
- Evidence: **运行时版本决定识别结果。** 同一份前端特征与同一份 `model_quant.onnx`，ONNX Runtime 版本变化时，低置信帧（该样本第 22 帧，两个候选 token 的 logits 相差约 0.11）的 argmax 会翻转，最终文本相差一个汉字；固定 `onnxruntime-node@1.29.0` 后与 Python `onnxruntime 1.28.0` 逐帧一致。`work/asr-spike/results/asr-node-decode.json`。依赖锁须包含精确版本，受支持平台的打包校验须比对运行时版本。
- Evidence: **生产前端的 dither 不可逐项复现。** `WavFrontend` 的 `dither` 为 1.0，`kaldi-native-fbank` 的 `RandomState` 以当前时间初始化种子，同一段音频两次 Fbank 最大相差 5.43。数值验收在 `dither=0` 的确定性配置下进行，生产配置按多次运行的识别文本集合验收。`work/asr-spike/results/frontend-ts-compare.json`。
- Evidence: **FSMN VAD 是有状态图，分段由配置与状态机共同决定。** 生产 `Fsmn_vad_online` 每 10 秒块输入 `speech` [1,T,400] 与 `in_cache0..3` [1,128,19,1]，输出 `logits` [1,T,248] 与 `out_cache0..3`；`config.yaml` 的 `model_conf` 与 `WavFrontendOnline` 的 `dither=0.0`、LFR 5/1 决定 `E2EVadModel` 的窗口检测、最大段长 20000 ms 与跨块事件配对。事件流是「块 → batch → 事件列表」三层，`-1` 为未闭合端点，`_decode_onnx_vad_events` 要求 batch 长度为 1。2026-11-14 Node 侧移植后，`logits` 与缓存误差为 0、分段与事件流逐项一致；块 0 的 `out_cache0` 幅值 6.47 成为块 1 的 `in_cache0`，不是平凡零状态。`work/asr-spike/results/vad-ts-compare.json`。VAD 前端的跨块缓存与 ASR 前端参数不同，不能复用同一次前端验证的结论；同日已单独移植 `WavFrontendOnline` 并逐块比对：waveform 边界逐值一致、`feats` 最大绝对误差 `5.09e-5` 至 `1.66e-4`，`is_final` 尾帧补齐由各用例最后一块覆盖。
- Evidence: `work/asr-spike/arbiter.py` 使用待测候选生成仲裁文本，`final-metrics.json` 和 `final-metrics-preroll.json` 因此产生不同基线 CER。正式比较需要在运行候选前冻结独立参考文本。
- Evidence: `app/src-tauri/src/data_storage_validation.rs` 的旧迁移基线记录模型标识、PyTorch 组件和指纹；模型设置迁移、进行中的位置迁移与历史资产需要单独覆盖。
- Evidence: **端到端文本差异来自前端 FFT，不是运行时。** 同一份 Python `feats` 在 `onnxruntime-node@1.29.0`
  下与 Python `onnxruntime 1.28.0` 的 `ctc_logits` 最大绝对误差为 0、105 个 token 完全一致；
  改用 TypeScript 前端算出的 `feats`（最大误差 `2.8e-5`）后 `logits` 差 2.3、第 33 个 token 起
  不同，`pharma-90s` 544 字中 9 字不同。`Math.fround` 模拟 float32 后误差为 `4.58e-5`，没有改善，
  说明差异来自 kiss_fftr 的 radix-4 分解与标准 radix-2 FFT 的运算顺序，而非 float32 舍入路径。
  端到端结构（VAD 分段、切片样本数、每块 ≤20.5 秒、时间单调、音频边界）全部一致。
  `work/asr-spike/results/transcriber-ts-compare.json`、`results/asr-segment-diag.json`。
- Evidence: **独立参考的噪声远大于待测差异。** 用架构独立的 Paraformer 做参考时，Python 生产引擎与
  参考互比 CER 就有 `23.64%`（`mixed-a16z` 中英混合为 `48.89%`，超出其中文词表能力），而 TypeScript
  与 Python 的增量为 `−0.159pp`。因此增量判定不能只看聚合 CER：`mixed-a16z` 的 `0.00pp` 不含判别力，
  须辅以人工校对真值（`conversation-street` 两侧均 `1.92%`、编辑距离 11:11）、逐段一致率（146 段中
  99 段相同）和差异构成（多字 23、漏字 23、替换 29，双向对称）。
  `work/asr-spike/results/cer-reference-compare.json`、`results/cer-truth-compare.json`。
- Evidence: **`deno compile` 单文件会静默加载系统旧版 ONNX Runtime。** 编译产物 357 MB；运行时内嵌的
  `onnxruntime_binding.node` 无法定位同目录的 `onnxruntime.dll`，Windows 加载器回退到
  `C:\Windows\system32\onnxruntime.dll`（1.17.1，API 上限 17），报
  `The requested API version [29] is not available`。同一份代码用「随包 deno.exe + 外置
  `node_modules`」则数值与文本与 Node 完全一致。因此打包必须外置原生库，并在冒烟里断言真实推理
  成功、校验 DLL 哈希，避免用户机器上悄悄用系统旧版。`work/asr-spike/results/deno-runtime-matrix.json`。
- Evidence: **Deno 运行期权限面。** 加载 `.node` 必须有 `--allow-ffi`，`--allow-env` 与
  `--allow-sys` 都不需要，FFI 可收窄到 `node_modules` 目录；`node_modules` 解析用 `deno.json` 的
  `{"nodeModulesDir": "manual"}` 即可自动生效。裁剪非本平台 `bin` 与 `DirectML.dll`、`dxcompiler.dll`、
  `dxil.dll` 后 `node_modules` 从 296 MB 降到 27.6 MB，8 条端到端文本仍不变；`deno eval` 与
  `node -e` 冷启动中位数 51.5 ms 与 52.3 ms。
- Evidence: **分项数值全部通过，端到端却是空的。** `E2EVadModel` 移植漏了 `noiseAverageDecibel`
  初始化，`snr` 比较恒为 `NaN`，所有帧被判成静音、分段恒为空；而同批检查里 VAD `feats` 误差
  `2.3e-5`、`logits` 与缓存误差 `0`、状态机逻辑逐行对应。只有端到端分段断言能暴露这类「每步都对、
  合起来不工作」的缺陷，这是把探针固化成门禁的直接收益。
- Evidence: **分段相等不是所有音频都成立。** 同一实现与生产 Python 相比，`conversation-street`、
  `interview-finance` 的窗口分段逐毫秒一致，但 `music-song` 与 `discussion-tech` 的若干窗口相差
  10~120 ms，甚至多出一个 530 ms 短段。根因是前端 `1e-4` 量级浮点差异落在临界帧上，两侧的窗口
  累计值在阈值两侧各差一帧。因此 fixture 必须按「边界稳健」筛选，不能按「音频类型有代表性」筛选；
  跨平台时间戳的 10 ms 级漂移应作为残余风险记录，而不是靠改代码消除。

- Evidence: **重写成 TypeScript 后 `do_extend: 1` 被当成布尔缺失。** 生产 VAD `config.yaml` 用数字表示
  开关，只认 `boolean` 的读法让 `do_extend` 变成 `undefined`，端点延展失效：`dialogue-32s` 的分段
  从 `[[0,1600],[1970,4550],[5150,25160],[25160,31980]]` 变成 `[[0,1490],[2170,4440],[5350,25360],
  [25360,31980]]`，相对生产基线 CER 升到 `1.399%`。同一份代码在改回数字识别后立刻回到 `0.000%`。
  这是门禁第二次先于逐项数值比对发现问题。
- Evidence: **ModelScope 公开文件端点能搬运生产资产，完整性只能靠固定哈希。**
  `GET https://www.modelscope.cn/api/v1/models/<id>/repo?Revision=master&FilePath=<file>` 对小文件
  直出 200，对大文件 302 到 `cdn-lfs-cn-1.modelscope.cn/...?auth_key=<带过期时间>`；CDN 路径本身
  内含对象 SHA-256（`/prod/lfs-objects/21/dc/965f68…9822`），但那是内部命名，不能当校验依据。
  `Content-Length` 与 `Accept-Ranges: bytes` 都在（`Range` 返回 206 并带 `Content-Range`），续传
  可用；`auth_key` 会过期，因此重试必须重新请求 API 端点，不能复用 302 之后的地址。9 个文件共
  242474788 字节（`model_quant.onnx` 占 241216270），本机 13 秒下完，逐文件哈希与
  `ONNX_REQUIRED_ASSET_HASHES` 全部相符。BPE 文件仍取自 `iic/SenseVoiceSmall`（ONNX 仓库不含），
  与 Python `_place_onnx_bpe_asset` 的取法一致。端点返回的是可变 `master` 分支，上游重打标签时
  哈希会失败——这是有意为之：宁可拒绝，也不要拿一份没人验证过的权重去转写用户音频。
- Evidence: **Windows 上「目录联接」在 Node 里就是符号链接。** `fs.lstat` 对 junction 返回
  `isSymbolicLink() === true`、`mode & 0o170000 === 0o120000`，因此产物写入可以用同一条
  `isSymbolicLink()` 拒止符号链接与目录联接，不需要 Python 那种 `st_file_attributes` 重解析位。
  顺带解决测试问题：`fs.symlink(target, path, 'junction')` 不需要开发者模式，Windows CI 上也能覆盖
  链接拒止；普通文件符号链接仍要开发者模式，POSIX 上才有等价覆盖。
- Evidence: **journal 是跨语言可互读的事实，不是某一份实现的私有格式。** 注入崩溃留下
  `state=prepared` 的 journal 后，TypeScript 写的 journal 由 Python `recover_task_artifacts` 恢复为
  `rolled_back` 并还原旧内容，反向亦然；两份实现写出的 JSON 缩进与字段顺序不同也不影响，因为解析按
  字段校验而不是按字节比对。这也意味着字段、状态、内部文件名任何一处放宽，都会让另一份实现把不可信
  状态当成已提交——所以契约里的正反例被直接当成单测输入。

- Evidence: **宿主能区分「没跑起来」与「跑了但失败」，靠的是退出码而不是解析结果。** Python 版把
  「stdin 非法」和「用法错误」都做成进程行为：前者输出 `WORKER_STDIN_INVALID` 结果并退出 1，后者由
  argparse 退出 2 且不产生结果行。TypeScript 侧只迁移了参数模式，因此未注册的模式一律走 2 —— 宿主
  传错模式时会立刻收到「worker 不会做这件事」，而不是拿到一个看起来成功的空结果。
- Evidence: **缓存就绪时模型下载模式不发任何进度事件。** 第二次执行 `--download-asr-model` 时
  stderr 为 0 行、stdout 一行 `completed`；这与 Python 的提前返回一致，但也意味着宿主的进度空闲超时
  不能假设「下载模式一定会先收到 preparing 事件」——结果行本身是唯一的完成信号。

- Evidence: **流的判定只看目标流存在与否，不管多余流。** 把带音频的视频按「音频」提交会被正常接受并
  只需抽出音轨；把音频按「视频」提交才触发 `LOCAL_MEDIA_KIND_MISMATCH`。也就是说 worker 侧不做
  「扩展名与内容是否一致」的二次判断——那层在宿主选文件时。迁移时若在 TypeScript 侧「顺手加严」，
  会让原本能处理的文件在升级后失败。
- Evidence: **归一化后的产物必须再探测一次。** `ffmpeg` 退出码为 0 不代表参数真的生效：容器/编码器
  组合可能悄悄保留原采样率或声道。`stagedFile` 的 validator 走同一套 `isNormalizedPcmWav`（`pcm_s16le`
  + `s16` + 16000 + 1 声道），不满足就按 `AUDIO_NORMALIZATION_FAILED` 失败，而不是把可疑音频送进 ASR。

- Evidence: **清单是两代 worker 的共同状态，不是某一代的私有格式。** TypeScript 写出的 `task.json`
  被 Python 的 `load_task_manifest` 一路严格校验收下（`schema_version`、来源字段、`artifacts` 闭集、
  `source_privacy_migration_version`），`TaskStoreFacade.open` 还能从中还原 `LocalFileTaskSource` 与
  产物路径；反向由 Python 写的清单被 TypeScript 读回 `note_title` 与 `draft_seed_insight_id`。
  两份实现的字段顺序与取值逐项相同——顺序本身不影响解析，但它说明两边都是从同一份字段表生成的，
  而不是各自照着测试凑出来的。
- Evidence: **媒体任务的失败也要留下清单。** 媒体准备失败、模型未下载、识别失败三种情况都会写出
  `status=failed` 的 `task.json` 并带上 `error{code,message,stage}`，只有「连任务目录都建不出来」才
  返回不带 `task_id` 的结果。这样界面上的失败卡片与任务历史都靠同一个文件，不需要另一套记录。

- Evidence: **AI 生成不需要移植 `agent_runtime`。** 三个 agent 实际只用到四样能力：多轮对话、
  function 工具调用、工具返回 `None` 即交付完成、轮与轮之间替换工具集（先交导图再交摘要）。
  `worker-ts/src/ai/tool-loop.ts` 用约 150 行实现这四样，10 项测试覆盖交付即停、换工具、
  纯文本回复被催促、未知工具名、参数不是 JSON、一条回复里多个工具调用、空回复重试一次、
  轮数上限、非法轮数拒止。SDK 的图片上下文、工具结果溢出文件、模型回退这些未被使用的特性不移植。
- Evidence: **请求形状以抓包为准，不以文档为准。** Python 侧真正发出的是
  `{"model", "stream": false, "messages", "tool_choice": "auto", "tools", "max_tokens"}`，
  抓包后才看得出 `stream` 显式写 false、没有 `temperature`、`tool_choice` 只在有工具时出现。
  这份抓包已固化成 golden fixture，TypeScript 侧一旦有人「顺手加个参数」测试就会失败。
- Evidence: **提示词的差异看得见但读不出来。** 两侧渲染同一份文字稿，3 语言 × 2 来源的提示词
  逐字节相同；这不是「差不多」的问题——`Organize the transcript (86 characters)` 里的字数，
  Python 用 `len()` 数码点，JS 用 `.length` 会数成 UTF-16 单元，含 emoji 的文字稿会差 1。
  同理，`\`mindmap\`` 的反引号、示例的三级缩进、末尾那一个换行，都只能靠渲染结果比对。
- Evidence: **分块的字节偏移是下游的锚点。** 三档 `max_length` 下块的 `content`、`summary`、
  `start_byte`/`end_byte` 与 `sha256` 全部与 Python 相同，包括「标题行被切开时该块归属上一节」这种
  边界情形。洞察与解剖用 `source_chunk_id` 指回原文，偏移差一个字节就会指到别的段落。
- Evidence: **重新打开任务比新建任务严格得多。** Python 的 `load_task_manifest` 要过五层：任务 id 必须是单层目录名、任务目录与清单不能是链接且清单 `nlink=1`、realpath 必须仍在 `<output>/tasks` 内、先恢复残留事务、再校验 `schema_version`/来源/标题/产物闭集。TypeScript 侧逐层补齐后才敢把清单当可信状态；写的时候「字段差不多」不会立刻出错，读的时候放宽会让任意一份被改过的文件变成「可信任务」。
- Evidence: **摘要与清单必须一次提交。** Python 的 `finalize(artifact_payloads=...)` 把 `ai/summary.md`、`ai/mindmap.mmd` 与 `task.json` 放进同一个 journal：只写文件不写清单，界面仍显示旧版；只写清单不写文件，清单会指向不存在或旧的内容。TypeScript 新增 `finalizeTaskWithPayloads` 走同一事务，并先按闭集把 payload 路径补进 `artifacts` 再序列化清单。
- Evidence: **修掉一个尚未被用户触发的清单漂移。** `tasks/manifest.ts` 原先写 `draft → ai/original/draft.md`，但契约 `artifactKeysByDestination`、Python `paths.draft_path` 与事务闭集都写 `ai/draft.md`（`ai/original/` 是非产物目标）。旧实现对空 `artifacts` 无影响，一旦草稿产物出现就会把合法清单判成非法。现在固定路径表直接由事务闭集取反表生成，两处不可能再各自漂移。
- Evidence: **契约里的 `aiGeneration.request` 比实际请求窄。** 契约只声明 4 个字段，Python 的 `RETRY_REQUEST_FIELDS` 有 7 个（草稿的 `insight_id` / `platform` 也在内）。静态守卫因此同时比两份：字段集合与 Python 逐项相同，契约的 4 个字段必须是子集，target 闭集与三语闭集各自与契约相同。
- Evidence: **偏好快照有三份形状，任一份漂移都会换一批灵感。** 请求里的字段闭集（Python
  `parse_preference_snapshot`）、提示词里的紧凑 JSON（`ensure_ascii=False, separators=(",", ":")`）、
  落盘文件（`indent=2` + 末尾换行）必须同时对齐：字段顺序一变，整段提示词就变，同一模型可能给出
  不同的结果；落盘文件排版一变，前端与 Python 读回的选项也会变。22 个正反例由 Python 直接判定生成，
  比自己按契约写断言更可靠。
- Evidence: **`sourceChunkId` 是「来源标注」唯一的锚点。** 交付 schema 里的 enum 由本次
  `MarkdownSplitter` 切出的真实块 id 动态生成；块边界差一个字节（或按 UTF-16 单元计长）就会让模型
  引用一个不存在的片段。校验不通过时工具返回错误文本让模型重交，而不是把没有来源的清单落盘。
- Evidence: **草稿种子的三态由「是否真的换了洞察」决定。** `insights` 成功会重新编号，旧的
  `draft_seed_insight_id` 必须清空；生成失败时洞察没变，必须沿用旧值；`summary` 则一律沿用。
  这与之前 `draftSeedInsightId` 的 `??` 陷阱是同一个三态问题，只是换到了调用侧。

- Evidence: **官方独立 yt-dlp 的 macOS 资产是 universal 单文件，且可执行文件的许可与源码不同。**
  `2026.10.26` 的 release 文件表列出 Win10+ x64 `yt-dlp.exe`、macOS 10.15+ `yt-dlp_macos`、
  zipimport 版 `yt-dlp` 与源码 tarball；macOS 没有分别提供 x64 与 arm64 文件。
  `SHA2-256SUMS` 与 `SHA2-512SUMS` 覆盖 19 个发行文件并提供 GPG 签名。yt-dlp 源码为
  Unlicense，但 PyInstaller 打包的可执行文件含 GPLv3+ 代码，组合作品按 GPLv3+ 分发；
  zipimport 版与源码包只含 Unlicense / ISC / MIT 代码。证据
  `work/ytdlp/{SHA2-256SUMS,release.json}` 与官方 release files 说明。

## Decision Log

- Decision: worker 重写范围只包含当前 ONNX 模型，ASR 通过可替换接口接入；其他模型留待后续决定。Rationale: 用户确定本次交付范围。Date/Author: 2026-11-13 / User。
- Decision: 验收全程自动化，允许官方独立 yt-dlp 程序内置 Python 作为唯一第三方例外。Rationale: 用户确认验收和发行边界。Date/Author: 2026-11-13 / User。
- Decision: 使用候选输出之外独立生成并固定的参考文本。Rationale: 自动识别参考只能作为质量代理指标，现有仲裁文本依赖候选输出。Date/Author: 2026-11-13 / Codex。
- Decision: ASR 采用 `onnxruntime-node` 直接加载生产 `iic/SenseVoiceSmall-onnx` 模型文件，沿用 `<根>/models/onnx/` 缓存、就绪标记、哈希校验与模型标识；TypeScript 侧实现前端、CTC 解码、文本清理与 FSMN VAD 状态机。Rationale: 权重、分段与解码规则与生产基线一致，现有缓存可直接读取，升级无需重新下载模型。Date/Author: 2026-11-14 / User。
- Decision: `onnxruntime-node` 固定为 `1.29.0`，纳入依赖锁与三平台打包校验。Rationale: 与生产基线 Python `onnxruntime 1.28.0` 的推理数值行为一致，逐帧 argmax、CTC token 序列与识别文本相同。Date/Author: 2026-11-14 / Codex。
- Decision: FSMN VAD 按生产 `Fsmn_vad_online` 的 10 秒分块有状态路径实现，逐块移植 `E2EVadModel`、事件合法性校验与跨块配对；VAD 前端使用 `dither=0.0`、LFR 5/1、400 维，与 ASR 前端的 7/6、560 维分开实现。Rationale: 分段时间戳决定文字稿可定位性；实测证明缓存传递与状态机可在 `onnxruntime-node@1.29.0` 下逐值复现，前端跨块缓存另列验证项。Date/Author: 2026-11-14 / Codex。
- Decision: 不移植 kiss_fft 追求与 Python 逐位一致；TypeScript 端到端文本允许前端浮点级差异，质量按 CER 门槛与候选无关的独立参考文本验收，运行时要单独用同一份 `feats` 证明 `logits` 一致。Rationale: 同一 `feats` 下运行时误差为 0，差异全部来自 FFT 算法；`Math.fround` 实验无改善，精确移植 kiss_fftr 的 radix-4 分解与 twiddle 表成本高且超出本次单一模型范围。实测依据（2026-11-14）：8 条窗口相对 Paraformer 参考的增量 `−0.159pp`、人工校对真值两侧同分 `1.92%`、差异字符多字与漏字对称。Date/Author: 2026-11-14 / Codex。
- Decision: worker 运行期采用随包 `deno.exe`（锁定 `2.9.1`）+ 外置 `node_modules` 布局，不使用 `deno compile` 单文件，也不改为随包 Node；启动参数为 `--allow-read --allow-write --allow-ffi`，`node_modules` 解析由 `deno.json` 的 `nodeModulesDir: "manual"` 提供。Rationale: Deno 2.9.1 加载 `onnxruntime-node@1.29.0` 的 napi-v6 binding 正常，零张量数值与 8 条端到端文本与 Node 逐值/逐字一致，冷启动无差异，且 `deno.exe` 本就在安装包内（无新增运行时体积）；单文件编译会回退到 `C:\Windows\system32\onnxruntime.dll` 1.17.1 并失败。Date/Author: 2026-11-14 / Codex。
- Decision: 打包时删除 `onnxruntime-node/bin/napi-v6` 下非目标平台目录，以及 Windows 侧 CPU 路径不需要的 `DirectML.dll`、`dxcompiler.dll`、`dxil.dll`，只保留 `onnxruntime.dll` 与 `onnxruntime_binding.node`。Rationale: `node_modules` 从 296 MB 降到 27.6 MB，裁剪后零张量数值与 8 条端到端文本完全不变；原生库必须与 `.node` 同目录，冒烟须断言真实推理成功并校验 DLL 哈希，防止回退到系统旧版。Date/Author: 2026-11-14 / Codex。
- Decision: ASR 门禁落在 `scripts/asr-verification/`，判定分三层且不可互相替代——资产 SHA-256、分段与生产基线逐毫秒相同、文本既与本机 golden 逐字相同又相对生产基线 CER ≤ `0.005`。fixture 按「两侧分段完全一致」筛选，golden 按 `process.platform-arch` 分目录，缺失时明确失败而不回退其他平台。Rationale: 只留 golden 会把生产差异固化成「正确」，只留 CER 会放过逐字退化；分段相等在临界帧上并不跨实现成立，因此需要按窗口筛选而不是放宽断言。Date/Author: 2026-11-14 / Codex。
- Decision: ASR 实现只存在于生产包 `worker-ts/src/asr/`，门禁导入该实现而不自带副本；依赖也只由 `worker-ts` 提供，门禁不再安装第二份 `onnxruntime-node`。公共面收在 `src/asr/index.ts`（`createTranscriber`、`Transcriber`、`Transcript`、`ASRError`），`onnxruntime-node` 只允许在 `sensevoice.ts` 中出现，由静态测试守卫。Rationale: 「实验实现 + 生产实现」两份代码必然分叉，且门禁验证的必须是真正要发货的代码；单一依赖避免两份原生库。Date/Author: 2026-11-14 / Codex。
- Decision: 模型准备不移植 `modelscope` SDK，改为直接请求 ModelScope 公开文件端点，完整性只依赖 `model-assets.ts` 的逐文件 SHA-256，不接受自定义 URL、镜像或修订。Rationale: SDK 是 Python 依赖，发行包已不带 Python；固定哈希把「来源是否正确」变成可判定事实，端点只负责搬运；Python 对 ONNX 分支同样拒止自定义来源。Date/Author: 2026-11-14 / Codex。
- Decision: 产物写入沿用现有 journal 协议、闭集目的地与提交顺序，不引入新的存储格式或双写；文字稿产物按目标目录决定走多文件事务（任务内 `transcript/`）还是逐文件原子写（导出、诊断）。Rationale: 三份实现互读同一个 journal，改协议会让正在运行的其它实现把不可信状态当成已提交；任务外的目录不承担事务开销，也没有「同一版产物」的语义。Date/Author: 2026-11-14 / Codex。
- Decision: 协议入口只注册已实现的模式（当前仅 `--download-asr-model`），未迁移的模式不注册参数、以用法错误退出码 2 失败，不发明「模式暂不可用」类错误码。Rationale: 宿主按退出码与结果行分流，静默成功或新造码都会让 Rust 侧的分类逻辑分叉；模式上线时再加参数，接口面始终等于能力面。Date/Author: 2026-11-14 / Codex。
- Decision: 媒体准备只做「探测 + 归一化 + 受限复制」，ffmpeg 参数逐字沿用生产，产物一律走 staging + 探测校验 + 原子替换，不引入转码预设或额外优化。Rationale: 参数变化会改变 ASR 前端拿到的样本并改变识别文本；归一化后再探测是唯一能证明「产物真是 16 kHz 单声道」的检查；原子替换保证用户目录里不会出现半份 media 文件。Date/Author: 2026-11-14 / Codex。
- Decision: 任务存储与本地管线按 Python 的布局与清单字段逐项复刻（`<output>/tasks/<id>`、`schema_version=3`、`source_privacy_migration_version=2`、`artifacts` 闭集），不引入新字段也不改目录结构；管线只在「模型缓存判定」与「转写器构造」两处留注入点。Rationale: 清单与目录是宿主、Python、Rust 三方共读的状态，任何一处「顺手加个字段」都会让另一份实现拒止整个任务；注入点用于单测在不下载 460 MB 模型的前提下跑通全部分支。Date/Author: 2026-11-14 / Codex。
- Decision: AI 生成不引入 TypeScript 的 agent 框架，自己实现最小工具循环；请求体对齐 Python SDK 的实际抓包，错误码与文案沿用 `insight_errors` / `ai_runtime` 的闭集。Rationale: 现有 agent 只用到 function 调用与「工具返回完成信号」，引入框架会把一个可读的 150 行循环换成一个需要长期跟随上游的依赖；抓包 golden 让「两个实现发同一个请求」变成可执行断言，而不是靠文档推断。Date/Author: 2026-11-14 / Codex。
- Decision: 提示词、三语语义表与分块规则以「Python 渲染结果」为唯一基准，用 golden fixture 做逐字节/逐字段比对；摘要 agent 复用自建工具循环，不再为「换工具」单独造一套状态机。Rationale: 这些内容用户能直接看到（提示词影响输出语言，分块偏移影响来源标注），靠代码审阅看不出差异；用 Python 当基准比自己写断言更可靠。Date/Author: 2026-11-14 / Codex。
- Decision: `--retry-insights-stdin` 先只实现 `target=summary`，其余 5 个 target 用独立码 `INSIGHT_TARGET_UNSUPPORTED` 明确失败（临时码，宿主当前回落到通用文案），既不把它们伪装成「请求非法」，也不发明「模式暂不可用」类长期码；`INSIGHT_TARGET_UNSUPPORTED` 会随最后一批 agent 落地一起移除。Rationale: 把能力面写进结果行，宿主才不会把「还没做」当成「做失败」；等到 6 个 target 齐备时这个分支应当自然消失，而不是变成永久兼容逻辑。Date/Author: 2026-11-14 / Codex。
- Decision: 第三个 target `title` 不复用「产物 + 清单一次事务」骨架，而是复刻 Python 的 `run_note_title_step`：只就地改清单的 `note_title` / `updated_at`，两次单事务写 `generating` 与终态，结果只挂任务标识不重写清单。Rationale: 标题不是产物文件，界面靠清单里的状态机区分「正在生成 / 成功 / 失败」；若走 `finalize` 会覆盖 `status` 与前端写入的未知字段，进程被杀时还会丢失可重试语义。标题元数据的校验规则抽到 `tasks/note-title-metadata.ts` 一份，生成、落盘、读清单三处共用，避免「写进去、下次打不开」。Date/Author: 2026-11-15 / Codex。
- Decision: 第四个 target `transcript` 不复用 `createInsightLlm`：Python 的整理稿走草稿 agent 的 `build_llm_provider`，整次只 checkout 一次、所有分段共享 provider，且未显式配置 `APP_LLM_MAX_TOKENS` 时不发 `max_tokens`；若复用「每次 chat 换一次凭证」的 insight provider，24 段会扣 24 次额度。因此单独实现 `createPolishLlm`（一次解析 + 一次 checkout + endpoint 复用）并给 `chatCompletion` 加可选 `omitMaxTokens`，既有 agent 的请求体形状不变。两份产物 `polished.txt` / `polished.meta.json` 同样不进事务闭集，按 Python 逐个原子写，清单另走 `finalizeTask`。Rationale: 计费单位与产物注册都是跨语言契约，改动它们不会让功能「看起来更正常」，只会让宿主读到的额度与清单不一致。Date/Author: 2026-11-15 / Codex。
- Decision: 第五个 target `dissection` 的报告校验与持久化读回共用 `dissection-report.ts` 一份实现，来源摘要（原稿 SHA-256、`sourceLanguage`、`sourceChunks`）只由 worker 根据未裁剪的权威文字稿算出，模型交付的语义部分必须逐字段通过闭集校验。Rationale: Python 的 `parse_dissection_report` 与 `parse_persisted_dissection` 本来就复用同一套规则，拆成两份会让「写进去的报告下次读不出来」；读取时用当前原稿重算并比对整份文件，还能让原稿变更后的旧报告自动失效。进度事件通过 `ToolLoopOptions.onChatRequest` 发出，避免为解剖单独复制一份工具循环；`attempt` 封顶在 6 以内，契约校验要求 `attempt <= total <= 100`。Date/Author: 2026-11-15 / Codex。
- Decision: 第二个 target 不另造管线骨架：`summary` 与 `insights` 共用「打开任务 → 读权威稿 → 生成 → 合并已有产物 → 一次事务提交」，差异只在生成函数与产物路径；偏好词表、提示词、三语 Markdown 继续以 Python 渲染结果为 golden。Rationale: 新增一份平行管线会把「清单与产物同生共死」的约束复制两遍，而这两条 target 的行为差别只有模型交付工具；golden 比对能抓住人工审阅看不出的换行、字段顺序与码点计长差异。Date/Author: 2026-11-14 / Codex。
- Decision: 第六个 target `draft` 先迁它依赖的检索工作间，再接成稿链：MCP 用官方 `@modelcontextprotocol/sdk` 的 streamable-http 客户端（工具名与参数结构取自 `tools/list`，本地不预设），技能 frontmatter 用 `yaml` 解析（SKILL.md 随 `worker-ts/skills/` 分发），计划与技能各用独立注释哨兵整段替换 system 消息；整次成稿只 checkout 一次凭证，40 轮共用同一 endpoint。Rationale: `agent_runtime` 的 `ToolLoopAgentRunner` 是 Python 依赖，自行复制它的协议解析与 YAML 解析会造出两份不可信实现；用官方 SDK 与 `yaml` 让「连真实 anysearch 端点」成为可验证的接线，而不是替换 import。工具集的装配顺序、提示词、失败文案与产物路径仍以 Python 生产源码生成的 golden 逐字节比对。Date/Author: 2026-11-15 / Codex。

- Decision: URL 下载器使用官方独立 yt-dlp 可执行文件，Windows x64 用 `yt-dlp.exe`、macOS 用 universal `yt-dlp_macos`，按固定版本 `2026.10.26` 与官方 SHA-256 随包分发，运行时禁止自动更新与回退 Python 模块。Rationale: 发行包不携带自有 Python，而 PyInstaller 可执行文件自带 Python 是用户确认的唯一例外；固定版本与哈希让随包资产是否被替换成为可判定事实。官方 release 只提供一份 macOS universal 文件，x64 与 arm64 共用。Date/Author: 2026-11-15 / Codex。
- Decision: 随包 PyInstaller 可执行文件按 GPLv3+ 组合作品分发，发行包随附许可文本、第三方许可清单与对应源码获取方式；`--download-runtime-component` 不再迁移。Rationale: 官方明确说明打包可执行文件含 GPLv3+ 代码，zipimport 版与源码包虽无此义务但无法满足 Windows 与 macOS 的独立运行；旧 PyTorch 运行时组件与新版本只提供 ONNX 的范围冲突，保留用户数据目录里的旧组件文件即可满足升级兼容。Date/Author: 2026-11-15 / Codex。
- Decision: 下载命令前缀由调用方注入（官方独立可执行文件路径），三平台下载函数与小红书字幕探测作为 `downloadVideo` 的注入点，不提供默认策略。Rationale: Python 的解释器模块入口不能复用，产品规格禁止回退到系统 Python；在传输层接通前给默认策略会让 URL 任务静默成功却拿不到视频。命令参数本身仍以 Python 生产源码生成的 golden 逐项比对。Date/Author: 2026-11-15 / Codex。
- Decision: 字幕的 HTML5 实体解码使用 `entities@6.0.0`（BSD-2-Clause），不复制 Python 标准库里 2231 条实体表。Rationale: HTML5 字符引用是成熟的标准化规则，手工复制实体表或无分号最长前缀匹配会引入难以察觉的偏差；该库已实测能在随包 Deno `2.9.1` 的 `nodeModulesDir: "manual"` 布局下加载，发行包须随附其许可文本。Date/Author: 2026-11-15 / Codex。
- Decision: URL 清单沿用 Python 的「无 `source_kind`」形状，只写 `source_url` / `source_identity` / `platform`；读回时缺失、`null` 与显式 `"url"` 都按 URL 处理。Rationale: `task.json` 是 Rust / Python / TypeScript 三方共读的持久化状态，多写一个键就会让宿主把 URL 任务误判成第三种来源；身份必须重新过平台识别且规范 URL 必须相等，才能阻止分享链接里的 token 或篡改的稳定 ID 进入历史记录。URL 任务身份与清单先于下载管线落地，是为了让后续接线不必同时改持久化格式。Date/Author: 2026-11-15 / Codex。
- Decision: `--request-stdin` 随 URL 全链一起注册，但三平台 fallback 策略与小红书字幕探测默认保持为空注入点。Rationale: 官方独立 yt-dlp 主路径已经可用，继续把参数藏起来只会让宿主一直拿到用法错误；反爬兜底属于另一块 2647 行传输层，装配空策略会让 URL 任务静默成功却拿不到视频。因此把差距写进产品规格与差距文档，由传输层迁移关闭，而不是靠 CLI 开关遮掩。下载器路径通过契约 `env.ytdlpPath=APP_YTDLP_PATH` 显式注入，缺失即固定失败，绝不回退系统 Python。Date/Author: 2026-11-15 / Codex。
- Decision: B 站 fallback 的 ffmpeg 合并复用主路径的 `CommandRunner`，策略上下文因此新增可选 `runner`。Rationale: B 站是唯一需要二次合并的平台，单独再建一个 runner 会让「同一次任务用两套进程管理」；把 runner 放进 `FallbackDownloadContext` 后，超时、取消与测试注入都只有一条路径，抖音等不需要合并的平台忽略该字段即可。DASH 选择保持 Python 的字典序比较并在并列时取先出现项，避免「同码率不同分辨率」时结果漂移。Date/Author: 2026-11-16 / Codex。
- Decision: 三平台 fallback 按平台逐个接通，`createFallbackStrategies` 接受部分实现，未提供的平台不进入策略列表；`pipeline` 默认使用 `createPlatformFallbackStrategies()`，当前注册抖音与 B 站。Rationale: 一次性迁移 2600 行传输层无法在本轮充分验证，而「注册空策略」会让 yt-dlp 失败被伪装成平台错误。按平台拆分后，每块都能用 Python 生产代码生成的基准与真实进程冒烟独立验收；抖音先行的原因是它自包含（分享页 + bit_rate + 有序下载），不依赖 ffmpeg 合并。Cookie 只按主机名记忆（不区分 path/过期）是相对 `CookieJar` 的刻意简化，只影响同名跨路径 Cookie 的罕见场景。Date/Author: 2026-11-16 / Codex。

## Context and Orientation

- 产品与 ASR 设计：`docs/product-specs/2026-11-13-worker-typescript-rewrite.md`、`docs/design-docs/2026-11-13-typescript-worker-asr-boundary.md`。
- Python worker：`worker/worker_core/cli.py`、`asr_runtime/`、`model_download.py`、`pipeline_runtime/`、`*_agent.py`、`storage_validation.py`。
- 桌面宿主与契约：`app/src-tauri/src/worker_runtime/`、`settings.rs`、`data_storage_validation.rs`、`contracts/desktop-worker-contract.json`。
- 构建与验证：`scripts/build-installer.mjs`、`app/src-tauri/tauri.conf.json`、`docs/EXECUTION_GATES.md`；当前待验证事项见 `docs/exec-plans/active/2026-11-13-worker-typescript-rewrite-gaps.md`。

## Plan of Work

### 前置可行性验证

1. **当前 ONNX 模型与 ASR 实现。** 以 `funasr_onnx` + FSMN VAD 的生产路径为质量与性能基线。
   使用 `onnxruntime-node@1.29.0` 直接加载生产 `model_quant.onnx` 与 FSMN VAD ONNX，沿用
   `<根>/models/onnx/` 缓存、就绪标记与哈希校验。逐项核验 Fbank 80 维特征、LFR 7/6、
   `am.mvn` CMVN 归一化后的 `speech` 张量与 Python 侧的数值一致性；CTC greedy 解码、
   `tokens.json` 映射、SentencePiece 拼接与标签清理的逐字一致性；FSMN VAD 的 `in_cache0..3`
   状态传递、事件流解析与分段时间戳一致性（2026-11-14 已用三个真实音频用例实测通过，
   `logits` 与缓存误差为 0）。VAD 使用独立的 `WavFrontendOnline` 前端（`dither=0.0`、
   LFR 5/1、400 维），其跨块 `input_cache` / `lfr_splice_cache` / `reserve_waveforms`
   已于同日逐块比对（waveform 逐值一致、`feats` 误差 ≤ `1.66e-4`）。端到端质量同日以 Paraformer
   独立参考在 8 条窗口实测，增量 `−0.159pp` 通过门槛。固定 `onnxruntime-node@1.29.0` 与
   受支持平台原生依赖的来源、许可与完整性。全部比对使用真实音频并记录实测差异，待验证项见
   `2026-11-13-worker-typescript-rewrite-gaps.md`。
2. **下载器。** 使用官方独立 yt-dlp 程序，盘点现有受支持来源、URL 和平台 fallback，以真实公开或已授权链接核验视频、音频、字幕、元数据、失败码、取消和超时。确认受支持平台的发行资产、版本、许可证、二进制来源和完整性；官方说明 PyInstaller 打包的发行文件含 GPLv3+ 代码，组合发行包采用 GPLv3+，必须核实具体发行资产与项目分发要求。不得引入第三方解析服务接收用户链接，亦不得绕过登录墙、访问控制或 CAPTCHA。
3. **运行期。** 现有安装包已有 Deno。2026-11-14 已在 Windows x64 用锁定版本 `2.9.1` 验证通过：
   `onnxruntime-node@1.29.0` 原生插件可加载、数值与 8 条端到端文本与 Node 完全一致，权限最小集为
   `--allow-read --allow-write --allow-ffi`，`deno compile` 单文件不可用。因此采用「随包 `deno.exe` +
   外置 `node_modules`」，不再评估随包 Node。仍需在 macOS x64 与 arm64 复跑同样的加载、权限与
   `DYLD_LIBRARY_PATH` 验证，并核验 Rust 监督下的启动、取消与进程树。记录体积、启动时间、权限与
   许可证证据，不假设 `DYLD_LIBRARY_PATH` 一定适用于最终包。
4. **工作间。** `agent_runtime` 是 Python 第三方依赖。盘点工具调用循环、工具结果校验、提示词、重试上限、MCP、planning、skills、LLM checkout、BYOK 和错误映射；选择可满足现有行为的 TypeScript 依赖并验证。测试托管与 BYOK 的真实调用及计费边界，避免超时后重复扣费。不能仅以替换 import 表示完成。
5. **基线与数据。** 固定旧版本提交、依赖锁、ONNX 模型及 VAD 文件哈希、语料文件哈希、运行参数、平台和测量脚本版本，生成可复现的基线快照。中文语音窗口使用已在实验中运行的 Paraformer 生成独立参考文本，固定参考模型文件、运行参数和输出哈希；参考文本不得读取基线或候选转写。英文为主的窗口单独使用适合英文的独立本地参考模型，并固定相同信息；参考模型缺失或未证明适用时，该项保持未验证。真实语料与转写保持本机或经授权的私有位置，仓库仅存不包含用户内容的清单与指标；缺少授权或语料时该项保持未验证。保留独立开发环境复算基线，发行包不包含该环境。将必要门禁脚本纳入仓库。

依赖参考：[yt-dlp 官方发行文件与许可说明](https://github.com/yt-dlp/yt-dlp#release-files)、[Deno Node 与 npm 兼容说明](https://docs.deno.com/runtime/fundamentals/node/)。实际选用的版本和发行文件还须逐项核验。

### 实施步骤

1. 建立独立 TypeScript worker 包，逐项映射 `worker/worker_core/cli.py` 中仍受支持的模式与 `storage_validation` 入口，保留请求大小、stdin、stdout 单结果、stderr 进度前缀和退出语义。更新 `app/src-tauri/src/worker_runtime/command.rs`、`runtime.rs` 及 Python 子进程调用点，包括 BYOK 探针和存储校验。
2. 迁移任务、网页保存、媒体来源、字幕、下载、ffmpeg、模型下载和缓存管理；沿用当前数据根许可、来源校验、原子提交、事务恢复和取消行为。通过真实旧任务验证续写，保留历史和合集。
3. 按 ASR 设计文档实现 `Transcriber`、公共 `Transcript` 类型及唯一 ONNX 适配器；用 `onnxruntime-node@1.29.0`
   加载生产 `model_quant.onnx` 与 FSMN VAD ONNX，在适配器内实现 ASR 的 Fbank/LFR 7/6/CMVN 前端、
   CTC greedy 解码、`tokens.json` 映射、SentencePiece 拼接、标签清理，以及 VAD 独立的
   `WavFrontendOnline`（`dither=0.0`、LFR 5/1、400 维）、`E2EVadModel` 状态机、事件校验、
   跨块配对、分段、时间戳与失败映射。
   运行时依赖、模型张量与 VAD 状态限制在适配器内；沿用 `<根>/models/onnx/` 的就绪标记、哈希校验
   与按需下载，逐项比对 Python 基线的特征张量、解码结果与分段时间戳。
4. 收窄受支持模型列表，更新 `contracts/desktop-worker-contract.json` 及前端、Rust、worker 的模型枚举、请求校验、结果校验和测试；检查总契约与各请求版本的语义并同步版本与断言。历史清单的旧模型标识仍可读取，直接提交旧模型作为新任务或下载请求须明确拒绝，不能伪装为 ONNX 请求。
5. 在 `app/src-tauri/src/settings.rs` 的版本化设置迁移中处理旧 PyTorch 选择：在支持列表校验之前一次性迁移到 ONNX，保留其他配置并显示可关闭的提示；现有 ONNX 选择不提示。更新设置与模型准备界面，移除 PyTorch 运行组件下载入口及相关错误提示。对未知模型继续明确报错。
6. 处理 `app/src-tauri/src/data_storage_validation.rs`、`worker/worker_core/storage_validation.py` 及数据位置迁移的旧控制记录：旧基线可能包含 PyTorch `ready_models`、组件版本及指纹。将旧资产按数据完整性核验并保留，不能在无 Python 的新 worker 中尝试导入 PyTorch；迁移中断或升级后的旧记录须安全恢复，无法证明数据完整时保持恢复状态且不得清理源文件。保留旧模型、组件文件及历史任务，TypeScript worker 直接读取现有 ONNX 缓存并沿用其校验规则。
7. 实现工作间所有目标和依赖能力，逐项核对工具协议、AI 产物、使用量、错误与取消；覆盖托管、BYOK、网页和媒体来源。
8. 修改 `scripts/build-installer.mjs`、`app/src-tauri/tauri.conf.json` 和发布 CI，替换自有 Python 资源、依赖导出、指纹与导入检查；停止分发和下载 PyTorch 运行组件；加入 `onnxruntime-node` 与受支持平台的原生依赖，记录许可、来源、版本和校验。按已定布局打包：worker 源码与 `node_modules` 外置，`node_modules` 只保留目标平台的 `bin/napi-v6/<platform>/<arch>` 与 CPU 必需的 `onnxruntime.dll`/`onnxruntime_binding.node`，随 `deno.json` 声明 `nodeModulesDir: "manual"`；不要用 `deno compile`。检查打包产物、模型按需下载与运行时启动链，确保满足用户确认的 Python 范围。
9. 将现有测试按可观察行为迁移；Python AST 或导入边界测试改为适用于 TypeScript 的等价边界检查。更新 `AGENTS.md`、`docs/ARCHITECTURE.md`、`docs/EXECUTION_GATES.md` 等实际受影响文档，完成下列验收后归档。

## Validation and Acceptance

所有验收自动运行，命令、输入版本、平台、退出状态和结果由实施者在本节记录。ASR 链路已有可执行门禁
`scripts/asr-verification/run.mjs`，以下 ASR 相关条目应优先走该门禁；`worker-ts` 的整体门禁脚本尚不存在，
其余条目不能把计划中的路径当作已经可执行的命令。

- **可复现门禁（已可执行）：** `node --experimental-strip-types scripts/asr-verification/run.mjs
  --cache-dir <缓存目录>`，Deno 下为 `deno run --allow-read --allow-write --allow-ffi run.mjs
  --cache-dir <缓存目录>`。它直接导入生产代码 `worker-ts/src/asr`，依次断言资产 SHA-256、分段与
  `golden/production-reference.json` 逐毫秒相同、文本与本机 `golden/<平台>/` 逐字相同且相对生产基线
  CER ≤ 0.5 个百分点。改动 ASR 代码或模型资产后必须复跑；失败时不得修改 golden 或阈值绕过，除非另行
  记录理由并重新评审基线。配套 `npm --prefix worker-ts test`（20 项，不需要模型）覆盖接口与失败语义，
  `node --test scripts/tests/asr-verification-assets.test.mjs`（5 项）覆盖资产与边界守卫。

- **功能与契约：** 逐入口验证有效及无效请求、闭集进度、结构化结果、错误码、超时和进程树取消；覆盖媒体与网页任务、旧任务续写、历史合集、存储迁移验证、BYOK 连接、工作间各目标与失败恢复。对新任务和模型下载断言只接受 ONNX，旧任务及旧模型标识仍可读取。执行前端、Rust、worker、脚本和文档治理的相关门禁，复核 `docs/EXECUTION_GATES.md`。
- **模型设置与旧数据：** 用真实旧版设置覆盖旧 PyTorch、现有 ONNX、空值和未知模型；验证一次性迁移与提示、重复启动、其他配置保留、未知值报错及非静默下载。覆盖现有 ONNX 缓存存在或缺失、旧组件存在、数据位置迁移或恢复中断后升级等情形；验证缓存存在时 TypeScript worker 直接读取、模型文件与哈希不变、无需重新下载；核验旧任务、源文件、目标文件和控制记录，未完成恢复时不得清理源文件。
- **ASR 前端与解码等价性：** 数值比对在 `dither=0` 的确定性配置下逐项比对 Python 基线与 TypeScript
  实现的 Fbank 特征、LFR 拼帧结果、CMVN 后的 `speech` 张量、`speech_lengths` 与 `feats` 最大误差；
  再用**同一份** `feats` 比对 `ctc_logits`、CTC 解码 token 序列与分段时间戳，运行时差异须为 0。
  端到端文本允许前端浮点级差异，须在有独立参考文本时按 CER 门槛判定，不能要求与 Python 逐字相同；
  2026-11-14 已按此口径实测通过（增量 `−0.159pp`、人工校对真值两侧同分），正式验收须用仓库内冻结的
  参考与脚本复跑。
  生产 `dither=1.0` 配置按多次运行的识别文本集合验收。比对前核对 `onnxruntime-node` 版本与依赖锁一致。
- **VAD 状态机与分段等价性：** 用真实长语音、音乐和纯静音音频逐块比对生产 `Fsmn_vad_online`
  与 TypeScript 实现的 `speech` [1,T,400]（含 `WavFrontendOnline` 的 `input_cache` /
  `lfr_splice_cache` / `reserve_waveforms` 边界与 `is_final` 尾帧补齐）、`logits` [1,T,248]、
  四组 `in_cache` / `out_cache`、每帧分贝、逐块事件流与最终分段时间戳，记录最大绝对误差；
  无语音零段、跨块未闭合端点配对与非法事件流拒止必须通过断言。核对 `onnxruntime-node@1.29.0`
  与依赖锁一致。
- **ASR 接口：** 公共面是 `worker-ts/src/asr/index.ts` 的 `createTranscriber` / `Transcriber` /
  `Transcript` / `ASRError`。用真实当前模型和真实音频验证输入、语言映射、结果结构、时间戳与错误码；
  静态检查任务编排只依赖该入口，`onnxruntime-node`、VAD 状态机与张量不泄漏到任务流程。取消以 Rust
  宿主终止完整进程树为准，不在接口内承诺可中断。现已落地：错误码映射、闭集模型拒止、无语音、模型
  缺失/损坏有单测；仍缺真实注入：单段识别失败、`dispose()` 后复用、进程树取消。
- **ASR 结构：** 每个送入识别器的块不超过 20.5 秒，补边不能重叠重复识别；覆盖句首、长停顿、长文件、无语音和纯音乐。输出 schema、时间戳边界和用户可定位性必须通过测试。
- **自动化识别质量：** 以当前 Python ONNX 生产路径为基线，基线与候选均识别同一批固定的音频窗口，使用候选无关的同一份自动参考文本比较。中文采用 Paraformer，英文为主窗口使用适合英文的独立本地参考；中英文分别报告，不能用中文参考模型推断英文质量。所有参考文本和模型哈希在候选运行前冻结。字符单位和编辑距离沿用 `work/asr-spike/metrics/compute.py` 的 `units` 与 `levenshtein` 规则：中文逐字、英文和数字按字符并保留词边界标记，标点与空白不参与；每个窗口的 CER 为编辑距离除以参考单位数，空参考作为独立边界用例处理。中文窗口 CER 算术均值增量 ≤0.5 个百分点、任一中文窗口增量 ≤2 个百分点；英文窗口采用相同阈值单独计算。漏句计数为参考与输出的编辑距离回溯中连续删除至少 10 个单位的次数；重复循环沿用 `repetition_loops` 的长度 1 至 20 单位、连续至少三次规则，两侧各自总数均不得高于基线。语种误判及无语音输出按固定语料标签独立核验；未能提供可信自动参照的语种或音频类别保持未验证。测试同时记录每条结果与模型版本；参考生成步骤、单位规则、分组、判定阈值及窗口在跑候选前冻结，不能根据候选结果调整。自动参考的误差与偏差必须随结果报告：报告须包含参考与基线引擎的互比 CER 作为噪声基准，参考对该窗口明显失效时（如中英混合超出中文参考词表）该窗口单列，不计入增量判定。2026-11-14 已按此口径实测：8 条中文窗口增量 `−0.159pp`、参考与基线互比 CER `23.64%`、`mixed-a16z` 单列为参考失效。
- **性能：** 同机同语料重复测量，与当前 Python ONNX 路径比较，记录聚合识别耗时、逐条实时因子、峰值内存及长文件稳定性；沿用聚合耗时 ≤基线 1.0 倍、逐条 ≤1.2 倍、内存 ≤1.5 倍。记录测量次数、统计口径和环境。
- **两平台与打包：** Windows x64 与 macOS Apple Silicon 分别通过 `onnxruntime-node` 原生依赖加载和打包应用端到端自动冒烟；检查发行文件及运行组件只在官方独立 yt-dlp 内含 Python，核验许可证、完整性、模型按需获取与用户升级。记录两平台安装包体积与旧版本比较。worker 以随包 `deno.exe` 加外置 `node_modules` 启动，权限为 `--allow-read --allow-write --allow-ffi`，`node_modules` 由 `deno.json` 的 `nodeModulesDir: "manual"` 解析；冒烟必须断言真实推理成功并校验随包 `onnxruntime.dll` 哈希，防止在用户机器上回退到 `C:\Windows\system32\onnxruntime.dll`（1.17.1）这类系统旧版；确认打包删除了非目标平台的 `bin` 与 CPU 路径不需要的 DLL 后冒烟仍通过。

## Outcomes & Retrospective

重写尚未实施。2026-11-14 确定 ASR 采用 `onnxruntime-node@1.29.0` 直接加载生产模型文件，完成 Python 与
Node 两侧的加载、推理、CTC 解码、ASR 前端、FSMN VAD 状态机、VAD 在线前端与端到端 `Transcriber` 原型
验证：分段、切片、块上限、时间单调与音频边界全部与 Python 基线一致；文本存在前端浮点级差异
（`pharma-90s` 544 字中 9 字不同），已定位到 kiss_fftr 与 radix-2 FFT 的运算顺序，运行时在相同 `feats`
下误差为 0。同日以 Paraformer 独立参考在 8 条真实窗口（6277 个字符单位）上按产品门槛判定质量通过：
增量 `−0.159pp`（门槛 `0.5pp`），人工校对真值用例两侧均 `1.92%`、编辑距离 11:11，146 段中 99 段文本
相同，75 个差异字符为多字 23 / 漏字 23 / 替换 29。同日验证运行期：安装包锁定的 Deno `2.9.1` 可加载
`onnxruntime-node@1.29.0` 原生插件，零张量数值与 8 条端到端文本与 Node 完全一致，权限最小集为
`--allow-read --allow-write --allow-ffi`，`deno compile` 单文件会回退到系统旧版 ONNX Runtime 因此
排除；裁剪后 `node_modules` 为 27.6 MB。同日把整条链路固化成仓库内门禁 `scripts/asr-verification/`：
3 条 fixture（1.4 MB，入库并哈希固定）、生产基线、`win32-x64` golden 与三层判定；Node 与 Deno 两种
运行时结果逐字相同，`speech-12s` / `dialogue-32s` 相对生产基线 CER 均 `0.000%`，静音用例按预期零段，
文本与资产两类负例都能拦下。门禁在建立过程中抓到一个真实移植缺陷（`noiseAverageDecibel` 未初始化导致
全部帧判静音），而分项数值比对完全看不出来。同日把实现搬进生产包 `worker-ts/src/asr/`：公共
`Transcriber`/`Transcript` 与稳定错误码、只读模型缓存校验、唯一 SenseVoice 适配器与 `createTranscriber`
入口；门禁改为导入该实现，不再有第二份代码；`npm --prefix worker-ts test` 的 20 项失败语义断言不需要
模型即可运行，静态守卫确保原生依赖只出现在适配器内。迁移过程中门禁又抓到第二个缺陷：`do_extend: 1`
被当成布尔缺失，端点延展退化、CER 升到 `1.399%`。macOS Apple Silicon 原生依赖与打包、macOS 的 golden、
官方独立下载器、Rust 监督下的启动与取消仍未验证；工作间的 MCP 检索客户端、技能与规划已用真实
Python MCP 端点验证，托管 checkout 与 BYOK 的计费边界、进程树取消及网页来源分支仍待验证。`work/asr-spike/` 的语料、
脚本和结果仍未纳入版本库，因此除 `scripts/asr-verification/` 覆盖的 ASR 链路外，其余探针结论仍不
构成跨机器可复现的验收资产。

Residual risk: `onnxruntime-node` 原生依赖的 macOS 打包与许可、macOS Apple Silicon golden 尚未生成、
Windows 上回退到 `C:\Windows\system32\onnxruntime.dll`（1.17.1）旧版的风险、分段在临界帧上跨实现
漂移 10~120 ms（靠 fixture 选点规避，不是代码修正）、英文与中英混合窗口的适用独立参考
（现有 Paraformer 中文词表对 `mixed-a16z` 失效，该条增量无判别力）、逐条性能、旧数据迁移恢复尚未验证；
参考与主候选互比 CER 为 `23.64%`，参考噪声远大于待测差异，正式验收必须记录实际运行证据并同时报告
参考噪声基准。
- Decision: 小红书传输层复用同一套 `DownloadToPathOptions` 与主路径 runner 语义：页面 GET 与媒体流共用一个 `FetchXiaohongshuHttpClient`（按主机记忆 Cookie），视频流 2 GiB/120 秒无进展、字幕 2 MiB/30 秒，字幕地址限定 `xhscdn.com` 与 `xiaohongshu.com` 的 https。Rationale: 小红书未登录页面就会下发 Cookie，媒体 CDN 校验 Referer 与 Cookie，拆成两个客户端会让真实下载概率性失败；字幕是可选产物，任何失败都必须收敛成「没有字幕」，不能把 2 MiB 上限或主机白名单错误抛进视频任务的失败码。`urllib.parse` 的语义（主机大小写保留、`parse_qs` 丢空值、`geturl` 只小写 scheme）单独复刻在 `url.ts`，因为 `new URL` 会改写清单里的规范 URL。Date/Author: 2026-11-16 / Codex。
- Decision: 平台传输层记录响应头时删掉 `Content-Encoding`，由 `fetch` 独占解压；`decodeResponseBody` 的解压分支只服务直接传入压缩正文的调用方。Rationale: Node 22.22.2 的 undici 与 Deno 2.9.1 都在读取正文时解压并保留响应头，若按头再解一次，所有 B 站与小红书请求都会以「正文无法解码」失败（真实公网复现，见 gaps「真实公网冒烟结果」）。不采用「按魔数嗅探是否仍需解压」的做法：那要靠猜测区分同一语义的两种正文，错误会落在解析而非请求层。Date/Author: 2026-11-16 / Codex。
- Decision: 发行包用「随包 Deno + 外置 `node_modules`」直接跑 `src/cli.ts`，不做 `deno compile`、不引入运行时打包器；宿主按「四件资产齐全」自动选代，缺一回落 Python。Rationale: `deno compile` 会因内嵌 `.node` 找不到同目录 `onnxruntime.dll` 而回退系统旧版（已实测报 API 版本不足）；仓库里保留源码树让打包产物与测试跑同一份代码，不需要额外的 bundle 步骤去解释「线上线下不一致」。回落而不是编译期开关，是为了让「打包脚本没跑」表现为可用的旧行为，而不是启动即失败。Date/Author: 2026-11-16 / Codex.
- Decision: `--allow-run` 暂不按程序名收窄，接受整条 `--allow-run`。Rationale: `APP_YTDLP_PATH` 可以指向任意绝对路径，按名收窄需要在宿主侧解析后再注入白名单，而漏掉一个程序在生产里表现为下载/转码失败；worker 本身是随包签名的可信代码，stdin 请求已有闭集校验。收窄列为打包前的硬化项。Date/Author: 2026-11-16 / Codex.
- Decision: 停止支持 macOS Intel，发布目标收窄为 Windows x64 与 macOS Apple Silicon。Rationale: `onnxruntime-node@1.29.0` 不提供 `darwin/x64` 二进制，维持 Intel 需要换用 napi-v3 的 `1.20.1` 并长期并行两套版本策略，还要为 Intel 维护独立的 Python 运行时与安装包；产品不为一个已停止供货的架构承担这份维护成本。发行工作流、macOS 验收工作流、构建脚本的 target 闭集、`make-macos-dmg.sh` 与 Rust 资源标识同步删除 `macos-x64`，已有 Intel 用户停留在最后一个支持该平台的版本。Date/Author: 2026-11-16 / Codex.
