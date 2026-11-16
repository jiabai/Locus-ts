# Active Exec Plans

- `2026-11-13-worker-typescript-rewrite-gaps.md` — 重写待验证事项：macOS Apple Silicon 原生依赖打包与 golden、ASR 适配接口、独立 yt-dlp、工作间运行器，以及英文参考、协议、旧数据和发行验证。`onnxruntime-node@1.29.0` 的 Node 侧推理、CTC 解码、ASR 前端、FSMN VAD 状态机、VAD 在线前端、事件流和分段时间戳均已与 Python 基线比对通过；端到端 `Transcriber` 原型已跑通分段、切片与产物组装，文本存在前端浮点级差异（FFT 算法所致），已按 CER 门槛用 Paraformer 独立参考在 8 条真实窗口实测通过（增量 `−0.159pp`，门槛 `0.5pp`；人工校对真值用例两侧同为 `1.92%`）；Windows x64 已验证随包 Deno `2.9.1` 可加载原生插件、8 条端到端文本与 Node 完全一致，`deno compile` 单文件被排除；整条链路已固化为 `scripts/asr-verification/` 可执行门禁（fixture、模型哈希、生产基线与逐平台 golden，三层判定，Node 与 Deno 结果逐字相同）；现有 ONNX 缓存直接复用。

- `2026-11-13-worker-typescript-rewrite-plan.md` — worker Python→TypeScript 重写计划，生产包 `worker-ts/` 已落地 ASR 接口与唯一适配器（公共 `Transcriber`/`Transcript`、稳定错误码、只读缓存校验、模型准备与 `createTranscriber` 入口，由 `scripts/asr-verification/` 直接跑生产代码做等价判定）、原子写与产物事务、媒体准备、任务存储、线协议入口、AI 调用层，以及 `--retry-insights-stdin` 的六个 target（`summary` / `insights` / `title` / `transcript` / `dissection` / `draft`）与草稿所需的检索工作间（官方 MCP SDK、`SKILL.md` 渐进式披露、计划状态、单次 checkout）；「本地文件 → 文字稿 → 清单」与六条重新生成路径均已真实 CLI 端到端跑通，产物、`note_title`、整理稿元数据、解剖报告与成稿可被 Python 严格读回。网页任务已落地：URL 规范化与保存契约经 Python golden 逐字节对齐（66 例），`--save-web-page-stdin`（`schema_version=4` 清单）与重算的网页来源分支（`WEB_PAGE_RETRY_TARGET_INVALID`、`APP_AI_SOURCE_KIND=article`）由双向 CLI 冒烟覆盖（TS 保存 → Python 严格读回；Python 保存 → TS 重算摘要 → Python 再读回）。存储校验探针（数据位置迁移的基线采集/核验入口）也已落地并与 Python 探针双向冒烟逐字节一致；BYOK 探针（`--probe-llm-stdin`）也已迁移并有双向 CLI 冒烟。来源识别（`--resolve-source-stdin`，四平台直连 + 三平台短链展开）也已落地并与 Python 逐字段冒烟一致。剩余：macOS Apple Silicon 实启动与 golden/CI、打包体积与许可随附、最后两处 Python 入口、运行边界的完整验收。ASR 使用 `onnxruntime-node@1.29.0` 直接加载生产模型文件，沿用现有 ONNX 缓存与 `iic/SenseVoiceSmall-onnx` 标识；旧 PyTorch 设置迁移到 ONNX 并提示，保留旧数据。验收全程自动化；官方独立 yt-dlp 程序内置 Python 获准作为唯一第三方例外。

- `2026-11-11-collection-membership-feedback-plan.md` — 合集成员状态反馈：**代码、门禁、提交与原生验收完成**。用户确认合集保持引用语义，笔记总列表始终全量；添加清单保留已加入笔记并标注状态，加入/移除后显示「笔记仍在笔记列表」的说明与撤销。规格、`DESIGN.md`、组件、三语文案、样式与测试已更新；前端 137 文件 / 1591 通过 / 1 跳过，lint 与 build 通过，文档 0/0；提交 `b8b1311` 已推送 `origin/main`。2026-11-11 Windows 原生窗口真实指针与键盘验收在 `en-US` / `zh-CN` / `zh-TW` 三语各 17 项全过（累计 51 项，证据 `work/collection-membership-native-acceptance-*.json`，台账 `design-qa.md`），撤销后焦点落在 `Finish selecting notes` / `完成笔记选择` / `完成筆記選擇` 按钮。残余：macOS WKWebView 焦点链需 macOS 主机。前端门禁需在 PowerShell 里先清 `NODE_OPTIONS`。该功能随 v0.6.0 于 2026-11-11 发布。

