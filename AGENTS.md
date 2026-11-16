# Locus：AI 协作规则

本文件是给 AI coding agent 的工作指令：只放"下一个进来干活的 agent 需要知道的事"。历史台账（发布记录、release notes、已完成的执行计划）在 `docs/` 下维护，不在此展开。

`RULES.md` 与本文同时生效，其中每一条都是强制性的语言与行为规则，动手前必须先读。两者冲突时以 `RULES.md` 为准。

## 项目概述

Locus 是本地优先的桌面应用：粘贴公开或已授权的视频链接，本地完成下载、音频提取、SenseVoice Small 语音识别，导出文字稿，并在用户确认且额度充足时进入工作间，用其中的四件工具（要点总结、文字稿解剖、启发灵感、生成文字稿）调用云端 LLM。

- 桌面端：Tauri + React + TypeScript（`app/`）
- Worker：Python + uv（`worker/`），工作间里的四件工具统一使用 agent_runtime
- 服务端：Fastify + SQLite（`server/`），负责账号、激活码月费、LLM 结账与额度

## 目录地图

| 路径 | 职责 | 纳入 git |
| --- | --- | --- |
| `app/` | Tauri + React + TypeScript 桌面客户端 | 是 |
| `worker/` | Python worker：下载、媒体校验、音频提取、ASR、agent_runtime 工作间工具 | 是 |
| `worker-ts/` | TypeScript worker（重写目标）。已落地 `src/asr/`（`Transcriber` 接口与 SenseVoice ONNX 适配器、模型准备）、`src/artifacts/`（原子写与产物事务）、`src/media/`（探测与归一化）、`src/tasks/`（任务目录与 `task.json`）、`src/protocol/` + `src/cli.ts`（线协议入口）、`src/pipeline/`（本地任务与重新生成管线）、`src/ai/`（AI 调用的凭证/请求/工具循环 + 提示词、分块、偏好词表、要点总结、启发灵感、笔记标题、文字稿整理、解剖报告与成稿 agent）、`src/ai/workspace/`（官方 MCP SDK 的 streamable-http 客户端、随包 `SKILL.md` 技能、计划工具与 system 消息注入）、`src/tasks/note-title-{metadata,store}.ts`（标题元数据与清单状态机）、`src/tasks/existing-artifacts.ts`（已有摘要/快照/洞察读回）、`src/pipeline/{transcript-polish-step,draft-step}.ts`（整理稿与成稿的独立步骤）、`src/web/web-page-contract.ts` + `src/pipeline/web-page-save.ts`（网页 URL 规范化与保存契约，`--save-web-page-stdin` 落 `schema_version=4` 网页任务，golden 与 Python 逐字节一致）、`src/storage-validation.ts`（存储校验探针：组件状态矩阵与就绪模型统计，独立脚本入口，输出与 Python 探针逐字节一致）；`--retry-insights-stdin` 的六个 target 全部可用，网页任务按 `article` 来源生成并拒绝 title/transcript；`src/ai/llm-probe.ts`（BYOK 探针 `--probe-llm-stdin`，裸 `{ok, error_code, latency_ms}` 结果行，分类与 Python 探针一致）、`src/sources/`（四平台来源身份识别 `--resolve-source-stdin`，直连 + 三平台短链展开与 Python 逐字段一致）、`src/protocol/process-request.ts`（URL 任务 `--request-stdin` 的请求解析层，35 例 golden 与 Python 逐项一致）、`src/media/{ytdlp,subtitles,download-output,download}.ts`（URL 下载器确定性内核：命令参数与 YouTube 失败分类、SRT/VTT 字幕解析、产物定位、下载编排；三组跨语言 golden 逐项一致，HTML5 实体解码用 `entities@6.0.0`）、`src/tasks/` 的 `UrlTaskSource` / `createUrlTaskContext`（URL 任务 id、`source_url` / `source_identity` / `platform` 清单字段与严格读回，5 组完整清单文本与 20 个读回用例和 Python 逐字节/逐项一致；URL 清单不写 `source_kind`）、`src/media/url-media.ts` + `src/pipeline/url-media.ts`（`--request-stdin` 全链已接通并注册：来源解析 → 建任务 → 下载/媒体准备 → 字幕或 ASR → 清单；10 个媒体准备场景与 Python 逐项一致；下载器由安装脚本按固定版本与 SHA-256 随包，宿主注入 `APP_YTDLP_PATH`；三平台 fallback 全部接通（`src/sources/douyin/`：分享页解析、候选探测与排序、续传重试；`src/sources/xiaohongshu/`：笔记 ID 与短链、`__INITIAL_STATE__` 解析、候选流打分、字幕轨选择与下载；`src/sources/bilibili/`：BV/av 与短链、view/playurl、DASH 选择、分片下载与 ffmpeg 合并；共用 `src/download-reliability.ts`；3 份 golden + 4 组本机 HTTP 冒烟验证），URL 管线的 `probeXiaohongshuSubtitle` 默认接真实实现；三平台真实公网冒烟已完成：B 站与带分享令牌的小红书两侧产物逐字节相同，抖音两侧同为间歇可用，不带 `xsec_token` 的小红书链接两侧同为 `XHS_NOTE_NOT_FOUND`；发行包运行时由 `scripts/build-worker-ts.mjs` 组装成 `resources/worker-ts/`（46.8 MB，随包 Deno + 外置 `node_modules`），Rust 的 `runtime::worker_launch` 在四件资产齐全时自动切到 Deno 并回落 Python，已切换任务四模式、网页保存、模型下载、存储校验与 BYOK 探针；`--download-runtime-component` 与 native session 指纹仍在 Python；macOS 实启动未验证） | 是 |
| `worker/worker_core/summary_agent.py`、`dissection_agent.py`、`topic_agent.py`、`draft_agent.py` | 工作间里的四件工具：要点总结、文字稿解剖、启发灵感、生成文字稿；共用 `ai_runtime.py`、`ai_prompts.py` 与 `transcript_chunks.py` | 是 |
| `server/` | Fastify 账号/额度/LLM 结账服务 | 是 |
| `site/` | Astro 营销站。版本号唯一来源是 `site/src/consts.ts` 的 `LATEST_VERSION`，构建用 `npm --prefix site run build` | 否 |
| `video/` | Remotion 宣传视频工程（`promo-video`、`remotion-video1`） | 否 |
| `scripts/` | 文档校验、版本检查、安装包构建与开发辅助脚本 | 是 |
| `lib-external/` | 外部下载实现的阅读参考（`EasyDownload`、`videodl`），运行期不得 import | 否 |
| `design-system/` | 营销站设计参考与设计变量种子，`banners/` 为生成的图片素材 | 部分 |
| `build/` | 安装包构建的本地运行期缓存（Deno 与 npm 缓存） | 否 |
| `deploy/` | 服务端部署 runbook + Nginx/systemd 参考配置 | 是 |
| `contracts/` | desktop-worker 契约 JSON | 是 |
| `docs/` | 架构、设计、安全、产品规格、执行计划、发布记录 | 是 |
| `outputs/` | 任务产物（视频/音频/文字稿/总结/脑图/灵感 + task manifest） | 否 |
| `models/` | 本地 ASR 模型缓存 | 否 |

