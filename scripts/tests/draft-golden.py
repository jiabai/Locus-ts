# 生成草稿链的 Python 基准，供 TypeScript 侧逐字节比对。
# 用法：uv run python scripts/tests/draft-golden.py
# 平台词表、系统提示词、种子提示词、技能清单、规划工具与交付工具全部取自生产源码。

import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "worker"))

from agent_runtime.extensions.planning import build_write_todos_tool  # noqa: E402
from agent_runtime.extensions.planning.entities import Todo, TodoStatus  # noqa: E402
from agent_runtime.extensions.planning.prompts import build_planning_prompt, render_plan  # noqa: E402
from agent_runtime.extensions.planning.todo_hook import _REMINDER  # noqa: E402
from agent_runtime.extensions.plugins.store import InMemoryPluginStore  # noqa: E402
from agent_runtime.extensions.skills import SkillManager, build_skill_tool, build_skills_prompt  # noqa: E402
from agent_runtime.extensions.skills.skill_manager import _sanitize_prompt_path_for_prompt  # noqa: E402
from worker_core import draft_agent  # noqa: E402
from worker_core.ai_prompts import (  # noqa: E402
    _DRAFT_PLATFORM_LABELS,
    _DRAFT_PLATFORM_PASSTHROUGH_LABELS,
    _platform_label_for_draft_platform,
    build_draft_from_inspiration_prompt,
)
from worker_core.models import (  # noqa: E402
    GenerationPreferences,
    Insight,
    InspirationProfile,
    PreferenceLabelSnapshot,
    PreferenceSnapshot,
)

OUT = ROOT / "worker-ts" / "tests" / "fixtures" / "draft-golden.json"
LANGUAGES = ("zh-CN", "zh-TW", "en-US")
SKILLS_ROOT = Path(draft_agent.__file__).parent / "skills"

platform_ids = list(_DRAFT_PLATFORM_LABELS) + list(_DRAFT_PLATFORM_PASSTHROUGH_LABELS)

system_prompts = []
for platform in ("douyin", "twitter", "wechat_official_account"):
    for source_kind in ("transcript", "article"):
        for summary in (None, "   ", "原视频要点：上下文决定上限。"):
            system_prompts.append({
                "platform": platform,
                "sourceKind": source_kind,
                "summary": summary,
                "expected": draft_agent._build_system_prompt(platform, summary, source_kind),
            })

snapshot_dict = {
    "profile": {
        "role": "content_creator",
        "domain": "content_media",
        "stage": "early_career",
        "cityContext": "tier1_city",
        "genderPerspective": "unspecified",
        "platforms": ["douyin", "xiaohongshu"],
    },
    "profileSkipped": False,
    "generationPreferences": {
        "goal": "content_creation",
        "scenario": "short_video",
        "angles": ["topic_angle", "contrarian_view"],
        "audience": "fans_readers",
        "styles": ["direct_sharp"],
        "avoid": ["clickbait"],
    },
    "labelSnapshot": {"profile": [], "generationPreferences": []},
}
skipped_snapshot_dict = {
    "profile": None,
    "profileSkipped": True,
    "generationPreferences": {
        "goal": "content_creation",
        "scenario": "short_video",
        "angles": ["topic_angle"],
        "audience": "fans_readers",
        "styles": ["grounded"],
        "avoid": [],
    },
    "labelSnapshot": {"profile": [], "generationPreferences": []},
}


def make_snapshot(raw):
    profile = None
    if raw["profile"] is not None:
        profile = InspirationProfile(**{
            "role": raw["profile"]["role"],
            "domain": raw["profile"]["domain"],
            "stage": raw["profile"]["stage"],
            "city_context": raw["profile"]["cityContext"],
            "gender_perspective": raw["profile"]["genderPerspective"],
            "platforms": tuple(raw["profile"]["platforms"]),
        })
    preferences = raw["generationPreferences"]
    return PreferenceSnapshot(
        profile=profile,
        profile_skipped=raw["profileSkipped"],
        generation_preferences=GenerationPreferences(
            goal=preferences["goal"],
            scenario=preferences["scenario"],
            angles=tuple(preferences["angles"]),
            audience=preferences["audience"],
            styles=tuple(preferences["styles"]),
            avoid=tuple(preferences["avoid"]),
        ),
        label_snapshot=PreferenceLabelSnapshot(profile=(), generation_preferences=()),
    )


insight_full = {
    "id": 3,
    "topic": "企业级 Agent 和通用 AI 工具的价值分水岭是什么？",
    "matchReason": "源自原视频对 Context/Orchestration 的核心判断",
    "followUpQuestions": ["上下文能力为何决定 Agent 上限？", "流程编排如何影响落地成本？"],
    "suitableUse": "公众号",
    "sourceChunkId": 7,
}
insight_minimal = {
    "id": 1,
    "topic": "把长视频拆成短视频",
    "matchReason": "与选题方向一致",
    "followUpQuestions": [],
    "suitableUse": "other",
    "sourceChunkId": None,
}


