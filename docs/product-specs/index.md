# Product Specs Index

产品规格描述用户可见意图与边界，先于或伴随实现落盘。实施进度不进入 spec，而进入 `docs/exec-plans/`。已退役或被取代的历史规格移入 `archive/`，索引条目保留以便追溯。

## Account, Billing & Server

- `2026-08-24-self-service-email-activation-code.md` — Current default unlock intent: inactive or expired desktop users request an account-bound activation code by email, then manually redeem it for a new 31-day window; repeat after every expiry without an administrator.
- `archive/2026-06-21-account-billing.md` — Retired self-serve WeChat purchase draft; its administrator-issued visible-path statement is superseded by the 2026-08-24 self-service email activation spec.
- `2026-06-21-activation-code-authorization.md` — Historical administrator-issued activation-code baseline; administrator universal codes remain supported, while the default user distribution path is superseded by the 2026-08-24 self-service email activation spec.
- `2026-06-22-server-managed-llm-quota.md` — Server-managed dedicated client LLM config and 20 AI Credits per activation window.
- `2026-06-27-admin-entitlement-adjustments.md` — Admin Web manual compensation for entitlement expiry and LLM API-call quota after support incidents.
- `2026-07-10-server-entitlement-transaction-safety.md` — Atomic, retry-safe payment settlement, activation-code redemption, and administrator entitlement compensation.
- `2026-08-03-web-user-dashboard.md` — Browser-side per-user Web dashboard at `/dashboard` with email-OTP cookie-session login that lands on the dashboard, reusing the `desktop_login` OTP purpose and the Admin Web session model.
- `2026-08-04-server-page-i18n.md` — Per-page language switcher on `/login`, `/dashboard`, `/admin/login`, and `/admin` supporting `zh-CN` (default), `en`, and `zh-TW` via the `server/src/i18n.ts` module.
- `2026-07-15-server-managed-anysearch-config.md` — Server-managed anysearch MCP URL + optional key on Admin Web as an encrypted singleton, replacing `server/.env`; checkout contract unchanged.

## Desktop Runtime, Packaging & Distribution

- `2026-11-13-worker-typescript-rewrite.md` — 自有 worker 从 Python 换成 TypeScript，只实现当前 SenseVoice ONNX 模型，并以稳定接口支持后续模型接入；旧 PyTorch 设置迁移到 ONNX，保留旧任务与数据。保留工作间、网页笔记和安全边界；官方独立 yt-dlp 内置 Python 获准作为唯一第三方例外，验收全程自动化。

- `2026-11-09-project-rename-locus.md` — 改名为 Locus 并去品牌化命名：`worker_core` → `worker_core`、`APP_*` → `APP_*`、`pro.8xf.app` → `pro.8xf.app`、磁盘契约与日志去掉品牌；品牌名收敛为三处常量，文案用 `{{product}}` 占位。域名、仓库与部署目录另按运维动作处理。

- `2026-11-01-data-storage-location.md` — 基础设置的统一数据存储位置；任务/笔记/合集、模型、运行组件与缓存可恢复迁移，凭据/设置/日志固定保留，兼容旧输出目录与明确清理旧副本。

- `2026-10-20-windows-installer-security-software-warning.md`：Windows installer detects 360 Total Security, 火绒, and Tencent PC Manager before writing files and shows one Chinese message with the trust-list and install-location guidance; silent and passive installs skip the message.
- `2026-11-09-windows-installer-preflight.md`：安装前测量目标卷可用空间与 `$INSTDIR` 可写性，交互安装失败时给中文提示并可换目录重试，静默/被动/更新只记录不阻断；每次安装追加一份 `$TEMP\install.log` 步骤日志。
- `2026-10-20-lightweight-installer-runtime-trim.md`：现有 Python worker 的默认 ONNX 模型与按需 PyTorch 运行组件；TypeScript 重写后的模型范围见 `2026-11-13-worker-typescript-rewrite.md`。
- `2026-09-19-v0.3.8-desktop-release.md` — v0.3.8 desktop release scope and acceptance; bundled `yt-dlp` upgrade 2026.7.4 -> 2026.8.19 to restore YouTube media-stream downloads for already-installed users, plus a read-only current-version line in Settings.
- `2026-09-19-v0.3.7-desktop-release.md` — v0.3.7 desktop release scope and acceptance; bounded Douyin share-page retry and the neutralized activation-panel title.
- `2026-09-05-v0.3.6-desktop-release.md` — v0.3.6 desktop release scope and acceptance.

