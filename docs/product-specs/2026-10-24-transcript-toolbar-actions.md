# 结果工作区：文字稿工具栏动作（合并规格）

本文件由下列原始文档合并而成，内容按节忠实保留（原文一级标题降为节标题，代码块原样保留）。原文件已移除；历史台账（`TASKS.md`、completed exec-plans）中对旧文件名的引用按约定保留。

| 节 | 原文件 |
| --- | --- |
| 结果工作区：定位文字稿 | `2026-10-20-transcript-locate-action.md` |
| 结果工作区：复制文字稿 | `2026-10-23-transcript-copy-action.md` |
| 结果工作区：整理文字稿 | `2026-10-24-transcript-polish-action.md` |

---

## 结果工作区：定位文字稿

### Background

完成态的结果页有一个本地文件工具栏，已经提供「定位视频」与「定位音频」。文字稿在左侧工作区直接可读，但要定位它的文件，只能绕到详情视图里操作。用户在结果页看到文字稿卡片时，缺一个和视频、音频并列的入口。

### Goals

- 在文字稿工作区的工具栏增加「定位文字稿」，顺序排在「定位音频」之后。
- 文字稿未生成时不显示该按钮，与视频、音频的可见性规则一致。
- 存在未保存的编辑时拦截定位，提示先保存。

### Non-goals

- 不改 `transcript.txt` 的产物路径、写入方式与原子替换语义。
- 不改 AI 详情 sheet 里已有的导出入口（那条路径定位的是各 AI artifact）。
- 不新增导出格式，不改变 Markdown 与纯文本的产出。

### Result Experience

- 按钮图标为 `FileText`，文案走 `workspace.locateTranscript`，三语与视频、音频保持同样的措辞风格。
- 点击后调用 `exportTranscript`，在系统文件管理器中选中当前任务的 `transcript.txt`。
- 工具栏在有任一可见动作时出现，避免出现空容器。

### Validation Rules

- 定位动作复用 `useArtifactDetailController.exportTranscript`，其中的未保存判定位于 `useArtifactDetailController.ts` 的 dirty 分支，提示文案为 `transcript.notice.unsavedLocate`。
- 不经过 `locateArtifact`。那条路径没有 dirty 拦截，会把磁盘上的旧稿定位给用户。

### Acceptance Criteria

- 完成态的文字稿工具栏依次包含「定位视频」「定位音频」「定位文字稿」。
- 点击「定位文字稿」打开文件管理器并选中 `transcript.txt`。
- 有未保存编辑时点击，出现保存提示，不发生定位。
- 文字稿尚未生成时，按钮不出现。

### 2026-10-30 修订：删除重复的底部「导出」

本规格落地时假设「导出」只存在于 AI 详情 sheet，实际校对面板底部还有第二个用 `exportTranscript` 的按钮：「定位文字稿」与「导出」在同一面板内调用同一函数、定位同一份 `transcript.txt`、可见条件同为 `transcript_txt` 存在，属于纯重复，且「导出」这个词会让用户期待另存一份副本。

处理：删掉校对面板底部的「导出」，footer 只保留「复制当前内容」与「保存」，定位动作统一收在工具栏三连里；`review.export` 文案键（三语）随之删除。AI 详情 sheet 的导出入口不受影响。

---

## 结果工作区：复制文字稿

### Background

完成态的结果页有一个本地文件工具栏，已经提供「定位视频」「定位音频」「定位文字稿」。文字稿校对区底部的「复制」按钮复制的是编辑器里的当前文本，包含尚未保存的修改。用户需要在别处粘贴一份与磁盘上 `transcript.txt` 完全一致的内容时，编辑器草稿无法满足。

### Goals

- 在文字稿工作区的工具栏增加「复制文字稿」，位置紧接在「定位文字稿」右侧。
- 点击后把当前任务 `transcript.txt` 的正文写入剪贴板。
- 文字稿未生成时不显示该按钮，与视频、音频、文字稿定位的可见性规则一致。

