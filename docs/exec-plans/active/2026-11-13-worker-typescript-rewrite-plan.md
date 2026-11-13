# Worker TypeScript Rewrite Plan

> This ExecPlan is a living document. The sections Progress, Surprises & Discoveries, Decision Log, and Outcomes & Retrospective must be kept up to date as work proceeds.

状态：方案已按单一 ONNX 模型范围修订，生产代码尚未开始重写。产品规格见 `docs/product-specs/2026-11-13-worker-typescript-rewrite.md`，目标架构见 `docs/design-docs/2026-11-13-typescript-worker-architecture.md`，ASR 接口设计见 `docs/design-docs/2026-11-13-typescript-worker-asr-boundary.md`；实施前须确认本计划并完成相关可行性验证。

## Purpose / Big Picture

用户继续在本地处理视频、音频和网页，读取已有笔记并使用工作间；处理阶段、用户数据和安全边界保持现有约定。worker 改用 TypeScript，模型选择调整为当前 ONNX 模型。规格与 ASR 设计分别定义用户可见行为和适配边界。

- 将自有 Python worker 换成 TypeScript，保留当前媒体、网页笔记、存储、工作间及 BYOK 行为；具体范围和用户数据保护见产品规格。
- 只交付当前默认的 `iic/SenseVoiceSmall-onnx` 模型选项，并通过模型无关的 `Transcriber` 接口隔离 ASR 实现。新版本不提供 PyTorch 选项及其运行时组件；其他模型的实现不属于本次范围。
- 现有 PyTorch 设置一次性迁移到 ONNX 并提示用户；历史任务与原模型文件、运行组件保留。验收全程自动化；粤语按原可行性测量决定排除在本次 ASR 质量语料之外。
- 用户允许官方独立 yt-dlp 程序内置 Python，作为发行包内唯一第三方例外；自有 worker 不保留 Python 运行时。
- 单独维护 TypeScript worker 包，沿用项目现有包管理方式，不为迁移引入根级 workspace 或前后端共享框架。代码共用仅在确有重复的稳定契约时考虑。
- 不引入双运行时常驻、远程开关或更新通道；验证时在开发环境使用固定的旧版本作为对照。出现问题通过现有发布流程修复，数据兼容和原子恢复须独立验证。

## Progress

- [x] 2026-11-13：完成默认 ONNX 路径的可行性测量，结论为有条件可行，尚需完成正式质量、性能与打包验收。Validation: `docs/exec-plans/completed/2026-11-12-asr-sherpa-onnx-node-spike-plan.md`。
- [x] 2026-11-13：明确单一 ONNX 模型、可替换 ASR 适配接口、自动化验收和独立 yt-dlp 例外；更新产品规格、接口设计、计划及待验证事项，生产代码未改动。Validation: 项目 `.venv` 执行 `scripts/validate_agents_docs.py --level ERROR` 和 `--level WARN` 均为 0 个错误、0 个警告；`git diff --check` 通过。
- [x] 2026-11-13：核对历史实验结果、自动仲裁脚本与模型文件哈希，统一已完成实验记录及索引；正式验收使用候选输出之外生成的固定参考文本。Validation: `final-metrics*.json`、`arbiter.py`、`mirror-cross-check.json`，以及生产和实验模型的 SHA-256 实测。
- [x] 2026-11-13：记录 TypeScript 目标架构图、Python 版本对比、数据边界和待验证事项。Validation: `docs/design-docs/2026-11-13-typescript-worker-architecture.md`；文档治理 ERROR 与 WARN 均为 0 个错误、0 个警告；`git diff --check` 通过。
- [ ] 验证 ONNX 资产兼容、官方独立下载器、TypeScript 运行期和工作间依赖；确认结论后细化执行步骤。
- [ ] 实施重写、运行完整验收并记录真实命令和结果。

## Surprises & Discoveries