- `archive/2026-06-18-installer-distribution.md` — Historical lightweight-installer distribution baseline; model-acquisition behavior superseded by `2026-07-27-selectable-asr-model-on-demand-download.md`.
- `2026-06-23-desktop-one-click-updates.md` — Low-noise desktop update reminders and one-click upgrades via GitHub Releases static `latest.json`.
- `2026-07-05-app-local-cache-dir-rename.md` — Use `cache/` for the app-local temporary task area and retire the legacy worker env contract.
- `2026-07-05-desktop-diagnostics-logs.md` — Local desktop diagnostics log for installer/runtime debugging, including YouTube JavaScript runtime failures.
- `2026-07-05-youtube-js-runtime-packaging.md` — Bundle Deno as the packaged JavaScript runtime needed by `yt-dlp` for clean-machine YouTube extraction.
- `2026-07-12-v0.2.16-open-source-release.md` — Stable v0.2.16 GitHub Release policy for personal-development, small-user, and open-source distribution.
- `2026-07-15-desktop-i18n-ai-output-language.md` — Offline bundled Simplified Chinese, Traditional Chinese, and US English UI; app-local language preference; strict confirmation-time AI output language.
- `2026-07-17-v0.2.17-desktop-i18n-release.md` — Stable v0.2.17 three-platform release policy for the completed desktop localization and confirmation-time AI output-language work.
- `2026-07-22-release-reliability-hardening.md` — Broad-release requirements for crash-consistent desktop persistence, bounded supervised-worker execution, atomic server authentication/AI Credit accounting, and production operations.
- `2026-08-03-v0.3.0-desktop-feature-release.md` — Stable v0.3.0 minor three-platform release policy; inherits v0.2.17 reliability acceptance.
- `2026-08-05-v0.3.1-desktop-feature-release.md` — Stable v0.3.1 minor three-platform release policy; includes mandatory server gates; excludes the standalone Web marketing site.
- `2026-08-09-desktop-diagnostic-export.md` — User-initiated, local-only export of the most recent seven days of privacy-bounded desktop and ASR model-download diagnostics.
- `2026-08-15-vc-runtime-selfcheck-and-import-diagnostics.md` — Windows app-local VC++ 2015-2022 runtime DLL bundling, pre-flight self-check with closed `ASR_MODEL_RUNTIME_MISSING`, and import-stage diagnostic fallback.
- `2026-08-16-asr-model-download-startup-recovery.md` — Windows ASR model-download startup failure fix: app-local VC++ preflight and explicit 0% startup-failure semantics.

## Input & Media Processing

- `2026-11-01-web-page-notes.md` — 网页正文与本地笔记、既有工作间；复用系统 WebView 独立宿主，取消额外浏览器下载与准备界面。Windows实现、构建与验收完成，平台能力及未验证范围见2026-11-02完成记录。
- `2026-11-09-bounded-ytdlp-download.md` — yt-dlp 下载子进程的固定时间预算；到期终止并沿既有下载失败路径结束任务，`ffprobe` 与 `ffmpeg` 的执行时间维持原状。

- `2026-06-16-douyin-video-transcription-client.md` — MVP desktop client: input a Douyin URL, output highest-quality public video and transcript; includes Douyin share-page fallback and the 2026-09-16 share-page retry with a randomized 3 to 10 second wait.
- `2026-07-05-repeat-url-task-reuse.md` — Reuse an existing completed local task when the same public video URL is submitted again.
- `2026-07-05-processing-toolbar-new-task-guard.md` — Disable the toolbar new-task/reset action while a video task is actively processing.
- `2026-07-10-source-url-privacy-boundary.md` — Separate process-local download URLs from safe canonical source identities; keep raw URL metadata out of persistence, history, diagnostics, and cloud AI prompts.
- `2026-07-10-desktop-process-supervision-cancellation.md` — Truthful cancellable worker/model-download lifecycle with platform process-tree termination and preservation of partial local artifacts.
- `2026-07-16-local-media-file-import.md` — Single-file local video/audio import with opaque Rust-owned selection tokens, normalized local WAV transcription, and strict path secrecy.
- `2026-07-18-process-video-request-contract-v3.md` — Minimal URL-only desktop intent, Rust-owned ASR configuration, and strict v3 worker execution request.
- `2026-07-27-selectable-asr-model-on-demand-download.md` — Two selectable local ASR models, model-snapshot task submission, and selected-model on-demand download with automatic resume.
- `2026-08-25-xiaohongshu-platform-subtitle-first-transcript.md` — Reuse verified Xiaohongshu platform SRT subtitles before local ASR in the existing single-link transcription flow; missing or malformed subtitles fall back to ASR, with no standalone subtitle-download UI.

## History & Workspace

- `2026-11-05-processing-workspace.md` — 用户确认的处理状态网页精准移植；集中任务、真实进度、来源、取消与后续用途提示，保留现有控制器和已保存笔记阅读。

