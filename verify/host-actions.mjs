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
 *   - unknown action code
 *   - the model-facing `sticker_todo` tool: `tags` on add/update, `tag` action, `tags` echo
 *
 * Exit codes: 0 all checks passed, 1 one or more checks failed.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
