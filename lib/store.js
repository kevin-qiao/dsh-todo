/**
 * Durable JSON store for the sticker TODO plugin.
 *
 * The Host half owns the todo data so that both the Web panel and the agent tool see the same
 * list. One small JSON document is kept in memory and rewritten atomically (temp file + rename)
 * after every mutation; writes are serialized so a burst of panel clicks cannot interleave.
 *
 * Document v2 (CONTRACT.md round 7) adds the memory of the board next to the notes themselves:
 * an append-only `events` ring (what happened), `memory.facts` (short user-owned preferences)
 * and `memory.threads` (the per-note advisory conversation plus its last advice). A v1 document
 * loads unchanged and is upgraded on the next write.
 *
 * @module dsh-sticker-todo/lib/store
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

/** Sticky-note palette keys the client renders. */
export const COLORS = ['yellow', 'pink', 'blue', 'green', 'purple', 'orange']

/** One day in milliseconds, used by the trailing-week window. */
const DAY_MS = 24 * 60 * 60 * 1000

/** Document format version; bumped when the persisted shape changes (v2 adds memory). */
const VERSION = 2

/** Upper bounds that keep one bad request from bloating the document. */
const LIMITS = { todos: 500, text: 500, note: 2000 }

/** Tag format limits from CONTRACT.md: 0–3 entries, each 1–12 characters. */
const TAG_LIMITS = { count: 3, length: 12 }

/** Memory limits from CONTRACT.md round 7. */
const MEMORY_LIMITS = {
  events: 2000,
  facts: 50,
  threads: 200,
  factText: 120,
  rounds: 3,
  question: 120,
  answer: 800,
  advice: 400,
}

/** Event kinds the document may hold. */
export const EVENT_KINDS = ['create', 'update', 'done', 'reopen', 'remove', 'plan', 'tag', 'remind', 'clear']

/** Fields whose change is recorded on an `update` event. */
const CHANGE_FIELDS = ['dueAt', 'remindAt', 'priority', 'tags', 'text']

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

/* ------------------------------------------------------------------------- *
 * Memory (v2): events, facts, threads, derived statistics
 * ------------------------------------------------------------------------- */

/**
 * Coerce one persisted event into the canonical shape, dropping anything unusable.
 * @param {unknown} raw candidate from the document.
 * @returns {Record<string, any> | null} the canonical event, or null when it cannot be kept.
 */
function toEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (typeof raw.at !== 'string' || typeof raw.kind !== 'string' || !EVENT_KINDS.includes(raw.kind)) return null
  if (Number.isNaN(new Date(raw.at).getTime())) return null
  /** @type {Record<string, any>} */
  const event = { at: raw.at, kind: raw.kind }
  if (typeof raw.id === 'string' && raw.id !== '') event.id = raw.id
  if (typeof raw.text === 'string' && raw.text !== '') event.text = raw.text.slice(0, LIMITS.text)
  if (typeof raw.count === 'number' && Number.isFinite(raw.count)) event.count = raw.count
  if (raw.changes && typeof raw.changes === 'object' && !Array.isArray(raw.changes)) {
    /** @type {Record<string, { from: unknown, to: unknown }>} */
    const changes = {}
    for (const field of CHANGE_FIELDS) {
      const entry = raw.changes[field]
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      changes[field] = { from: entry.from ?? null, to: entry.to ?? null }
    }
    if (Object.keys(changes).length > 0) event.changes = changes
  }
  return event
}

/**
 * Copy one event so a caller cannot mutate the document through the copy.
 * @param {Record<string, any>} event stored event.
 * @returns {Record<string, any>} a fresh event.
 */
function copyEvent(event) {
  /** @type {Record<string, any>} */
  const copy = { at: event.at, kind: event.kind }
  if (event.id) copy.id = event.id
  if (event.text) copy.text = event.text
  if (typeof event.count === 'number') copy.count = event.count
  if (event.changes) {
    /** @type {Record<string, { from: unknown, to: unknown }>} */
    const changes = {}
    for (const [field, entry] of Object.entries(event.changes)) changes[field] = { from: entry.from, to: entry.to }
    copy.changes = changes
  }
  return copy
}

/**
 * Coerce one persisted or incoming fact, dropping it when the text is unusable.
 * @param {unknown} raw candidate.
 * @returns {Record<string, any> | null} the canonical fact, or null.
 */
function toFact(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const text = typeof raw.text === 'string' ? raw.text.trim() : ''
  if (text === '' || [...text].length > MEMORY_LIMITS.factText) return null
  const now = new Date().toISOString()
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : now
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : `m_${randomUUID().slice(0, 8)}`,
    text,
    source: raw.source === 'confirmed' ? 'confirmed' : 'user',
    createdAt,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : createdAt,
  }
}

