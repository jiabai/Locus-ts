# 生成文字稿（合并规格）

本文件由下列原始文档合并而成，内容按节忠实保留（原文一级标题降为节标题，代码块原样保留）。原文件已移除；历史台账（`TASKS.md`、completed exec-plans）中对旧文件名的引用按约定保留。

| 节 | 原文件 | 状态 |
| --- | --- | --- |
| 基于所选灵感的文字稿生成 | `2026-07-12-generate-draft-from-inspiration.md` | 父规格；平台来源与结果视图条款被后续节取代，其余边界继续有效 |
| 文字稿生成的目标平台选择（draft 平台可改） | `2026-07-15-draft-platform-selection.md` | 有效增量；与父规格冲突时以本节为准 |
| 文字稿结果：可编辑 + 落盘 + 重新生成 | `2026-07-15-draft-result-editor.md` | 保存与重新生成条款有效；分栏布局与下载按钮被末节取代 |
| 文字稿结果视图：渲染优先、编辑模式与全屏 | `2026-10-20-draft-result-view-modes.md` | 结果视图现行状态 |

## 冲突裁决（合并时确定）

四份规格构成增量链，现行有效状态按以下裁决：

1. **平台来源**：父规格 Prompt Strategy 中「`suitableUse` 决定体裁与形态」已被「文字稿生成的目标平台选择」节取代——成稿平台以用户在确认页选择的 `platform` 为唯一来源，`Insight.suitable_use` 在成稿链路退役（字段保留，仍用于灵感展示）。
2. **结果视图**：父规格 Result Experience 的只读预览先被「文字稿结果：可编辑 + 落盘 + 重新生成」节升级为可编辑，再被「文字稿结果视图：渲染优先、编辑模式与全屏」节改为渲染优先。现行布局以末节为准：渲染模式默认、编辑模式显式切换、全屏切换、无左右分栏、无「下载」按钮。
3. **保存与重新生成**：「文字稿结果：可编辑 + 落盘 + 重新生成」节的保存语义（`ai/original/draft.md` 一次性备份、dirty 判定）、重新生成流程、`load_draft_detail` / `save_draft_edit` 本地 IO 边界继续有效；其中「左右分栏」「下载」「窄屏堆叠」及对应验收项被末节取代。
4. **未改动边界**：单种子、额度（1 次尝试 = 1 额度，不论成败不返还）、隐私（不送 transcript 片段/视频/音频/URL）、错误归属（`JobStage.DRAFT_GENERATING`）、`output_language` 冻结等父规格条款未被后续节改动，继续有效。

---

## 基于所选灵感的文字稿生成

### Background

`工作间` 当前有两张独立 工具卡片：`要点总结（同时生成思维导图文件）` 与 `启发灵感`。`启发灵感` 会从一个已完成任务的文字稿中生成一组结构化 `Insight`（灵感），每条包含议题问句 `topic`、匹配理由 `matchReason`、启发问题 `followUpQuestions`、适合用途 `suitableUse` 和来源片段 `sourceChunkId`。

用户希望把其中**某一条灵感**继续延展成一篇完整、可直接使用的新文字稿（成稿/草稿），并且稿子要能通过联网检索补足事实材料，而不是仅凭灵感问句空写。为此，在 `工作间` 工作区新增第三张独立 工具卡片 `生成文字稿`，其 AI 种子来自用户在 `启发灵感` 中选中的**单条** `Insight`。

这项能力仍服务于桌面端本地优先工作流：视频、音频、文字稿、用户偏好与生成结果默认留在本机。用户在 `生成文字稿` 确认页点击 `确认` 后，worker 以所选灵感字段 + 任务局部偏好快照为种子构造草稿 prompt，交由 agent（anysearch 联网检索 + skills + planning + submit_draft 交付契约）生成成稿；agent 生成中可经 anysearch 联网检索补足事实材料并回灌 LLM 上下文，但**不会**上传视频、音频、原文 transcript 片段或 source URL。任务局部偏好快照与可选的要点总结均由 worker 从任务目录读取，前端不在 draft 请求中重发。

### Goals

- 让用户把一条有启发的问题，延展成一篇可直接使用的新文字稿，而不是止步于灵感列表。
- 稿子要能"找到合适信息"再写：经 anysearch 联网检索补足事实材料，而非仅凭灵感问句空写。
- 把 `生成文字稿` 做成与 `要点总结`、`启发灵感` 平级的第三张独立 工具卡片，共享 AI整理 的卡片模板、类型化状态、额度与隐私纪律。
- 以 `启发灵感` 中选中的单条 `Insight` 作为唯一 AI 种子，沿用已有的结构化灵感数据，不要求用户重新填写偏好。
- 严格保持项目的本地优先与隐私边界：不发送原文 transcript 片段、视频、音频或 source URL；草稿的事实 grounding 来自 anysearch 联网检索（可回灌 LLM 上下文）与可选的要点总结（整篇 summary），而非原文片段。
- 复用既有的确认 / 额度 / 错误归属机制，不引入新的隐私或额度漏洞。

### Non-goals

- 本规格仍是未来独立功能；2026-07-15 桌面多语言实施不新增 `draft` target、命令或 artifact，
  只为未来草稿请求规定与其他 AI target 相同的必填 `output_language`。
- 不做"多选灵感合并成一篇文字稿"；种子严格为单条 `Insight`。
- 不做自由文本 prompt 编辑器或"复制灵感 → 粘贴进某页面"的桥接；种子选取是结构化的应用内动作。
- 不把 AI 生成的草稿写回 `transcript.txt` 或复用 transcript artifact，避免污染本地优先的"正式文字稿"概念。
- 不重新收集 6 步生成偏好；草稿复用当初生成该灵感时使用的任务局部偏好快照（由 worker 从盘读，前端不重发）。
- 不改变主流程：视频提取与文字稿生成仍可在不使用 LLM 的情况下完成。
- 不个性化 `要点总结` 或 Mermaid mindmap。
- 不送原文 transcript 片段、视频、音频或 source URL 作为 LLM 输入；`sourceChunkId` 仅作溯源标注。事实 grounding 来自 anysearch 联网检索；要点总结（整篇 summary）作为可选的原视频内容 grounding，缺失则降级为纯联网检索。
- v1 不在确认页新增 anysearch 检索的数据披露行；用户可见数据文案保持现状。