标注为「否」的目录由 `.gitignore` 排除，改动不会出现在 `git status`，也不进入代码审查。`design-system/` 只提交 `README.md`、`apple-DESIGN.md`、`globals.css`，`banners/` 同样被排除。`lib-external/` 内部另有 `AGENTS.md`，那是外部项目自带的文件，不构成本仓库的协作规则。

## 常用命令

- 安装依赖：`uv sync --dev`、`(cd app && npm install)`、`(cd server && npm install)`
- Worker 检查：`uv run ruff check worker`、`uv run pytest worker/tests`
- 前端检查：`npm --prefix app test`、`npm --prefix app run lint`、`npm --prefix app run build`
- 服务端检查：`npm --prefix server test`、`npm --prefix server run build`
- Rust 检查：`cargo test --manifest-path app/src-tauri/Cargo.toml`
- 脚本检查：`node --test scripts/tests/*.test.mjs`、`python -m pytest scripts/tests`
- 文档治理：`uv run python scripts/validate_agents_docs.py --level ERROR`、`uv run python scripts/validate_agents_docs.py --level WARN`
- 打包冒烟：`npm --prefix app run tauri -- build --no-bundle`
- ASR 门禁：`node --experimental-strip-types scripts/asr-verification/run.mjs --cache-dir <模型缓存目录>`，直接跑生产代码 `worker-ts/src/asr`，用固定 fixture、模型哈希与逐平台 golden 判定；改 ASR 代码或模型资产后必须复跑。说明见 `scripts/asr-verification/README.md`。
- TypeScript worker：`npm --prefix worker-ts run typecheck`、`npm --prefix worker-ts test`（不需要模型）。
- worker-ts 发行包运行时：`node scripts/build-worker-ts.mjs <目标目录> <deno 可执行文件> <缓存目录> [windows-x64|macos-arm64|macos-x64]`，组装源码树与裁剪后的 `node_modules`，并用随包 Deno 实跑一次 `--resolve-source-stdin` 与协议结果逐字比对；`scripts/build-installer.mjs` 已自动调用。`onnxruntime-node@1.29.0` 没有 `darwin/x64` 原生二进制，`macos-x64` 会在组装阶段直接失败。