/**
 * Copy one fact so a caller cannot mutate the document through the copy.
 * @param {Record<string, any>} fact stored fact.
 * @returns {Record<string, any>} a fresh fact.
 */
function copyFact(fact) {
  return { id: fact.id, text: fact.text, source: fact.source, createdAt: fact.createdAt, updatedAt: fact.updatedAt }
}

/**
 * Coerce one persisted or incoming thread, dropping it when there is nothing to remember.
 * Rounds are trimmed and capped at three; an advice without text is dropped.
 * @param {unknown} raw candidate.
 * @returns {{ rounds: Array<Record<string, any>>, advice: Record<string, any> | null, updatedAt: string } | null} the canonical thread, or null.
 */
function toThread(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const now = new Date().toISOString()
  /** @type {Array<Record<string, any>>} */
  const rounds = []
  if (Array.isArray(raw.rounds)) {
    for (const entry of raw.rounds) {
      if (rounds.length >= MEMORY_LIMITS.rounds) break
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      const question = typeof entry.question === 'string' ? entry.question.trim().slice(0, MEMORY_LIMITS.question) : ''
      const answer = typeof entry.answer === 'string' ? entry.answer.trim().slice(0, MEMORY_LIMITS.answer) : ''
      if (question === '' || answer === '') continue
      rounds.push({
        round: rounds.length + 1,
        question,
        answer,
        at: typeof entry.at === 'string' ? entry.at : now,
      })
    }
  }
  /** @type {Record<string, any> | null} */
  let advice = null
  if (raw.advice && typeof raw.advice === 'object' && !Array.isArray(raw.advice)) {
    const text = typeof raw.advice.text === 'string' ? raw.advice.text.trim().slice(0, MEMORY_LIMITS.advice) : ''
    if (text !== '') {
      advice = {
        text,
        source: raw.advice.source === 'fallback' ? 'fallback' : 'model',
        at: typeof raw.advice.at === 'string' ? raw.advice.at : now,
      }
    }
  }
  if (rounds.length === 0 && advice === null) return null
  return { rounds, advice, updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now }
}

/**
 * Copy one thread so a caller cannot mutate the document through the copy.
 * @param {{ rounds: Array<Record<string, any>>, advice: Record<string, any> | null, updatedAt: string }} thread stored thread.
 * @returns {Record<string, any>} a fresh thread.
 */
function copyThread(thread) {
  return {
    rounds: thread.rounds.map((entry) => ({ ...entry })),
    advice: thread.advice ? { ...thread.advice } : null,
    updatedAt: thread.updatedAt,
  }
}

/**
 * Keep at most {@link MEMORY_LIMITS}.threads threads, dropping the least recently updated.
 * @param {Record<string, any>} threads id → thread map.
 * @returns {Record<string, any>} the pruned map (the input is not modified).
 */
function pruneThreads(threads) {
  const ids = Object.keys(threads)
  if (ids.length <= MEMORY_LIMITS.threads) return threads
  const keep = ids
    .sort((a, b) => String(threads[a].updatedAt).localeCompare(String(threads[b].updatedAt)))
    .slice(ids.length - MEMORY_LIMITS.threads)
  /** @type {Record<string, any>} */
  const pruned = {}
  for (const id of keep) pruned[id] = threads[id]
  return pruned
}

/**
 * Whether one `update` event pushed a deadline later.
 * Setting a first deadline (`from` null) or moving it earlier is not a postponement.
 * @param {unknown} changes the event's `changes` member.
 * @returns {boolean} true when the deadline moved forward in time.
 */
export function duePostponed(changes) {
  const entry = changes && typeof changes === 'object' ? changes.dueAt : undefined
  if (!entry || typeof entry !== 'object') return false
  const from = typeof entry.from === 'string' ? new Date(entry.from).getTime() : Number.NaN
  const to = typeof entry.to === 'string' ? new Date(entry.to).getTime() : Number.NaN
  return Number.isFinite(from) && Number.isFinite(to) && to > from
}

/**
 * Count postponements per note id across an event log.
 * @param {Array<Record<string, any>>} events the event log.
 * @returns {Record<string, number>} id → count (only ids with at least one).
 */
export function derivePostpones(events) {
  /** @type {Record<string, number>} */
  const counts = {}
  if (!Array.isArray(events)) return counts
  for (const event of events) {
    if (!event || event.kind !== 'update' || typeof event.id !== 'string') continue
    if (!duePostponed(event.changes)) continue
    counts[event.id] = (counts[event.id] ?? 0) + 1
  }
  return counts
}