### Non-goals

- 不改变校对区底部「复制」按钮复制编辑器草稿的行为。
- 不改变 `transcript.txt` 的产物路径、写入方式与原子替换语义。
- 不新增导出格式，不改变 Markdown 与纯文本的产出。
- 不因存在未保存的编辑而拦截复制。

### Result Experience

- 按钮图标为 `Copy`，文案走 `workspace.copyTranscript`，三语与相邻按钮保持同样的措辞风格。
- 点击后把文档控制器已加载的 `transcript.txt` 正文写入剪贴板。
- 复制成功提示 `transcript.notice.copied`。
- 剪贴板写入失败时提示 `transcript.notice.transcriptCopyFailed`。
- 正文无法读取时提示 `transcript.notice.transcriptFileCopyFailed`，剪贴板内容保持不变。
- 正文尚未加载完成时按钮置灰，避免读到空内容。
- 工具栏在有任一可见动作时出现，四个按钮按「定位视频」「定位音频」「定位文字稿」「复制文字稿」排列。

### Validation Rules

- 复制内容取自 `useTranscriptDocumentController` 持有的 `transcriptDetail.text`，该值是 `load_transcript_detail` 返回的正式稿正文。`transcriptDraft` 不参与。
- `useArtifactDetailController` 只负责写入剪贴板与提示，不读取文件，保持文字稿详情加载由文档控制器独占。
- 失败提示不带出文件路径与底层异常文本。
- 未保存编辑不构成拦截条件，复制结果始终是磁盘上的正式稿。

### Acceptance Criteria

- 完成态的文字稿工具栏依次包含「定位视频」「定位音频」「定位文字稿」「复制文字稿」。
- 编辑器里存在未保存修改时点击「复制文字稿」，剪贴板得到的是 `transcript.txt` 的内容，未保存的修改不出现在剪贴板中。
- `transcript.txt` 无法读取时点击，出现失败提示，不写入剪贴板。
- 文字稿尚未生成时，按钮不出现。

### 2026-10-30 修订：底部「复制」改名为「复制当前内容」

工具栏的「复制文字稿」与校对区底部的「复制」并排出现后，两个名字都叫“复制”容易让用户以为是同一件事。底部按钮复制的是编辑器当前文本（含未保存修改），与磁盘上的正式稿无关，因此改名为「复制当前内容」（繁体「複製目前內容」，英文 `Copy Current Text`），文案键仍为 `review.copy`，行为不变。

---

## 结果工作区：整理文字稿

### Background

ASR 转写受口音、专有名词、同音字影响，正式稿里常有识别错误，且口语转写保留了大量语气词与无信息量重复，通读困难。结果工作区工具栏的「复制文字稿」只能原样复制 `transcript.txt`。用户希望先由 LLM 做一次适度整理（修正错误、去口头语、理顺分段），再复制一份更可读的文字稿。冒烟验证（2026-10-24）确认「仅修正识别错误」的保守档通读感无明显变化，故定档为中度整理。

### Goals

- 工具栏原「复制文字稿」按钮在无整理稿时显示为「整理文字稿」，位置与可见性规则不变（紧跟「定位文字稿」右侧）。
- 点击后直接开始整理（不弹确认框）：通过 `retry_insights` 的 `transcript` target 调用云端 LLM，做中度整理：修正 ASR 的错字、漏字、断句与标点，删除不影响原意的口头语与无意义重复，并按语义重新分段。
- 中度整理的红线：不改变原意，不增删事实内容，不把说话人的用词换成书面同义词，不润色升华，不翻译。
- 整理产物是独立文件 `transcript/polished.txt`，原有 `transcript.txt` 与 `segments.json` 一律不动。
- 整理成功后按钮变为「复制文字稿」，点击复制整理后的文字稿；重启或从历史恢复任务后该状态依然成立。
- 未登录或额度不足时先打开账号面板，不发起调用。

### Non-goals

