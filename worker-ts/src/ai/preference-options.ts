// 偏好词表。
//
// 对齐 `worker/worker_core/requests.py` 的 `PROFILE_FIELD_OPTIONS` /
// `GENERATION_FIELD_OPTIONS`（也等价于契约 `aiGeneration.request` 里的 enum）。
// 词表是宿主、Python、TypeScript 三方共用的：多一个 id 会让请求被其中一方拒止，
// 少一个会让界面上「可选但发不出去」。所以这里由 golden fixture 逐字段比对，不手抄一遍就完事。
export const PROFILE_FIELD_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  role: new Set([
    'content_creator', 'product_ops', 'marketing_sales', 'entrepreneur',
    'student_researcher', 'teacher_trainer', 'investor_business_analyst',
    'general_learner', 'unspecified',
  ]),
  domain: new Set([
    'content_media', 'product_operations', 'marketing_sales', 'education_training',
    'technology_rd', 'management_consulting', 'investment_business',
    'freelance', 'general_perspective', 'unspecified',
  ]),
  stage: new Set([
    'student', 'early_career', 'experienced_professional', 'manager',
    'entrepreneur_operator', 'retired', 'unspecified',
  ]),
  cityContext: new Set([
    'tier1_city', 'new_tier1_city', 'lower_tier_city', 'county_township',
    'overseas', 'unspecified',
  ]),
  genderPerspective: new Set([
    'unspecified', 'female_perspective', 'male_perspective', 'neutral_perspective',
  ]),
  platforms: new Set([
    'douyin', 'xiaohongshu', 'wechat_channels', 'bilibili',
    'wechat_official_account', 'podcast', 'course_community', 'internal_sharing',
  ]),
};

export const GENERATION_FIELD_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  goal: new Set([
    'content_creation', 'learning_understanding', 'review_deconstruction',
    'business_insight', 'controversy_discussion', 'action_advice',
  ]),
  scenario: new Set([
    'personal_notes', 'short_video', 'article_official_account', 'livestream_podcast',
    'team_sharing', 'client_communication', 'course_community',
  ]),
  angles: new Set([
    'topic_angle', 'contrarian_view', 'audience_pain_point', 'practical_advice',
    'case_analogy', 'risk_controversy', 'trend_judgment', 'reusable_method',
    'memorable_phrase', 'cognitive_refresh',
  ]),
  audience: new Set(['self', 'beginners', 'peers', 'clients', 'boss_team', 'fans_readers']),
  styles: new Set([
    'direct_sharp', 'gentle_inspiring', 'professional_analysis', 'grounded',
    'storytelling', 'short_video_friendly', 'long_form_friendly',
  ]),
  avoid: new Set([
    'chicken_soup', 'academic', 'vague', 'clickbait', 'commercialized',
    'negative', 'grand_narrative',
  ]),
};

/** 多选字段的取值范围与 Python `_read_multi_option` 一一对应。 */
export const MULTI_OPTION_LIMITS: Readonly<Record<string, readonly [number, number]>> = {
  platforms: [0, 3],
  angles: [1, 3],
  styles: [1, 2],
  avoid: [0, 3],
};