`npm --prefix app test` 已内置 `--no-file-parallelism`，用例在 `worker/tests/`。`npm --prefix <dir> install` 在 npm 10 下会失败，`install` 子命令不读取 prefix 配置，`run` 与 `test` 子命令不受影响。完整门禁条件见 `docs/EXECUTION_GATES.md`。

## 核心信念

1. **本地优先**：视频、音频、文字稿、模型缓存与本地历史默认留在用户本机。
2. **处理阶段可见**：UI 必须始终显示清晰处理阶段（输入 → 视频提取 → 视频转译 → 话题点生成 → 完成/失败）。
3. **安装包轻量**：安装包不得内置 ASR 权重、LLM key、云端 LLM 模型或用户私有配置；核心本地 ASR 模型仅在用户提交已验证任务且所选模型缺失时按需下载到 app-local data，启动时不得自动下载。模型版本、缓存、下载进度、取消、失败降级与离线行为必须在产品与 worker 中显式处理。
4. **代码边界**：worker 运行期不得跨目录 import 本仓库的其他模块，尤其不得 import `server/` 的代码；工作间能力由 `worker/worker_core/` 内的 agent、提示词、分段器和报告模块维护。
5. **安全边界**：只处理公开、自有或已授权视频，不绕过平台登录墙、访问控制、CAPTCHA、版权或隐私限制；account 服务不得接收视频/音频/文字稿/洞察/cookie/模型缓存/本地历史内容；真实 `.env`、SQLite、备份、日志、模型缓存、产物与密钥一律不进 git。

## 约束机制

- 模式：`linter+agents`
- 配置：`ruff.toml`

代码风格：

- Python 用 ruff（`ruff.toml`）。
- TypeScript 由 `npm --prefix app run lint` 检查，内含 `tsc --noEmit` 与 `scripts/check-i18n-literals.mjs`。
- 提交信息用英文 conventional commits（如 `fix(server): ...`）。

## 开发流程

非平凡改动（改变用户可见行为或新增边界）按 `WORKFLOW.md` 推进：先读 `RULES.md` 与相关文档 → 更新 product spec → 更新 ExecPlan → 确认后实现。轻量改动仍需 inspect、最小验证、文档同步，并在最终说明列出验证结果与残余风险。

Git 工作流：提交直接进入 `main`，无 feature-branch 工作流。桌面端发布走 `v*` tag → GitHub Releases，发布完成后有三件事必须做：

- 用 `gh release edit vX.Y.Z --notes-file docs/releases/vX.Y.Z.md` 写入已审阅的发布说明，并回读比对正文。`desktop-release.yml` 不设置 release 正文，草稿上显示的只是 `tauri-action` 的占位文本。
- 在 `TASKS.md` 新增版本台账条目，记录发布时间、tag、发布链接、验收要点与残余风险。
- 确认 `docs/releases/vX.Y.Z.md` 与 release notes、completed ExecPlan 的表述一致。

## 快速入口

动手前先读 `RULES.md` 与 `WORKFLOW.md`，收尾对照 `docs/EXECUTION_GATES.md`。

按改动范围查阅：`docs/ARCHITECTURE.md`、`docs/DESIGN.md`、`docs/SECURITY.md`。

索引：`docs/product-specs/index.md`、`docs/design-docs/index.md`、`docs/references/index.md`、`docs/exec-plans/index.md`、`docs/exec-plans/active/index.md`。

台账：`docs/exec-plans/tech-debt-tracker.md`、`docs/releases/`、`TASKS.md`。
