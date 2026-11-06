#!/usr/bin/env node
/**
 * verify/host-actions.mjs — offline integration test for the sticker TODO Host half.
 *
 * The Host code is ESM and normally only loads inside a running DSH process, so this
 * harness builds the smallest Cordis-shaped context the plugin needs, calls the real
 * `apply()` from `index.js`, captures the `/dsh-todo` HTTP handler and the
 * `sticker_todo` tool registration, and drives both with fake request/response objects.
 *
 * Usage:
 *   node verify/host-actions.mjs
 *
 * Node built-ins only. No network, no DSH process, no live data file: the store writes
 * into a throwaway directory that is removed on exit.
 *
 * Covered contract surface (CONTRACT.md, v1.2.0):
 *   - GET  /dsh-todo/state envelope and Todo shape (including `tags: []` on legacy rows)
 *   - POST add / update with `tags` (array and delimited-string forms, canonicalisation)
 *   - tag validation failures (`invalid_input` for too many / too long tags)
 *   - POST aiTag with no model service: `source: "fallback"`, tags written onto notes,
 *     `tagResult` shape, notes returned fresh, document persisted
 *   - POST aiNoteAdvice: deterministic fallback advice without a model, `question`/`advice`
 *     model rounds through a scripted model, question answer options (2–4) and advice alternatives,
 *     the three-question limit, and input validation
 *   - unknown action code, and the `plan` / `tag` fallback paths
 *   - the model-facing `sticker_todo` tool: `tags` on add/update, `tag` action, `tags` echo
 *
 * v1.8.0 (CONTRACT.md round 8):
 *   - `aiTag` classifies ONLY untagged open notes; tagged notes keep their tags (no write),
 *     done notes are never classified, and both empty board cases return the fallback summary
 *     without calling the model or rewriting the document
 *   - a model reply that names an already-tagged note cannot overwrite its tags
 *   - the `sticker_todo` tool's `tag` action inherits the same behaviour
 *
 * v1.7.0 memory surface (CONTRACT.md round 7):
 *   - document v2: create/update/remove events with `text` + `changes`, v1 migration
 *   - derived `postpones` (only later deadlines count) and the `state.memory` block shape
 *   - facts CRUD (remember / updateFact / forget), duplicate rejection and the 50-fact cap
 *   - advice threads persisted by aiNoteAdvice (rounds + last advice), dropped with their note
 *   - `review` / `memoryCandidates` fallback shapes and their "no write" guarantee
 *   - `clearMemory` keeps the notes but drops facts, threads and the event log
 *   - the tool's `remember` / `forget` / `memories` / `review` actions and the `memory` echo
 *
 * Exit codes: 0 all checks passed, 1 one or more checks failed.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const results = { pass: 0, fail: 0 }
const failures = []

function pass(name, detail = '') {
  results.pass += 1
  console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}`)
}
function fail(name, detail = '') {
  results.fail += 1
  failures.push({ name, detail })
  console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`)
}
function section(title) {
  console.log(`\n== ${title} ==`)
}
function ensure(condition, message) {
  if (!condition) throw new Error(message)
}
function ensureObject(value, label) {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object, got ${JSON.stringify(value)}`)
  return value
}
function ensureArray(value, label) {
  ensure(Array.isArray(value), `${label} must be an array, got ${JSON.stringify(value)}`)
  return value
}
function ensureString(value, label, { nonEmpty = true } = {}) {
  ensure(typeof value === 'string', `${label} must be a string, got ${JSON.stringify(value)}`)
  if (nonEmpty) ensure(value.trim() !== '', `${label} must be non-empty`)
  return value
}
function ensureTags(value, label) {
  ensureArray(value, label)
  ensure(value.length <= 3, `${label} must hold at most 3 tags, got ${JSON.stringify(value)}`)
  const seen = new Set()
  for (const [index, tag] of value.entries()) {
    ensureString(tag, `${label}[${index}]`)
    ensure(tag === tag.trim(), `${label}[${index}] must be trimmed, got ${JSON.stringify(tag)}`)
    ensure(tag.startsWith('#') === false, `${label}[${index}] must not start with "#"`)
    ensure(tag.length <= 12, `${label}[${index}] must be at most 12 characters`)
    const key = tag.toLowerCase()
    ensure(!seen.has(key), `${label} repeats "${tag}" case-insensitively`)
    seen.add(key)
  }
  return value
}
async function runCheck(name, fn) {
  try {
    const detail = await fn()
    pass(name, typeof detail === 'string' ? detail : '')
  } catch (error) {
    fail(name, error?.message || String(error))
  }
}

/* ------------------------------------------------------------------ *
 * Minimal Cordis context + HTTP fakes
 * ------------------------------------------------------------------ */

function createHarness(dataFile, services = {}) {
  const captured = { tool: null, route: null, disposers: [] }
  const noopDisposer = () => {}

  const ctx = {
    // Optional services are supplied by the caller; absent ones make the AI layer degrade
    // to its local heuristics, which is what the default harness exercises.
    get: (name) => services[name],
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : noopDisposer
    },
    inject: (deps, callback) => {
      if (!Array.isArray(deps) || !deps.includes('webServer')) return
      const webCtx = {
        effect: (fn) => {
          const dispose = fn()
          return typeof dispose === 'function' ? dispose : noopDisposer
        },
        webServer: {
          register: (registration) => {
            captured.route = registration
            return noopDisposer
          },
        },
      }
      callback(webCtx)
    },
    tools: {
      register: (definition) => {
        captured.tool = definition
        return noopDisposer
      },
    },
  }

  apply(ctx, { dataFile, aiTimeoutMs: 2_000, logger: () => {} })
  return captured
}

