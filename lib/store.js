/**
 * Durable JSON store for the sticker TODO plugin.
 *
 * The Host half owns the todo data so that both the Web panel and the agent tool see the same
 * list. One small JSON document is kept in memory and rewritten atomically (temp file + rename)
 * after every mutation; writes are serialized so a burst of panel clicks cannot interleave.
 *
 * @module dsh-sticker-todo/lib/store
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

/** Sticky-note palette keys the client renders. */
export const COLORS = ['yellow', 'pink', 'blue', 'green', 'purple', 'orange']

/** Document format version; bumped when the persisted shape changes. */
const VERSION = 1

/** Upper bounds that keep one bad request from bloating the document. */
const LIMITS = { todos: 500, text: 500, note: 2000 }

/** Tag format limits from CONTRACT.md: 0–3 entries, each 1–12 characters. */
const TAG_LIMITS = { count: 3, length: 12 }

/** Separators accepted inside one tag field: ASCII/Chinese comma and semicolon, and whitespace. */
const TAG_SPLITTER = /[,，;；、\s]+/

/**
 * A rejected user input, carrying a stable code the HTTP layer maps onto `ok: false`.
 */
export class InputError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'InputError'
    this.code = code
  }
}

/**
 * Convert a user-supplied timestamp into a canonical ISO string.
 * Accepts ISO-8601, `YYYY-MM-DDTHH:mm[:ss]` (read as local time), or an empty value.
 * @param {unknown} value raw value from the client, the agent tool, or the persisted file.
 * @param {string} field field name used in the failure message.
 * @returns {string | null} canonical ISO string or null.
 */
export function normalizeTime(value, field) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new InputError('invalid_input', `${field} must be an ISO-8601 date-time string`)
  const trimmed = value.trim()
  if (trimmed === '') return null
  const parsed = new Date(trimmed)
  if (Number.isNaN(parsed.getTime())) throw new InputError('invalid_input', `${field} is not a valid date-time: ${trimmed}`)
  return parsed.toISOString()
}

/**
 * Trim and bound an optional free-text field.
 * @param {unknown} value raw value.
 * @param {string} field field name used in the failure message.
 * @param {number} max maximum accepted length.
 * @returns {string} the cleaned text (empty when absent).
 */
function optionalText(value, field, max) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new InputError('invalid_input', `${field} must be a string`)
  const trimmed = value.trim()
  if (trimmed.length > max) throw new InputError('invalid_input', `${field} is longer than ${max} characters`)
  return trimmed
}

/**
 * Validate and canonicalize a priority value.
 * @param {unknown} value raw value; absent means medium.
 * @returns {number} 1 (high) | 2 (medium) | 3 (low).
 */
function priorityOf(value) {
  if (value === undefined || value === null || value === '') return 2
  const parsed = typeof value === 'string' ? Number(value) : value
  if (parsed !== 1 && parsed !== 2 && parsed !== 3) throw new InputError('invalid_input', 'priority must be 1, 2, or 3')
  return parsed
}

/**
 * Validate and canonicalize a sticker color.
 * @param {unknown} value raw value; absent means yellow.
 * @returns {string} one of {@link COLORS}.
 */
function colorOf(value) {
  if (value === undefined || value === null || value === '') return 'yellow'
  if (typeof value !== 'string' || !COLORS.includes(value)) {
    throw new InputError('invalid_input', `color must be one of ${COLORS.join(', ')}`)
  }
  return value
}

/**
 * Trim one tag and drop the `#` prefixes users type in front of it.
 * @param {string} value raw tag text.
 * @returns {string} the bare tag (empty when nothing is left).
 */
