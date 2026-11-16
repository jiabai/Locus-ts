# worker-ts

Locus TypeScript worker。协议入口的全部模式都已迁移：`--download-asr-model`、
`--process-local-media-stdin`、`--retry-insights-stdin`、`--request-stdin`（URL 任务）、
`--save-web-page-stdin`（网页笔记）、`--resolve-source-stdin`（来源识别）与 `--probe-llm-stdin`（BYOK 探针），
另有独立入口 `src/storage-validation-main.ts`。ASR、媒体准备、产物写入、任务存储、AI 六条生成链、
检索工作间与三平台下载 fallback 都在本目录；发行包里由随包 Deno 执行同一份源码，
迁移计划见 `docs/exec-plans/active/2026-11-13-worker-typescript-rewrite-plan.md`。

```bash
npm install          # onnxruntime-node@1.29.0、@modelcontextprotocol/sdk、yaml
npm run typecheck    # tsc --noEmit
npm test             # 不需要模型：接口契约、配置解析、VAD 事件流、缓存校验、下载语义、产物事务、媒体归一化、任务清单、两条管线、AI 请求/工具循环/提示词/偏好词表/标题/整理稿/解剖报告/成稿与检索工作间
```

`deno.json` 固定 `{"nodeModulesDir": "manual"}`，让随包 Deno 解析外置 `node_modules`。
发行包运行时由 `scripts/build-worker-ts.mjs` 组装（源码树 + `skills/` + 裁剪后的 `node_modules`），
宿主按 `deno run --config deno.json --allow-read --allow-write --allow-ffi --allow-run --allow-net --allow-env src/cli.ts <模式>` 启动：

```bash
# 与宿主完全相同的启动形态（组装后的目录或本仓库都适用）
deno run --config deno.json --allow-read --allow-write --allow-ffi --allow-run --allow-net --allow-env \
  src/cli.ts --resolve-source-stdin
```

# 按 worker 协议跑一次模型下载：stderr 事件 + stdout 单行结果 + 退出码
APP_MODEL_DIR=<数据根>/models node --experimental-strip-types src/cli.ts \
  --download-asr-model --asr-model iic/SenseVoiceSmall-onnx

# 跑一条本地音频任务：请求走 stdin，结果一行 JSON
printf '%s' '{"contract_version":4,"source_path":"…/a.wav","media_kind":"audio",
"safe_display_name":"a.wav","source_extension":"wav","asr_model":"iic/SenseVoiceSmall-onnx"}' \
  | APP_OUTPUT_DIR=<数据根>/outputs APP_CACHE_DIR=<数据根>/cache \
    APP_MODEL_DIR=<数据根>/models node --experimental-strip-types src/cli.ts \
    --process-local-media-stdin

# 为已转写的任务重新生成摘要与导图（BYOK 或托管凭证由环境变量提供）
printf '%s' '{"task_id":"<任务 id>","target":"summary","output_language":"zh-CN"}' \
  | APP_OUTPUT_DIR=<数据根>/outputs APP_CACHE_DIR=<数据根>/cache \
    APP_LLM_API_KEY=<key> APP_LLM_MODEL=<model> APP_LLM_BASE_URL=<url> \
    node --experimental-strip-types src/cli.ts --retry-insights-stdin

# 重新生成笔记标题（只接受三个字段；stderr 发两条 title.generation.* 进度事件）
printf '%s' '{"task_id":"<任务 id>","target":"title","output_language":"zh-CN"}' \
  | APP_OUTPUT_DIR=<数据根>/outputs APP_CACHE_DIR=<数据根>/cache \
    APP_LLM_API_KEY=<key> APP_LLM_MODEL=<model> APP_LLM_BASE_URL=<url> \
    node --experimental-strip-types src/cli.ts --retry-insights-stdin

