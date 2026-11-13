# 小红书平台字幕实测（合并探针记录）

本文件由下列原始文档合并而成，内容按节忠实保留（原文一级标题降为节标题，代码块原样保留）。原文件已移除；历史台账（`TASKS.md`、completed exec-plans）中对旧文件名的引用按约定保留。

| 节 | 原文件 |
| --- | --- |
| 小红书平台字幕实测：`6a81333b000000003300b98f` | `2026-08-21-xiaohongshu-platform-subtitle-probe.md` |
| 小红书平台字幕实测：`6a82e94900000000260360d5` | `2026-08-22-xiaohongshu-platform-subtitle-probe-6a82e949.md` |
| 小红书平台字幕实测：`6a84fc60000000002c0077e4` | `2026-08-22-xiaohongshu-platform-subtitle-probe-6a84fc60000000002c0077e4.md` |
| 小红书平台字幕实测：`6a872cd0000000002702f748` | `2026-08-22-xiaohongshu-platform-subtitle-probe-6a872cd0000000002702f748.md` |

---

## 小红书平台字幕实测：`6a81333b000000003300b98f`

### 结论

这个公开视频确实提供了平台已有字幕，不需要 ASR：

- 中文原始字幕：`mediaV2 -> video -> subtitles -> source[0]`
- 中文字幕：`mediaV2 -> video -> subtitles -> zh-CN[0]`
- 英文字幕：`mediaV2 -> video -> subtitles -> en-US[0]`

关键点是 `note.video.mediaV2` 在当前页面响应里是 **JSON 字符串**，不是已经解码的对象。字幕 URL 不在 FrameQ 当前读取的 `note.video.media.stream` 中，而在 `json.loads(mediaV2)["video"]["subtitles"]` 中。

### 实测记录

测试日期：2026-08-21。目标笔记 ID：`6a81333b000000003300b98f`。访问令牌没有写入本记录。

使用 FrameQ 生产 worker 的以下入口读取公开页面：

1. `parse_xiaohongshu_input` 解析 note ID 和 `xsec_token`。
2. `build_explore_url` 构造 `/explore/{note_id}` 页面地址。
3. `UrllibXiaohongshuHttpClient.get` + `page_headers` 获取页面。
4. `decode_response_body`、`extract_initial_state`、`lookup_note` 读取 note 对象。

实测结果：页面 HTTP 200，note 类型为 `video`，`mediaV2` 类型为 `str`，字幕组为 `en-US`、`source`、`zh-CN`，每组各 1 条。

从这三个平台返回的 SRT URL 下载结果：

| 轨道 | HTTP | 字节数 | 本地文件 |
| --- | ---: | ---: | --- |
| `source / zh-CN` | 200 | 32721 | `outputs/6a81333b000000003300b98f_source_zh-CN_0.srt` |
| `zh-CN / zh-CN` | 200 | 32717 | `outputs/6a81333b000000003300b98f_zh-CN_zh-CN_0.srt` |
| `en-US / en-US` | 200 | 41917 | `outputs/6a81333b000000003300b98f_en-US_en-US_0.srt` |

将 `source / zh-CN` 文件按 FrameQ 的字幕文件命名规则放入临时目录后，`find_subtitle_transcript` 实测解析成功：335 个时间段、8427 个字符；首段为“好，大家好，今天我们来讲一下关于deepseek harness整个架构的拆解”。

### 可复用解析方法

```python
parsed = parse_xiaohongshu_input(raw_url, http_client=client)
response = client.get(
    build_explore_url(parsed.note_id, parsed.xsec_token),
    headers=page_headers(),
    timeout_seconds=20.0,
)
state = extract_initial_state(decode_response_body(response))
note = lookup_note(state, parsed.note_id)

media_v2 = json.loads(note["video"]["mediaV2"])
tracks = media_v2["video"]["subtitles"]
track = tracks["source"][0]       # 中文原始平台字幕
# 或：tracks["zh-CN"][0] / tracks["en-US"][0]

subtitle_response = client.get(
    track["url"],
    headers=media_headers(),
    timeout_seconds=20.0,
)
Path("note.zh-CN.srt").write_bytes(subtitle_response.body)
```

