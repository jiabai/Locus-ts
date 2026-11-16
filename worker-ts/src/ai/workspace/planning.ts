// 成稿计划的 `write_todos` 工具与状态注入。
//
// 对应 `agent_runtime.extensions.planning`：计划是独立于消息流的状态，每次模型请求前
// 重新注入 system 消息；模型想以纯文本收尾但计划还有未完成项时，最多提醒两次再放行。
import type {ToolSpec} from '../chat.ts';
import type {Tool} from '../tool-loop.ts';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface Todo {
  readonly content: string;
  readonly status: TodoStatus;
}

const STATUS_MARK: Readonly<Record<TodoStatus, string>> = {
  pending: '[ ]',
  in_progress: '[~]',
  completed: '[x]',
};

const PLANNING_MAX_REMINDERS = 2;

export const PLANNING_REMINDER = 'You have not finished the plan. There are still unfinished '
  + 'todos. Continue working on the next pending item, or call `write_todos` to update the '
  + 'plan. Only stop once every item is completed.';

export const TODO_STATE_OPEN = '<!-- todo-state -->';
export const TODO_STATE_CLOSE = '<!-- /todo-state -->';

export function renderPlan(todos: readonly Todo[]): string {
  if (todos.length === 0) return '_No plan yet. Call `write_todos` to create one._';
  return todos.map((todo) => `- ${STATUS_MARK[todo.status]} ${todo.content}`).join('\n');
}

export function buildPlanningPrompt(todos: readonly Todo[]): string {
  return '## Plan\n\n'
    + 'For any open-ended, multi-step task, keep a todo plan with the `write_todos` '
    + 'tool. The plan is your single source of truth for progress.\n\n'
    + 'Rules:\n'
    + '- `write_todos` is **full-replacement**: always pass the complete list, not a '
    + 'diff. To change one item, resend every item.\n'
    + '- Each item has `content` and a `status` of `pending`, `in_progress`, or '
    + '`completed`.\n'
    + '- Keep **exactly one** item `in_progress` at a time; mark it `completed` before '
    + 'starting the next.\n'
    + '- Update the plan as you go, and do not declare the task finished while items '
    + 'remain unfinished.\n\n'
    + '### Current plan\n\n'
    + renderPlan(todos);
}

export const WRITE_TODOS_TOOL_SPEC: ToolSpec = {
  name: 'write_todos',
  description: 'Create or replace the current todo plan for an open-ended, multi-step task. '
    + 'Full-replacement: always pass the complete list of items, not a diff. Each '
    + 'item has \'content\' (the step) and \'status\' (pending/in_progress/completed). '
    + 'Keep exactly one item in_progress at a time. Update the plan as you make '
    + 'progress.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The complete todo list, replacing any prior plan.',
        items: {
          type: 'object',
          properties: {
            content: {type: 'string', description: 'The step description.'},
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: "The item's lifecycle status.",
            },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
};

function todoFromArgs(value: unknown): Todo {
  const record = value as Record<string, unknown>;
  const rawStatus = record.status;
  const status: TodoStatus = rawStatus === 'pending' || rawStatus === 'in_progress'
    || rawStatus === 'completed'
    ? rawStatus
    : 'pending';
  return {content: String(record.content ?? ''), status};
}

export interface PlanningState {
  readonly todos: readonly Todo[];
  readonly reminderCount: number;
}

export function createPlanningState(): PlanningState & {
  replace(todos: readonly Todo[]): void;
  hasUnfinished(): boolean;
  veto(): boolean;
} {
  const state = {
    todos: [] as Todo[],
    reminderCount: 0,
    replace(todos: readonly Todo[]): void {
      state.todos = [...todos];
    },
    hasUnfinished(): boolean {
      return state.todos.some((todo) => todo.status !== 'completed');
    },
    veto(): boolean {
      if (!state.hasUnfinished()) return false;
      if (state.reminderCount >= PLANNING_MAX_REMINDERS) return false;
      state.reminderCount += 1;
      return true;
    },
  };
  return state;
}

export function createWriteTodosTool(state: ReturnType<typeof createPlanningState>): Tool {
  return {
    ...WRITE_TODOS_TOOL_SPEC,
    handler: ({args}) => {
      const raw = args.todos;
      if (!Array.isArray(raw)) return 'Plan updated:\n\n' + renderPlan([]);
      const plan = raw
        .filter((item) => item !== null && typeof item === 'object' && !Array.isArray(item))
        .map(todoFromArgs);
      state.replace(plan);
      return `Plan updated:\n\n${renderPlan(plan)}`;
    },
  };
}