def make_insight(raw):
    return Insight(
        id=raw["id"],
        topic=raw["topic"],
        match_reason=raw["matchReason"],
        follow_up_questions=tuple(raw["followUpQuestions"]),
        suitable_use=raw["suitableUse"],
        source_chunk_id=raw["sourceChunkId"],
    )


summary_text = "## 要点\n- 上下文能力决定 Agent 上限。\n- 流程编排影响落地成本。\n"
user_prompts = []
cases = [
    ("full-zh", insight_full, snapshot_dict, None, "zh-CN", "douyin", "transcript"),
    ("full-en", insight_full, snapshot_dict, summary_text, "en-US", "twitter", "transcript"),
    ("full-tw", insight_full, skipped_snapshot_dict, summary_text, "zh-TW", "bilibili", "article"),
    ("no-snapshot", insight_full, None, None, "zh-CN", "other", "transcript"),
    ("minimal", insight_minimal, None, None, "en-US", "youtube", "article"),
    ("blank-summary", insight_full, None, "   ", "zh-CN", "wechat_official_account", "transcript"),
    ("article-full", insight_full, snapshot_dict, summary_text, "zh-CN", "xiaohongshu", "article"),
]
for label, insight, snapshot_raw, summary, language, platform, source_kind in cases:
    user_prompts.append({
        "label": label,
        "insight": insight,
        "snapshot": snapshot_raw,
        "summary": summary,
        "language": language,
        "platform": platform,
        "sourceKind": source_kind,
        "expected": build_draft_from_inspiration_prompt(
            make_insight(insight),
            make_snapshot(snapshot_raw) if snapshot_raw is not None else None,
            language,
            summary=summary,
            platform=platform,
            source_kind=source_kind,
        ),
    })

skill_manager = SkillManager(skills_root=str(SKILLS_ROOT))
skills = skill_manager.list_skills(active_only=True)
inventory = build_skills_prompt(skills)
normalized_root = _sanitize_prompt_path_for_prompt(str(SKILLS_ROOT))
normalized_inventory = inventory.replace(normalized_root, "SKILLS_ROOT")


def tool_dict(tool):
    return {
        "name": tool.name,
        "description": tool.description,
        "parameters": tool.parameters,
    }


skill_tool = build_skill_tool(skill_manager)
todo_tool = build_write_todos_tool(InMemoryPluginStore())
submit_tool = draft_agent._build_submit_draft_tool(draft_agent.DraftSink())

plan_cases = [
    [],
    [Todo(content="结构构思", status=TodoStatus.IN_PROGRESS),
     Todo(content="资料检索", status=TodoStatus.PENDING),
     Todo(content="按平台文体写作", status=TodoStatus.COMPLETED)],
]
planning_prompts = [
    {
        "todos": [{"content": todo.content, "status": todo.status.value} for todo in todos],
        "expected": build_planning_prompt(todos),
        "rendered": render_plan(todos),
    }
    for todos in plan_cases
]

sink = draft_agent.DraftSink()
accepted = asyncio.run(submit_tool.handler(None, markdown="# 标题\n\n正文"))
rejected = asyncio.run(submit_tool.handler(None, markdown="  \n "))
skill_content = skill_manager.load_skill("viral-writer")

payload = {
    "platformIds": platform_ids,
    "platformLabels": [
        {"id": platform_id, "label": _platform_label_for_draft_platform(platform_id)}
        for platform_id in platform_ids
    ],
    "systemPrompts": system_prompts,
    "userPrompts": user_prompts,
    "skillsInventory": normalized_inventory,
    "skillTool": tool_dict(skill_tool),
    "skillContent": skill_content,
    "writeTodosTool": tool_dict(todo_tool),
    "submitDraftTool": tool_dict(submit_tool),
    "submitDraftResponses": {"accepted": accepted, "rejected": rejected},
    "planningPrompts": planning_prompts,
    "planningReminder": _REMINDER,
    "maxTurns": draft_agent._DEFAULT_MAX_TURNS,
    "planningOffValues": list(draft_agent._PLANNING_OFF_VALUES),
    "retrievalFallbackPhrase": draft_agent._RETRIEVAL_FALLBACK_PHRASE,
    "skillInventorySentinels": ["<!-- skills-inventory -->", "<!-- /skills-inventory -->"],
    "todoStateSentinels": ["<!-- todo-state -->", "<!-- /todo-state -->"],
}

OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