生产实现应保留 URL 中平台返回的签名参数，只在内存和下载请求中使用，不写入 task manifest、诊断日志或普通用户可见错误文案。SRT 文件落地后可以直接复用 `worker/frameq_worker/subtitles.py` 的 `.srt` / `.vtt` 探测和解析逻辑。

### FrameQ 当前缺口

当前 `worker/frameq_worker/xiaohongshu/streams.py` 的 `parse_video_streams` 只读取 `note.video.media.stream`，`xiaohongshu_fallback.py` 也只负责下载 MP4；`media_preparation.py` 的字幕探测只扫描下载目录中已经存在的 `.srt` / `.vtt` 文件。因此当前产品链路会下载视频，但不会主动读取 `mediaV2.video.subtitles`。

这次验证没有修改生产 worker，只新增了本次实测得到的 SRT 产物和本记录。若要把能力并入 FrameQ，应新增小红书字幕资源解析/下载边界，并让失败时继续沿用现有 ASR 兜底；这会改变下载与字幕用户可见行为，应另立 product spec / ExecPlan 后实现。

### 证据来源

- FrameQ：`worker/frameq_worker/xiaohongshu_fallback.py`、`worker/frameq_worker/xiaohongshu/page.py`、`worker/frameq_worker/xiaohongshu/streams.py`、`worker/frameq_worker/subtitles.py`。
- 小红书公开笔记页面：`https://www.xiaohongshu.com/explore/6a81333b000000003300b98f`（查询参数和签名 URL 未写入文档）。
- 现场下载产物：本仓库 `outputs/` 下列出的三个 `.srt` 文件。

---

## 小红书平台字幕实测：`6a82e94900000000260360d5`

### 结论

该公开视频提供平台已有字幕，不需要 ASR。使用 FrameQ 生产 worker 的小红书页面解析入口读取页面后，发现：

```text
note.video.mediaV2              # JSON 字符串
  -> JSON.parse(...).video.subtitles
  -> source / zh-CN / en-US
  -> 每组一个签名 SRT URL
```

页面返回 HTTP 200，note 类型为 `video`，三组字幕均存在且每组 1 条。访问令牌和带签名的字幕 URL 不写入本文档。

### 已下载文件

| 轨道 | HTTP | 字节数 | 本地文件 |
| --- | ---: | ---: | --- |
| `source / zh-CN` | 200 | 25676 | `outputs/6a82e94900000000260360d5_source_zh-CN_0.srt` |
| `zh-CN / zh-CN` | 200 | 25672 | `outputs/6a82e94900000000260360d5_zh-CN_zh-CN_0.srt` |
| `en-US / en-US` | 200 | 32108 | `outputs/6a82e94900000000260360d5_en-US_en-US_0.srt` |

### FrameQ 解析验证

将下载的 SRT 按 FrameQ 的字幕文件命名规则放入临时下载目录后，调用 `find_subtitle_transcript` 验证：

- `source / zh-CN`：276 个时间段，6917 个字符；首段“好，大家好”，末段“在这里面是怎么具体跑起来的？”
- `zh-CN / zh-CN`：276 个时间段，6905 个字符。
- `en-US / en-US`：369 个时间段，19298 个字符。

### 可复用实现边界

页面获取和初始状态解析复用：

- `worker/frameq_worker/xiaohongshu_fallback.py`：`parse_xiaohongshu_input`
- `worker/frameq_worker/xiaohongshu/source.py`：`build_explore_url`
- `worker/frameq_worker/xiaohongshu/page.py`：`decode_response_body`、`extract_initial_state`、`lookup_note`
- `worker/frameq_worker/xiaohongshu/transport.py`：`UrllibXiaohongshuHttpClient`、`page_headers`、`media_headers`

字幕提取核心代码：