- `2026-10-31-client-surface-unification.md` — 以当前主界面统一客户端确认、结果、草稿、设置、账号、模型、历史和笔记弹窗的平面样式，保留真实流程与保护边界。

- `2026-10-31-sidebar-note-actions.md` — Seven sidebar note actions, independent Pinned section, manual display names, canonical source operations, and confirmed permanent deletion with durable cleanup.
- `2026-10-31-llm-note-titles.md` — Automatic LLM note titles after saved transcription, submission-time cloud and one-Credit disclosure, and persistent local title metadata.
- `2026-10-30-desktop-sidebar-home.md` — Approved sidebar and Home redesign, real local history/artifact navigation, compact media composer, and additional capability decisions.

- `2026-07-10-history-task-restore-ownership.md` — Controller-owned history restoration that rejects active workflow switches and prevents stale operation overwrite.
- `2026-07-11-history-vnext-strict-boundary.md` — Strict manifest-only history listing plus on-demand detail for current safe v3 tasks.
- `2026-07-11-local-transcript-ai-workspaces.md` — One task with separate inline local transcript review and independently confirmed AI summary/inspiration workspaces.
- `2026-07-12-history-task-permanent-deletion.md` — Explicit irreversible deletion of one supported History vNext task and its playback cache.
- `2026-07-12-desktop-density-history-toolbar-polish.md` — Intrinsic History height, clearer secondary typography, and a quieter grouped desktop toolbar.
- `2026-07-12-task-workspace-visual-hierarchy.md` — Restrained hierarchy cleanup for local transcript and AI workspaces without changing product, privacy, or workflow boundaries.
- `2026-10-24-transcript-toolbar-actions.md`：结果工作区文字稿工具栏三动作合并规格——「定位文字稿」（未保存编辑拦截）、「复制文字稿」（复制磁盘 `transcript.txt` 正式稿，不受未保存编辑影响）、「整理文字稿」（经 retry_insights `transcript` target 分段 LLM 中度整理，落盘独立 `polished.txt`，成功后按钮变回「复制文字稿」优先复制整理稿，原稿不动）。
- `2026-10-24-summary-agent-runtime.md`：要点总结改经 agent_runtime 顺序交付 Mermaid 脑图与 Markdown 总结，保留既有产物、前端契约和每次实际 LLM 调用一次 checkout 的计费规则。

## AI Insight

- `2026-11-10-llm-byok-custom-providers.md` — v0.6.1 自定义 LLM 配置（BYOK）：设置里添加自己的 OpenAI 兼容 API，预设供应商 + 可自由输入、系统钥匙串存 key、测试连接走 worker 最小 chat 探针、多配置与启用切换；与 Locus 托管并存且默认不变，切到 BYOK 不扣 AI Credit、不需登录，草稿检索仍走 server。设计见 `docs/design-docs/2026-11-10-llm-byok-architecture.md`。
- `2026-10-25-intelligent-extraction-agent-runtime.md` — 三个工作间目标统一使用 agent_runtime，保留产物与隐私契约，删除旧生成目录。
- `2026-07-06-personalized-insight-preferences.md` — Six-field local Inspiration Profile v2 plus per-run six-step generation preferences.
- `2026-10-20-generate-draft.md` — `生成文字稿` 四规格合并：单条 `Insight` 种子成稿（单种子、额度 1 次尝试=1 额度、本地优先隐私边界）；确认页 9 选 1 可改目标平台（取代 `suitable_use` 平台来源，视频号/抖音/Tiktok/X→抖音文体）；结果可编辑落盘 `ai/draft.md` + 重新生成重走首次确认页；渲染优先视图（编辑/渲染模式切换、全屏、无下载）。分栏布局与下载按钮已被渲染优先节取代，保存与重新生成条款继续有效。
- `2026-10-20-ai-detail-sheet-fullscreen.md`：三个 AI 详情 tab 共用全屏切换，关闭弹层时退出全屏，常规尺寸仍按内容收缩。
- `2026-07-31-transcript-dissection.md` — Independent `文字稿解剖` AI target for traceable structural review of a saved transcript.

## Motion UI

- `2026-08-16-motion-ui.md` — Motion 三阶段合并规格：第一阶段处理阶段、ASR 真实进度、AI target 与历史列表的克制动效；第二阶段主要 Sheet 的延迟卸载、焦点保持与进出场动效；第三阶段摘要确认、灵感偏好流程、文字稿解剖确认的延迟卸载与焦点生命周期。

## Web Marketing Site

- `2026-08-05-web-marketing-site.md` — Public marketing site at top-level `site/` using Astro SSG; index/download/privacy three pages with Hallmark anti-AI-slop visual system and zero analytics/tracking.