### Product Model

`生成文字稿` 是 `工作间` 的第三张独立 工具卡片，遵循与 `要点总结`、`启发灵感` 相同的卡片模板：各自拥有状态、额度/隐私说明、确认/重试/查看动作、进度与错误。

- **种子（seed）**：`启发灵感` 结果中由用户选中的单条 `Insight`。未选种子时，本卡片不可用。
- **生成路线**：经 agent（anysearch 联网检索 + skills + planning + submit_draft）成稿，而非单次 LLM 调用；联网检索是 agent 路线的差异化价值，去掉后 agent 退化为无意义的多轮循环。
- **依赖关系**：`生成文字稿` 依赖 `启发灵感` 已成功生成且存在至少一条 `Insight`，并已选中其中一条。这是两张 target 之间的数据依赖，不改变"每张 target 各自独立确认"的原则。
- **产物命名**：卡片 UI 文案为 `生成文字稿`（用户术语）；底层 AI 产物称为 `草稿 / draft`，以区别于 ASR `transcript.txt`。UI 可在卡片副标题注明"（AI 草稿）"以避免语义混淆。

### Seed Selection

种子选择在 `启发灵感` 卡片内完成，而不是在 `生成文字稿` 卡片内：

1. `启发灵感` 列表的每条灵感提供一个 `选为文字稿种子` 的单选交互（radio 或单按钮）。
2. 选中后，该灵感在 `启发灵感` 列表内高亮为"已选种子"，并同步地、只读地在 `生成文字稿` 卡片显示"种子：灵感 #N — <topic 截断>"。
3. 仅允许选 1 条（单种子）。切换选择即更新种子；提供清除选择的交互。
4. 选择是任务级状态，持久化为任务 manifest 的 `draft_seed_insight_id`，便于结果展示与防止 stale 选择。
5. 当 `启发灵感` 被重新生成（如 `换个方向` 后再次确认）时，旧 `insight_id` 可能失效，必须清空 `draft_seed_insight_id`，并使 `生成文字稿` 回到安静禁用态，要求用户重新选择。

### Generation Flow (生成文字稿 Card)

- **未生成启发灵感 / 启发灵感失败 / 未选种子**：卡片安静禁用，提示"请先在启发灵感中选择一条灵感作为种子"。不消耗额度，不暴露 LLM 入口。
- **已选种子**：主按钮 `确认` 可点。
- 点击 `确认` 打开确认页（**不消耗额度**）。
- 确认页点击最终 `确认` 后，经 `retry_insights` 扩展 `target="draft"` 触发 worker 草稿生成（见 Architecture Boundary）。
- 生成期间：复用 `insights_generating` 阶段，`activeAiTarget` 为 `"draft"`；本地工作区保持可读/可回听，文字稿编辑/保存禁用，提示"AI 正在使用已保存版本"。
- 失败：该卡片显示失败态 + 重试入口；错误 `WorkerError.stage` 为 `JobStage.DRAFT_GENERATING`，仅归因到 `生成文字稿`；若其他 target 成功，整体为 `partial_completed`。

### Confirmation Panel

`生成文字稿` 确认页展示：

- **本次输出语言**：展示确认时解析后的实际 UI locale（简体中文、繁體中文或 English），
  不显示 `system` 字样；点击最终确认时冻结该值。
- **种子摘要**：灵感 #N + `topic` 全文。
- **额度说明**：`1 次额度 = 1 次草稿生成尝试`，不论成败、不返还，重试另计；确认页固定显示 `1 次`（根因见 Quota Consumption）。
- **数据提示**：将把所选灵感的字段（`topic` / `followUpQuestions` / `suitableUse` / `matchReason`）与本次任务局部偏好快照发送给管理员配置的云端 LLM 服务；**不会**上传视频、音频或原文全量；任务局部偏好快照只在草稿生成时参与（由 worker 从任务目录读取，复用当初生成该灵感时的快照），不参与 `要点总结` 或 Mermaid mindmap 生成。
- **操作按钮**：`确认`、`取消`。

用户点击 `确认` 后才触发 worker 的草稿生成流程。v1 不在确认页新增 anysearch 检索披露行（用户明确决定）。

### Quota Consumption

- `1 次额度` 表示 1 次 draft 生成**尝试**，不是 1 次 LLM API 调用。draft 采用 one-checkout 结构：一次确认生成只向 server 发起 1 次 LLM checkout，server 在 checkout 当场 `consumeLlmQuota`（`llmQuotaUsed += 1`，`prismaStore.ts:260` / checkout 端点 `server.ts:439`），**不论该次生成最终成功或失败**。
- 失败、超时、空结果或 seed 失效**不返还**额度：server 无 refund / success-gating 路径，`consumeLlmQuota` 当场扣、无回滚。
- 每次确认生成（含重试）各计 1 次：tauri 每次 `retry_insights` 生成新 `request_id`（`account.rs:376` `format!("llm-{}", Uuid::new_v4().simple())`），不命中 server 的 `(userId, requestId)` 幂等，故重试另计。
- 仅进入确认页或点击 `取消` 不消耗额度（不发起 checkout）；账户或额度预检未通过时草稿生成不开始，也不消耗额度。
- anysearch 联网检索调用**不计入**用户额度（`anysearch/checkout` 不调 `consumeLlmQuota`）；server/LLM 供应商侧成本随 agent 轮数增长（`max_turns` 默认 40），由 FrameQ 承担，靠 `FRAMEQ_DRAFT_MAX_TURNS` env 收紧。
- 草稿生成不隐式扣除 `要点总结` / `启发灵感` / Mermaid mindmap 的额度。