- `2026-11-10-data-storage-migration-speedup-plan.md` — 数据存储迁移提速（**第一批代码完成**）：并行复制/验证、砍写入后重哈希、源重验 identity+length 廉价判定、persist 250ms 节流；用户干净环境 data_storage 全模块 **88 passed / 0 failed**（agent 宿主内删除拦截致波动假失败，教训已记）。残余：全量 `cargo test --lib` 复跑与真实迁移计时对比。第二批与第三批单独立项。

- `2026-11-09-project-rename-locus-plan.md` — 已完成（提交 `5d312de` / `0a8d377` / `83d50ea`）：改名为 Locus 并彻底去品牌化，包名、环境变量、应用标识符、磁盘契约与日志改成中性名（`worker_core` / `APP_*` / `pro.8xf.app` / `task.json`），品牌收敛到四处常量并用 `{{product}}` 渲染文案；不写迁移代码。残余：旧数据目录不迁移、生产域名与路径仍是旧名、macOS 侧改动等待托管 CI 首次验证。




- `2026-11-07-web-login-response-classification-plan.md` — Windows 与 macOS 原生宿主把「HTTP 200 且重定向到登录页」在提取前判为 `WEB_PAGE_ACCESS_RESTRICTED`；Windows crate 20 项单测、前端 1507 项、脚本 57 项、生产构建与文档治理通过。macOS Swift 编译与协议测试已由 v0.5.0 重发的托管 CI 覆盖；2026-11-08 完成真实 WebView2 Runtime 157.0.4341.42 + 公网端到端验收：登录跳转 12.5 秒即时报受限码、正常文章不误报、直达 `/login` 的边界行为符合设计。剩余：真实 WKWebView 验收需 macOS 机器。
- `2026-10-31-llm-note-titles-plan.md` — 自动标题已实现；前端 1102、worker 1198、Rust 381 项通过，真实供应商两次共使用 2 个 AI Credit；完整原生 URL 流程验收待完成。
- `2026-10-30-desktop-sidebar-home-plan.md` - 侧栏、Home、本地合集与笔记流程已实现；1039 项前端测试与 Windows 构建通过。2026-11-08 三项残余原生验收闭环：详情动作激活 13 项、原生合集删除与任务文件保留 14 项（脚本化原生输入 + 字节级比对），以及用户手动跑通的「新建笔记 → 真实网页处理 → 自动入集」（微信文章，新任务 `20261108-145629-web-602ecab8a8b14291`，合集 0→1，无 AI 调用）。membership-retry 失败路径未触发，仍只有组件测试覆盖；本机 11-05 构建产物混版本曾导致 web 会话 `WEB_STORAGE_FAILED`，重建 `tauri build --no-bundle` 后恢复。详见计划与 `design-qa.md`。




- `2026-08-09-desktop-diagnostic-export-plan.md` - Implementation and automated gates complete for contract v8 structured ASR model-download diagnostics, Rust-owned bounded persistence, and user-initiated local ZIP export from failure UI and Settings > Advanced. 2026-11-08: focused Rust 50+8, worker 73, scripts 57, frontend 23 and packaged-worker equality all green; new permanent test writes a real ZIP to disk and scans every entry for seeded forbidden data. Same day the **real Windows Save As dialog** was driven through WebView2 CDP (`--remote-debugging-port=9222`) plus Win32 messages / `SendInput` (no mouse, .NET UIA blocked here): success / cancel / replace-existing / destination-failure all passed, zero forbidden-data hits. Remaining: strict packaged (NSIS) evidence, Rust write-stage `failed` code (unit-test only), and macOS native dialog/replacement. No automatic upload, mail or network probes.

See `../completed/index.md` for completed plans and `docs/exec-plans/index.md`
for the full index.