function makeRequest({ method = 'GET', url = '/', body } = {}) {
  const chunks = []
  if (body !== undefined) chunks.push(Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8'))
  const request = {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
  return request
}

function makeResponse() {
  return {
    status: 0,
    headers: {},
    payload: '',
    writableEnded: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
    },
    end(payload) {
      this.payload = payload === undefined ? '' : String(payload)
      this.writableEnded = true
    },
  }
}

function createClient(captured) {
  const handler = captured.route?.handler
  ensure(typeof handler === 'function', 'the plugin did not register a /dsh-todo handler')

  async function call(method, pathname, body) {
    const response = makeResponse()
    await handler(makeRequest({ method, url: pathname, body }), response)
    let json = null
    if (response.payload !== '') {
      try {
        json = JSON.parse(response.payload)
      } catch {
        throw new Error(`${method} ${pathname} returned non-JSON: ${response.payload.slice(0, 200)}`)
      }
    }
    return { status: response.status, json }
  }

  return {
    get: (pathname) => call('GET', pathname),
    action: (name, params = {}) => call('POST', '/dsh-todo/action', { action: name, ...params }),
    raw: (pathname, body) => call('POST', pathname, body),
  }
}

function expectOkData(response, label) {
  ensure(response.status === 200, `${label}: expected HTTP 200, got ${response.status}`)
  const envelope = ensureObject(response.json, `${label}: JSON envelope`)
  ensure(envelope.ok === true, `${label}: ok !== true (${JSON.stringify(envelope.error ?? envelope).slice(0, 240)})`)
  return envelope.data
}

function expectError(response, label) {
  ensure(response.status === 200, `${label}: expected HTTP 200, got ${response.status}`)
  const envelope = ensureObject(response.json, `${label}: JSON envelope`)
  ensure(envelope.ok === false, `${label}: expected ok:false, got ${JSON.stringify(envelope.ok)}`)
  const error = ensureObject(envelope.error, `${label}.error`)
  ensureString(error.code, `${label}.error.code`)
  ensureString(error.message, `${label}.error.message`)
  return error
}

function validateTodo(todo, label) {
  ensureObject(todo, label)
  ensureString(todo.id, `${label}.id`)
  ensureString(todo.text, `${label}.text`)
  ensureTags(todo.tags, `${label}.tags`)
  ensure(typeof todo.note === 'string', `${label}.note`)
  ensure(typeof todo.done === 'boolean', `${label}.done`)
  return todo
}

/* ------------------------------------------------------------------ *
 * v1.7.0 memory helpers
 * ------------------------------------------------------------------ */

/** True when `value` is a parseable ISO-8601 timestamp string. */
function isIso(value) {
  return typeof value === 'string' && value !== '' && !Number.isNaN(Date.parse(value))
}

/** Character length of `value` (code points, not UTF-16 units). */
function charCount(value) {
  return [...String(value)].length
}

/** Read and parse the persisted JSON document at `filePath`. */
function readDocument(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

/** Assert one v1.7.0 Fact against the contract shape. */
function validateFact(fact, label) {
  ensureObject(fact, label)
  ensureString(fact.id, `${label}.id`)
  ensure(/^m_[0-9a-z]{8}$/.test(fact.id), `${label}.id must be "m_" + 8 hex characters, got ${JSON.stringify(fact.id)}`)
  ensureString(fact.text, `${label}.text`)
  ensure(fact.text === fact.text.trim(), `${label}.text must be trimmed`)
  ensure(charCount(fact.text) <= 120, `${label}.text must be at most 120 characters`)
  ensure(fact.source === 'user', `${label}.source must be "user", got ${JSON.stringify(fact.source)}`)
  ensure(isIso(fact.createdAt), `${label}.createdAt must be an ISO timestamp`)
  ensure(isIso(fact.updatedAt), `${label}.updatedAt must be an ISO timestamp`)
  return fact
}

/** Assert one v1.7.0 Thread against the contract shape. */
function validateThread(thread, label) {
  ensureObject(thread, label)
  ensureArray(thread.rounds, `${label}.rounds`)
  ensure(thread.rounds.length <= 3, `${label}.rounds must hold at most 3 entries`)
  for (const [index, entry] of thread.rounds.entries()) {
    ensureObject(entry, `${label}.rounds[${index}]`)
    ensure(entry.round === index + 1, `${label}.rounds[${index}].round must be ${index + 1}, got ${JSON.stringify(entry.round)}`)
    ensureString(entry.question, `${label}.rounds[${index}].question`)
    ensure(charCount(entry.question) <= 120, `${label}.rounds[${index}].question must be at most 120 characters`)
    ensureString(entry.answer, `${label}.rounds[${index}].answer`)
    ensure(charCount(entry.answer) <= 800, `${label}.rounds[${index}].answer must be at most 800 characters`)
    ensure(isIso(entry.at), `${label}.rounds[${index}].at must be an ISO timestamp`)
  }
  if (thread.advice !== null) {
    ensureObject(thread.advice, `${label}.advice`)
    ensureString(thread.advice.text, `${label}.advice.text`)
    ensure(['model', 'fallback'].includes(thread.advice.source), `${label}.advice.source must be model|fallback`)
    ensure(isIso(thread.advice.at), `${label}.advice.at must be an ISO timestamp`)
  }
  ensure(isIso(thread.updatedAt), `${label}.updatedAt must be an ISO timestamp`)
  return thread
}

/** Assert the ReviewResult shape from CONTRACT.md round 7. */
function validateReview(review, label, { expectSource } = {}) {
  ensureObject(review, label)
  ensureString(review.headline, `${label}.headline`, { nonEmpty: false })
  ensure(charCount(review.headline) <= 100, `${label}.headline must be at most 100 characters`)
  const range = ensureObject(review.range, `${label}.range`)
  ensure(isIso(range.from) && isIso(range.to), `${label}.range.from/to must be ISO timestamps`)
  ensure(Date.parse(range.to) > Date.parse(range.from), `${label}.range.to must be after range.from`)
  ensure(range.days === 7, `${label}.range.days must be 7, got ${JSON.stringify(range.days)}`)
  const stats = ensureObject(review.stats, `${label}.stats`)
  const keys = Object.keys(stats).sort()
  const expected = ['completed', 'created', 'overdue', 'open', 'postponed', 'removed'].sort()
  ensure(JSON.stringify(keys) === JSON.stringify(expected), `${label}.stats must hold exactly ${expected.join('/')}, got ${keys.join('/')}`)
  for (const key of expected) {
    ensure(typeof stats[key] === 'number' && Number.isFinite(stats[key]) && stats[key] >= 0, `${label}.stats.${key} must be a non-negative number`)
  }
  const highlights = ensureArray(review.highlights, `${label}.highlights`)
  ensure(highlights.length <= 4, `${label}.highlights must hold at most 4 entries`)
  for (const [index, line] of highlights.entries()) {
    ensureString(line, `${label}.highlights[${index}]`)
    ensure(charCount(line) <= 120, `${label}.highlights[${index}] must be at most 120 characters`)
  }
  const tips = ensureArray(review.tips, `${label}.tips`)
  ensure(tips.length <= 3, `${label}.tips must hold at most 3 entries`)
  const TIP_KINDS = ['focus', 'breakdown', 'deadline', 'rest', 'scope']
  for (const [index, tip] of tips.entries()) {
    ensureObject(tip, `${label}.tips[${index}]`)
    ensureString(tip.text, `${label}.tips[${index}].text`)
    ensure(TIP_KINDS.includes(tip.kind), `${label}.tips[${index}].kind must be one of ${TIP_KINDS.join('/')}, got ${JSON.stringify(tip.kind)}`)
  }
  ensure(isIso(review.generatedAt), `${label}.generatedAt must be an ISO timestamp`)
  ensure(['model', 'fallback'].includes(review.source), `${label}.source must be model|fallback`)
  if (expectSource !== undefined) ensure(review.source === expectSource, `${label}.source expected ${expectSource}, got ${review.source}`)
  return review
}

/** Assert the memory-candidate DTO shape from CONTRACT.md round 7. */
function validateCandidates(candidates, label, { expectSource } = {}) {
  ensureArray(candidates, label)
  ensure(candidates.length <= 5, `${label} must hold at most 5 entries, got ${candidates.length}`)
  for (const [index, candidate] of candidates.entries()) {
    ensureObject(candidate, `${label}[${index}]`)
    ensureString(candidate.text, `${label}[${index}].text`)
    ensure(candidate.text === candidate.text.trim(), `${label}[${index}].text must be trimmed`)
    ensure(charCount(candidate.text) <= 60, `${label}[${index}].text must be at most 60 characters`)
    ensureString(candidate.reason, `${label}[${index}].reason`)
    ensure(candidate.reason === candidate.reason.trim(), `${label}[${index}].reason must be trimmed`)
    ensure(charCount(candidate.reason) <= 80, `${label}[${index}].reason must be at most 80 characters`)
  }
  if (expectSource !== undefined) ensure(expectSource === 'fallback', 'harness only requests fallback candidates')
  return candidates
}

/* ------------------------------------------------------------------ *
 * Scripted model service (exercises the model path of aiNoteAdvice)
 * ------------------------------------------------------------------ */

/**
 * Build a fake `llm` + `agentDefaultModel` pair that answers each stream request with the
 * next scripted text. The AI layer only needs `llm.stream()` to yield text-delta chunks and
 * one terminal finish chunk.
 * @param {string[]} responses scripted model outputs, consumed in order (last one repeats).
 */
function createScriptedModel(responses) {
  let index = 0
  const llm = {
    listProviders: () => [{ id: 'fake', name: 'Fake provider' }],
    stream() {
      const text = responses[Math.min(index, responses.length - 1)]
      index += 1
      return (async function* stream() {
        yield { type: 'text-delta', text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const agentDefaultModel = { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) }
  return { llm, agentDefaultModel }
}

/** A valid canonical history of `count` question/answer rounds. */
function historyOf(count) {
  const history = []
  for (let index = 0; index < count; index += 1) {
    history.push({ question: `第 ${index + 1} 个问题？`, answer: `第 ${index + 1} 个回答` })
  }
  return history
}

/** Assert one NoteAdviceResult envelope against the contract shape. */
function validateNoteAdvice(data, label, { expectedRound } = {}) {
  ensureObject(data, label)
  ensure(typeof data.round === 'number' && data.round >= 0 && data.round <= 3, `${label}.round must be 0..3, got ${JSON.stringify(data.round)}`)
  if (expectedRound !== undefined) ensure(data.round === expectedRound, `${label}.round expected ${expectedRound}, got ${data.round}`)
  if (data.kind === 'advice') {
    const advice = ensureObject(data.advice, `${label}.advice`)
    ensureString(advice.text, `${label}.advice.text`, { nonEmpty: false })
    ensure(['model', 'fallback'].includes(advice.source), `${label}.advice.source must be model|fallback, got ${JSON.stringify(advice.source)}`)
    if (advice.options !== undefined) {
      ensureOptions(advice.options, `${label}.advice.options`, { min: 1, max: 3, maxChars: 120 })
    }
    return `advice(${advice.source}, round ${data.round}): ${String(advice.text).slice(0, 40)}`
  }
  ensure(data.kind === 'question', `${label}.kind must be advice|question, got ${JSON.stringify(data.kind)}`)
  ensureString(data.question, `${label}.question`)
  ensure(data.source === 'model', `${label}.source must be "model" for a question, got ${JSON.stringify(data.source)}`)
  // v1.3.0: a question always carries 2–4 short answer options.
  ensureOptions(data.options, `${label}.options`, { min: 2, max: 4, maxChars: 24 })
  return `question(round ${data.round}, ${data.options.length} options): ${String(data.question).slice(0, 40)}`
}

/** Assert a validated options array. */
function ensureOptions(value, label, { min, max, maxChars }) {
  ensureArray(value, label)
  ensure(value.length >= min && value.length <= max, `${label} must hold ${min}..${max} entries, got ${value.length}`)
  const seen = new Set()
  for (const [index, option] of value.entries()) {
    ensureString(option, `${label}[${index}]`)
    ensure(option.trim() === option, `${label}[${index}] must be trimmed`)
    ensure([...option].length <= maxChars, `${label}[${index}] must be at most ${maxChars} characters`)
    ensure(!seen.has(option), `${label} repeats "${option}"`)
    seen.add(option)
  }
  return value
}

/* ------------------------------------------------------------------ *
 * Checks
 * ------------------------------------------------------------------ */

async function main() {
  const workDir = mkdtempSync(join(tmpdir(), 'dsh-todo-host-'))
  const dataFile = join(workDir, 'todos.json')
  let captured
  let api

  try {
    captured = createHarness(dataFile)
    api = createClient(captured)

    section('Route + empty state')
    await runCheck('GET /dsh-todo/state returns an empty, well-formed board', async () => {
      const response = await api.get('/dsh-todo/state')
      const data = expectOkData(response, 'state')
      ensure(typeof data.now === 'string' && !Number.isNaN(Date.parse(data.now)), 'state.now must be an ISO timestamp')
      ensureArray(data.todos, 'state.todos')
      ensure(data.todos.length === 0, `expected an empty board, got ${data.todos.length} todo(s)`)
      ensureArray(data.dueReminders, 'state.dueReminders')
      const ai = ensureObject(data.ai, 'state.ai')
      ensure(ai.available === false, `ai.available must be false without services, got ${JSON.stringify(ai.available)}`)
      ensure(typeof ai.reason === 'string', 'ai.reason must explain why AI is unavailable')
      return 'empty board, ai.available=false'
    })

    await runCheck('GET /dsh-todo root reports the plugin identity', async () => {
      const response = await api.get('/dsh-todo')
      const data = expectOkData(response, 'root')
      ensure(data.plugin === 'sticker-todo', `expected plugin "sticker-todo", got ${JSON.stringify(data.plugin)}`)
      return `plugin=${data.plugin}`
    })

    section('add / update with tags')
    let taggedId = null
    await runCheck('add canonicalises tags (strip "#", trim, dedupe case-insensitively)', async () => {
      const response = await api.action('add', {
        text: '写周报',
        tags: ['#工作', ' 汇报 ', '工作', '汇报'],
      })
      const todo = validateTodo(expectOkData(response, 'add'), 'add result')
      ensureTags(todo.tags, 'add result.tags')
      ensure(todo.tags.length === 2, `expected 2 tags after dedupe, got ${JSON.stringify(todo.tags)}`)
      ensure(todo.tags[0] === '工作' && todo.tags[1] === '汇报', `unexpected tags: ${JSON.stringify(todo.tags)}`)
      taggedId = todo.id
      return `tags=${JSON.stringify(todo.tags)}`
    })

    await runCheck('add accepts a delimited tag string', async () => {
      const response = await api.action('add', { text: '买牛奶', tags: '生活, 采购；生活' })
      const todo = validateTodo(expectOkData(response, 'add delimited'), 'add result')
      ensure(todo.tags.length === 2 && todo.tags.includes('生活') && todo.tags.includes('采购'),
        `unexpected tags from delimited input: ${JSON.stringify(todo.tags)}`)
      return `tags=${JSON.stringify(todo.tags)}`
    })

    await runCheck('add without tags yields tags: []', async () => {
      const response = await api.action('add', { text: '没有标签的便签' })
      const todo = validateTodo(expectOkData(response, 'add plain'), 'add result')
      ensureArray(todo.tags, 'add result.tags')
      ensure(todo.tags.length === 0, `expected no tags, got ${JSON.stringify(todo.tags)}`)
      return 'tags=[]'
    })

    await runCheck('update replaces tags', async () => {
      ensure(taggedId, 'no tagged todo from the earlier add')
      const response = await api.action('update', { id: taggedId, tags: ['学习'] })
      const todo = validateTodo(expectOkData(response, 'update'), 'update result')
      ensure(todo.tags.length === 1 && todo.tags[0] === '学习', `tags not replaced: ${JSON.stringify(todo.tags)}`)
      return `tags=${JSON.stringify(todo.tags)}`
    })

    await runCheck('update without tags keeps them', async () => {
      const response = await api.action('update', { id: taggedId, note: '补充说明' })
      const todo = validateTodo(expectOkData(response, 'update note'), 'update result')
      ensure(todo.tags.length === 1 && todo.tags[0] === '学习', `tags changed unexpectedly: ${JSON.stringify(todo.tags)}`)
      return 'tags preserved'
    })

    section('tag validation')
    await runCheck('more than three tags -> invalid_input', async () => {
      const response = await api.action('add', { text: '标签太多', tags: ['a', 'b', 'c', 'd'] })
      const error = expectError(response, 'four tags')
      ensure(error.code === 'invalid_input', `expected invalid_input, got ${JSON.stringify(error.code)}`)
      return error.code
    })

    await runCheck('tag longer than twelve characters -> invalid_input', async () => {
      const response = await api.action('add', { text: '标签太长', tags: ['这个标签明显超过十二个字符了'] })
      const error = expectError(response, 'long tag')
      ensure(error.code === 'invalid_input', `expected invalid_input, got ${JSON.stringify(error.code)}`)
      return error.code
    })

    await runCheck('non-string tag -> invalid_input', async () => {
      const response = await api.action('add', { text: '标签类型错误', tags: [42] })
      const error = expectError(response, 'bad tag type')
      ensure(error.code === 'invalid_input', `expected invalid_input, got ${JSON.stringify(error.code)}`)
      return error.code
    })

    section('aiTag (no model service -> local fallback)')
    let tagResultSnapshot = null
    await runCheck('aiTag writes fallback tags onto open notes and returns them fresh', async () => {
      const response = await api.action('aiTag', {})
      const data = expectOkData(response, 'aiTag')
      const tagResult = ensureObject(data.tagResult, 'aiTag.tagResult')
      ensureString(tagResult.summary, 'tagResult.summary', { nonEmpty: false })
      ensure(tagResult.source === 'fallback', `expected source "fallback" without services, got ${JSON.stringify(tagResult.source)}`)
      ensure(typeof tagResult.generatedAt === 'string' && !Number.isNaN(Date.parse(tagResult.generatedAt)), 'tagResult.generatedAt must be ISO')
      ensureArray(tagResult.items, 'tagResult.items')
      ensure(tagResult.items.length > 0, 'tagResult.items must tag at least one open note')

      const todos = ensureArray(data.todos, 'aiTag.todos')
      todos.forEach((todo, index) => validateTodo(todo, `aiTag.todos[${index}]`))
      const byId = new Map(todos.map((todo) => [todo.id, todo]))
      for (const [index, item] of tagResult.items.entries()) {
        ensureObject(item, `tagResult.items[${index}]`)
        ensureString(item.id, `tagResult.items[${index}].id`)
        ensureTags(item.tags, `tagResult.items[${index}].tags`)
        ensure(item.tags.length >= 1, `tagResult.items[${index}] must carry at least one tag`)
        const todo = byId.get(item.id)
        ensure(todo, `tagResult.items[${index}].id ${item.id} is missing from the returned todos`)
        ensure(JSON.stringify(todo.tags) === JSON.stringify(item.tags),
          `todo ${item.id} tags ${JSON.stringify(todo.tags)} do not match tagResult ${JSON.stringify(item.tags)}`)
      }
      tagResultSnapshot = tagResult
      return `items=${tagResult.items.length}, source=${tagResult.source}, summary="${String(tagResult.summary).slice(0, 40)}"`
    })

    await runCheck('aiTag result is persisted in the document', async () => {
      const text = readFileSync(dataFile, 'utf8')
      const document = JSON.parse(text)
      ensure(Array.isArray(document.todos), 'persisted document must hold todos')
      const tagged = document.todos.filter((todo) => Array.isArray(todo.tags) && todo.tags.length > 0)
      ensure(tagged.length > 0, 'no persisted todo carries tags after aiTag')
      return `${tagged.length} persisted note(s) carry tags`
    })

    await runCheck('state reflects the tags written by aiTag', async () => {
      const response = await api.get('/dsh-todo/state')
      const data = expectOkData(response, 'state after aiTag')
      const todos = ensureArray(data.todos, 'state.todos')
      todos.forEach((todo, index) => validateTodo(todo, `state.todos[${index}]`))
      ensure(todos.some((todo) => todo.tags.length > 0), 'no note carries tags in /state after aiTag')
      return `${todos.length} todo(s)`
    })

    section('aiTag only classifies untagged notes (v1.8.0)')
    await runCheck('aiTag tags only untagged open notes and leaves tagged / done notes untouched', async () => {
      const filterPath = join(workDir, 'aiTag-filter.json')
      const filterCaptured = createHarness(filterPath)
      const filterApi = createClient(filterCaptured)
      const taggedNote = expectOkData(await filterApi.action('add', { text: '已有标签的便签', tags: ['工作'] }), 'filter add tagged')
      const untaggedNote = expectOkData(await filterApi.action('add', { text: '还没标签的便签' }), 'filter add untagged')
      const doneNote = expectOkData(await filterApi.action('add', { text: '已完成的未分类便签' }), 'filter add done')
      expectOkData(await filterApi.action('toggle', { id: doneNote.id, done: true }), 'filter toggle done')
      const beforeDocument = readDocument(filterPath)
      const beforeTagged = beforeDocument.todos.find((todo) => todo.id === taggedNote.id)

      const data = expectOkData(await filterApi.action('aiTag'), 'filtered aiTag')
      const tagResult = ensureObject(data.tagResult, 'filtered tagResult')
      ensure(tagResult.source === 'fallback', `expected the fallback source without services, got ${JSON.stringify(tagResult.source)}`)
      const items = ensureArray(tagResult.items, 'filtered tagResult.items')
      ensure(items.length === 1, `only the untagged open note may be classified, got ${JSON.stringify(items.map((item) => item.id))}`)
      ensure(items[0].id === untaggedNote.id, `the untagged note was expected, got ${JSON.stringify(items[0].id)}`)
      ensure(ensureArray(items[0].tags, 'item tags').length >= 1, 'the untagged note must receive tags')
      ensure(items.every((item) => item.id !== taggedNote.id && item.id !== doneNote.id), 'tagged/done notes must not appear in tagResult.items')

      const todos = ensureArray(data.todos, 'filtered aiTag todos')
      todos.forEach((todo, index) => validateTodo(todo, `filtered aiTag todos[${index}]`))
      const byId = new Map(todos.map((todo) => [todo.id, todo]))
      ensure(JSON.stringify(byId.get(taggedNote.id).tags) === JSON.stringify(['工作']), `the tagged note must keep its tags, got ${JSON.stringify(byId.get(taggedNote.id).tags)}`)
      ensure(byId.get(untaggedNote.id).tags.length >= 1, 'the untagged note was not tagged in the returned board')
      ensure(JSON.stringify(byId.get(doneNote.id).tags) === JSON.stringify([]), 'a done note must never be classified')

      const afterTagged = readDocument(filterPath).todos.find((todo) => todo.id === taggedNote.id)
      ensure(afterTagged.updatedAt === beforeTagged.updatedAt, 'the tagged note must not be rewritten (its updatedAt changed)')
      ensure(JSON.stringify(afterTagged.tags) === JSON.stringify(['工作']), 'the tagged note tags changed on disk')
      return `items=${items.length}, tagged note untouched`
    })

    await runCheck('a second aiTag pass on an all-tagged board is a no-op with the friendly summary', async () => {
      const allTaggedPath = join(workDir, 'aiTag-all-tagged.json')
      const allTaggedCaptured = createHarness(allTaggedPath)
      const allTaggedApi = createClient(allTaggedCaptured)
      expectOkData(await allTaggedApi.action('add', { text: '第一张有标签', tags: ['学习'] }), 'all-tagged add 1')
      expectOkData(await allTaggedApi.action('add', { text: '第二张有标签', tags: '生活, 采购' }), 'all-tagged add 2')
      const before = readFileSync(allTaggedPath, 'utf8')
      const data = expectOkData(await allTaggedApi.action('aiTag'), 'all-tagged aiTag')
      const tagResult = ensureObject(data.tagResult, 'all-tagged tagResult')
      ensure(tagResult.summary === '所有未完成便签都已经有标签，不用再分类。', `summary mismatch: ${JSON.stringify(tagResult.summary)}`)
      ensureArray(tagResult.items, 'all-tagged tagResult.items')
      ensure(tagResult.items.length === 0, `expected no items, got ${JSON.stringify(tagResult.items)}`)
      ensure(tagResult.source === 'fallback', `expected the fallback source, got ${JSON.stringify(tagResult.source)}`)
      ensure(isIso(tagResult.generatedAt), 'generatedAt must be an ISO timestamp')
      ensure(readFileSync(allTaggedPath, 'utf8') === before, 'an all-tagged pass must not rewrite the document')
      return tagResult.summary
    })

    await runCheck('aiTag on an empty board returns the friendly summary and never writes', async () => {
      const emptyFile = join(workDir, 'aiTag-empty.json')
      const emptyApi = createClient(createHarness(emptyFile))
      const data = expectOkData(await emptyApi.action('aiTag'), 'empty aiTag')
      const tagResult = ensureObject(data.tagResult, 'empty tagResult')
      ensure(tagResult.summary === '当前没有待办，暂时不用整理标签。', `summary mismatch: ${JSON.stringify(tagResult.summary)}`)
      ensureArray(tagResult.items, 'empty tagResult.items')
      ensure(tagResult.items.length === 0, 'an empty board must yield no items')
      ensure(tagResult.source === 'fallback', 'an empty board must report the fallback source')
      ensure(!existsSync(emptyFile), 'an empty-board aiTag must not create or rewrite the document')
      return tagResult.summary
    })

    await runCheck('aiTag never calls the model when nothing is untagged', async () => {
      let streamCalls = 0
      const countingModel = {
        llm: {
          listProviders: () => [{ id: 'fake', name: 'Fake provider' }],
          stream() {
            streamCalls += 1
            return (async function* stream() {
              yield { type: 'text-delta', text: '{"summary":"不应被调用","items":[]}' }
              yield { type: 'finish', reason: { kind: 'stop' } }
            })()
          },
        },
        agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) },
      }
      const noModelApi = createClient(createHarness(join(workDir, 'aiTag-no-model.json'), countingModel))
      expectOkData(await noModelApi.action('add', { text: '已经有标签的便签', tags: ['工作'] }), 'no-model add')
      const data = expectOkData(await noModelApi.action('aiTag'), 'no-model aiTag')
      ensure(
        data.tagResult.summary === '所有未完成便签都已经有标签，不用再分类。',
        `summary mismatch: ${JSON.stringify(data.tagResult.summary)}`,
      )
      ensure(streamCalls === 0, `an all-tagged board must not call the model, saw ${streamCalls} stream call(s)`)
      return 'model not called'
    })

    await runCheck('model output cannot re-tag a note the user already tagged', async () => {
      const responses = ['{"summary":"占位","items":[]}']
      const modelHarness = createHarness(join(workDir, 'aiTag-model-filter.json'), createScriptedModel(responses))
      const modelApi = createClient(modelHarness)
      const tagged = expectOkData(await modelApi.action('add', { text: '用户已打标签', tags: ['工作'] }), 'model-filter add tagged')
      const untagged = expectOkData(await modelApi.action('add', { text: '尚未打标签' }), 'model-filter add untagged')
      responses[0] = JSON.stringify({
        summary: '模型想改全部',
        items: [{ id: tagged.id, tags: ['学习'] }, { id: untagged.id, tags: ['模型标签'] }],
      })
      const data = expectOkData(await modelApi.action('aiTag'), 'model-filter aiTag')
      const tagResult = ensureObject(data.tagResult, 'model-filter tagResult')
      ensure(tagResult.source === 'model', `the scripted model result should survive, got ${JSON.stringify(tagResult.source)}`)
      const items = ensureArray(tagResult.items, 'model-filter items')
      ensure(items.length === 1 && items[0].id === untagged.id, `only the untagged note may be tagged, got ${JSON.stringify(items)}`)
      ensure(JSON.stringify(items[0].tags) === JSON.stringify(['模型标签']), `model tags for the untagged note mismatch: ${JSON.stringify(items[0].tags)}`)
      const taggedAfter = ensureArray(data.todos, 'model-filter todos').find((todo) => todo.id === tagged.id)
      ensure(JSON.stringify(taggedAfter.tags) === JSON.stringify(['工作']), `the model must not overwrite existing tags, got ${JSON.stringify(taggedAfter.tags)}`)
      return 'tagged note protected from the model output'
    })

    await runCheck('the sticker_todo tool tag action inherits the untagged-only behaviour', async () => {
      const toolHarness = createHarness(join(workDir, 'aiTag-tool.json'))
      const tool = toolHarness.tool
      ensure(tool && typeof tool.execute === 'function', 'the plugin did not register the sticker_todo tool')
      const toolApi = createClient(toolHarness)
      const tagged = expectOkData(await toolApi.action('add', { text: '工具测试已有标签', tags: ['工作'] }), 'tool-tag add tagged')
      const untagged = expectOkData(await toolApi.action('add', { text: '工具测试没有标签' }), 'tool-tag add untagged')
      const first = await tool.execute({ action: 'tag' })
      ensure(first.ok === true, `tool tag failed: ${JSON.stringify(first.error)}`)
      ensure(first.tagResult.source === 'fallback', `tool tag source must be fallback, got ${JSON.stringify(first.tagResult.source)}`)
      const firstIds = ensureArray(first.tagResult.items, 'tool tag items').map((item) => item.id)
      ensure(JSON.stringify(firstIds) === JSON.stringify([untagged.id]), `tool tag must only classify the untagged note, got ${JSON.stringify(firstIds)}`)
      const taggedAfter = ensureArray(first.todos, 'tool tag todos').find((todo) => todo.id === tagged.id)
      ensure(JSON.stringify(taggedAfter.tags) === JSON.stringify(['工作']), `the tool must not overwrite existing tags, got ${JSON.stringify(taggedAfter.tags)}`)
      const second = await tool.execute({ action: 'tag' })
      ensure(second.ok === true, `second tool tag failed: ${JSON.stringify(second.error)}`)
      ensure(second.tagResult.items.length === 0, `the second tool tag pass must be a no-op, got ${JSON.stringify(second.tagResult.items)}`)
      ensure(
        second.tagResult.summary === '所有未完成便签都已经有标签，不用再分类。',
        `second tool tag summary mismatch: ${JSON.stringify(second.tagResult.summary)}`,
      )
      return 'tool tag: only untagged, then no-op'
    })

    section('aiNoteAdvice (per-note advice conversation, no model service)')
    let adviceNoteId = null
    await runCheck('aiNoteAdvice without a model returns deterministic fallback advice', async () => {
      ensure(taggedId, 'no tagged todo from the earlier add')
      adviceNoteId = taggedId
      const response = await api.action('aiNoteAdvice', { id: adviceNoteId })
      const data = expectOkData(response, 'aiNoteAdvice fallback')
      const summary = validateNoteAdvice(data, 'aiNoteAdvice fallback', { expectedRound: 0 })
      ensure(data.kind === 'advice', `fallback must be advice, got ${JSON.stringify(data.kind)}`)
      ensure(data.advice.source === 'fallback', `fallback source must be fallback, got ${JSON.stringify(data.advice.source)}`)
      ensure(data.advice.text.trim() !== '', 'fallback advice text must be non-empty')
      return summary
    })

    await runCheck('aiNoteAdvice with three answered rounds still answers (round 3)', async () => {
      const response = await api.action('aiNoteAdvice', { id: adviceNoteId, history: historyOf(3) })
      const data = expectOkData(response, 'aiNoteAdvice round limit')
      const summary = validateNoteAdvice(data, 'aiNoteAdvice round limit', { expectedRound: 3 })
      ensure(data.kind === 'advice', `round 3 must be advice, got ${JSON.stringify(data.kind)}`)
      return summary
    })

    await runCheck('aiNoteAdvice unknown id -> not_found', async () => {
      const response = await api.action('aiNoteAdvice', { id: 'td_missing' })
      const error = expectError(response, 'advice unknown id')
      ensure(error.code === 'not_found', `expected not_found, got ${JSON.stringify(error.code)}`)
      return error.code
    })

    await runCheck('aiNoteAdvice bad history -> invalid_input', async () => {
      const cases = [
        historyOf(4),
        [{ question: '问题', answer: '' }],
        [{ question: '问题' }],
        [{ question: '', answer: '回答' }],
        'not-an-array',
      ]
      for (const history of cases) {
        const response = await api.action('aiNoteAdvice', { id: adviceNoteId, history })
        const error = expectError(response, `advice bad history ${JSON.stringify(history).slice(0, 40)}`)
        ensure(error.code === 'invalid_input', `expected invalid_input, got ${JSON.stringify(error.code)}`)
      }
      return `${cases.length} case(s) rejected`
    })

    section('aiNoteAdvice with a scripted model')
    await runCheck('model asks an optioned question on round 0 and answers with advice + alternatives on round 1', async () => {
      const scripted = createScriptedModel([
        '{"kind":"question","question":"这件事现在卡在哪一步：缺资料、缺时间，还是没想清楚？","options":["缺资料","缺时间","还没想清楚"]}',
        '{"kind":"advice","text":"今晚先花 20 分钟把标题里那件事拆出第一步，做完再决定要不要继续。","options":["先写开头两段","先列提纲再写","先找上周数据"]}',
      ])
      const modelCaptured = createHarness(join(workDir, 'model-advice.json'), scripted)
      const modelApi = createClient(modelCaptured)
      const added = expectOkData(await modelApi.action('add', { text: '准备周会材料', note: '需要先确认上周数据' }), 'model harness add')
      const first = expectOkData(await modelApi.action('aiNoteAdvice', { id: added.id }), 'model round 0')
      const firstSummary = validateNoteAdvice(first, 'model round 0', { expectedRound: 0 })
      ensure(first.kind === 'question', `round 0 should ask a question, got ${JSON.stringify(first.kind)}`)
      ensure(first.options.length >= 2 && first.options.length <= 4, `a question needs 2–4 options, got ${JSON.stringify(first.options)}`)
      const second = expectOkData(
        await modelApi.action('aiNoteAdvice', { id: added.id, history: [{ question: first.question, answer: first.options[0] }] }),
        'model round 1',
      )
      const secondSummary = validateNoteAdvice(second, 'model round 1', { expectedRound: 1 })
      ensure(second.kind === 'advice', `round 1 should answer with advice, got ${JSON.stringify(second.kind)}`)
      ensure(second.advice.source === 'model', `model advice source must be model, got ${JSON.stringify(second.advice.source)}`)
      ensure(Array.isArray(second.advice.options) && second.advice.options.length === 3,
        `model advice alternatives should be carried, got ${JSON.stringify(second.advice.options)}`)
      return `${firstSummary} -> ${secondSummary}`
    })

    await runCheck('a question without options is rejected and falls back to advice', async () => {
      const scripted = createScriptedModel(['{"kind":"question","question":"再问一个问题？"}'])
      const modelCaptured = createHarness(join(workDir, 'model-no-options.json'), scripted)
      const modelApi = createClient(modelCaptured)
      const added = expectOkData(await modelApi.action('add', { text: '整理年度总结' }), 'no-options add')
      const data = expectOkData(await modelApi.action('aiNoteAdvice', { id: added.id }), 'no-options advice')
      const summary = validateNoteAdvice(data, 'no-options advice', { expectedRound: 0 })
      ensure(data.kind === 'advice', `a question without options must fall back to advice, got ${JSON.stringify(data.kind)}`)
      ensure(data.advice.source === 'fallback', `the fallback advice must say fallback, got ${JSON.stringify(data.advice.source)}`)
      return summary
    })

    await runCheck('advice alternatives are clamped to at most three', async () => {
      const scripted = createScriptedModel([
        '{"kind":"advice","text":"先做最小的一步。","options":["方案 A","方案 B","方案 C","方案 D","方案 E"]}',
      ])
      const modelCaptured = createHarness(join(workDir, 'model-many-options.json'), scripted)
      const modelApi = createClient(modelCaptured)
      const added = expectOkData(await modelApi.action('add', { text: '规划学习路线' }), 'many-options add')
      const data = expectOkData(await modelApi.action('aiNoteAdvice', { id: added.id }), 'many-options advice')
      const summary = validateNoteAdvice(data, 'many-options advice', { expectedRound: 0 })
      ensure(data.kind === 'advice', `expected advice, got ${JSON.stringify(data.kind)}`)
      if (data.advice.options !== undefined) {
        ensure(data.advice.options.length <= 3, `advice alternatives must be clamped to 3, got ${JSON.stringify(data.advice.options)}`)
      }
      return summary
    })

    await runCheck('a question at round 3 is rejected and falls back to advice', async () => {
      const scripted = createScriptedModel(['{"kind":"question","question":"还想再问一个问题？","options":["想","不想"]}'])
      const modelCaptured = createHarness(join(workDir, 'model-limit.json'), scripted)
      const modelApi = createClient(modelCaptured)
      const added = expectOkData(await modelApi.action('add', { text: '整理季度预算' }), 'model limit add')
      const response = await modelApi.action('aiNoteAdvice', { id: added.id, history: historyOf(3) })
      const data = expectOkData(response, 'model round limit')
      const summary = validateNoteAdvice(data, 'model round limit', { expectedRound: 3 })
      ensure(data.kind === 'advice', `round 3 must be advice, got ${JSON.stringify(data.kind)}`)
      ensure(data.advice.source === 'fallback', `rejected question must fall back, got ${JSON.stringify(data.advice.source)}`)
      return summary
    })

    section('memory: event log and derived postpones')
    const DAY_MS = 24 * 60 * 60 * 1000
    const nowMs = Date.now()
    const dueFirst = new Date(nowMs + 2 * DAY_MS).toISOString()
    const dueLater = new Date(nowMs + 4 * DAY_MS).toISOString()
    const dueEarlier = new Date(nowMs + DAY_MS).toISOString()
    const dueLatest = new Date(nowMs + 6 * DAY_MS).toISOString()
    let memoryNoteId = null

    await runCheck('create/update/remove events are recorded with text and real field changes', async () => {
      const added = expectOkData(await api.action('add', { text: '记忆事件测试' }), 'event add')
      memoryNoteId = added.id
      expectOkData(await api.action('update', { id: memoryNoteId, dueAt: dueFirst }), 'event update first deadline')
      expectOkData(await api.action('update', { id: memoryNoteId, dueAt: dueLater }), 'event update postpone')
      expectOkData(await api.action('update', { id: memoryNoteId, dueAt: dueEarlier }), 'event update pull earlier')
      expectOkData(await api.action('update', { id: memoryNoteId, dueAt: dueLatest }), 'event update postpone again')
      expectOkData(await api.action('update', { id: memoryNoteId, note: '只改备注，不产生事件' }), 'event update note')

      const document = readDocument(dataFile)
      ensure(document.version === 2, `document version must be 2, got ${JSON.stringify(document.version)}`)
      const events = ensureArray(document.events, 'document.events')
      const mine = events.filter((event) => event.id === memoryNoteId)
      const creates = mine.filter((event) => event.kind === 'create')
      ensure(creates.length === 1, `expected one create event, got ${creates.length}`)
      ensure(creates[0].text === '记忆事件测试', `create event text mismatch: ${JSON.stringify(creates[0].text)}`)
      const updates = mine.filter((event) => event.kind === 'update')
      ensure(updates.length === 4, `expected 4 update events (a note-only edit is not tracked), got ${updates.length}`)
      ensure(updates.every((event) => isIso(event.at)), 'every update event needs an ISO "at"')
      ensure(updates.every((event) => event.text === '记忆事件测试'), 'update events keep the note title')
      ensure(updates[0].changes?.dueAt?.from === null && updates[0].changes.dueAt.to === dueFirst, 'first deadline must be from:null')
      ensure(updates[1].changes?.dueAt?.from === dueFirst && updates[1].changes.dueAt.to === dueLater, 'postponement change mismatch')
      ensure(updates[2].changes?.dueAt?.from === dueLater && updates[2].changes.dueAt.to === dueEarlier, 'pull-earlier change mismatch')
      ensure(updates[3].changes?.dueAt?.from === dueEarlier && updates[3].changes.dueAt.to === dueLatest, 'second postponement change mismatch')
      ensure(!('note' in (updates[0].changes ?? {})), 'only the four tracked fields may appear in changes')

      const removed = expectOkData(await api.action('add', { text: '会被删除的便签' }), 'remove-event add')
      expectOkData(await api.action('remove', { id: removed.id }), 'remove-event remove')
      const afterRemove = readDocument(dataFile)
      const removeEvent = ensureArray(afterRemove.events, 'events after remove')
        .find((event) => event.kind === 'remove' && event.id === removed.id)
      ensure(removeEvent, 'remove must append an event')
      ensure(removeEvent.text === '会被删除的便签', `remove event must keep the deleted title, got ${JSON.stringify(removeEvent.text)}`)
      ensure(!afterRemove.todos.some((todo) => todo.id === removed.id), 'the removed note must be gone from the document')
      return `${events.length} event(s); 4 update events tracked, note-only edit ignored`
    })

    await runCheck('postpones counts only later deadlines (first deadline / earlier moves do not count)', async () => {
      const state = expectOkData(await api.get('/dsh-todo/state'), 'state postpones')
      const memory = ensureObject(state.memory, 'state.memory')
      const postpones = ensureObject(memory.postpones, 'state.memory.postpones')
      ensure(postpones[memoryNoteId] === 2, `expected two postponements for ${memoryNoteId}, got ${JSON.stringify(postpones[memoryNoteId])}`)
      for (const [id, count] of Object.entries(postpones)) {
        ensure(typeof id === 'string' && Number.isInteger(count) && count >= 1, `postpones[${id}] must be a positive integer, got ${JSON.stringify(count)}`)
      }
      const stats = ensureObject(memory.stats, 'state.memory.stats')
      const week = ensureObject(stats.week, 'state.memory.stats.week')
      ensure(week.postponed >= 2, `week.postponed should count both postponements, got ${week.postponed}`)
      return `postpones=${JSON.stringify(postpones)}`
    })

    await runCheck('state.memory carries facts/stats/postpones/threads and leaves the Todo shape alone', async () => {
      const state = expectOkData(await api.get('/dsh-todo/state'), 'state memory shape')
      const memory = ensureObject(state.memory, 'state.memory')
      ensure(
        JSON.stringify(Object.keys(memory).sort()) === JSON.stringify(['facts', 'postpones', 'stats', 'threads']),
        `state.memory members changed: ${Object.keys(memory).sort().join('/')}`,
      )
      ensureArray(memory.facts, 'state.memory.facts')
      ensureObject(memory.postpones, 'state.memory.postpones')
      ensureObject(memory.threads, 'state.memory.threads')
      const stats = ensureObject(memory.stats, 'state.memory.stats')
      ensure(
        JSON.stringify(Object.keys(stats).sort()) === JSON.stringify(['averageOpenAgeDays', 'done', 'open', 'overdue', 'week']),
        `state.memory.stats members changed: ${Object.keys(stats).sort().join('/')}`,
      )
      for (const key of ['averageOpenAgeDays', 'done', 'open', 'overdue']) {
        ensure(typeof stats[key] === 'number' && Number.isFinite(stats[key]) && stats[key] >= 0, `stats.${key} must be a non-negative number`)
      }
      const week = ensureObject(stats.week, 'state.memory.stats.week')
      ensure(
        JSON.stringify(Object.keys(week).sort()) === JSON.stringify(['completed', 'created', 'postponed', 'removed']),
        `state.memory.stats.week members changed: ${Object.keys(week).sort().join('/')}`,
      )
      for (const todo of state.todos) {
        for (const leaked of ['memory', 'facts', 'threads', 'postpones']) {
          ensure(!(leaked in todo), `Todo shape must not gain a "${leaked}" member (the memory block is a sibling)`)
        }
      }
      return `facts=${memory.facts.length}, stats=${JSON.stringify(stats.week)}`
    })

    section('memory: facts')
    let factA = null
    let factB = null
    await runCheck('remember stores a trimmed user fact and /state returns facts newest first', async () => {
      factA = validateFact(expectOkData(await api.action('remember', { text: '  周报固定在周五下午发  ' }), 'remember A'), 'fact A')
      ensure(factA.text === '周报固定在周五下午发', `fact text must be trimmed, got ${JSON.stringify(factA.text)}`)
      factB = validateFact(expectOkData(await api.action('remember', { text: '每天先做最重要的一件' }), 'remember B'), 'fact B')
      const state = expectOkData(await api.get('/dsh-todo/state'), 'state facts')
      const facts = ensureArray(state.memory.facts, 'state.memory.facts')
      ensure(facts.length >= 2, `expected at least two facts, got ${facts.length}`)
      ensure(facts[0].id === factB.id && facts[1].id === factA.id, 'state.memory.facts must be newest first')
      const document = readDocument(dataFile)
      ensureArray(document.memory.facts, 'document.memory.facts')
      ensure(
        document.memory.facts.some((fact) => fact.id === factA.id) && document.memory.facts.some((fact) => fact.id === factB.id),
        'both facts must be persisted in the document',
      )
      return `facts=${facts.length}, newest=${facts[0].id}`
    })

    await runCheck('remember rejects duplicates after trim + lower-casing', async () => {
      const before = ensureArray(expectOkData(await api.get('/dsh-todo/state'), 'state before duplicates').memory.facts, 'facts before duplicates')
      for (const text of ['周报固定在周五下午发', '  周报固定在周五下午发  ']) {
        const error = expectError(await api.action('remember', { text }), `duplicate ${JSON.stringify(text)}`)
        ensure(error.code === 'invalid_input', `expected invalid_input for a duplicate, got ${JSON.stringify(error.code)}`)
      }
      expectOkData(await api.action('remember', { text: 'Weekly sync on Monday' }), 'remember english fact')
      const caseDuplicate = expectError(await api.action('remember', { text: '  weekly sync on monday ' }), 'case duplicate')
      ensure(caseDuplicate.code === 'invalid_input', `expected invalid_input for a case duplicate, got ${JSON.stringify(caseDuplicate.code)}`)
      const after = ensureArray(expectOkData(await api.get('/dsh-todo/state'), 'state after duplicates').memory.facts, 'facts after duplicates')
      ensure(after.length === before.length + 1, `duplicate rejections must not store facts (${before.length} -> ${after.length})`)
      return `${before.length} -> ${after.length}`
    })

    await runCheck('remember rejects empty / missing / over-long fact texts', async () => {
      const before = ensureArray(expectOkData(await api.get('/dsh-todo/state'), 'state before bad facts').memory.facts, 'facts before bad facts')
      const cases = ['', '   ', '很'.repeat(121), undefined]
      for (const text of cases) {
        const payload = text === undefined ? {} : { text }
        const error = expectError(await api.action('remember', payload), `bad fact text ${JSON.stringify(text)}`)
        ensure(error.code === 'invalid_input', `expected invalid_input, got ${JSON.stringify(error.code)} for ${JSON.stringify(text)}`)
      }
      const after = ensureArray(expectOkData(await api.get('/dsh-todo/state'), 'state after bad facts').memory.facts, 'facts after bad facts')
      ensure(after.length === before.length, 'rejected facts must not be stored')
      return `${cases.length} case(s) rejected`
    })

    await runCheck('updateFact rewrites a fact and rejects duplicate text / unknown ids', async () => {
      const updated = validateFact(
        expectOkData(await api.action('updateFact', { id: factA.id, text: '周报固定在周五 16:00 发' }), 'updateFact'),
        'updated fact A',
      )
      ensure(updated.id === factA.id, `updateFact must keep the id, got ${JSON.stringify(updated.id)}`)
      ensure(updated.text === '周报固定在周五 16:00 发', `updateFact text mismatch: ${JSON.stringify(updated.text)}`)
      ensure(Date.parse(updated.updatedAt) >= Date.parse(factA.updatedAt), 'updatedAt must not go backwards')
      const duplicate = expectError(await api.action('updateFact', { id: factA.id, text: factB.text }), 'updateFact duplicate')
      ensure(duplicate.code === 'invalid_input', `expected invalid_input for a duplicate, got ${JSON.stringify(duplicate.code)}`)
      const missing = expectError(await api.action('updateFact', { id: 'm_missing1', text: '不存在的记忆' }), 'updateFact missing')
      ensure(missing.code === 'not_found', `expected not_found, got ${JSON.stringify(missing.code)}`)
      const state = expectOkData(await api.get('/dsh-todo/state'), 'state after updateFact')
      const stateFact = state.memory.facts.find((fact) => fact.id === factA.id)
      ensure(stateFact && stateFact.text === '周报固定在周五 16:00 发', 'the rewritten fact must be returned by /state')
      return duplicate.code
    })

    await runCheck('forget removes one fact and rejects unknown ids', async () => {
      const result = expectOkData(await api.action('forget', { id: factB.id }), 'forget')
      ensureObject(result, 'forget result')
      ensure(result.forgotten === factB.id, `forget result must echo the id, got ${JSON.stringify(result.forgotten)}`)
      const state = expectOkData(await api.get('/dsh-todo/state'), 'state after forget')
      ensure(!state.memory.facts.some((fact) => fact.id === factB.id), 'the forgotten fact must be gone from /state')
      const error = expectError(await api.action('forget', { id: 'm_missing1' }), 'forget missing')
      ensure(error.code === 'not_found', `expected not_found, got ${JSON.stringify(error.code)}`)
      return error.code
    })

    await runCheck('facts are capped at 50 (the 51st is rejected; a forget frees a slot)', async () => {
      const limitCaptured = createHarness(join(workDir, 'facts-limit.json'))
      const limitApi = createClient(limitCaptured)
      let firstId = null
      for (let index = 0; index < 50; index += 1) {
        const fact = validateFact(
          expectOkData(await limitApi.action('remember', { text: `容量测试事实 ${index + 1}` }), `remember #${index + 1}`),
          `fact #${index + 1}`,
        )
        if (index === 0) firstId = fact.id
      }
      const overflow = expectError(await limitApi.action('remember', { text: '第 51 条事实' }), 'fact overflow')
      ensure(overflow.code === 'invalid_input', `expected invalid_input at the cap, got ${JSON.stringify(overflow.code)}`)
      expectOkData(await limitApi.action('forget', { id: firstId }), 'forget at cap')
      const freed = validateFact(expectOkData(await limitApi.action('remember', { text: '第 51 条事实' }), 'remember after forget'), 'fact after forget')
      ensure(freed.text === '第 51 条事实', 'a forget must free one fact slot')
      const state = expectOkData(await limitApi.get('/dsh-todo/state'), 'state at cap')
      ensure(state.memory.facts.length === 50, `expected the cap of 50 facts, got ${state.memory.facts.length}`)
      return '50 accepted, 51st rejected, slot freed after forget'
    })

    section('memory: advice threads')
    let threadNoteId = null
    await runCheck('aiNoteAdvice persists the rounds and the fallback advice in state.memory.threads', async () => {
      const added = expectOkData(await api.action('add', { text: '线程测试便签' }), 'thread add')
      threadNoteId = added.id
      const history = [{ question: '这一步卡在哪？', answer: '缺资料' }]
      const advice = expectOkData(await api.action('aiNoteAdvice', { id: threadNoteId, history }), 'thread advice')
      ensure(advice.kind === 'advice', `fallback must be advice, got ${JSON.stringify(advice.kind)}`)
      const state = expectOkData(await api.get('/dsh-todo/state'), 'state after thread')
      const thread = validateThread(ensureObject(state.memory.threads[threadNoteId], 'memory.threads[threadNoteId]'), 'thread')
      ensure(thread.rounds.length === 1, `expected one stored round, got ${thread.rounds.length}`)
      ensure(thread.rounds[0].question === '这一步卡在哪？' && thread.rounds[0].answer === '缺资料', 'stored round mismatch')
      ensureObject(thread.advice, 'thread.advice')
      ensure(thread.advice.text === advice.advice.text, 'stored advice text must match the returned advice')
      ensure(thread.advice.source === 'fallback', 'stored advice source must be fallback')
      return `rounds=${thread.rounds.length}`
    })

    await runCheck('a model question round stores the submitted rounds and no advice', async () => {
      const scripted = createScriptedModel(['{"kind":"question","question":"还想再补什么？","options":["补数据","先这样"]}'])
      const questionCaptured = createHarness(join(workDir, 'thread-question.json'), scripted)
      const questionApi = createClient(questionCaptured)
      const added = expectOkData(await questionApi.action('add', { text: '线程追问测试' }), 'question-thread add')
      const history = [{ question: '卡在哪？', answer: '缺资料' }]
      const data = expectOkData(await questionApi.action('aiNoteAdvice', { id: added.id, history }), 'question-thread advice')
      ensure(data.kind === 'question', `the scripted model should ask a question, got ${JSON.stringify(data.kind)}`)
      const state = expectOkData(await questionApi.get('/dsh-todo/state'), 'question-thread state')
      const thread = validateThread(ensureObject(state.memory.threads[added.id], 'question thread'), 'question thread')
      ensure(thread.rounds.length === 1 && thread.rounds[0].question === '卡在哪？', 'the submitted history must be stored as rounds')
      ensure(thread.advice === null, `a question round must not store advice, got ${JSON.stringify(thread.advice)}`)
      return 'rounds stored, advice null'
    })

    await runCheck('removing a note drops its thread but keeps its events', async () => {
      expectOkData(await api.action('remove', { id: threadNoteId }), 'thread remove')
      const state = expectOkData(await api.get('/dsh-todo/state'), 'state after thread remove')
      ensure(!(threadNoteId in state.memory.threads), 'the removed note thread must be gone from /state')
      const document = readDocument(dataFile)
      ensure(
        document.events.some((event) => event.kind === 'remove' && event.id === threadNoteId),
        'the removed note events must survive the removal',
      )
      return 'thread dropped, event kept'
    })

    section('memory: weekly review')
    await runCheck('review returns the deterministic fallback ReviewResult and writes nothing', async () => {
      const before = readFileSync(dataFile, 'utf8')
      const data = expectOkData(await api.action('review'), 'review')
      const review = validateReview(ensureObject(data.review, 'review result'), 'review', { expectSource: 'fallback' })
      const after = readFileSync(dataFile, 'utf8')
      ensure(after === before, 'review must not write the document')
      ensure(
        JSON.stringify(Object.keys(review).sort()) === JSON.stringify(['generatedAt', 'headline', 'highlights', 'range', 'source', 'stats', 'tips']),
        `ReviewResult members changed: ${Object.keys(review).sort().join('/')}`,
      )
      ensure(review.stats.postponed >= 2, `the review must count the recorded postponements, got ${review.stats.postponed}`)
      return `source=${review.source}, headline=${review.headline}`
    })

    section('memory: memory candidates')
    await runCheck('memoryCandidates proposes fallback candidates from patterns and writes nothing', async () => {
      for (let index = 0; index < 3; index += 1) {
        expectOkData(await api.action('add', { text: `复盘候选便签 ${index + 1}`, tags: ['复盘'] }), `candidate note #${index + 1}`)
      }
      const before = readFileSync(dataFile, 'utf8')
      const data = expectOkData(await api.action('memoryCandidates'), 'memoryCandidates')
      ensureObject(data, 'memoryCandidates result')
      ensure(Array.isArray(data.candidates), 'memoryCandidates.candidates must be an array')
      ensure(data.source === 'fallback', `memoryCandidates.source must be fallback without a model, got ${JSON.stringify(data.source)}`)
      ensure(isIso(data.generatedAt), 'memoryCandidates.generatedAt must be an ISO timestamp')
      validateCandidates(data.candidates, 'memoryCandidates.candidates', { expectSource: 'fallback' })
      ensure(
        JSON.stringify(Object.keys(data).sort()) === JSON.stringify(['candidates', 'generatedAt', 'source']),
        `memoryCandidates must return the candidate DTO, got members ${Object.keys(data).sort().join('/')}`,
      )
      const tagCandidate = data.candidates.find((candidate) => candidate.text.includes('复盘'))
      ensure(tagCandidate, `three notes sharing the 复盘 tag should yield a candidate, got ${JSON.stringify(data.candidates)}`)
      const after = readFileSync(dataFile, 'utf8')
      ensure(after === before, 'memoryCandidates must not write the document')
      const state = expectOkData(await api.get('/dsh-todo/state'), 'state after candidates')
      ensure(
        !state.memory.facts.some((fact) => fact.text === tagCandidate.text),
        'a proposed candidate must never be stored until the user calls remember',
      )
      return `candidates=${data.candidates.length}`
    })

    section('model-facing sticker_todo tool: memory actions')
    await runCheck('tool action enum exposes remember/forget/memories/review', async () => {
      const actionEnum = ensureArray(captured.tool?.parameters?.properties?.action?.enum, 'tool action enum')
      for (const name of ['remember', 'forget', 'memories', 'review']) {
        ensure(actionEnum.includes(name), `tool actions must include "${name}", got ${JSON.stringify(actionEnum)}`)
      }
      return `${actionEnum.length} actions`
    })

    await runCheck('tool remember/memories/list/review/forget round-trip with the memory echo', async () => {
      const tool = captured.tool
      const remembered = await tool.execute({ action: 'remember', text: '周五下午发周报' })
      ensure(remembered.ok === true, `tool remember failed: ${JSON.stringify(remembered.error)}`)
      const fact = validateFact(ensureObject(remembered.fact, 'tool remember fact'), 'tool fact')
      ensure(fact.text === '周五下午发周报', `tool remember text mismatch: ${JSON.stringify(fact.text)}`)

      const memories = await tool.execute({ action: 'memories' })
      ensure(memories.ok === true, `tool memories failed: ${JSON.stringify(memories.error)}`)
      ensureArray(memories.memory.facts, 'tool memories facts')
      ensure(memories.memory.facts.includes('周五下午发周报'), 'memories must echo the stored fact text')
      ensureObject(memories.memory.stats, 'tool memories stats')

      const list = await tool.execute({ action: 'list' })
      ensure(list.ok === true, `tool list failed: ${JSON.stringify(list.error)}`)
      ensureArray(list.memory.facts, 'tool list memory.facts')
      ensure(list.memory.facts.includes('周五下午发周报'), 'tool list must echo the memories')
      ensureObject(list.memory.stats, 'tool list memory.stats')
      ensureObject(list.memory.stats.week, 'tool list memory.stats.week')

      const before = readFileSync(dataFile, 'utf8')
      const reviewed = await tool.execute({ action: 'review' })
      ensure(reviewed.ok === true, `tool review failed: ${JSON.stringify(reviewed.error)}`)
      validateReview(ensureObject(reviewed.review, 'tool review'), 'tool review', { expectSource: 'fallback' })
      ensure(readFileSync(dataFile, 'utf8') === before, 'tool review must not write')

      const forgotten = await tool.execute({ action: 'forget', id: fact.id })
      ensure(forgotten.ok === true, `tool forget failed: ${JSON.stringify(forgotten.error)}`)
      ensure(forgotten.forgotten === fact.id, 'tool forget must echo the id')
      const afterForget = await tool.execute({ action: 'list' })
      ensure(!afterForget.memory.facts.includes('周五下午发周报'), 'tool forget must drop the fact from the echo')
      return `fact=${fact.id}`
    })

    section('memory: clearMemory')
    await runCheck('clearMemory drops facts, threads and the event log but keeps the notes', async () => {
      const beforeState = expectOkData(await api.get('/dsh-todo/state'), 'state before clearMemory')
      const factsBefore = beforeState.memory.facts.length
      const threadsBefore = Object.keys(beforeState.memory.threads).length
      const documentBefore = readDocument(dataFile)
      const eventsBefore = documentBefore.events.length
      const notesBefore = documentBefore.todos.map((todo) => todo.id).sort()
      ensure(factsBefore >= 2, `expected stored facts before clearing, got ${factsBefore}`)
      ensure(threadsBefore >= 1, `expected a stored thread before clearing, got ${threadsBefore}`)
      ensure(eventsBefore >= 1, `expected events before clearing, got ${eventsBefore}`)
      const data = expectOkData(await api.action('clearMemory'), 'clearMemory')
      const cleared = ensureObject(data.cleared, 'clearMemory.cleared')
      ensure(cleared.facts === factsBefore, `cleared.facts expected ${factsBefore}, got ${JSON.stringify(cleared.facts)}`)
      ensure(cleared.threads === threadsBefore, `cleared.threads expected ${threadsBefore}, got ${JSON.stringify(cleared.threads)}`)
      ensure(cleared.events === eventsBefore, `cleared.events expected ${eventsBefore}, got ${JSON.stringify(cleared.events)}`)

      const after = readDocument(dataFile)
      ensure(after.version === 2, `document version must stay 2, got ${JSON.stringify(after.version)}`)
      ensure(Array.isArray(after.events) && after.events.length === 0, 'clearMemory must empty the event log')
      ensure(Array.isArray(after.memory.facts) && after.memory.facts.length === 0, 'clearMemory must empty the facts')
      ensureObject(after.memory.threads, 'after.memory.threads')
      ensure(Object.keys(after.memory.threads).length === 0, 'clearMemory must empty the threads')
      ensure(after.todos.map((todo) => todo.id).sort().join() === notesBefore.join(), 'clearMemory must keep the notes')

      const state = expectOkData(await api.get('/dsh-todo/state'), 'state after clearMemory')
      ensure(state.memory.facts.length === 0, 'facts must stay empty after clearing')
      ensure(Object.keys(state.memory.threads).length === 0, 'threads must stay empty after clearing')
      ensure(Object.keys(state.memory.postpones).length === 0, 'clearMemory must reset the derived postponements')
      const week = state.memory.stats.week
      ensure(
        week.completed === 0 && week.created === 0 && week.postponed === 0 && week.removed === 0,
        `the weekly counts must be zero after clearing, got ${JSON.stringify(week)}`,
      )
      return `cleared facts=${cleared.facts}, threads=${cleared.threads}, events=${cleared.events}`
    })

    section('store: v1 document migration')
    await runCheck('a v1 document loads with empty memory and is upgraded to v2 on the next write', async () => {
      const v1File = join(workDir, 'v1-document.json')
      const v1Document = {
        version: 1,
        todos: [{
          id: 'td_legacy1',
          text: '旧版便签',
          note: '',
          done: false,
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
          dueAt: null,
          remindAt: null,
          remindFiredAt: null,
          priority: 2,
          color: 'yellow',
          tags: ['旧版'],
        }],
      }
      writeFileSync(v1File, JSON.stringify(v1Document, null, 2), 'utf8')
      const legacyCaptured = createHarness(v1File)
      const legacyApi = createClient(legacyCaptured)
      const state = expectOkData(await legacyApi.get('/dsh-todo/state'), 'v1 state')
      ensureArray(state.todos, 'v1 state.todos')
      ensure(state.todos.length === 1, `expected the v1 note to load, got ${state.todos.length}`)
      ensure(state.todos[0].id === 'td_legacy1' && state.todos[0].text === '旧版便签', 'the v1 todo must load unchanged')
      const memory = ensureObject(state.memory, 'v1 state.memory')
      ensureArray(memory.facts, 'v1 memory.facts')
      ensure(memory.facts.length === 0, 'a v1 document must load with empty facts')
      ensureObject(memory.threads, 'v1 memory.threads')
      ensure(Object.keys(memory.threads).length === 0, 'a v1 document must load with empty threads')
      ensureObject(memory.postpones, 'v1 memory.postpones')
      ensure(Object.keys(memory.postpones).length === 0, 'a v1 document has no postponements')

      const added = expectOkData(await legacyApi.action('add', { text: '迁移后新建' }), 'v1 upgrade add')
      const document = JSON.parse(readFileSync(v1File, 'utf8'))
      ensure(document.version === 2, `the next write must bump the document to v2, got ${JSON.stringify(document.version)}`)
      const events = ensureArray(document.events, 'upgraded document.events')
      ensure(events.some((event) => event.kind === 'create' && event.id === added.id), 'the new create event must be persisted')
      ensureArray(document.memory.facts, 'upgraded document.memory.facts')
      ensureObject(document.memory.threads, 'upgraded document.memory.threads')
      return 'v1 loaded; write upgraded to v2'
    })

    section('unknown action')
    await runCheck('unknown action -> unknown_action', async () => {
      const response = await api.action('definitely_not_real')
      const error = expectError(response, 'unknown action')
      ensure(error.code === 'unknown_action', `expected unknown_action, got ${JSON.stringify(error.code)}`)
      return error.code
    })

    section('model-facing sticker_todo tool')
    await runCheck('tool is registered with the tag action and tags parameter', async () => {
      const tool = captured.tool
      ensure(tool && typeof tool === 'object', 'the plugin did not register the sticker_todo tool')
      ensure(tool.name === 'sticker_todo', `tool name changed: ${JSON.stringify(tool.name)}`)
      const actionEnum = tool.parameters?.properties?.action?.enum
      ensureArray(actionEnum, 'tool.parameters.properties.action.enum')
      ensure(actionEnum.includes('tag'), `tool actions must include "tag", got ${JSON.stringify(actionEnum)}`)
      ensure(tool.parameters.properties.tags !== undefined, 'tool parameters must expose tags')
      return `actions=${actionEnum.length}`
    })

    await runCheck('tool add + tag action round-trip', async () => {
      const tool = captured.tool
      const added = await tool.execute({ action: 'add', text: '学习 TypeScript 泛型', tags: ['学习'] })
      ensure(added.ok === true, `tool add failed: ${JSON.stringify(added.error)}`)
      const created = ensureArray(added.todos, 'tool add todos').find((todo) => todo.text === '学习 TypeScript 泛型')
      ensure(created, 'tool add did not echo the created note')
      ensure(Array.isArray(created.tags) && created.tags.includes('学习'), `tool add did not echo tags: ${JSON.stringify(created.tags)}`)

      const tagged = await tool.execute({ action: 'tag' })
      ensure(tagged.ok === true, `tool tag failed: ${JSON.stringify(tagged.error)}`)
      const tagResult = ensureObject(tagged.tagResult, 'tool tag tagResult')
      ensure(tagResult.source === 'fallback', `tool tag source must be fallback without services, got ${JSON.stringify(tagResult.source)}`)
      ensure(Array.isArray(tagged.todos) && tagged.todos.some((todo) => Array.isArray(todo.tags) && todo.tags.length > 0),
        'tool tag did not echo tagged notes')
      return `items=${tagResult.items.length}`
    })

    await runCheck('tool renderer produces text content', async () => {
      const content = captured.tool.output.render({}, { counts: { open: 1, done: 0, overdue: 0, dueSoon: 0 } })
      ensureArray(content, 'tool render content')
      ensure(content.length > 0 && content[0].type === 'text', 'tool render must return a text block')
      return 'text block'
    })

    ensure(tagResultSnapshot !== null, 'aiTag was never exercised')
  } finally {
    for (const dispose of captured?.disposers ?? []) {
      try { dispose() } catch { /* ignore */ }
    }
    try { rmSync(workDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  section('Summary')
  const total = results.pass + results.fail
  console.log(`checks: ${results.pass} passed, ${results.fail} failed`)
  if (failures.length > 0) {
    console.log('failures:')
    for (const item of failures) console.log(`  - ${item.name}${item.detail ? `: ${item.detail}` : ''}`)
  }
  console.log(`RESULT: ${results.fail === 0 ? 'PASS' : 'FAIL'}`)
  process.exitCode = results.fail === 0 ? 0 : 1
  if (total === 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(`[FAIL] unexpected error: ${error?.stack || error}`)
  process.exitCode = 1
})