> 撤回早前"1 额度 = 1 LLM 调用 / 按实际调用次数 / 失败不返还 / 不得固定显示 1 次"的额度单位表述：核实 server（`consumeLlmQuota` 当场扣、无 refund）+ tauri（每次新 `request_id`）后，draft 额度模型定为"1 次尝试 = 1 额度，不论成败"，确认页固定显示 1 次。若未来要"失败不计 / 免费重试"，需 server 侧加 success-gating 或 refund 端点（跨 server+worker 改动），记为未来项。

### Result Experience

- 成功：写入底层 artifact `{task_dir}/ai/draft.md`（UI 称"草稿/成文"），与 transcript/summary/insights/mindmap 并列、互不覆盖。
- `生成文字稿` 卡片提供 `查看`、`复制`、`导出（定位文件）` 动作；查看使用经净化的 Markdown 渲染（GitHub Flavored Markdown），不渲染原始 HTML 或 Mermaid 源码。
- 草稿是独立 artifact，不与官方 transcript 共用容器，也不可作为官方 transcript 编辑/导出。
- 失败：卡片展示结构化错误原因、重试入口与可修改入口；重试走同一确认 / 额度流程。

### Draft Artifact Schema

- 文件：`{task_dir}/ai/draft.md`（`TaskPaths.draft_path`）。
- `ProcessResult` 增加 `draft: str` 字段（类比 `summary` / `insights`）；Rust `ProcessVideoResult` 同步增 `draft: String`。
- 任务 manifest 增加 `draft_path` / `has_draft` / `draft_seed_insight_id`，用于历史展示与定位；不复制草稿全文进 manifest。
- UI 详情、复制文本、导出定位均以该 artifact 为准。

### Prompt Strategy

worker 的 `build_draft_from_inspiration_prompt(seed: Insight, preference_snapshot: PreferenceSnapshot | None, output_language, summary: str | None = None) -> str`（位于 `worker/frameq_worker/ai_prompts.py`），构造草稿**种子 prompt** 供 agent 消费（agent 叠加 anysearch 联网检索 + skills + planning + submit_draft 交付契约成稿），并遵守以下规则：

- **输出语言**：`output_language` 必须复用共享的 `zh-CN | zh-TW | en-US` 闭集，使用固定
  enum 派生的语言指令覆盖标题、正文和所有用户可见生成内容；不得把任意 UI 字符串直接拼为指令。
- **输入**：单条 `Insight` 的结构化字段 + 任务局部 `PreferenceSnapshot`（缺失则无个性化降级）+ 可选要点总结 `summary`（整篇，作为原视频内容 grounding；缺失则略过）。不拼接 transcript 片段、视频、音频或 URL。
- **角色**：把一条可迁移的议题问句延展为一篇完整、可直接使用的成稿/文字稿。
- **骨架**：`topic` 作为中央议题 / 标题方向；`followUpQuestions` 作为章节结构 / 子论点展开角度。
- **约束**：`suitableUse` 决定体裁与形态并写入 prompt 作为平台方向；`skills/` 下的平台文体 skill（v1 由 `viral-writer` 覆盖 抖音/小红书/公众号，注意 `公众号` ↔ skill 内 `微信公众号` 名称映射）由 agent 自取加载，后端不做 suitableUse→skill 硬匹配；其余取值（视频号/b站/播客/课程·社群/内部分享）走 LLM 通用兜底。加新平台 = 在 `skills/` 丢 `SKILL.md`，零代码改动。`matchReason` 作为目标感锚点，防止跑题；`PreferenceSnapshot`（goal / scenario / angles / audience / styles / avoid）决定语气、受众、角度与避雷方向。
- **溯源而非输入**：`sourceChunkId` 仅用于向 LLM 说明该灵感的来源片段编号，或用于结果中标注溯源；其对应片段文本**不进入 prompt**。v1 不送原文 transcript 片段；整篇要点总结 summary 是允许的可选 grounding。
- **原创性**：产出应为原创成稿；若草稿引用原文字稿中的具体观点或案例，须显式标注来源，不得伪装为凭空原创。
- **外部引用标注**：草稿引用 anysearch 检索来的事实/案例时，须显式标注来源（v1 依赖 prompt 指令；web 引用结构化模型留待后续）。
- **个性化降级**：当任务局部偏好快照缺失时，按"无档案 / 不指定"处理，不得补任何默认画像、角色、领域或风格。
- 生成内容应主动避开 `avoid` 中声明的方向；`styles` 调整措辞而不改变事实判断。

### Data and Storage

- 草稿 artifact 写入任务目录，与 `transcript`、`summary`、`insights`、`mindmap` 并列，互不覆盖。
- **任务局部偏好快照必须持久化**：草稿复用当初生成该灵感时使用的快照（worker 从 `ai/preference-snapshot.json` 读）。若快照缺失，草稿以无个性化方式生成（不阻断、不伪造画像）。
- **要点总结作为可选 grounding**：worker 从 `ai/summary.md` 读取（前端不发）；缺失则降级为纯联网检索，不阻断。
- 日志、错误文案和诊断信息不得输出完整个人档案、完整生成偏好、完整 prompt、完整 transcript 或草稿全文。
- 草稿与偏好快照均属于本地任务产物，不上传 FrameQ server。

### Architecture Boundary

- 这是 `AI整理` 的信息架构扩展，不是 worker 流水线重写。它不得改变 `process_video`、stdin 传输、server 权益/额度职责、`SourceIdentity`、任务存储或 `ProcessSupervisor` 内部。
- **触发方式**：经 `retry_insights` 扩展 `target="draft"` 触发（`RetryInsightsRequest{ task_id, target="draft", insight_id, preference_snapshot? }`），复用既有确认、额度预检、监督、取消与 `partial_completed` 降级；不新增独立 Tauri 命令。退役独立 CLI `--generate-draft-json` / `generate_draft_once` / `GenerateDraftRequest`（落盘逻辑吸收进 `retry_insights_once` 的 draft 分支）。`retry_insights` 仍是唯一可构造 AI client、接收 server-managed checkout、消耗额度的本地 worker 调用。
- target=draft 的 stdin request 同样必须包含确认时冻结的
  `output_language: "zh-CN" | "zh-TW" | "en-US"`；TypeScript、Rust、Python 拒绝缺失或非法值，
  不允许旧调用默认语言。
