// 成稿技能的渐进式披露。
//
// 对应 `agent_runtime.extensions.skills`：`SKILL.md` 的 frontmatter 只把 name 与
// description 放进 system 提示词的技能清单，模型需要时再用 `Skill` 工具加载全文。
// 技能文件随 worker-ts 一起分发，不依赖 Python 包目录。
import {readdir, readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {parse} from 'yaml';

import type {ToolSpec} from '../chat.ts';
import type {Tool} from '../tool-loop.ts';

export interface SkillInfo {
  readonly name: string;
  readonly description: string;
  /** 技能目录，统一用正斜杠；用于提示词里定位附带文件。 */
  readonly path: string;
  readonly active: boolean;
  readonly content: string;
}

const SKILL_NAME_PATTERN = /^[\w.-]+$/u;
const CONTROL_CHARACTERS = /[\x00-\x1F\x7F]/gu;
const UNSAFE_PATH_CHARACTERS = /[^\w./ ,()'\-]/gu;

/** Python `Path.read_text()` 会做通用换行转换，这里必须同样把 CRLF 折成 LF。 */
function universalNewlines(text: string): string {
  return text.replace(/\r\n/gu, '\n');
}

function frontmatterDescription(text: string): string {
  if (!text.startsWith('---')) return '';
  const lines = text.split('\n');
  if (lines[0].trim() !== '---') return '';
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      end = index;
      break;
    }
  }
  if (end === -1) return '';
  let payload: unknown;
  try {
    payload = parse(lines.slice(1, end).join('\n'));
  } catch {
    return '';
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const description = (payload as Record<string, unknown>).description;
  return typeof description === 'string' ? description.trim() : '';
}

async function activeFlags(skillsRoot: string): Promise<Readonly<Record<string, boolean>>> {
  let raw: string;
  try {
    raw = await readFile(path.join(skillsRoot, 'skills.json'), 'utf8');
  } catch {
    return {};
  }
  const parsed: unknown = JSON.parse(raw);
  const record = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
  const skills = record.skills;
  if (skills === null || typeof skills !== 'object' || Array.isArray(skills)) return {};
  const flags: Record<string, boolean> = {};
  for (const [name, entry] of Object.entries(skills as Record<string, unknown>)) {
    const active = entry !== null && typeof entry === 'object'
      ? (entry as Record<string, unknown>).active
      : undefined;
    flags[name] = active === undefined ? true : Boolean(active);
  }
  return flags;
}

/** 按目录名排序发现技能，与 Python `_scan` 的顺序一致。 */
export async function loadSkills(skillsRoot: string): Promise<readonly SkillInfo[]> {
  const flags = await activeFlags(skillsRoot);
  const entries = await readdir(skillsRoot);
  const found: SkillInfo[] = [];
  for (const name of entries.sort()) {
    const dir = path.join(skillsRoot, name);
    const info = await stat(dir).catch(() => null);
    if (info === null || !info.isDirectory()) continue;
    let text: string | null = null;
    for (const fileName of ['SKILL.md', 'skill.md']) {
      try {
        text = universalNewlines(await readFile(path.join(dir, fileName), 'utf8'));
        break;
      } catch {
        // 继续找另一种文件名；两个都不存在就跳过这个目录。
      }
    }
    if (text === null) continue;
    found.push({
      name,
      description: frontmatterDescription(text),
      path: dir.replace(/\\/gu, '/'),
      active: flags[name] ?? true,
      content: text,
    });
  }
  return found;
}

function displayName(name: string): string {
  return SKILL_NAME_PATTERN.test(name) ? name : '<invalid_skill_name>';
}

function sanitizeDescription(description: string): string {
  const cleaned = description.replace(/`/gu, '').replace(CONTROL_CHARACTERS, ' ');
  return cleaned.split(/\s+/u).filter(Boolean).join(' ');
}

function sanitizePath(value: string): string {
  return value
    .replace(/\\/gu, '/')
    .replace(/`/gu, '')
    .replace(CONTROL_CHARACTERS, '')
    .replace(UNSAFE_PATH_CHARACTERS, '');
}

/** 逐字复刻 `build_skills_prompt`；传入的 path 已经过调用方规范化。 */
export function buildSkillsInventory(skills: readonly SkillInfo[]): string {
  const lines = skills.map((skill) => {
    const description = sanitizeDescription(skill.description || 'No description') || 'No description';
    const renderedPath = sanitizePath(skill.path) || '<skills_root>/<skill_name>';
    return `- **${displayName(skill.name)}**: ${description}\n  Directory: \`${renderedPath}\``;
  });
  return '## Skills\n\n'
    + 'You have specialized skills — reusable instruction bundles stored '
    + 'in `SKILL.md` files. Each skill has a **name** and a **description** '
    + 'that tells you what it does and when to use it.\n\n'
    + '### Available skills\n\n'
    + `${lines.join('\n')}\n\n`
    + '### Skill rules\n\n'
    + '1. **Discovery** — The list above is the complete skill inventory '
    + 'for this session. Full instructions live in each skill\'s '
    + '`SKILL.md` file.\n'
    + '2. **When to trigger** — Use a skill if the user names it '
    + 'explicitly, or if the task clearly matches the skill\'s description. '
    + '*Never silently skip a matching skill* — either use it or briefly '
    + 'explain why you chose not to.\n'
    + '3. **Mandatory grounding** — Before executing any skill you MUST '
    + 'first load its `SKILL.md` instructions by calling the `Skill` tool '
    + 'with the skill\'s **name** (e.g. `Skill(name="<skill_name>")`). '
    + 'Never rely on memory or assumptions about a skill\'s content.\n'
    + '4. **Progressive disclosure** — Load only what is directly '
    + 'referenced from `SKILL.md`:\n'
    + '   - If `scripts/` exist, prefer running or patching them over '
    + 'rewriting code from scratch.\n'
    + '   - If `references/`, `assets/`, or templates exist, reuse them.\n'
    + '   - Do NOT bulk-load every file in the skill directory.\n'
    + '5. **Coordination** — When multiple skills apply, pick the minimal '
    + 'set needed. Announce which skill(s) you are using and why '
    + '(one short line).\n'
    + '6. **Context hygiene** — Avoid deep reference chasing; open only '
    + 'files that are directly linked from `SKILL.md`. The directory path '
    + 'shown for each skill is for locating its ancillary files.\n'
    + '7. **Failure handling** — If a skill cannot be applied, state the '
    + 'issue clearly and continue with the best alternative.\n';
}

export const SKILL_TOOL_SPEC: ToolSpec = {
  name: 'Skill',
  description: 'Load the full SKILL.md instructions for a named skill. Pass the skill\'s '
    + 'name exactly as it appears in the available-skills inventory; call this '
    + 'before executing a skill to ground yourself in its instructions. This tool '
    + 'loads instructions only — it does not read arbitrary files.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'The skill name to load, from the available-skills inventory.',
      },
    },
    required: ['name'],
  },
};

export function createSkillTool(skills: readonly SkillInfo[]): Tool {
  return {
    ...SKILL_TOOL_SPEC,
    handler: ({args}) => {
      const name = args.name;
      if (typeof name !== 'string' || !SKILL_NAME_PATTERN.test(name)) {
        return `Invalid skill name: ${JSON.stringify(name)}`;
      }
      const skill = skills.find((candidate) => candidate.name === name && candidate.active);
      if (skill === undefined) return `Skill not found: ${JSON.stringify(name)}`;
      return skill.content;
    },
  };
}