function bareTag(value) {
  return value.trim().replace(/^[#＃]+/, '').trim()
}

/**
 * Canonical tag list for one note.
 *
 * Accepts an array of tag strings, or one delimited string (comma, Chinese comma,
 * semicolon, Chinese semicolon, or whitespace — the panel sends one text field). Every
 * tag is trimmed, loses leading `#`, must be 1–12 characters, and duplicates are
 * dropped case-insensitively while keeping the first spelling and the input order.
 * At most three tags are accepted; a fourth tag is a validation error, not silently cut.
 *
 * @param {unknown} value array of strings, or a delimited string, or absent.
 * @returns {string[]} the canonical tag list (always an array).
 * @throws {InputError} code `invalid_input` for a wrong type, an over-long tag, or more than three tags.
 */
export function normalizeTags(value) {
  if (value === undefined || value === null) return []
  /** @type {unknown[]} */
  let candidates
  if (typeof value === 'string') candidates = value.split(TAG_SPLITTER)
  else if (Array.isArray(value)) candidates = value
  else throw new InputError('invalid_input', 'tags must be an array of strings or one delimited string')

  /** @type {string[]} */
  const tags = []
  const seen = new Set()
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') throw new InputError('invalid_input', 'tags must be an array of strings')
    const tag = bareTag(candidate)
    if (tag === '') continue
    if ([...tag].length > TAG_LIMITS.length) {
      throw new InputError('invalid_input', `a tag must be 1-${TAG_LIMITS.length} characters: ${tag}`)
    }
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    tags.push(tag)
    if (tags.length > TAG_LIMITS.count) {
      throw new InputError('invalid_input', `at most ${TAG_LIMITS.count} tags are allowed`)
    }
  }
  return tags
}

/**
 * Read tags from the persisted document without ever throwing: only a real array of
 * strings is kept, malformed members are dropped, and the list is capped at three.
 * @param {unknown} value persisted value.
 * @returns {string[]} the tags to load into memory.
 */
function persistedTags(value) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return []
  /** @type {string[]} */
  const tags = []
  const seen = new Set()
  for (const entry of value) {
    const tag = bareTag(entry)
    if (tag === '' || [...tag].length > TAG_LIMITS.length) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    tags.push(tag)
    if (tags.length >= TAG_LIMITS.count) break
  }
  return tags
}

/**
 * Copy a stored tag array so a caller cannot mutate the document through the copy.
 * @param {unknown} value stored tags.
 * @returns {string[]} a fresh array.
 */
function copyTags(value) {
  return Array.isArray(value) ? value.filter((tag) => typeof tag === 'string') : []
}

/**
 * Coerce one persisted or incoming record into the canonical todo shape.
 * @param {Record<string, unknown>} raw candidate.
 * @param {string} fallbackId id to keep when the record has none (new records supply one).
 * @returns {Record<string, unknown>} canonical todo.
 */
function toTodo(raw, fallbackId) {
  const now = new Date().toISOString()
  const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, LIMITS.text) : ''
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : fallbackId,
    text,
    note: typeof raw.note === 'string' ? raw.note.slice(0, LIMITS.note) : '',
    done: raw.done === true,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now,
    dueAt: typeof raw.dueAt === 'string' ? raw.dueAt : null,
    remindAt: typeof raw.remindAt === 'string' ? raw.remindAt : null,
    remindFiredAt: typeof raw.remindFiredAt === 'string' ? raw.remindFiredAt : null,
    priority: raw.priority === 1 || raw.priority === 2 || raw.priority === 3 ? raw.priority : 2,
    color: typeof raw.color === 'string' && COLORS.includes(raw.color) ? raw.color : 'yellow',
    tags: persistedTags(raw.tags),
    planAt: typeof raw.planAt === 'string' ? raw.planAt : null,
    planNote: typeof raw.planNote === 'string' ? raw.planNote.slice(0, LIMITS.note) : '',
  }
}

/**
 * Display order: open notes first (soonest deadline, then highest priority), finished ones last.
 * @param {Array<Record<string, any>>} todos records to sort; the input is not modified.
 * @returns {Array<Record<string, any>>} a new sorted array.
 */