- worker 仅接收选中 `insight_id`；由 worker 自行从 `ai/insights.json` 取该 Insight 结构化字段、从 `ai/preference-snapshot.json` 读偏好快照、从 `ai/summary.md` 读可选 summary grounding。前端在 target=draft 请求中**不携带** `preference_snapshot`（避免覆盖当初生成灵感时的快照）。worker 不读取、传递或拼接 transcript 片段、视频、音频或 URL。
- **类型化状态**：前端 `activeAiTarget` 扩展为 `"summary" | "insights" | "draft" | null`；UI 行为不得从状态文案推断 target。底层仍复用 `insights_generating` 阶段，target 归属为 `draft`，错误 target 经 `aiErrorTarget="draft"` 投影。
- 本地进度与 AI target 状态为分离的视图模型投影；AI 生成期间本地投影保持 ready（transcript 可用）。
- `FrameQ server` 仍只负责账号、权益、配额和 LLM+anysearch checkout；server 不接收、不存储灵感、偏好或草稿，不为草稿新增接口或字段。
- LLM supplier 在用户确认后收到灵感字段 + 偏好快照 + agent 生成中经 anysearch 检索回灌的事实材料 + 可选 summary grounding；**不收到** transcript 片段、视频、音频或 URL。确认页用户可见数据文案保持"把所选灵感字段 + 偏好快照发送给云端 LLM；不上传视频/音频/原文全量"，v1 不新增 anysearch 检索披露行（内部边界放宽、确认页文案不变）。
- 两张 target 之间存在数据依赖（草稿依赖启发灵感结果 + 选中），但各自保持独立的状态、确认、额度与错误归属；历史恢复时两工作区共享同一 taskId。

### Validation Rules (new)

- `insight_id` 必须在当前任务 `insights.json` 中存在；不存在（例如 `启发灵感` 已重新生成且编号变化）时，worker 返回 `DRAFT_SEED_INVALID`（或等价明确错误）并要求用户重新选择种子，不得静默使用错误条目，且不消耗草稿 LLM 调用。
- 种子选择随 `启发灵感` 重生成而失效：重生成成功后清空 `draft_seed_insight_id`，`生成文字稿` 回到安静禁用态。
- `生成文字稿` 不得在 `启发灵感` 未生成、生成失败或 `draft_seed_insight_id` 为空时发起任何 worker 调用。
- target=draft 请求中前端不携带 `preference_snapshot`；worker 从 `ai/preference-snapshot.json` 读取，缺失则按无个性化降级，不伪造画像。
- draft 失败的 `WorkerError.stage` 用 `JobStage.DRAFT_GENERATING`，使错误归因到 draft target 而非 insights。
- 成稿生成默认不打印工具参数、工具返回内容、模型回复片段或完整异常转储；异常返回保留
  `DRAFT_GENERATION_FAILED` 与 `draft_generating`，消息固定为 `Draft generation failed.`。
  工具交付、空结果检查及已有产物的失败保护保持有效；hook 与 MCP 清理警告只包含固定事件信息。

### Acceptance Criteria

- `工作间` 显示三张独立 工具卡片：`要点总结（同时生成思维导图文件）`、`启发灵感`、`生成文字稿`；三者共享卡片模板、类型化状态、额度与隐私纪律。
- `生成文字稿` 在未生成启发灵感、启发灵感失败或未选种子时安静禁用，提示先选一条灵感；不消耗额度、不暴露 LLM 入口。
- `启发灵感` 列表中每条灵感提供 `选为文字稿种子` 单选；选中后高亮并同步到 `生成文字稿` 卡片显示种子摘要；仅允许选 1 条，可清除。
- `activeAiTarget` 类型扩展为 `"summary" | "insights" | "draft" | null`；UI 不依赖状态文案推断 target。
- `生成文字稿` 确认页展示种子摘要、额度说明（1 次确认生成尝试 = 扣 1 次额度，不论成败不返还，重试另计；agent 多轮规划/写作与 anysearch 检索不另计）与数据提示（只发灵感字段 + 任务局部偏好快照，不上传视频/音频/原文全量；v1 不披露 anysearch）。
- `生成文字稿` 确认页展示实际输出语言；最终确认冻结并发送共享 enum 的
  `output_language`，生成中切换 UI 不改变该请求，重试使用重试确认时的新语言。
- 确认后才触发 worker 调用；每次确认的 checkout 扣 1 次额度，不论成败不返还，重试另计；仅进入确认页或取消不扣；anysearch 检索不计额度。
- 草稿经 agent（anysearch 联网检索 + skills + planning + submit_draft）生成；worker 仅接收 `insight_id`，自行读取 Insight 字段 + 偏好快照 + 可选 summary，不发送 transcript 片段、视频、音频或 URL；`sourceChunkId` 仅作溯源标注，不作为 LLM 输入。
- 草稿写入 `ai/draft.md`；`ProcessResult` 含 `draft`，manifest 含 `draft_path` / `has_draft` / `draft_seed_insight_id`；UI 提供查看/复制/导出，且不与官方 transcript 共用容器。
- 任务局部偏好快照被持久化以支持草稿复用（worker 从盘读，前端 draft 请求不重发）；缺失时草稿以无个性化方式生成，不伪造画像。
- `insight_id` 校验存在，失效返回 `DRAFT_SEED_INVALID` 且不消耗额度；`启发灵感` 重生成后清空种子选择并使 `生成文字稿` 回到禁用态。
- `生成文字稿` 失败仅归因本 target（`JobStage.DRAFT_GENERATING`）；整体 `partial_completed` 时其他 target 的成功产物不受影响。
- `FrameQ server` 不新增保存灵感、偏好或草稿的接口或字段。

---

## 文字稿生成的目标平台选择（draft 平台可改）

> 本规格是 `2026-07-12-generate-draft-from-inspiration.md` 的增量优化。父规格定义了 `生成文字稿` 这张 工具卡片与单条 `Insight` 种子、额度、隐私边界；本规格只改动「目标平台从哪来、怎么映射、用户能否改」这一条链路，不重述父规格的其他内容。冲突时以本规格为准。

