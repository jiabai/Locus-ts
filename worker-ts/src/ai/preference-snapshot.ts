// 个性化偏好快照：解析、序列化与提示词渲染。
//
// 对齐 `worker/worker_core/requests.py` 的 `parse_preference_snapshot`、
// `models.py` 的 `PreferenceSnapshot.to_dict` 与 `ai_prompts.py` 的
// `format_preference_snapshot_for_prompt`。
//
// 三处共用同一份形状：请求里的字段必须逐项校验（否则一份伪造的偏好会进提示词），
// 落盘文件与提示词里的 JSON 必须与 Python 逐字节相同（否则同一份偏好在两代 worker
// 里会生成不同的灵感，也会被前端读成不同的选项）。
import {
  GENERATION_FIELD_OPTIONS,
  MULTI_OPTION_LIMITS,
  PROFILE_FIELD_OPTIONS,
} from './preference-options.ts';

export interface InspirationProfile {
  readonly role: string;
  readonly domain: string;
  readonly stage: string;
  readonly cityContext: string;
  readonly genderPerspective: string;
  readonly platforms: readonly string[];
}

export interface GenerationPreferences {
  readonly goal: string;
  readonly scenario: string;
  readonly angles: readonly string[];
  readonly audience: string;
  readonly styles: readonly string[];
  readonly avoid: readonly string[];
}

export interface PreferenceLabelValue {
  readonly id: string;
  readonly label: string;
}

export interface PreferenceLabelSnapshotItem {
  readonly field: string;
  readonly label: string;
  readonly values: readonly PreferenceLabelValue[];
}

export interface PreferenceLabelSnapshot {
  readonly profile: readonly PreferenceLabelSnapshotItem[];
  readonly generationPreferences: readonly PreferenceLabelSnapshotItem[];
}

export interface PreferenceSnapshot {
  readonly profile: InspirationProfile | null;
  readonly profileSkipped: boolean;
  readonly generationPreferences: GenerationPreferences;
  readonly labelSnapshot: PreferenceLabelSnapshot;
}

export class InvalidPreferenceSnapshotError extends Error {
  constructor(message = 'preference_snapshot is invalid.') {
    super(message);
    this.name = 'InvalidPreferenceSnapshotError';
  }
}

function invalid(): InvalidPreferenceSnapshotError {
  return new InvalidPreferenceSnapshotError();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function readSingleOption(
  value: unknown,
  field: string,
  options: Readonly<Record<string, ReadonlySet<string>>>,
): string {
  if (typeof value !== 'string' || !options[field]?.has(value)) throw invalid();
  return value;
}

function readMultiOption(
  value: unknown,
  field: string,
  options: Readonly<Record<string, ReadonlySet<string>>>,
): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw invalid();
  const [min, max] = MULTI_OPTION_LIMITS[field] as readonly [number, number];
  if (value.length < min || value.length > max) throw invalid();
  if (new Set(value).size !== value.length) throw invalid();
  if (value.some((item) => !options[field]?.has(item))) throw invalid();
  return value as string[];
}

const PROFILE_FIELDS = ['role', 'domain', 'stage', 'cityContext', 'genderPerspective', 'platforms'];
const GENERATION_FIELDS = ['goal', 'scenario', 'angles', 'audience', 'styles', 'avoid'];
const SNAPSHOT_FIELDS = ['profile', 'profileSkipped', 'generationPreferences', 'labelSnapshot'];
const LABEL_SNAPSHOT_FIELDS = ['profile', 'generationPreferences'];
const LABEL_ITEM_FIELDS = ['field', 'label', 'values'];
const LABEL_VALUE_FIELDS = ['id', 'label'];

function parseProfile(value: unknown): InspirationProfile | null {
  if (value === null) return null;
  if (!isPlainObject(value) || !hasExactKeys(value, PROFILE_FIELDS)) throw invalid();
  return {
    role: readSingleOption(value.role, 'role', PROFILE_FIELD_OPTIONS),
    domain: readSingleOption(value.domain, 'domain', PROFILE_FIELD_OPTIONS),
    stage: readSingleOption(value.stage, 'stage', PROFILE_FIELD_OPTIONS),
    cityContext: readSingleOption(value.cityContext, 'cityContext', PROFILE_FIELD_OPTIONS),
    genderPerspective: readSingleOption(value.genderPerspective, 'genderPerspective', PROFILE_FIELD_OPTIONS),
    platforms: readMultiOption(value.platforms, 'platforms', PROFILE_FIELD_OPTIONS),
  };
}