# 整理文字稿（原稿只读，产出 transcript/polished.txt 与 polished.meta.json）
# 每段前发一条 ai.generation.running；整次只 checkout 一次托管凭证
printf '%s' '{"task_id":"<任务 id>","target":"transcript","output_language":"zh-CN"}' \
  | APP_OUTPUT_DIR=<数据根>/outputs APP_CACHE_DIR=<数据根>/cache \
    APP_LLM_API_KEY=<key> APP_LLM_MODEL=<model> APP_LLM_BASE_URL=<url> \
    node --experimental-strip-types src/cli.ts --retry-insights-stdin

# 生成文字稿解剖报告（submit_dissection 单工具交付；产出 ai/dissection.json 与 ai/dissection.md）
# 每次模型请求前发一条 ai.generation.running（attempt/total 固定 6）
printf '%s' '{"task_id":"<任务 id>","target":"dissection","output_language":"zh-CN"}' \
  | APP_OUTPUT_DIR=<数据根>/outputs APP_CACHE_DIR=<数据根>/cache \
    APP_LLM_API_KEY=<key> APP_LLM_MODEL=<model> APP_LLM_BASE_URL=<url> \
    node --experimental-strip-types src/cli.ts --retry-insights-stdin

# 由一条灵感成稿（platform 只接受 9 个 id；检索端点由 ANYSEARCH_MCP_URL 提供）
# 整次只 checkout 一次托管凭证，40 轮工具循环用 submit_draft 交付，产出 ai/draft.md
printf '%s' '{"task_id":"<任务 id>","target":"draft","output_language":"zh-CN","insight_id":5,"platform":"douyin"}' \
  | APP_OUTPUT_DIR=<数据根>/outputs APP_CACHE_DIR=<数据根>/cache \
    APP_LLM_API_KEY=<key> APP_LLM_MODEL=<model> APP_LLM_BASE_URL=<url> \
    ANYSEARCH_MCP_URL=<mcp-url> node --experimental-strip-types src/cli.ts --retry-insights-stdin
```

注意 `src/cli.ts` 只注册了已实现的模式：别的模式参数会以用法错误（退出码 2）失败，不会静默成功。

推理等价性由 `scripts/asr-verification/run.mjs` 用真实模型与固定语料验证。本包不重复那套基线。

## 边界

```text
任务流程  ──►  prepareModelCache  ──►  <数据根>/models/onnx（原子提交）
                │
                └─►  Transcriber（接口）  ──►  SenseVoice ONNX 适配器
                              │                │
                              │                ├─ 前端 / CTC / VAD / 分段
                              └── Transcript   └─ 只读模型缓存，不下载