> 相关文档：执行计划 [`2026-07-15-draft-platform-selection-plan.md`](../exec-plans/completed/2026-07-15-draft-platform-selection-plan.md)、设计方案 [`2026-07-15-draft-platform-selection.md`](../design-docs/2026-07-15-draft-platform-selection.md)。

### Background

`生成文字稿` 的目标平台来自用户在确认页的选择，`worker/frameq_worker/ai_prompts.py` 与 `draft_agent.py` 使用同一平台映射生成指令。`Insight.suitable_use` 继续用于灵感展示，灵感档案的 `platforms` 用于推导确认页的默认选项。

本次优化把「目标平台」变成**用户在 `生成文字稿` 确认页可见、可改的单选项**，并重做平台→文体映射：

- 平台来源从 `Insight.suitable_use` 切换为**用户在确认页选择的平台**；`suitable_use` 在成稿链路退役（仍留在 `Insight` 上做展示/他用，不删除字段）。
- 确认页默认值由灵感档案的 `platforms` 推导：档案**恰好 1 个且可映射**时预选它，否则默认「其他」。
- 用户改选平台**只影响本次稿子生成**，不回写灵感档案。
- 平台→prompt 文体映射重做（见 Platform→Form Mapping）。

### Goals

- 让用户在生成稿子前**看到并修改**目标平台，而不是由 `suitable_use` 在后台静默决定。
- 默认值尽量贴合用户既有偏好：灵感档案恰好配了 1 个可映射平台时，确认页直接预选它，减少手动操作。
- 把平台→文体的映射收敛到一套与用户选项对齐的新词表，覆盖短视频系（抖音 / 视频号 / Tiktok）统一走「抖音」文体；X(Twitter) 与 B站 / Youtube / 其他按显示名透传，不套短视频文体。
- 严格保持父规格的本地优先、隐私、额度、单种子、错误归属边界：平台是一个请求态字段，不落盘、不进 manifest、不回写档案、不上传 FrameQ server。

### Non-goals

- **不持久化平台选择**：不写进 draft manifest、不写进任务 manifest、不回写灵感档案；重开历史 draft / 重试时重新走默认推导 + 用户改选。
- **不改灵感档案 `platforms` 词表**：档案仍维持现有 8 项；draft 平台是**独立的新词表**（9 项，含 Youtube / Tiktok / X(Twitter) / 其他），与档案词表部分重叠但互不等同。
- **不做多平台一次生成多篇**：draft 仍是 1 seed → 1 平台 → 1 篇 → 1 额度（父规格 Quota 不变）。
- **不改父规格的隐私/额度/种子校验/错误归属**：确认页数据提示文案保持现状（不新增平台相关的数据披露行）；额度仍为「1 次尝试 = 1 额度，不论成败」。
- **不删除 `Insight.suitable_use` 字段**：它仍在灵感生成与展示中使用，只是不再作为成稿平台来源。

### Platform Vocabulary

`生成文字稿` 确认页提供 **9 个单选项**（稳定英文 id + 中文显示名，id 风格与档案 `platforms` 对齐）：

| id | 显示名 |
|---|---|
| `bilibili` | B站 |
| `xiaohongshu` | 小红书 |
| `wechat_official_account` | 公众号 |
| `wechat_channels` | 视频号 |
| `douyin` | 抖音 |
| `youtube` | Youtube |
| `tiktok` | Tiktok |
| `twitter` | X(Twitter) |
| `other` | 其他 |

> 与档案 `platforms` 的关系：`douyin / xiaohongshu / wechat_channels / bilibili / wechat_official_account` 5 项 id 复用，便于默认推导恒等映射；`youtube / tiktok / twitter / other` 4 项是 draft 独有，**档案词表里没有**，只能由用户在确认页手动改选，无法从档案自动预选。档案里的 `podcast / course_community / internal_sharing` 在 draft 词表里**无对应项**，归为不可映射。

### Default Platform Derivation

确认页打开时，按灵感档案 `platforms` 推导默认选中项（前端读取本地偏好，复用 `getInsightPreferences`）：

1. 档案 `platforms` 为空 / 档案被跳过 / 档案不存在 → 默认 `other`。
2. 档案 `platforms` 恰好 1 个且**可映射**（id 属于上述 9 项的交集）→ 预选该 id（恒等映射：`douyin→douyin`、`xiaohongshu→xiaohongshu`、`wechat_channels→wechat_channels`、`bilibili→bilibili`、`wechat_official_account→wechat_official_account`）。
3. 档案 `platforms` 恰好 1 个但**不可映射**（`podcast / course_community / internal_sharing`）→ 默认 `other`。
4. 档案 `platforms` ≥ 2 个 → 默认 `other`（不替用户猜优先级，让其自己挑）。

默认推导**只读档案、不写档案**。

### User Modification

- 确认页的平台选择是**可修改的单选**（chip / radio 风格，与灵感档案选项控件一致）。
- 用户改选后，**本次生成请求**携带新平台；不回写灵感档案 `platforms`，也不写任何持久化存储。
- 平台始终有值（默认 `other` 兜底），不存在「未选平台」的空态，故不引入新的校验阻断。

### Platform→Form Mapping

worker 侧把用户选的平台 id 映射成 prompt 里的「目标平台」文体标签，取代原 `_platform_label_for_suitable_use`（以 `suitable_use` 为输入）：

| 选的平台 id | prompt「目标平台」 |
|---|---|
| `wechat_official_account` | 微信公众号 |
| `xiaohongshu` | 小红书 |
| `wechat_channels` / `douyin` / `tiktok` / `twitter` | 抖音 |
| `bilibili` / `youtube` / `other` | 透传显示名（兜底） |

兜底分支沿用父规格的「原样透传」语义：prompt 写成「目标平台：{显示名}」（如 `other` →「目标平台：其他」），不挂特定平台 skill，走 LLM 通用文体。> 已知粗糙边：`other` 透传会渲染「目标平台：其他。请按该平台文体…」，语义略空，但用户在盘问中明确接受（产品定位为视频文案，`other` 极少被主动选用）。