- Evidence: 生产 `model_quant.onnx` 与实验 `model.int8.onnx` 的 SHA-256 不同，且生产使用 FSMN、实验使用 Silero。两份文件的本机 SHA-256 与 `worker/worker_core/model_download.py`、`work/asr-spike/results/mirror-cross-check.json` 的记录一致。
- Evidence: `work/asr-spike/arbiter.py` 使用待测候选生成仲裁文本，`final-metrics.json` 和 `final-metrics-preroll.json` 因此产生不同基线 CER。正式比较需要在运行候选前冻结独立参考文本。
- Evidence: `app/src-tauri/src/data_storage_validation.rs` 的旧迁移基线记录模型标识、PyTorch 组件和指纹；模型设置迁移、进行中的位置迁移与历史资产需要单独覆盖。

## Decision Log

- Decision: worker 重写范围只包含当前 ONNX 模型，ASR 通过可替换接口接入；其他模型留待后续决定。Rationale: 用户确定本次交付范围。Date/Author: 2026-11-13 / User。
- Decision: 验收全程自动化，允许官方独立 yt-dlp 程序内置 Python 作为唯一第三方例外。Rationale: 用户确认验收和发行边界。Date/Author: 2026-11-13 / User。
- Decision: 使用候选输出之外独立生成并固定的参考文本。Rationale: 自动识别参考只能作为质量代理指标，现有仲裁文本依赖候选输出。Date/Author: 2026-11-13 / Codex。

## Context and Orientation

- 产品与 ASR 设计：`docs/product-specs/2026-11-13-worker-typescript-rewrite.md`、`docs/design-docs/2026-11-13-typescript-worker-asr-boundary.md`。
- Python worker：`worker/worker_core/cli.py`、`asr_runtime/`、`model_download.py`、`pipeline_runtime/`、`*_agent.py`、`storage_validation.py`。
- 桌面宿主与契约：`app/src-tauri/src/worker_runtime/`、`settings.rs`、`data_storage_validation.rs`、`contracts/desktop-worker-contract.json`。
- 构建与验证：`scripts/build-installer.mjs`、`app/src-tauri/tauri.conf.json`、`docs/EXECUTION_GATES.md`；当前待验证事项见 `docs/exec-plans/active/2026-11-13-worker-typescript-rewrite-gaps.md`。

## Plan of Work

### 前置可行性验证

1. **当前 ONNX 模型。** 以 `funasr_onnx` + FSMN VAD 的生产路径为基线，实测生产 `model_quant.onnx` 与候选运行时的兼容性。已完成的 `sherpa-onnx-node` 实验使用另一份同源导出文件和 Silero VAD：须核实模型文件的来源、版本、许可、哈希、下载和真实加载能力，不能因模型同源而判定文件或输出相同。若使用实验所用导出文件，保留旧缓存、提示需要下载，并在当前模型选项下完成全部质量与性能门槛。
2. **下载器。** 使用官方独立 yt-dlp 程序，盘点现有受支持来源、URL 和平台 fallback，以真实公开或已授权链接核验视频、音频、字幕、元数据、失败码、取消和超时。确认三个平台的发行资产、版本、许可证、二进制来源和完整性；官方说明 PyInstaller 打包的发行文件含 GPLv3+ 代码，组合发行包采用 GPLv3+，必须核实具体发行资产与项目分发要求。不得引入第三方解析服务接收用户链接，亦不得绕过登录墙、访问控制或 CAPTCHA。
3. **运行期。** 现有安装包已有 Deno，先在实际锁定版本与三平台上验证其对选定 npm 依赖、原生插件、进程行为和打包布局的支持；Deno 支持 Node-API 不代表具体插件可用。若验证失败，再选择随包 Node。记录体积、启动时间、权限、许可证与安装包加载证据，不假设 `DYLD_LIBRARY_PATH` 一定适用于最终包。
4. **工作间。** `agent_runtime` 是 Python 第三方依赖。盘点工具调用循环、工具结果校验、提示词、重试上限、MCP、planning、skills、LLM checkout、BYOK 和错误映射；选择可满足现有行为的 TypeScript 依赖并验证。测试托管与 BYOK 的真实调用及计费边界，避免超时后重复扣费。不能仅以替换 import 表示完成。
5. **基线与数据。** 固定旧版本提交、依赖锁、ONNX 模型及 VAD 文件哈希、语料文件哈希、运行参数、平台和测量脚本版本，生成可复现的基线快照。中文语音窗口使用已在实验中运行的 Paraformer 生成独立参考文本，固定参考模型文件、运行参数和输出哈希；参考文本不得读取基线或候选转写。英文为主的窗口单独使用适合英文的独立本地参考模型，并固定相同信息；参考模型缺失或未证明适用时，该项保持未验证。真实语料与转写保持本机或经授权的私有位置，仓库仅存不包含用户内容的清单与指标；缺少授权或语料时该项保持未验证。保留独立开发环境复算基线，发行包不包含该环境。将必要门禁脚本纳入仓库。