/**
 * Board + trailing-week statistics derived from the document (never persisted).
 * @param {Array<Record<string, any>>} todos the board.
 * @param {Array<Record<string, any>>} events the event log.
 * @param {Date | number | string} [now] reference clock.
 * @returns {{ open: number, done: number, overdue: number, averageOpenAgeDays: number, week: { completed: number, created: number, postponed: number, removed: number } }} the statistics.
 */
export function deriveStats(todos, events, now = new Date()) {
  const list = Array.isArray(todos) ? todos : []
  const log = Array.isArray(events) ? events : []
  const reference = new Date(now).getTime()
  const since = reference - 7 * DAY_MS
  let open = 0
  let done = 0
  let overdue = 0
  let ageSum = 0
  for (const todo of list) {
    if (todo.done === true) {
      done += 1
      continue
    }
    open += 1
    const created = typeof todo.createdAt === 'string' ? new Date(todo.createdAt).getTime() : Number.NaN
    if (Number.isFinite(created) && Number.isFinite(reference)) ageSum += Math.max(0, reference - created)
    if (todo.dueAt && new Date(todo.dueAt).getTime() < reference) overdue += 1
  }
  const week = { completed: 0, created: 0, postponed: 0, removed: 0 }
  for (const event of log) {
    if (!event || typeof event.at !== 'string') continue
    const at = new Date(event.at).getTime()
    if (!Number.isFinite(at) || at < since) continue
    if (event.kind === 'done') week.completed += 1
    else if (event.kind === 'create') week.created += 1
    else if (event.kind === 'remove') week.removed += 1
    else if (event.kind === 'update' && duePostponed(event.changes)) week.postponed += 1
  }
  const averageOpenAgeDays = open > 0 ? Math.round((ageSum / open / DAY_MS) * 10) / 10 : 0
  return { open, done, overdue, averageOpenAgeDays, week }
}

/** Validate and trim one fact text (1–120 characters). */
function factText(value) {
  if (typeof value !== 'string') throw new InputError('invalid_input', 'text must be a string')
  const text = value.trim()
  if (text === '') throw new InputError('invalid_input', 'text is required')
  if ([...text].length > MEMORY_LIMITS.factText) {
    throw new InputError('invalid_input', `一条记忆最多 ${MEMORY_LIMITS.factText} 个字符`)
  }
  return text
}