```

- **只依赖 `src/asr/index.ts`**。任务编排不应 import `sensevoice.ts`、`vad-state.ts` 或
  `onnxruntime-node`；那些是实现细节。门禁会按这条边界检查调用方。
- **闭集模型列表**。`SUPPORTED_ASR_MODELS` 只有 `iic/SenseVoiceSmall-onnx`。历史标识
  （`LEGACY_ASR_MODELS`）可读取但作为新任务输入必须拒绝，不能悄悄落到当前模型。
- **适配器不写产物**。它只返回 `Transcript`；写 `txt`/`md`/分段 JSON、原子替换与事务恢复由任务
  管理模块负责。
- **取消不由转写接口提供**。取消以 Rust 宿主终止完整进程树为准；异步返回值本身不承诺可中断同步
  原生推理。`dispose()` 只负责释放本适配器持有的会话与缓存。模型准备是异步 I/O，接受 `AbortSignal`：
  取消后清掉 staging、不发 `model.download.completed`、发出 `model.download.cancelled`，并以
  `AbortError` 形状的错误离开，不新造错误码。
- **模型准备的来源是固定的**。只从 ModelScope 官方仓库按固定哈希取 9 个文件，不接受自定义 URL、
  镜像或修订；完整性由 `model-assets.ts` 的 SHA-256 判定，端点只负责搬运。

## 错误语义

错误码沿用现有 Python 侧与 worker 契约，不新造码：

| 情况 | 码 |
| --- | --- |
| 无语音、识别结果全空 | `ASR_EMPTY_TRANSCRIPT` |
| 模型文件缺失、哈希不符、就绪标记不匹配 | `ASR_MODEL_NOT_DOWNLOADED` |
| 缓存目录不可读 | `ASR_MODEL_CACHE_UNAVAILABLE` |
| `onnxruntime-node` 缺失或原生模块加载失败 | `ASR_DEPENDENCY_MISSING` |
| 图加载失败、分段失败、单段识别失败、已 dispose 后再用 | `ASR_RUNTIME_ERROR` |
| 模型标识不在闭集内 | `ASR_MODEL_UNSUPPORTED` |
| 下载失败：网络、HTTP 状态、磁盘空间不足 | `ASR_MODEL_DOWNLOAD_FAILED` |
| 下载内容不对：哈希不符、文件缺失、体积超限 | `ASR_MODEL_ARCHIVE_INVALID` |

失败不产生成功文字稿；损坏的缓存不会被当作可用缓存降级使用——半份模型跑出来的结果没人能解释。

## 语言与时间戳

- 语言映射：`Chinese`/`zh`/`zh-cn`/`mandarin` → `zh`，`English`/`en` → `en`，其余 → `auto`。
- 时间戳以源音频起点为零点、单位毫秒，段落按时间升序；段编号 `seg-0001` 起递增（跳过空段，
  因此编号连续但不保证等于 VAD 段序号）。
- `text` 是各段文本以单个空格拼接，与现有 Python 行为一致。

## 产物写入

`src/artifacts/` 负责把文字稿安全落盘，规则见 `contracts/task-artifact-transaction-v1.json`：

```text
writeTranscriptFiles ──► 任务内 transcript/  ──► commitTaskArtifacts（journal + 回滚）
                     └─► 其他目录           ──► 逐文件原子写
```

- `atomic-file.ts`：同目录 staging → fsync → 校验 → `rename`；失败一律 `AtomicFileCommitError`，
  消息里不带路径；目标是符号链接或目录联接时拒止。
- `task-transaction.ts`：最多 8 个闭集目标一次提交。journal 落盘即提交点——`prepared` 恢复必须回滚，
  `committed` 恢复只清材料；回滚材料先读齐再动手，缺一份就整体拒绝。残留清理只认闭集名字。
- `transcript-artifacts.ts`：`transcript.txt` / `.md` / `segments.json` 的文件名、Markdown 结构与平台
  换行与 Python 一致；没有分段时删掉旧 `segments.json`；空文本报 `ASR_EMPTY_TRANSCRIPT`。
- journal 与 Python、Rust 互读：TypeScript 留下的 `prepared` journal 可以被 Python 恢复，反之亦然。

## 线协议

`src/cli.ts` + `src/protocol/` 复现宿主协议，常量来自 `contracts/desktop-worker-contract.json`：

- 进度事件写 stderr，带 `APP_PROGRESS ` / `APP_MODEL_DOWNLOAD ` / `APP_DIAGNOSTIC ` 前缀；
  终态结果是 stdout 上**恰好一行** UTF-8 JSON。
- 退出码：0 结果可用、1 失败终态、2 用法错误（后者不产生结果行）。
- 事件发之前按契约校验码、状态、`current_file` 与 `message_args` 白名单；`current_file` 必须是安全
  basename，不会把路径或敏感词写进事件流。
- 进度表与契约、Python 注册表的一致性由 `scripts/tests/worker-protocol-contract.test.mjs` 守卫。

## 媒体准备

`src/media/` 把用户选中的文件变成任务产物，参数与生产一致，不在这里「优化」：

```text
源文件 ──► download/ 受限复制 ──► ffprobe 校验 ──┬─► media/video.<ext>（原样复制）
                                                └─► media/audio.wav（16 kHz 单声道 PCM）