export function sortTodos(todos) {
  const time = (value) => (typeof value === 'string' ? new Date(value).getTime() : Number.POSITIVE_INFINITY)
  const rank = (todo) => {
    if (todo.done) return 2
    return todo.dueAt ? 0 : 1
  }
  return [...todos].sort((a, b) => {
    const byRank = rank(a) - rank(b)
    if (byRank !== 0) return byRank
    if (a.done && b.done) return time(b.updatedAt) - time(a.updatedAt)
    const byDue = time(a.dueAt) - time(b.dueAt)
    if (byDue !== 0) return byDue
    if (a.priority !== b.priority) return a.priority - b.priority
    return time(a.createdAt) - time(b.createdAt)
  })
}

/**
 * Reminders that are due and not acknowledged yet.
 * @param {Array<Record<string, any>>} todos records to scan.
 * @param {Date} now reference clock.
 * @returns {Array<Record<string, any>>} due reminders, earliest first.
 */
export function dueReminders(todos, now = new Date()) {
  const reference = now.getTime()
  return todos
    .filter((todo) => !todo.done && todo.remindAt && !todo.remindFiredAt && new Date(todo.remindAt).getTime() <= reference)
    .sort((a, b) => new Date(a.remindAt).getTime() - new Date(b.remindAt).getTime())
}

/**
 * Resolve the default data file path.
 * @returns {string} absolute path of the JSON document.
 */
export function defaultDataFile() {
  return join(homedir(), '.dsh-sticker-todo', 'todos.json')
}

/**
 * Create the in-memory store backed by one JSON document.
 * @param {{ filePath?: string, logger?: (message: string) => void }} [options] store options.
 * @returns {object} the store API.
 */