> `twitter`(X) 归入「抖音」组是产品决定：本场景稿子主要服务于视频文案，X 在此处按短视频脚本风格处理，而非文字 Thread。

### Data and Wire Boundary

- **请求态字段**：前端在 `target="draft"` 的 `RetryInsightsRequest` 上**新增 `platform: string`**（9 个 id 之一），与既有 `insight_id` 并列；`preference_snapshot` 仍**不发送**（父规格 A1 不变，由 worker 从盘读）。
- **不持久化**：`platform` 不进 draft artifact、不进任务 manifest、不进 draft manifest；与父规格「manifest 增加 `draft_path` / `has_draft` / `draft_seed_insight_id`」无关，本规格不新增任何 manifest 字段。
- **不上传 server**：FrameQ server 仍只负责账号/权益/配额/LLM+anysearch checkout，不接收、不存储平台选择，不为此新增接口或字段。
- **隐私不变**：平台 id 非用户敏感数据，但遵循父规格「日志不得输出完整 prompt」纪律——平台标签会出现在 prompt 中，日志按既有字段白名单处理，不额外打印 prompt 全文。

### Validation Rules (new)

- `target="draft"` 请求**必须**携带 `platform`，且值属于 9 个合法 id 之一；缺失或非法时 worker 返回明确错误（如 `INVALID_DRAFT_PLATFORM`），且**不消耗额度**（在 checkout 之前校验，对齐父规格「invalid seed 不扣额度」的代码顺序原则）。
- `platform` 字段**只允许出现在 `target="draft"`**；`summary` / `insights` 请求携带 `platform` 视为非法（保持非 draft 请求与历史契约字节一致）。
- 默认推导只读档案：档案缺失/被跳过时不得伪造平台偏好，统一降级为 `other`。
- worker 不再从 `Insight.suitable_use` 推导成稿平台；prompt 构造与 system prompt 均以传入的 `platform` 为唯一平台来源。

### Acceptance Criteria

- `生成文字稿` 确认页展示 **9 选 1** 的目标平台控件；默认值按 Default Platform Derivation 推导（档案恰好 1 个可映射→预选，其余→`other`）。
- 用户改选平台后，本次生成按新平台映射成稿；改选**不回写**灵感档案，重开/重试时重新推导默认。
- worker 的平台→文体映射符合 Platform→Form Mapping：公众号→微信公众号、小红书→小红书、视频号/抖音/Tiktok/X→抖音、B站/Youtube/其他→透传兜底。
- `target="draft"` 请求携带合法 `platform`；缺失/非法/在非 draft target 出现时返回明确错误且不扣额度。
- `platform` 不落盘、不进 manifest、不上传 server、不回写档案。
- 父规格的全部验收项继续成立（单种子、额度 1 次/尝试、隐私边界、`JobStage.DRAFT_GENERATING` 错误归属、`activeAiTarget="draft"` 类型）。
- 确认页数据提示文案与父规格一致，不新增平台相关披露行。

---

## 文字稿结果：可编辑 + 落盘 + 重新生成

### Background

父规格 `2026-07-12-generate-draft-from-inspiration`（本文件第一节）落地后，`生成文字稿` 的结果由 `DraftResultSheet` 以**只读预览**呈现：`workflow.draft` 经 `MarkdownContent`（remark-gfm + rehype-sanitize + skipHtml）渲染，工具区仅「复制（markdown）」+「导出（定位 `ai/draft.md` 文件）」。`ai/draft.md` 由 worker 在生成时一次性写入，前端只读，无写回通道；卡片 ready 后只有「查看结果」，没有「已生成状态下重新生成」的路径。

本规格是父规格的增量，把结果视图升级为**可编辑 + 可落盘 + 可重新生成**：

- 左右分栏：左侧 `textarea` 编辑 markdown 原文，右侧 `MarkdownContent` 实时预览。
- 编辑落盘覆盖本地 `ai/draft.md`（走受约束的本地 tauri 命令，**不上 server**）。
- 「复制」「下载」基于编辑器当前文本（markdown 原文）；「导出（定位文件）」降级保留。
- 「重新生成」：重走首次生成的确认页流程（重选 / 确认种子 + 偏好 + 平台），与第一次逻辑完全一致；编辑过则二次确认。

本能力仍服从桌面端本地优先工作流与父规格的全部边界。与 `2026-07-15-draft-platform-selection`（本文件第二节）正交：本规格不改平台链路，平台仍按那份规格的「请求态」处理。

### Goals

- 让用户在查看草稿时就能**就地修改**，而不是只能复制到别处编辑。
- 手改结果**落盘到本地 `ai/draft.md`**，与生成产物同源，后续查看 / 导出 / 复用一致。
- 「复制」「下载」都拿到**编辑后的 markdown 原文**，下载产出独立 `.md` 文件。
- 提供「重新生成」入口，复用首次生成的确认 / 额度 / 隐私纪律，避免用户退回卡片重走全套选择。
- 顺带修复「历史任务看不到草稿」的旧缺口（结果视图按需从盘读）。

### Non-goals

- 不做代码编辑器级体验（不上 CodeMirror / Monaco，无语法高亮 / 行号 / 软换行优化）。
- 不改右侧渲染保真度（复用 `MarkdownContent`：原始 HTML 仍剥离、Mermaid 仍显示为代码块）。
- 不持久化平台、不改平台→文体映射（platform-selection 的请求态不变）。
- 不新增 server 接口或字段（父规格红线：FrameQ server 不存草稿 / 灵感 / 偏好）。
- 不做多版本 / 编辑历史快照（仅 `ai/original/draft.md` 一次性备份，对齐 transcript 编辑器）。
- 不改 draft 生成链路、prompt、agent、额度模型、隐私边界。
- 不把草稿写回 `transcript.txt` 或与官方 transcript 共用容器（父规格 Non-goal 不变）。

### Result Experience（修订父规格同名章节）

`生成文字稿` 结果视图（`DraftResultSheet`）从只读预览升级为**左右分栏编辑器**：