```

- `ffmpeg -vn -ac 1 -ar 16000 -c:a pcm_s16le`：参数一改，ASR 前端拿到的样本就变。
- 两个产物都走 staging + 探测校验 + 原子替换；归一化后再探测一次（`pcm_s16le`/`s16`/16000/单声道），
  不满足就报 `AUDIO_NORMALIZATION_FAILED`，不把可疑音频送进 ASR。
- 错误码是契约闭集：`LOCAL_MEDIA_VALIDATION_FAILED`、`LOCAL_MEDIA_KIND_MISMATCH`、
  `LOCAL_VIDEO_STREAM_MISSING`、`LOCAL_VIDEO_AUDIO_STREAM_MISSING`、`LOCAL_AUDIO_STREAM_MISSING`、
  `LOCAL_VIDEO_COPY_FAILED`、`AUDIO_NORMALIZATION_FAILED`。
- 本组测试需要本机 `ffmpeg`；没有时整组跳过而不是假装通过。

## 任务存储与本地管线

`src/tasks/` 与 `src/pipeline/local-media.ts` 把前面几块接起来：

```text
stdin 请求 ──► 解析校验 ──► 建任务 ──► 媒体准备 ──► 识别 ──► 文字稿 ──► task.json
```

- **目录布局**与 Python 一致：产物在 `<APP_OUTPUT_DIR>/tasks/<id>/`（`media/`、`transcript/`、`ai/`），
  源文件副本只在 `<APP_CACHE_DIR>/tasks/<id>/download/` 里短暂存在。
- **清单**是宿主、Python、Rust 三方共读的状态：字段集合、`schema_version=3`、`artifacts` 闭集、
  `draft_seed_insight_id` 三态、`note_title` 保留都按 `worker_core/task_store.py` 复刻。TypeScript 写的
  清单能被 Python 的 `load_task_manifest` 完整读回，反之亦然。
- **失败也写清单**：`status=failed` 的 `task.json` 带 `error{code,message,stage}`；只有任务目录都建不
  出来时才返回不带 `task_id` 的结果。
- **PyTorch 模型标识明确拒止**（`ASR_MODEL_UNSUPPORTED`），本 worker 只有 ONNX 一条路径。
- 两个注入点用于单测：`transcriberFactory` 与 `modelCacheValidator`。

## AI 生成

`src/ai/` 分两层：调用层（怎么和模型说话）与生成层（说什么、产物怎么落盘）。

- **凭证**：BYOK 读 `APP_LLM_API_KEY`/`APP_LLM_MODEL`/`APP_LLM_BASE_URL`/`APP_LLM_PROVIDER`/
  `APP_LLM_TIMEOUT_SECONDS`/`APP_LLM_MAX_TOKENS`；托管（`APP_LLM_SOURCE=server`）每次调用前用会话令牌
  换一次临时凭证，`request_id` 递增。输出预算在 checkout 之前校验。
- **请求**：`POST {base_url}/chat/completions`，形状以 Python SDK 的实际抓包为准，golden 在
  `tests/fixtures/insight-request-golden.json`；`Authorization` 只出现在请求头。
- **错误**：401/403 → `AI_LLM_KEY_REJECTED`，404/400-模型不存在 → `AI_LLM_MODEL_UNAVAILABLE`，
  429 → `AI_LLM_RATE_LIMITED`，超时 → `AI_LLM_REQUEST_TIMEOUT`，连接失败 →
  `AI_LLM_NETWORK_FAILED`，读不懂 → `AI_LLM_INVALID_RESPONSE`，其余 → `AI_LLM_REQUEST_FAILED`。
- **工具循环**：多轮 + function 调用；工具返回 `null` 即「交付完成」，不再发起下一次调用；
  轮间可以替换工具集（先导图、再摘要）；空回复重试一次；轮数与参数非法直接拒止。
- 测试全部跑在假服务器/假传输上：请求形状与错误映射可验证，**输出质量不可**——真实调用要等有可用的
  BYOK 或托管凭证。

生成层（已落地，均与 Python 逐字节/逐字段比对）：

- `output-language.ts`：三语语义表（标题、章节名、示例、约束句）。
- `transcript-chunks.ts`：按语义边界切块，给字节偏移与 `sha256`；长度按码点算，和 `len()` 同口径。
- `prompts.ts`：导图与摘要提示词（transcript / article 两种来源）。
- `summary-agent.ts`：一次运行两段交付——先 `submit_mindmap`，换工具后 `submit_summary`；
  非法导图退回重交，纯文本回复点名催促，6 轮上限后按缺失项报 `AI_INVALID_MINDMAP` / `AI_EMPTY_SUMMARY`。
- `insights-agent.ts`：`submit_insights` 单工具交付，块 id 闭集、1–12 条、话题去重与追问数量校验；
  校验失败返回工具反馈让模型重交，6 轮后报 `AI_EMPTY_RESULT`。
- `preference-options.ts` / `preference-snapshot.ts`：两张偏好词表与快照解析，22 个正反例的判定与
  Python 一致，提示词 JSON 与落盘文件逐字节相同。
- `artifacts.ts`：任务内 `ai/` 走多文件事务（摘要、导图、洞察与清单同生共死），导出目录逐文件原子写。
- `note-title.ts`：12000 码点预算的头/中/尾采样、单次 JSON 对象补全与闭集回复解析（重复键拒止、
  Unicode 类别、英文 10 词上限）；标题元数据在 `tasks/note-title-metadata.ts` 只校验一次，
  生成、落盘、读清单共用。
- `transcript-polish.ts`：2000 码点切块（最多 24 段）、上一段末尾 200 码点衔接、逐段 system+user
  文本补全与空段回退；`createPolishLlm` 整次只 checkout 一次、未显式配置 `APP_LLM_MAX_TOKENS`
  时不发 `max_tokens`。`src/pipeline/transcript-polish-step.ts` 负责严格读官方稿、7 个失败码与
  两次独立原子写产物；`polished.*` 不进事务闭集，也不进清单 `artifacts`。
- `dissection-report.ts`：报告模型、闭集校验与五种分类、来源摘要重算、三语 Markdown 与
  JSON/Markdown 字节；`dissection-agent.ts` 用 `submit_dissection` 单工具交付，
  校验失败返回带分类的反馈让模型重交，6 轮为限、最多 16 个来源块。
  `ai/dissection.json` 与 `ai/dissection.md` 和清单进同一事务。
- `draft-platform.ts` / `draft-prompt.ts` / `draft-agent.ts`：9 个平台 id 词表、系统/种子两份
  提示词、`submit_draft` 接收槽与 40 轮工具循环；`createDraftLlm` 整次只 checkout 一次。
  `src/pipeline/draft-step.ts` 在读取权威文字稿之前校验种子，读回偏好快照与摘要，
  把 `ai/draft.md` 与清单放进同一事务并删除 `ai/original/draft.md`。
- `src/ai/workspace/`：`mcp-client.ts` 用官方 SDK 连 streamable-http 检索端点并把
  `tools/list` 的工具并入工具循环；`skills.ts` 用 `yaml` 解析随包
  `skills/viral-writer/SKILL.md`；`planning.ts` 复现 `write_todos` 与计划状态注入；
  `system-block.ts` 用注释哨兵整段替换 system 消息，不随轮数累积。

golden fixture 在 `tests/fixtures/`，由 `work/ai-spike/prompts_golden.py`、
`work/ai-spike/preference_cases.py` 与
`scripts/tests/{note-title,transcript-polish,dissection,draft}-golden.py`
调 Python 实现生成（草稿基准需要 `uv run python`，其余用系统 `python`）——改了提示词、分块规则、
偏好词表、标题采样、整理稿规则、解剖报告规则或工具 schema 就要重新生成并评审差异。

## 重新生成入口

`src/protocol/retry-request.ts` + `src/pipeline/insight-retry.ts` +
`src/pipeline/{transcript-polish-step,draft-step}.ts` +
`src/ai/{dissection-agent,dissection-report,draft-platform,draft-prompt,draft-agent}.ts` +
`src/ai/workspace/{mcp-client,skills,planning,system-block}.ts` +
`src/tasks/{load,source-file,source-text,note-title-metadata,note-title-store,existing-artifacts}.ts`
复现 Python `insight_retry.py` 的六个分支。要点：

- **只读可信状态**：清单加载要过任务 id、链接与 `nlink`、realpath 边界、残留事务恢复、
  schema/来源/标题/产物闭集五层校验；权威源文本必须由清单里的 `transcript_txt` 指向固定路径。
- **一次提交**：`summary` / `insights` / `dissection` 的产物与 `task.json` 进同一事务，
  不出现「文件新、清单旧」。已有洞察、标题、草稿种子与解剖报告从磁盘读回合并，
  不因只重算一项而丢失。解剖报告读回时用当前原稿重算来源摘要，被篡改或过期的文件按「没有」处理。
- **标题另走状态机**：`title` 不生成产物文件，`saveNoteTitle` 用两次单事务把 `note_title` 从
  `generating` 写到 `completed` / `failed`，就地改清单、保留前端写入的其它字段；结果只挂
  `task_id` / `task_dir` / `artifacts`，清单 `status` 不变。stderr 发
  `title.generation.running`（5%）与 `title.generation.completed`（100%），失败码落在
  `note_title.error_code`（`TITLE_OUTPUT_INVALID` / `TITLE_SAVE_FAILED` /
  `TITLE_TRANSCRIPT_UNAVAILABLE` / `TITLE_GENERATION_FAILED` 或供应商错误码）。
- **整理稿另走独立原子写**：`transcript` 自己严格读官方 `transcript/transcript.txt`（原稿字节不变），
  24 段上限在模型调用之前判定，逐段发 `ai.generation.running`（`attempt`/`total` 归一化到 1–100）；
  `polished.txt` 与 `polished.meta.json`（`schemaVersion=1` + 原稿 SHA-256）各原子写一次，
  清单再由 `finalizeTask` 提交。空稿、超长、空结果、写盘失败各有独立错误码。
- **解剖报告**：`dissection` 用未裁剪的权威原稿算来源摘要（SHA-256 与 2000 码点切块），
  模型只交语义部分；`highlights` 必须是原稿逐字子串，来源块 id 必须升序去重且在本次切块内。
  校验不合规时工具返回带分类的反馈让模型重交，6 轮内未交付则报 `DISSECTION_INVALID_RESULT`。
  每次模型请求前发 `ai.generation.running`（attempt/total 固定 6），两个产物与清单一起提交。
- **六个 target 全部可用**：`IMPLEMENTED_RETRY_TARGETS` 等于契约的 `RETRY_TARGETS`，
  临时码 `INSIGHT_TARGET_UNSUPPORTED` 已删除。`summary` / `insights` / `transcript` /
  `dissection` 在任务打开后的失败写 `status=partial_completed` 的清单，阶段
  `insights_generating`；`title` 的失败阶段是 `title_generating`；`draft` 是
  `draft_generating`，三个失败码为 `DRAFT_SEED_INVALID` / `DRAFT_GENERATION_FAILED` /
  `DRAFT_EMPTY_RESULT`。`insights` 成功后清空 `draft_seed_insight_id`（洞察重新编号会让旧草稿种子
  失效），失败则沿用；`draft` 成功则写入本次 `insight_id` 并按产物映射刷新
  `draft_path` / `has_draft`。
- **成稿走检索工作间**：`draft` 在读取权威文字稿之前派发，只读 `ai/insights.json` 里的种子、
  偏好快照与要点总结；种子无效时不消耗额度。检索工具由 `tools/list` 动态注入，
  技能清单与计划状态在每次模型请求前重新写入 system 消息，正文只能经 `submit_draft` 交付。
  `work/interop/draft-cli-smoke.mjs` 用 Python 官方 `mcp` 包起的真实端点验证跨语言往返。
- `insights` 会切块并用 `submit_insights` 交付，`sourceChunkId` 必须是本次真实存在的块 id；
  偏好快照在模型调用之前落盘，提示词与落盘文件都和 Python 逐字节相同。
- 发行包仍保留 Python 运行时的两处入口：`--download-runtime-component`（PyTorch 按需组件，TS 无此模式）与 native web session 的运行时指纹；撤掉随包 Python 前必须迁走，见执行计划的剩余项。