- 不改动校对区底部「复制」按钮（仍复制编辑器草稿）与「定位文字稿」。
- 不新增整理稿预览抽屉或导出入口；整理稿只通过按钮复制。
- 不把整理稿回写 `transcript.txt`，不更新 manifest 的 `text`/`text_preview`，不登记进任务事务 artifact 白名单。
- 不在 AI 工作区增加第五张 工具卡片；`transcript` 不进入前端 `StudioTool` 联合类型。
- 整理失败不改变任务终态，不生成部分产物。

### Result Experience

- 无整理稿时按钮为「整理文字稿」（Sparkles 图标）；点击后进入忙碌态：图标转圈、文案变「整理中」、`aria-busy`、校对区编辑与保存禁用。
- 未登录或 AI 额度不足时，点击打开账号面板并显示既有 AI 拦截提示，不消耗额度。
- 整理成功提示 `transcript.notice.polishedReady`；`POLISH_TRANSCRIPT_TOO_LONG` 显示 `errors.transcript.polishTooLong`（「文字稿过长，暂时无法整理。目前最多支持约 4.8 万字符（24 段，每段约 2,000 字符）。」），其余失败提示 `transcript.notice.polishFailed`（带错误码）或 `polishFailedNoCode`。
- 有有效整理稿时按钮为「复制文字稿」（Copy 图标），点击复制整理稿正文；原稿仍可从校对区「复制」获得。
- 历史任务恢复、应用重启后，只要 `polished.txt` 有效即直接显示「复制文字稿」。

### Validation Rules

- worker 只读取通过路径硬校验（非软链/junction）的正式稿 `transcript.txt`；空稿报 `POLISH_EMPTY_TRANSCRIPT`。
- 分段修正：约 2000 字按句界切段，段间携带上一段末尾约 200 字衔接上下文；超过 24 段报 `POLISH_TRANSCRIPT_TOO_LONG`，不发起调用。三语提示中的 24 段与 2,000 字符对应 `POLISH_MAX_CHUNKS` 与 `POLISH_CHUNK_CHARS`，调整常量时须同步文案；字符总数写成约数，切分会在空行与句号处提前结束分段。
- LLM 凭据复用成稿链路：整次整理只做一次 server-managed checkout（消耗一次 AI Credits），分段调用不再单独计费；LLM 空返回报 `POLISH_LLM_EMPTY_RESULT`，异常报 `POLISH_FAILED`。
- 产物以原子替换写入 `transcript/polished.txt`，并在 `transcript/polished.meta.json`（schema v1）记录原稿 SHA-256；写盘失败报 `POLISH_ARTIFACT_WRITE_FAILED`。
- `load_transcript_detail` 仅在 `polished.txt` 存在、为普通文件、且 meta 里的原稿摘要与当前 `transcript.txt` 匹配时返回 `polished_text`；原稿被编辑后整理稿视为过期，按钮回到「整理文字稿」。正式稿保存成功后客户端立即重新读取详情并重判，按钮在同一次保存内完成切换，不需要重开任务。
- 整理期间不重置编辑器草稿；成功后只更新整理稿字段。

### Acceptance Criteria

- 完成态、无整理稿：工具栏依次为「定位视频」「定位音频」「定位文字稿」「整理文字稿」。
- 登录且有额度时点击「整理文字稿」：进入忙碌态，`polished.txt` 生成后按钮变为「复制文字稿」，此时点击剪贴板得到整理稿正文，且 `transcript.txt` 字节不变。
- 未登录时点击：打开账号面板，不产生 `polished.txt`。
- 超长文字稿点击：出现带长度限制的失败提示（上限约 4.8 万字符，即 24 段、每段约 2,000 字符），不发起 LLM 调用，不消耗额度。
- 整理成功后编辑原稿并保存：保存完成后按钮立即回到「整理文字稿」，无需重开任务或重启应用。
- 重启应用并恢复同一任务：按钮仍为「复制文字稿」，复制内容为整理稿。