- **左侧**：受控 `textarea`，编辑 markdown 原文。打开时经 `load_draft_detail` 从盘读 `ai/draft.md` 作为初始内容（不再依赖 `workflow.draft` 是否被填充，因而历史任务也能查看 / 编辑）。
- **右侧**：`MarkdownContent` 实时渲染左侧缓冲（与摘要 / 灵感详情渲染一致：GFM、剥离原始 HTML、Mermaid 为代码块）。
- **工具区**：
  - `复制`：编辑器当前文本 → 剪贴板。
  - `下载`：基于编辑器当前文本生成 `.md`（Blob 下载）；文件名取首行 `# 标题`，无标题则 `{taskId}.md`。
  - `导出（定位文件）`：本地有 `taskDir` 时作为次要入口保留，定位 `ai/draft.md`。
  - `重新生成`：见下节。
- **保存语义**：编辑落盘覆盖 `ai/draft.md`，首次编辑前把 AI 原产出一次性备份到 `ai/original/draft.md`（基线 + 恢复点）；后续编辑不再覆盖 original。
- **dirty 一致性**：复制可用编辑器当前文本；`下载` / `导出` 在未保存时提示先保存，避免下载 / 定位到与盘上不一致的内容（对齐 transcript 编辑器决策）。
- **窄屏**：左右分栏退化为上下堆叠。
- 失败态：`ai/draft.md` 缺失 / 读取失败 / 保存失败给出可恢复提示，不崩视图。

### Regeneration

在结果视图新增「重新生成」入口（`workflow.draft` 非空或 `has_draft` 时可用），**逻辑与第一次生成完全一致**——重走确认页，不做静默一键复用：

- 当前任务的草稿详情读取结束前，「重新生成」禁用且不接受触发；关闭、重新打开或切换任务时重新等待本次读取，不能沿用上一任务或上次打开时的种子。
- 读取成功后优先采用当前详情的种子，再采用当前任务 `workflow.draftSeedInsightId`。读取失败显示既有提示，并允许使用当前任务的种子进入确认页；没有种子时沿用既有种子校验和重新选择要求。

1. **dirty 拦截**：若 `workflow.draftEdited === true`（用户已手改），弹二次确认「将丢弃当前编辑（含已落盘的 `ai/draft.md`），是否继续？」；取消则不发起调用、不扣额度。
2. **打开 `DraftConfirmationSheet`**（与首次生成同一个确认页）：
   - 种子：预选当前 `draftSeedInsightId`（当次会话）或 `load_draft_detail` 回传的 `draft_seed_insight_id`（历史）。
   - 偏好快照：前端**不携带**（父规格 Architecture Boundary），worker 从 `ai/preference-snapshot.json` 读，与首次一致。
   - 平台：确认页按 platform-selection 规则从档案推导默认，用户可改选。
3. 用户在确认页点「确认」→ 经既有 `retry_insights`（`target="draft"`，带 `insight_id` + `platform`）触发 worker。
4. 复用父规格的确认 / 额度 / 监督 / 取消与 `partial_completed` 降级；每次重生 checkout 扣 1 额度，不论成败不返还（父规格 Quota Consumption 不变）。
5. **重生成功**：`finishInsightRetry(target="draft")` 重置 `workflow.draftEdited = false`，并把 `ai/original/draft.md` 刷新为新 AI 产出（下次编辑的新基线）。

种子失效（如 `启发灵感` 已重生成、id 变化）时，按首次生成纪律要求用户先在 `启发灵感` 重选种子，不静默用错误种子（父规格 `DRAFT_SEED_INVALID` 纪律不变）。

### Data and Storage（增补父规格同名章节）

- 编辑落盘覆盖 `{task_dir}/ai/draft.md`，与 transcript / summary / insights / mindmap 并列、互不覆盖。
- 首次编辑前一次性备份 AI 原产出到 `{task_dir}/ai/original/draft.md`（仅一次，对齐 `transcript/original/`）。
- 任务 manifest 维持父规格的 `draft_path` / `has_draft` / `draft_seed_insight_id`。`draft_preview` 已移除（无消费者、worker 重写会丢失；待需要时再加）。
- 草稿、original 备份、偏好快照均属本地任务产物，**不上传 FrameQ server**。

### Architecture Boundary

- 这是 `AI整理` 结果视图的增量，不是 worker 流水线或 server 职责变更。不改变 `process_video`、stdin 传输、server 权益 / 额度职责、`SourceIdentity`、任务存储或 `ProcessSupervisor` 内部。
- **落盘走本地 tauri 命令** `load_draft_detail` / `save_draft_edit`（`app/src-tauri/src/draft_detail.rs`，照搬 `transcript_detail.rs` 的受约束 IO 边界）。**FrameQ server 不新增保存草稿的接口或字段**（父规格红线不变）。
- 安全校验与 transcript 详情同源：路径穿越（`validate_task_artifact_path`）、软链 / reparse point（`reject_linked_artifact_target`）、隔离 / 旧格式任务（`ensure_task_source_privacy_ready`）、空内容（trim 后为空拒绝）；全部 recoverable，不写半文件。
- 重新生成复用既有 `retry_insights` 的 `target="draft"` 分支（父规格触发方式不变），不新增独立 Tauri 命令；偏好快照仍由 worker 从盘读，前端 draft 请求不重发。
- 类型化状态：前端 `activeAiTarget` 仍为 `"summary" | "insights" | "draft" | null`，新增 `workflow.draftEdited` 仅供 dirty 判定，不影响 target 归属或阶段。
- 平台仍是请求态：重生重走确认页，平台在确认页重新选定（与首次一致），不持久化、不回写档案、不上 server（platform-selection 不变）。

### Validation Rules (new)