依赖参考：[yt-dlp 官方发行文件与许可说明](https://github.com/yt-dlp/yt-dlp#release-files)、[Deno Node 与 npm 兼容说明](https://docs.deno.com/runtime/fundamentals/node/)、[sherpa-onnx SenseVoice 文档](https://k2-fsa.github.io/sherpa/onnx/sense-voice/index.html)。实际选用的版本和发行文件还须逐项核验。

### 实施步骤

1. 建立独立 TypeScript worker 包，逐项映射 `worker/worker_core/cli.py` 中仍受支持的模式与 `storage_validation` 入口，保留请求大小、stdin、stdout 单结果、stderr 进度前缀和退出语义。更新 `app/src-tauri/src/worker_runtime/command.rs`、`runtime.rs` 及 Python 子进程调用点，包括 BYOK 探针和存储校验。
2. 迁移任务、网页保存、媒体来源、字幕、下载、ffmpeg、模型下载和缓存管理；沿用当前数据根许可、来源校验、原子提交、事务恢复和取消行为。通过真实旧任务验证续写，保留历史和合集。
3. 按 ASR 设计文档实现 `Transcriber`、公共 `Transcript` 类型及唯一 ONNX 适配器；模型识别、VAD 和运行时依赖限制在适配器内，模型准备与产物写入由各自职责负责。实现并验证分段、文字清理、时间戳、模型获取、进度和失败处理。
4. 收窄受支持模型列表，更新 `contracts/desktop-worker-contract.json` 及前端、Rust、worker 的模型枚举、请求校验、结果校验和测试；检查总契约与各请求版本的语义并同步版本与断言。历史清单的旧模型标识仍可读取，直接提交旧模型作为新任务或下载请求须明确拒绝，不能伪装为 ONNX 请求。
5. 在 `app/src-tauri/src/settings.rs` 的版本化设置迁移中处理旧 PyTorch 选择：在支持列表校验之前一次性迁移到 ONNX，保留其他配置并显示可关闭的提示；现有 ONNX 选择不提示。更新设置与模型准备界面，移除 PyTorch 运行组件下载入口及相关错误提示。对未知模型继续明确报错。
6. 处理 `app/src-tauri/src/data_storage_validation.rs`、`worker/worker_core/storage_validation.py` 及数据位置迁移的旧控制记录：旧基线可能包含 PyTorch `ready_models`、组件版本及指纹。将旧资产按数据完整性核验并保留，不能在无 Python 的新 worker 中尝试导入 PyTorch；迁移中断或升级后的旧记录须安全恢复，无法证明数据完整时保持恢复状态且不得清理源文件。保留旧模型、组件文件及历史任务，继续支持新 ONNX 缓存的校验。
7. 实现工作间所有目标和依赖能力，逐项核对工具协议、AI 产物、使用量、错误与取消；覆盖托管、BYOK、网页和媒体来源。
8. 修改 `scripts/build-installer.mjs`、`app/src-tauri/tauri.conf.json` 和发布 CI，替换自有 Python 资源、依赖导出、指纹与导入检查；停止分发和下载 PyTorch 运行组件。为新增二进制记录许可、来源和校验。检查打包产物、按需下载组件及运行时启动链，确保满足用户确认的 Python 范围。
9. 将现有测试按可观察行为迁移；Python AST 或导入边界测试改为适用于 TypeScript 的等价边界检查。更新 `AGENTS.md`、`docs/ARCHITECTURE.md`、`docs/EXECUTION_GATES.md` 等实际受影响文档，完成下列验收后归档。

## Validation and Acceptance

所有验收自动运行，命令、输入版本、平台、退出状态和结果由实施者在本节记录。当前不存在 `worker-ts` 门禁脚本，不能将计划中的路径当作已经可执行的命令。

- **功能与契约：** 逐入口验证有效及无效请求、闭集进度、结构化结果、错误码、超时和进程树取消；覆盖媒体与网页任务、旧任务续写、历史合集、存储迁移验证、BYOK 连接、工作间各目标与失败恢复。对新任务和模型下载断言只接受 ONNX，旧任务及旧模型标识仍可读取。执行前端、Rust、worker、脚本和文档治理的相关门禁，复核 `docs/EXECUTION_GATES.md`。
- **模型设置与旧数据：** 用真实旧版设置覆盖旧 PyTorch、现有 ONNX、空值和未知模型；验证一次性迁移与提示、重复启动、其他配置保留、未知值报错及非静默下载。覆盖旧缓存存在或缺失、旧组件存在、数据位置迁移或恢复中断后升级等情形；核验旧任务、源文件、目标文件和控制记录，未完成恢复时不得清理源文件。
- **ASR 接口：** 使用真实当前模型和真实音频验证公共 `Transcriber` 的输入、语言映射、结果结构、时间戳、错误和进程取消。静态检查任务编排只依赖公共接口；模型加载、VAD 及原生库不泄漏到任务流程。测试无需新增第二个假模型。
- **ASR 结构：** 每个送入识别器的块不超过 20.5 秒，补边不能重叠重复识别；覆盖句首、长停顿、长文件、无语音和纯音乐。输出 schema、时间戳边界和用户可定位性必须通过测试。
- **自动化识别质量：** 以当前 Python ONNX 生产路径为基线，基线与候选均识别同一批固定的音频窗口，使用候选无关的同一份自动参考文本比较。中文采用 Paraformer，英文为主窗口使用适合英文的独立本地参考；中英文分别报告，不能用中文参考模型推断英文质量。所有参考文本和模型哈希在候选运行前冻结。字符单位和编辑距离沿用 `work/asr-spike/metrics/compute.py` 的 `units` 与 `levenshtein` 规则：中文逐字、英文和数字按字符并保留词边界标记，标点与空白不参与；每个窗口的 CER 为编辑距离除以参考单位数，空参考作为独立边界用例处理。中文窗口 CER 算术均值增量 ≤0.5 个百分点、任一中文窗口增量 ≤2 个百分点；英文窗口采用相同阈值单独计算。漏句计数为参考与输出的编辑距离回溯中连续删除至少 10 个单位的次数；重复循环沿用 `repetition_loops` 的长度 1 至 20 单位、连续至少三次规则，两侧各自总数均不得高于基线。语种误判及无语音输出按固定语料标签独立核验；未能提供可信自动参照的语种或音频类别保持未验证。测试同时记录每条结果与模型版本；参考生成步骤、单位规则、分组、判定阈值及窗口在跑候选前冻结，不能根据候选结果调整。自动参考的误差与偏差必须随结果报告。
- **性能：** 同机同语料重复测量，与当前 Python ONNX 路径比较，记录聚合识别耗时、逐条实时因子、峰值内存及长文件稳定性；沿用聚合耗时 ≤基线 1.0 倍、逐条 ≤1.2 倍、内存 ≤1.5 倍。记录测量次数、统计口径和环境。
- **三平台与打包：** Windows x64、macOS x64、macOS arm64 分别通过依赖加载和打包应用端到端自动冒烟；检查发行文件及运行组件只在官方独立 yt-dlp 内含 Python，核验许可证、完整性、模型按需获取与用户升级。记录三平台安装包体积与旧版本比较。

## Outcomes & Retrospective

重写尚未实施。已完成的语音识别测量覆盖当前 ONNX 模型候选；模型文件兼容、下载器、TypeScript 运行期和工作间替代仍需验证。`work/asr-spike/` 的语料和结果未纳入版本库，不构成跨机器可复现的验收资产。

Residual risk: 英文独立参考模型、生产模型文件兼容性、旧数据迁移恢复与三平台打包尚未验证；正式验收必须记录实际运行证据。