/** Comparison key for duplicate detection (trimmed, lower-cased, spaces collapsed). */
function factKey(text) {
  return text.toLowerCase().replace(/\s+/g, ' ')
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
  /** @type {{ version: number, todos: Array<Record<string, any>>, events: Array<Record<string, any>>, memory: { facts: Array<Record<string, any>>, threads: Record<string, any> } }} */
  let data = { version: VERSION, todos: [], events: [], memory: { facts: [], threads: {} } }
  /** @type {Promise<void> | null} */
  let loadPromise = null
  /** @type {Promise<unknown>} */
  let writeQueue = Promise.resolve()

  /**
   * Read the document once; a missing or corrupt file starts an empty board instead of throwing.
   * A v1 document (no `events` / `memory`) loads unchanged.
   */
  async function load() {
    try {
      const text = await readFile(filePath, 'utf8')
      const parsed = JSON.parse(text)
      const todos = Array.isArray(parsed?.todos) ? parsed.todos : []
      const canonical = todos
        .filter((todo) => todo && typeof todo.text === 'string')
        .map((todo) => toTodo(todo, `td_${randomUUID().slice(0, 8)}`))
      const known = new Set(canonical.map((todo) => todo.id))
      const events = Array.isArray(parsed?.events)
        ? parsed.events.map(toEvent).filter(Boolean).slice(-MEMORY_LIMITS.events)
        : []
      const facts = Array.isArray(parsed?.memory?.facts)
        ? parsed.memory.facts.map(toFact).filter(Boolean).slice(-MEMORY_LIMITS.facts)
        : []
      /** @type {Record<string, any>} */
      const threads = {}
      const rawThreads = parsed?.memory?.threads
      if (rawThreads && typeof rawThreads === 'object' && !Array.isArray(rawThreads)) {
        for (const [id, raw] of Object.entries(rawThreads)) {
          if (!known.has(id)) continue
          const thread = toThread(raw)
          if (thread) threads[id] = thread
        }
      }
      data = { version: VERSION, todos: canonical, events, memory: { facts, threads: pruneThreads(threads) } }
    } catch (error) {
      if (error && error.code === 'ENOENT') return
      logger(`sticker-todo: could not read ${filePath} (${error.message}); starting empty`)
      try {
        await rename(filePath, `${filePath}.corrupt-${Date.now()}`)
      } catch {
        /* the document may be a directory or already gone; an empty board is still usable */
      }
      data = { version: VERSION, todos: [], events: [], memory: { facts: [], threads: {} } }
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

  /**
   * Append one event to the ring (the oldest event is dropped past the cap).
   * @param {Record<string, unknown>} event event to append.
   */
  function appendEvent(event) {
    data = { ...data, events: [...data.events, event].slice(-MEMORY_LIMITS.events) }
  }

  /**
   * Forget one note's advice thread, keeping its events.
   * @param {string} id todo id.
   */
  function dropThread(id) {
    if (!data.memory.threads[id]) return
    const threads = { ...data.memory.threads }
    delete threads[id]
    data = { ...data, memory: { ...data.memory, threads } }
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
    appendEvent({ at: now, kind: 'create', id: todo.id, text: todo.text })
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

    /** @type {Record<string, { from: unknown, to: unknown }>} */
    const changes = {}
    for (const field of CHANGE_FIELDS) {
      if (patch[field] === undefined || field === 'text' && next.text === current.text) continue
      if (field === 'tags') {
        if (JSON.stringify(current.tags) !== JSON.stringify(next.tags)) {
          changes.tags = { from: [...current.tags], to: [...next.tags] }
        }
        continue
      }
      if (current[field] !== next[field]) changes[field] = { from: current[field] ?? null, to: next[field] ?? null }
    }

    const todos = [...data.todos]
    todos[index] = next
    data = { ...data, todos }
    if (Object.keys(changes).length > 0) {
      appendEvent({ at: next.updatedAt, kind: 'update', id: next.id, text: next.text, changes })
    }
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
    appendEvent({ at: next.updatedAt, kind: target ? 'done' : 'reopen', id: next.id, text: next.text })
    await persist()
    return { ...next }
  }

  /**
   * Delete one note. Its events survive; its advice thread does not.
   * @param {string} id todo id.
   * @returns {Promise<{ removed: string }>} the removed id.
   */
  async function remove(id) {
    const found = data.todos.find((todo) => todo.id === id)
    if (!found) throw new InputError('not_found', `no todo with id ${id}`)
    data = { ...data, todos: data.todos.filter((todo) => todo.id !== id) }
    dropThread(id)
    appendEvent({ at: new Date().toISOString(), kind: 'remove', id: found.id, text: found.text })
    await persist()
    return { removed: id }
  }

  /**
   * Delete every finished note.
   * @returns {Promise<{ removed: number }>} how many were deleted.
   */
  async function clearCompleted() {
    const removedTodos = data.todos.filter((todo) => todo.done)
    if (removedTodos.length === 0) return { removed: 0 }
    data = { ...data, todos: data.todos.filter((todo) => !todo.done) }
    for (const todo of removedTodos) dropThread(todo.id)
    appendEvent({ at: new Date().toISOString(), kind: 'clear', count: removedTodos.length })
    await persist()
    return { removed: removedTodos.length }
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
    /** @type {Array<Record<string, any>>} */
    const fired = []
    const todos = data.todos.map((todo) => {
      if (!wanted.has(todo.id) || !todo.remindAt || todo.remindFiredAt) return todo
      acked += 1
      fired.push(todo)
      return { ...todo, remindFiredAt: now }
    })
    if (acked > 0) {
      data = { ...data, todos }
      for (const todo of fired) appendEvent({ at: now, kind: 'remind', id: todo.id, text: todo.text })
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
    appendEvent({ at: now, kind: 'plan', count: byId.size })
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
    appendEvent({ at: now, kind: 'tag', count: byId.size })
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

  /* ----------------------------------------------------------------------- *
   * Memory API
   * ----------------------------------------------------------------------- */

  /** @returns {Array<Record<string, any>>} a copy of the event log, oldest first. */
  function events() {
    return data.events.map(copyEvent)
  }

  /** @returns {Array<Record<string, any>>} a copy of the facts, newest first. */
  function facts() {
    return data.memory.facts.map(copyFact).reverse()
  }

  /** @returns {Record<string, any>} a deep copy of the id → thread map. */
  function threads() {
    /** @type {Record<string, any>} */
    const copy = {}
    for (const [id, thread] of Object.entries(data.memory.threads)) copy[id] = copyThread(thread)
    return copy
  }

  /**
   * Everything the panel and the AI layer need from the memory, in one object.
   * @returns {{ facts: Array<Record<string, any>>, stats: Record<string, any>, postpones: Record<string, number>, threads: Record<string, any> }} the memory block.
   */
  function memory() {
    return { facts: facts(), stats: stats(), postpones: postpones(), threads: threads() }
  }

  /** @returns {{ open: number, done: number, overdue: number, averageOpenAgeDays: number, week: Record<string, number> }} derived statistics. */
  function statistics(now) {
    return deriveStats(data.todos, data.events, now ?? new Date())
  }

  /** Alias kept for readability at the call sites. */
  const stats = statistics

  /** @returns {Record<string, number>} postponement count per note id. */
  function postpones() {
    return derivePostpones(data.events)
  }

  /**
   * Remember one user preference.
   * @param {unknown} text the fact text (1–120 characters).
   * @returns {Promise<Record<string, any>>} the created fact.
   */
  async function addFact(text) {
    const value = factText(text)
    if (data.memory.facts.length >= MEMORY_LIMITS.facts) {
      throw new InputError('invalid_input', `记忆最多 ${MEMORY_LIMITS.facts} 条，请先删掉一条`)
    }
    const key = factKey(value)
    if (data.memory.facts.some((fact) => factKey(fact.text) === key)) {
      throw new InputError('invalid_input', '这条记忆已经记过了')
    }
    const now = new Date().toISOString()
    const fact = { id: `m_${randomUUID().slice(0, 8)}`, text: value, source: 'user', createdAt: now, updatedAt: now }
    data = { ...data, memory: { ...data.memory, facts: [...data.memory.facts, fact] } }
    await persist()
    return { ...fact }
  }

  /**
   * Rewrite one fact.
   * @param {string} id fact id.
   * @param {unknown} text the new text (1–120 characters).
   * @returns {Promise<Record<string, any>>} the updated fact.
   */
  async function updateFact(id, text) {
    const index = data.memory.facts.findIndex((fact) => fact.id === id)
    if (index < 0) throw new InputError('not_found', `no memory with id ${id}`)
    const value = factText(text)
    const key = factKey(value)
    if (data.memory.facts.some((fact, position) => position !== index && factKey(fact.text) === key)) {
      throw new InputError('invalid_input', '这条记忆已经记过了')
    }
    const fact = { ...data.memory.facts[index], text: value, updatedAt: new Date().toISOString() }
    const facts = [...data.memory.facts]
    facts[index] = fact
    data = { ...data, memory: { ...data.memory, facts } }
    await persist()
    return { ...fact }
  }

  /**
   * Forget one fact.
   * @param {string} id fact id.
   * @returns {Promise<{ forgotten: string }>} the forgotten id.
   */
  async function forgetFact(id) {
    const facts = data.memory.facts.filter((fact) => fact.id !== id)
    if (facts.length === data.memory.facts.length) throw new InputError('not_found', `no memory with id ${id}`)
    data = { ...data, memory: { ...data.memory, facts } }
    await persist()
    return { forgotten: id }
  }

  /**
   * Persist one round of the per-note advisory conversation.
   * @param {string} id todo id (a note that no longer exists is ignored).
   * @param {Array<{ question?: unknown, answer?: unknown }>} rounds the Q&A history so far.
   * @param {{ text?: unknown, source?: unknown } | null} [advice] the advice returned in this round.
   * @returns {Promise<Record<string, any> | null>} the stored thread, or null when there was nothing to store.
   */
  async function saveThread(id, rounds, advice = null) {
    if (!data.todos.some((todo) => todo.id === id)) return null
    const now = new Date().toISOString()
    const thread = toThread({ rounds, advice, updatedAt: now })
    if (!thread) return null
    const threadsNext = pruneThreads({ ...data.memory.threads, [id]: thread })
    data = { ...data, memory: { ...data.memory, threads: threadsNext } }
    await persist()
    return copyThread(thread)
  }

  /**
   * Forget everything the plugin remembers (facts, threads and the event log).
   * The notes themselves are untouched.
   * @returns {Promise<{ facts: number, threads: number, events: number }>} how many of each were cleared.
   */
  async function clearMemory() {
    const cleared = {
      facts: data.memory.facts.length,
      threads: Object.keys(data.memory.threads).length,
      events: data.events.length,
    }
    data = { ...data, events: [], memory: { facts: [], threads: {} } }
    await persist()
    return cleared
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
    events,
    facts,
    threads,
    memory,
    stats,
    postpones,
    addFact,
    updateFact,
    forgetFact,
    saveThread,
    clearMemory,
  }
}