export function createStore(options = {}) {
  const filePath = options.filePath || defaultDataFile()
  const logger = options.logger || (() => {})
  /** @type {{ version: number, todos: Array<Record<string, any>> }} */
  let data = { version: VERSION, todos: [] }
  /** @type {Promise<void> | null} */
  let loadPromise = null
  /** @type {Promise<unknown>} */
  let writeQueue = Promise.resolve()

  /** Read the document once; a missing or corrupt file starts an empty list instead of throwing. */
  async function load() {
    try {
      const text = await readFile(filePath, 'utf8')
      const parsed = JSON.parse(text)
      const todos = Array.isArray(parsed?.todos) ? parsed.todos : []
      data = { version: VERSION, todos: todos.filter((todo) => todo && typeof todo.text === 'string').map((todo) => toTodo(todo, `td_${randomUUID().slice(0, 8)}`)) }
    } catch (error) {
      if (error && error.code === 'ENOENT') return
      logger(`sticker-todo: could not read ${filePath} (${error.message}); starting empty`)
      try {
        await rename(filePath, `${filePath}.corrupt-${Date.now()}`)
      } catch {
        /* the document may be a directory or already gone; an empty list is still usable */
      }
      data = { version: VERSION, todos: [] }
    }
  }

  /** Resolve once the persisted document has been read. */
  function ready() {
    loadPromise ??= load()
    return loadPromise
  }

  /** Atomically rewrite the document; failures are logged and never reject the caller's mutation. */
  function persist() {
    const snapshot = JSON.stringify(data, null, 2)
    writeQueue = writeQueue.then(async () => {
      try {
        await mkdir(dirname(filePath), { recursive: true })
        const temp = `${filePath}.${process.pid}.tmp`
        await writeFile(temp, snapshot, 'utf8')
        await rename(temp, filePath)
      } catch (error) {
        logger(`sticker-todo: could not write ${filePath} (${error.message})`)
      }
    })
    return writeQueue
  }

  /** @returns {Array<Record<string, any>>} a shallow copy of the records (tag arrays are copied too). */
  function all() {
    return data.todos.map((todo) => ({ ...todo, tags: copyTags(todo.tags) }))
  }

  /**
   * @param {string} id todo id.
   * @returns {Record<string, any> | undefined} a copy of the record.
   */
  function get(id) {
    const found = data.todos.find((todo) => todo.id === id)
    return found ? { ...found, tags: copyTags(found.tags) } : undefined
  }

  /**
   * Append a new note.
   * @param {Record<string, unknown>} input fields from the client or the agent tool.
   * @returns {Promise<Record<string, any>>} the created todo.
   */
  async function add(input = {}) {
    if (data.todos.length >= LIMITS.todos) throw new InputError('invalid_input', `the list already holds ${LIMITS.todos} notes`)
    const text = optionalText(input.text, 'text', LIMITS.text)
    if (text === '') throw new InputError('invalid_input', 'text is required')
    const now = new Date().toISOString()
    const todo = {
      id: `td_${randomUUID().slice(0, 8)}`,
      text,
      note: optionalText(input.note, 'note', LIMITS.note),
      done: false,
      createdAt: now,
      updatedAt: now,
      dueAt: normalizeTime(input.dueAt, 'dueAt'),
      remindAt: normalizeTime(input.remindAt, 'remindAt'),
      remindFiredAt: null,
      priority: priorityOf(input.priority),
      color: colorOf(input.color),
      tags: normalizeTags(input.tags),
      planAt: null,
      planNote: '',
    }
    data = { ...data, todos: [...data.todos, todo] }
    await persist()
    return { ...todo }
  }

  /**
   * Patch one note. Only the mutable fields are accepted.
   * @param {string} id todo id.
   * @param {Record<string, unknown>} patch fields to replace.
   * @returns {Promise<Record<string, any>>} the updated todo.
   */
  async function update(id, patch = {}) {
    const index = data.todos.findIndex((todo) => todo.id === id)
    if (index < 0) throw new InputError('not_found', `no todo with id ${id}`)
    const current = data.todos[index]
    /** @type {Record<string, any>} */
    const next = { ...current }
    if (patch.text !== undefined) {
      const text = optionalText(patch.text, 'text', LIMITS.text)
      if (text === '') throw new InputError('invalid_input', 'text must not be empty')
      next.text = text
    }
    if (patch.note !== undefined) next.note = optionalText(patch.note, 'note', LIMITS.note)
    if (patch.dueAt !== undefined) next.dueAt = normalizeTime(patch.dueAt, 'dueAt')
    if (patch.remindAt !== undefined) {
      const remindAt = normalizeTime(patch.remindAt, 'remindAt')
      if (remindAt !== current.remindAt) next.remindFiredAt = null
      next.remindAt = remindAt
    }
    if (patch.priority !== undefined) next.priority = priorityOf(patch.priority)
    if (patch.color !== undefined) next.color = colorOf(patch.color)
    if (patch.tags !== undefined) next.tags = normalizeTags(patch.tags)
    next.updatedAt = new Date().toISOString()
    const todos = [...data.todos]
    todos[index] = next
    data = { ...data, todos }
    await persist()
    return { ...next }
  }

  /**
   * Mark a note done or open.
   * @param {string} id todo id.
   * @param {boolean} [done] explicit target state; omitted toggles.
   * @returns {Promise<Record<string, any>>} the updated todo.
   */
  async function toggle(id, done) {
    const current = get(id)
    if (!current) throw new InputError('not_found', `no todo with id ${id}`)
    const target = typeof done === 'boolean' ? done : !current.done
    if (target === current.done) return current
    const index = data.todos.findIndex((todo) => todo.id === id)
    const next = { ...current, done: target, updatedAt: new Date().toISOString() }
    const todos = [...data.todos]
    todos[index] = next
    data = { ...data, todos }
    await persist()
    return { ...next }
  }

  /**
   * Delete one note.
   * @param {string} id todo id.
   * @returns {Promise<{ removed: string }>} the removed id.
   */
  async function remove(id) {
    const before = data.todos.length
    data = { ...data, todos: data.todos.filter((todo) => todo.id !== id) }
    if (data.todos.length === before) throw new InputError('not_found', `no todo with id ${id}`)
    await persist()
    return { removed: id }
  }

  /**
   * Delete every finished note.
   * @returns {Promise<{ removed: number }>} how many were deleted.
   */
  async function clearCompleted() {
    const before = data.todos.length
    data = { ...data, todos: data.todos.filter((todo) => !todo.done) }
    const removed = before - data.todos.length
    if (removed > 0) await persist()
    return { removed }
  }

  /**
   * Record that the user has seen the given reminders so they stop firing.
   * @param {string[]} ids todo ids.
   * @returns {Promise<{ acked: number }>} how many reminders were acknowledged.
   */
  async function ackReminders(ids) {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      throw new InputError('invalid_input', 'ids must be an array of todo ids')
    }
    const wanted = new Set(ids)
    const now = new Date().toISOString()
    let acked = 0
    const todos = data.todos.map((todo) => {
      if (!wanted.has(todo.id) || !todo.remindAt || todo.remindFiredAt) return todo
      acked += 1
      return { ...todo, remindFiredAt: now }
    })
    if (acked > 0) {
      data = { ...data, todos }
      await persist()
    }
    return { acked }
  }

  /**
   * Write an AI-produced schedule onto the notes it names.
   * @param {Array<{ id?: string, planAt?: unknown, note?: unknown }>} items normalized plan items.
   * @returns {Promise<Array<Record<string, any>>>} the fresh todo list.
   */
  async function applyPlan(items) {
    if (!Array.isArray(items) || items.length === 0) return all()
    /** @type {Map<string, { planAt: string | null, planNote: string }>} */
    const byId = new Map()
    for (const item of items) {
      if (!item || typeof item.id !== 'string') continue
      const planAt = normalizeTime(item.planAt, 'planAt')
      if (!planAt) continue
      byId.set(item.id, { planAt, planNote: typeof item.note === 'string' ? item.note.slice(0, LIMITS.note) : '' })
    }
    if (byId.size === 0) return all()
    const now = new Date().toISOString()
    data = {
      ...data,
      todos: data.todos.map((todo) => {
        const planned = byId.get(todo.id)
        return planned ? { ...todo, planAt: planned.planAt, planNote: planned.planNote, updatedAt: now } : todo
      }),
    }
    await persist()
    return all()
  }

  /**
   * Write AI-produced tags onto the notes they name.
   * Unknown ids, malformed entries, and items with no usable tags are ignored; existing tags
   * are replaced (never merged) and `updatedAt` is bumped only on the notes that changed.
   * @param {Array<{ id?: unknown, tags?: unknown }>} items normalized tagging items.
   * @returns {Promise<Array<Record<string, any>>>} the fresh todo list in display order.
   */
  async function applyTags(items) {
    if (!Array.isArray(items) || items.length === 0) return sortTodos(all())
    /** @type {Map<string, string[]>} */
    const byId = new Map()
    for (const item of items) {
      if (!item || typeof item.id !== 'string' || item.id === '') continue
      /** @type {string[]} */
      let tags
      try {
        tags = normalizeTags(item.tags)
      } catch (error) {
        continue
      }
      if (tags.length === 0) continue
      byId.set(item.id, tags)
    }
    if (byId.size === 0) return sortTodos(all())
    const now = new Date().toISOString()
    data = {
      ...data,
      todos: data.todos.map((todo) => {
        const tags = byId.get(todo.id)
        return tags ? { ...todo, tags: [...tags], updatedAt: now } : todo
      }),
    }
    await persist()
    return sortTodos(all())
  }

  /**
   * Drop every AI-planned slot, keeping the notes themselves.
   * @returns {Promise<Array<Record<string, any>>>} the fresh todo list.
   */
  async function clearPlan() {
    const now = new Date().toISOString()
    data = {
      ...data,
      todos: data.todos.map((todo) => (todo.planAt || todo.planNote ? { ...todo, planAt: null, planNote: '', updatedAt: now } : todo)),
    }
    await persist()
    return all()
  }

  return {
    filePath,
    ready,
    all,
    get,
    add,
    update,
    toggle,
    remove,
    clearCompleted,
    ackReminders,
    applyPlan,
    applyTags,
    clearPlan,
  }
}