function parseGenerationPreferences(value: unknown): GenerationPreferences {
  if (!isPlainObject(value) || !hasExactKeys(value, GENERATION_FIELDS)) throw invalid();
  return {
    goal: readSingleOption(value.goal, 'goal', GENERATION_FIELD_OPTIONS),
    scenario: readSingleOption(value.scenario, 'scenario', GENERATION_FIELD_OPTIONS),
    angles: readMultiOption(value.angles, 'angles', GENERATION_FIELD_OPTIONS),
    audience: readSingleOption(value.audience, 'audience', GENERATION_FIELD_OPTIONS),
    styles: readMultiOption(value.styles, 'styles', GENERATION_FIELD_OPTIONS),
    avoid: readMultiOption(value.avoid, 'avoid', GENERATION_FIELD_OPTIONS),
  };
}

function parseLabelValues(value: unknown): PreferenceLabelValue[] {
  if (!Array.isArray(value)) throw invalid();
  return value.map((item) => {
    if (!isPlainObject(item) || !hasExactKeys(item, LABEL_VALUE_FIELDS)) throw invalid();
    const id = item.id;
    if (typeof id !== 'string' || id.trim().length === 0) throw invalid();
    if (typeof item.label !== 'string') throw invalid();
    return {id, label: item.label};
  });
}

function parseLabelItems(value: unknown, section: 'profile' | 'generationPreferences'): PreferenceLabelSnapshotItem[] {
  if (!Array.isArray(value)) throw invalid();
  const options = section === 'profile' ? PROFILE_FIELD_OPTIONS : GENERATION_FIELD_OPTIONS;
  return value.map((item) => {
    if (!isPlainObject(item) || !hasExactKeys(item, LABEL_ITEM_FIELDS)) throw invalid();
    const field = item.field;
    if (typeof field !== 'string' || !(field in options)) throw invalid();
    if (typeof item.label !== 'string') throw invalid();
    return {field, label: item.label, values: parseLabelValues(item.values)};
  });
}

function parseLabelSnapshot(value: unknown): PreferenceLabelSnapshot {
  if (!isPlainObject(value) || !hasExactKeys(value, LABEL_SNAPSHOT_FIELDS)) throw invalid();
  return {
    profile: parseLabelItems(value.profile, 'profile'),
    generationPreferences: parseLabelItems(value.generationPreferences, 'generationPreferences'),
  };
}

/** 严格解析请求或落盘文件里的偏好快照；任何不符都抛同一个错误，由调用方决定失败码。 */
export function parsePreferenceSnapshot(payload: unknown): PreferenceSnapshot {
  if (!isPlainObject(payload) || !hasExactKeys(payload, SNAPSHOT_FIELDS)) throw invalid();
  if (typeof payload.profileSkipped !== 'boolean') throw invalid();
  return {
    profile: parseProfile(payload.profile),
    profileSkipped: payload.profileSkipped,
    generationPreferences: parseGenerationPreferences(payload.generationPreferences),
    labelSnapshot: parseLabelSnapshot(payload.labelSnapshot),
  };
}

/**
 * 按 Python `to_dict()` 的字段顺序生成载荷。
 *
 * 顺序不是装饰：提示词里会 `JSON.stringify` 这份对象，字段顺序一变，整段提示词就变，
 * 同一个模型可能给出不同结果；落盘文件也要能被前端与 Python 原样读回。
 */
export function preferenceSnapshotPayload(snapshot: PreferenceSnapshot): Record<string, unknown> {
  const profile = snapshot.profile === null ? null : {
    role: snapshot.profile.role,
    domain: snapshot.profile.domain,
    stage: snapshot.profile.stage,
    cityContext: snapshot.profile.cityContext,
    genderPerspective: snapshot.profile.genderPerspective,
    platforms: [...snapshot.profile.platforms],
  };
  const generationPreferences = snapshot.generationPreferences;
  const labelSnapshot = snapshot.labelSnapshot;
  return {
    profile,
    profileSkipped: snapshot.profileSkipped,
    generationPreferences: {
      goal: generationPreferences.goal,
      scenario: generationPreferences.scenario,
      angles: [...generationPreferences.angles],
      audience: generationPreferences.audience,
      styles: [...generationPreferences.styles],
      avoid: [...generationPreferences.avoid],
    },
    labelSnapshot: {
      profile: labelSnapshot.profile.map((item) => ({
        field: item.field,
        label: item.label,
        values: item.values.map((value) => ({id: value.id, label: value.label})),
      })),
      generationPreferences: labelSnapshot.generationPreferences.map((item) => ({
        field: item.field,
        label: item.label,
        values: item.values.map((value) => ({id: value.id, label: value.label})),
      })),
    },
  };
}

/** 提示词里的紧凑 JSON（Python `ensure_ascii=False, separators=(",", ":")`）。 */
export function formatPreferenceSnapshotForPrompt(snapshot: PreferenceSnapshot): string {
  return JSON.stringify(preferenceSnapshotPayload(snapshot));
}

/** `ai/preference-snapshot.json` 的文件内容（Python `indent=2` + 末尾换行）。 */
export function serializePreferenceSnapshot(snapshot: PreferenceSnapshot): string {
  return `${JSON.stringify(preferenceSnapshotPayload(snapshot), null, 2)}\n`;
}
