/**
 * The model-facing `sticker_todo` tool.
 *
 * The tool is a thin adapter over the same store and AI operations the Web panel calls, so a
 * request made in chat and a click made in the panel can never disagree.
 *
 * @module dsh-sticker-todo/lib/tools
 */
import { COLORS, InputError } from './store.js'

/** Maximum number of notes echoed back in one tool result. */
const MAX_ECHO = 100

/** Actions the model may request. */
const ACTIONS = ['list', 'add', 'update', 'complete', 'remove', 'clear_completed', 'plan', 'advice', 'tag']

/**
 * Rendering helper shared by every result: one short line followed by the board digest.
 * @param {unknown} _args tool arguments (unused).
 * @param {Record<string, any>} value the tool's canonical value.
 * @returns {Array<Record<string, unknown>>} content blocks.
 */
function render(_args, value) {
  const counts = value?.counts ?? { open: 0, done: 0, overdue: 0, dueSoon: 0 }
  const lines = [`便利贴待办：${counts.open} 项未完成，${counts.done} 项已完成`]
  if (counts.overdue > 0) lines[0] += `，${counts.overdue} 项已逾期`
  if (counts.dueSoon > 0) lines[0] += `，${counts.dueSoon} 项今天到期`
  if (value?.plan?.summary) lines.push(`AI 安排：${value.plan.summary}`)
  if (value?.advice?.headline) lines.push(`AI 建议：${value.advice.headline}`)
  if (value?.tagResult?.summary) lines.push(`AI 打标签：${value.tagResult.summary}`)
  if (value?.error?.message) lines.push(`失败：${value.error.message}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * Count open/done/overdue/due-soon notes.
 * @param {Array<Record<string, any>>} todos sorted notes.
 * @param {Date} now reference clock.
 * @returns {{ open: number, done: number, overdue: number, dueSoon: number }} counts.
 */
function count(todos, now) {
  const endOfToday = new Date(now)
  endOfToday.setHours(23, 59, 59, 999)
  let open = 0
  let done = 0
  let overdue = 0
  let dueSoon = 0
  for (const todo of todos) {
    if (todo.done) {
      done += 1
      continue
    }
    open += 1
    if (!todo.dueAt) continue
    const due = new Date(todo.dueAt)
    if (due.getTime() < now.getTime()) overdue += 1
    else if (due.getTime() <= endOfToday.getTime()) dueSoon += 1
  }
  return { open, done, overdue, dueSoon }
}

/**
 * Drop `undefined` members so spread arguments into the store stay clean.
 * @param {Record<string, any>} source raw tool arguments.
 * @param {string[]} keys members to keep.
 * @returns {Record<string, any>} the picked members.
 */
function pick(source, keys) {
  /** @type {Record<string, any>} */
  const picked = {}
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) picked[key] = source[key]
  }
  return picked
}

/**
 * Register the tool on the plugin context.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context carrying `tools`.
 * @param {{ store: object, ai: object, runAction: (payload: object) => Promise<any>, readState: () => Record<string, any> }} deps shared plugin operations.
 * @returns {() => void} the registration disposer.
 */
export function registerTodoTool(ctx, deps) {
  const { store, runAction, readState } = deps
  return ctx.tools.register({
    name: 'sticker_todo',
    description:
      "Read and change the user's personal sticker TODO board (the 便利贴待办 panel in the app sidebar). " +
      'Use it when the user mentions their todo list, asks what is due or what to do next, wants a task recorded, ' +
      'or wants the board planned, reviewed, or tagged. Every call returns the current board with counts. ' +
      '`plan` runs an AI scheduling pass that writes suggested start times onto the notes; `advice` returns review suggestions without changing anything; ' +
      '`tag` runs an AI classification pass that writes up to three short tags onto every open note.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description:
            'list reads the board and changes nothing. add needs `text`. update needs `id` plus the fields to change. ' +
            'complete needs `id` and toggles it unless `done` is given. remove needs `id`. clear_completed deletes every finished note. ' +
            'plan, advice and tag take no other fields.',
        },
        id: { type: 'string', description: 'Note id taken from an earlier result.' },
        text: { type: 'string', description: 'The task, as one short imperative line.' },
        note: { type: 'string', description: 'Optional detail shown under the task; send an empty string to clear it.' },
        dueAt: {
          type: 'string',
          description: 'Deadline as an ISO-8601 instant with offset, e.g. 2026-11-04T18:00:00+08:00. Omit for no deadline; send an empty string to clear it.',
        },
        remindAt: { type: 'string', description: 'When to remind the user, ISO-8601 with offset. Omit to remove the reminder.' },
        priority: { type: 'integer', enum: [1, 2, 3], description: '1 high, 2 medium (the default), 3 low.' },
        color: { type: 'string', enum: COLORS, description: 'Sticker color; omit to keep the current one.' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Up to three short tags, 1-12 characters each, without a leading #, e.g. ["工作","周报"]. Send an empty array to clear them.',
        },
        done: { type: 'boolean', description: 'Target state for the complete action; omit to toggle.' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object' },
      render,
    },
    async execute(args) {
      await store.ready()
      const input = args && typeof args === 'object' ? args : {}
      const action = typeof input.action === 'string' ? input.action : 'list'
      /** @type {Record<string, any>} */
      const extra = {}
      try {
        switch (action) {
          case 'list':
            break
          case 'add':
            await runAction({ action: 'add', ...pick(input, ['text', 'note', 'dueAt', 'remindAt', 'priority', 'color', 'tags']) })
            break
          case 'update':
            await runAction({ action: 'update', ...pick(input, ['id', 'text', 'note', 'dueAt', 'remindAt', 'priority', 'color', 'tags']) })
            break
          case 'complete':
            await runAction({ action: 'toggle', ...pick(input, ['id', 'done']) })
            break
          case 'remove':
            await runAction({ action: 'remove', ...pick(input, ['id']) })
            break
          case 'clear_completed':
            extra.removed = (await runAction({ action: 'clearCompleted' })).removed
            break
          case 'plan': {
            const result = await runAction({ action: 'aiPlan' })
            extra.plan = result.plan
            break
          }
          case 'advice': {
            const result = await runAction({ action: 'aiAdvice' })
            extra.advice = result.advice
            break
          }
          case 'tag': {
            const result = await runAction({ action: 'aiTag' })
            extra.tagResult = result.tagResult
            break
          }
          default:
            throw new InputError('unknown_action', `unknown action: ${action}`)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const code = error instanceof InputError ? error.code : 'internal_error'
        return { ok: false, error: { code, message } }
      }
      const state = readState()
      const now = new Date(state.now)
      const summary = count(state.todos, now)
      return {
        ok: true,
        now: state.now,
        counts: summary,
        ai: state.ai,
        todos: state.todos.slice(0, MAX_ECHO).map((todo) => ({
          id: todo.id,
          text: todo.text,
          done: todo.done,
          priority: todo.priority,
          dueAt: todo.dueAt,
          remindAt: todo.remindAt,
          planAt: todo.planAt,
          note: todo.note,
          tags: Array.isArray(todo.tags) ? [...todo.tags] : [],
        })),
        truncated: state.todos.length > MAX_ECHO,
        ...extra,
      }
    },
  })
}