- `save_draft_edit` 拒绝空内容（trim 后为空）；拒绝 draft 路径不落在 `{task_dir}/ai/draft.md` 的请求（路径穿越）；拒绝目标或父目录为软链 / reparse point；拒绝未完成 source-privacy 迁移 / quarantined 的任务。以上均 recoverable，不写半文件、不创建 original 备份。
- `ai/original/draft.md` 仅在首次编辑时创建一次；后续编辑不覆盖；重新生成成功后刷新为新 AI 产出。
- 「下载」/「导出」在 `draftEdited === true` 时必须先提示保存；保存成功后清 dirty。
- 重新生成在 `draftEdited === true` 时必须二次确认；取消则不发起 worker 调用、不扣额度。
- 重新生成重走首次确认页；种子 `insight_id` 必须在当前任务 `insights.json` 中存在，失效（如灵感已重生成、id 变化）时要求先在 `启发灵感` 重选种子，不得静默用错误种子（父规格 `DRAFT_SEED_INVALID` 纪律不变）。
- 重新生成仍过配额 / 账号预检；预检未通过不开始、不扣额度（父规格不变）。

### Acceptance Criteria

- `生成文字稿` 结果视图为左右分栏：左侧 `textarea` 可编辑 markdown 原文，右侧 `MarkdownContent` 实时预览；窄屏退化为上下堆叠。
- 打开结果视图时经 `load_draft_detail` 从盘读 `ai/draft.md`；历史任务（`HistoryDetailView` 不含 draft）也能加载并编辑草稿（修复旧缺口）。
- 编辑落盘覆盖 `ai/draft.md`；首次编辑前生成 `ai/original/draft.md` 备份，后续编辑不覆盖 original。
- 「复制」「下载」均基于编辑器当前文本（markdown 原文）；下载产出 `.md` 文件，文件名为首行标题或 `{taskId}.md`。
- 「导出（定位文件）」在本地有 `taskDir` 时作为次要入口保留；dirty 时「下载」/「导出」提示先保存。
- 「重新生成」入口在结果视图可用：重走首次确认页 `DraftConfirmationSheet`（种子预选 + 偏好从盘读 + 平台确认页选定）→ `retry_insights(target="draft")`；与第一次生成逻辑完全一致。
- `draftEdited === true` 时重新生成弹二次确认，取消不发起调用、不扣额度。
- 重新生成过配额 / 账号预检；每次重生 checkout 扣 1 额度、不论成败不返还（父规格额度模型不变）。
- 重新生成成功后 `workflow.draftEdited` 重置为 `false`，`ai/original/draft.md` 刷新为新基线。
- `save_draft_edit` 对空内容、路径穿越、软链目标、隔离 / quarantined 任务均 recoverable 拒绝，不写半文件、不创建 original 备份。
- 父规格全部验收项继续通过；平台请求态、`activeAiTarget` 类型、隐私边界、额度模型不变。

---

## 文字稿结果视图：渲染优先、编辑模式与全屏

### Background

`2026-07-15-draft-result-editor` 把 `生成文字稿` 的结果视图做成左右分栏：左侧 `textarea` 编辑 markdown 原文，右侧 `MarkdownContent` 实时预览，并提供「下载」按钮。分栏在 880px 宽的弹层里让两侧都变窄，长文阅读与长文编辑互相挤压；「下载」与「导出（定位文件）」功能重叠，用户实际需要的是定位本地文件。

本规格是该视图的增量，把交互改为渲染优先。

### Goals

- 打开结果视图直接阅读渲染后的 markdown，内容区独占整宽。
- 编辑是显式动作：点击「编辑模式」进入原文编辑，点击「渲染模式」返回渲染视图，缓冲内容保留。
- 移除「下载」按钮，保留「导出（定位文件）」作为本地文件入口。
- 增加「全屏」按钮，在常规弹层尺寸与接近视口尺寸之间切换。

### Non-goals

- 不改 Markdown 渲染保真度，仍复用 `MarkdownContent`（GFM、剥离原始 HTML、Mermaid 为代码块）。
- 不改保存语义、`ai/original/draft.md` 备份规则、重新生成流程、额度模型与隐私边界。
- 不做代码编辑器级能力（语法高亮、行号、软换行优化）。
- 不改 `ai/draft.md` 的存储位置、写入命令与本地 tauri IO 校验。

### Result Experience

`DraftResultSheet` 的两种视图模式与工具区：

- **渲染模式（默认）**：`MarkdownContent` 渲染当前缓冲，占满内容区；打开弹层时从 `ai/draft.md` 读取的文本直接进入渲染视图。
- **编辑模式**：受控 `textarea` 编辑 markdown 原文，替换渲染视图。工具区左侧状态文字显示「编辑模式」。
- **模式切换**：渲染模式下按钮为「编辑模式」，编辑模式下按钮为「渲染模式」。切换只改变展示方式，不丢弃缓冲，也不自动保存。
- **保存**：`保存` 按钮按 dirty 状态启用；保存成功后写入 `ai/draft.md` 并清除 dirty。
- **复制**：复制当前缓冲的 markdown 原文，两种模式下都可用。
- **导出（定位文件）**：定位 `ai/draft.md`；dirty 时先提示保存，避免定位到与缓冲不一致的内容。
- **全屏**：`全屏` 按钮把弹层扩展到接近视口尺寸，按钮变为「退出全屏」；再次点击恢复常规尺寸。
- **生命周期**：关闭弹层时重置为渲染模式并退出全屏；再次打开从渲染模式开始。

### Validation Rules

- 编辑模式下 `textarea` 的初始内容与渲染视图同源，均为 `load_draft_detail` 返回的 markdown。
- 「导出」在 dirty 时提示先保存，保存成功后恢复可用。
- 全屏切换不改变缓冲、dirty 状态或保存结果。
- 「保存」失败时保留 dirty 与缓冲，提示可恢复错误。

### Acceptance Criteria

- 打开结果视图直接看到渲染后的 markdown，内容区没有左右分栏。
- 点击「编辑模式」出现 `textarea`，渲染视图隐藏；点击「渲染模式」回到渲染视图，编辑内容保留。
- 工具区包含「编辑模式／渲染模式」「保存」「复制」「导出」「全屏」「重新生成」，不包含「下载」。
- 点击「全屏」弹层扩展，「退出全屏」恢复；内容与滚动位置不丢失。
- 关闭再打开，视图回到渲染模式且非全屏。
- 保存、导出、重新生成、额度与隐私边界的行为与父规格一致。