```python
media_v2 = json.loads(note["video"]["mediaV2"])
tracks = media_v2["video"]["subtitles"]
track = tracks["source"][0]  # 中文原始平台字幕
subtitle_response = client.get(track["url"], headers=media_headers())
Path("note.zh-CN.srt").write_bytes(subtitle_response.body)
```

下载后直接复用 `worker/frameq_worker/subtitles.py` 的 `.srt` / `.vtt` 解析即可。

### 来源

- 目标页面：`https://www.xiaohongshu.com/explore/6a82e94900000000260360d5`（完整查询参数未写入）。
- FrameQ 生产源码：上述 worker 文件及 `worker/frameq_worker/subtitles.py`。
- 现场下载产物：本仓库 `outputs/` 下列出的三个 `.srt` 文件。

---

## 小红书平台字幕实测：`6a84fc60000000002c0077e4`

使用 FrameQ 生产 worker 解析页面后，页面 HTTP 200，note 类型为 `video`。`note.video.mediaV2` 是 JSON 字符串，字幕位于 `json.loads(mediaV2)["video"]["subtitles"]`。

### 下载结果

| 轨道 | HTTP | 字节数 | 本地文件 |
| --- | ---: | ---: | --- |
| `source / zh-CN` | 200 | 22234 | `outputs/6a84fc60000000002c0077e4_source_zh-CN_0.srt` |
| `zh-CN / zh-CN` | 200 | 22244 | `outputs/6a84fc60000000002c0077e4_zh-CN_zh-CN_0.srt` |
| `en-US / en-US` | 200 | 27707 | `outputs/6a84fc60000000002c0077e4_en-US_en-US_0.srt` |

### FrameQ 解析验证

- `source / zh-CN`：243 个时间段，5984 个字符。
- `zh-CN / zh-CN`：243 个时间段，5956 个字符。
- `en-US / en-US`：327 个时间段，16365 个字符。

核心路径：

```python
media_v2 = json.loads(note["video"]["mediaV2"])
track = media_v2["video"]["subtitles"]["source"][0]
subtitle_response = client.get(track["url"], headers=media_headers())
```

下载后由 `worker/frameq_worker/subtitles.py` 的 `find_subtitle_transcript` 成功解析；未使用 ASR。完整查询参数和带签名字幕 URL 未写入本文档。

### 来源

- 目标页面：`https://www.xiaohongshu.com/explore/6a84fc60000000002c0077e4`
- FrameQ 生产源码：`worker/frameq_worker/xiaohongshu_fallback.py`、`worker/frameq_worker/xiaohongshu/page.py`、`worker/frameq_worker/xiaohongshu/transport.py`、`worker/frameq_worker/subtitles.py`
- 现场下载产物：本仓库 `outputs/` 下列出的三个 `.srt` 文件。

---

## 小红书平台字幕实测：`6a872cd0000000002702f748`

使用 FrameQ 生产 worker 读取公开页面：页面 HTTP 200，note 类型为 `video`。`note.video.mediaV2` 是 JSON 字符串，平台字幕位于 `json.loads(mediaV2)["video"]["subtitles"]`。

| 轨道 | HTTP | 字节数 | 本地文件 |
| --- | ---: | ---: | --- |
| `source / zh-CN` | 200 | 20747 | `outputs/6a872cd0000000002702f748_source_zh-CN_0.srt` |
| `zh-CN / zh-CN` | 200 | 20747 | `outputs/6a872cd0000000002702f748_zh-CN_zh-CN_0.srt` |
| `en-US / en-US` | 200 | 25741 | `outputs/6a872cd0000000002702f748_en-US_en-US_0.srt` |

FrameQ `find_subtitle_transcript` 解析验证：

- `source / zh-CN`：224 段，5378 字符。
- `zh-CN / zh-CN`：224 段，5370 字符。
- `en-US / en-US`：297 段，15453 字符。

未使用 ASR。访问令牌和带签名字幕 URL 未写入本文档。
