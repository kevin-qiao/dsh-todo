/**
 * Sticker TODO — Host half.
 *
 * Owns the todo document, the model-facing `sticker_todo` tool, the four AI operations
 * (schedule planning, advice, tag classification, and the per-note advisory conversation) and
 * the small JSON API the browser half talks to. The Web Client reaches this file over one prefix
 * route, `/dsh-todo`:
 *
 *   GET  /dsh-todo/state    -> { ok, data: { now, todos, dueReminders, ai } }
 *   POST /dsh-todo/action   -> { ok, data } | { ok: false, error: { code, message } }
 *
 * `/dsh-todo` is registered only when the composition provides `webServer`; the store and the
 * agent tool stay available in a headless profile, so the model can still read and edit notes.
 *
 * @module @local/dsh-sticker-todo
 */
import { createStore, dueReminders, sortTodos, InputError, defaultDataFile } from './lib/store.js'
import { createAiLayer } from './lib/ai.js'
import { registerTodoTool } from './lib/tools.js'

/** Loader row name, also used for logging. */
export const name = 'sticker-todo'

/** The tool registry is required; the browser API is registered optionally. */
export const inject = ['tools']

/** Largest JSON request body the action route accepts. */
const MAX_BODY_BYTES = 64 * 1024

/** The per-note AI advice conversation may ask at most this many questions. */
const MAX_NOTE_ADVICE_HISTORY = 3

/**
 * Merge the row's `config` with defaults.
 * @param {Record<string, unknown>} [raw] plugin row config.
 * @returns {{ dataFile: string, aiTimeoutMs: number, logger: (message: string) => void }} resolved options.
 */
function resolveConfig(raw = {}) {
  const logger = typeof raw.logger === 'function' ? raw.logger : (message) => console.warn(`[sticker-todo] ${message}`)
  return {
    dataFile: typeof raw.dataFile === 'string' && raw.dataFile !== '' ? raw.dataFile : defaultDataFile(),
    aiTimeoutMs: Number.isFinite(raw.aiTimeoutMs) && raw.aiTimeoutMs > 0 ? raw.aiTimeoutMs : 30_000,
    logger,
  }
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res response to complete.
 * @param {number} status HTTP status code.
 * @param {unknown} payload JSON-serializable body.
 */
function sendJson(res, status, payload) {
  if (res.writableEnded) return
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/**
 * Read and parse a JSON request body.
 * @param {import('node:http').IncomingMessage} req incoming request.
 * @param {number} limit maximum accepted bytes.
 * @returns {Promise<Record<string, any>>} the parsed object (never an array or scalar).
 */
async function readJson(req, limit) {
  /** @type {Buffer[]} */
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new InputError('invalid_input', `request body is larger than ${limit} bytes`)
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new InputError('invalid_input', 'request body is not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InputError('invalid_input', 'request body must be a JSON object')
  }
  return /** @type {Record<string, any>} */ (parsed)
}

/**
 * Validate the optional per-note Q&A history of the `aiNoteAdvice` action.
 * @param {unknown} value raw `history` parameter.
 * @returns {Array<{ question: string, answer: string }>} the validated history (empty when absent).
 */
function noteAdviceHistory(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new InputError('invalid_input', 'history must be an array of { question, answer } objects')
  }
  if (value.length > MAX_NOTE_ADVICE_HISTORY) {
    throw new InputError('invalid_input', `history must hold at most ${MAX_NOTE_ADVICE_HISTORY} entries`)
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new InputError('invalid_input', `history[${index}] must be a { question, answer } object`)
    }
    const question = typeof entry.question === 'string' ? entry.question.trim() : ''
    const answer = typeof entry.answer === 'string' ? entry.answer.trim() : ''
    if (question === '' || answer === '') {
      throw new InputError('invalid_input', `history[${index}] needs non-empty question and answer strings`)
    }
    return { question, answer }
  })
}

/**
 * Install the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {Record<string, unknown>} [config] the row's config.
 */
export function apply(ctx, config) {
  const options = resolveConfig(config)
  const store = createStore({ filePath: options.dataFile, logger: options.logger })
  const ai = createAiLayer(ctx, { timeoutMs: options.aiTimeoutMs, logger: options.logger })

  /** Read the dashboard payload both the browser half and the agent tool use. */
  function readState() {
    const now = new Date()
    const todos = sortTodos(store.all())
    return {
      now: now.toISOString(),
      todos,
      dueReminders: dueReminders(todos, now),
      ai: ai.available(),
    }
  }

  /**
   * Apply one store action by name — the single implementation shared by the HTTP route and,
   * indirectly, the agent tool.
   * @param {Record<string, any>} payload action name plus its parameters.
   * @returns {Promise<unknown>} the action result.
   */
  async function runAction(payload) {
    const action = payload.action
    const id = typeof payload.id === 'string' ? payload.id : ''
    switch (action) {
      case 'add':
        return store.add(payload)
      case 'update':
        return store.update(id, payload)
      case 'toggle':
        return store.toggle(id, typeof payload.done === 'boolean' ? payload.done : undefined)
      case 'remove':
        return store.remove(id)
      case 'clearCompleted':
        return store.clearCompleted()
      case 'ackReminders':
        return store.ackReminders(payload.ids)
      case 'aiPlan': {
        const plan = await ai.plan(store.all())
        const todos = await store.applyPlan(plan.items)
        return { plan, todos }
      }
      case 'aiAdvice':
        return { advice: await ai.advice(store.all()) }
      case 'aiTag': {
        const tagResult = await ai.tag(store.all())
        const todos = await store.applyTags(tagResult.items)
        return { tagResult, todos }
      }
      case 'aiNoteAdvice': {
        const todo = id === '' ? undefined : store.get(id)
        if (!todo) throw new InputError('not_found', `no todo with id ${id}`)
        return ai.noteAdvice(todo, noteAdviceHistory(payload.history))
      }
      case 'aiClearPlan':
        return { todos: await store.clearPlan() }
      default:
        throw new InputError('unknown_action', `unknown action: ${String(action)}`)
    }
  }

  // Model-facing tool: the same operations, exposed to the agent.
  ctx.effect(() => registerTodoTool(ctx, { store, ai, runAction, readState }))

  // Browser API. Optional so the plugin still works in a composition without a web server.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const handler = async (req, res) => {
        /** @type {URL} */
        let url
        try {
          url = new URL(req.url ?? '/', 'http://127.0.0.1')
        } catch {
          sendJson(res, 400, { ok: false, error: { code: 'invalid_input', message: 'malformed request URL' } })
          return
        }
        const path = url.pathname
        const method = req.method ?? 'GET'
        try {
          if (path === '/dsh-todo' || path === '/dsh-todo/') {
            if (method !== 'GET' && method !== 'HEAD') {
              sendJson(res, 405, { ok: false, error: { code: 'method_not_allowed', message: `${method} is not allowed here` } })
              return
            }
            sendJson(res, 200, { ok: true, data: { plugin: name, version: 1, actions: ['state', 'action'] } })
            return
          }
          if (path === '/dsh-todo/state') {
            if (method === 'OPTIONS') {
              res.writeHead(204, { Allow: 'GET, HEAD, OPTIONS' })
              res.end()
              return
            }
            if (method !== 'GET' && method !== 'HEAD') {
              sendJson(res, 405, { ok: false, error: { code: 'method_not_allowed', message: `${method} is not allowed here` } })
              return
            }
            await store.ready()
            sendJson(res, 200, { ok: true, data: readState() })
            return
          }
          if (path === '/dsh-todo/action') {
            if (method === 'OPTIONS') {
              res.writeHead(204, { Allow: 'POST, OPTIONS' })
              res.end()
              return
            }
            if (method !== 'POST') {
              sendJson(res, 405, { ok: false, error: { code: 'method_not_allowed', message: `${method} is not allowed here` } })
              return
            }
            await store.ready()
            const payload = await readJson(req, MAX_BODY_BYTES)
            const data = await runAction(payload)
            sendJson(res, 200, { ok: true, data })
            return
          }
          sendJson(res, 404, { ok: false, error: { code: 'not_found', message: `no route for ${path}` } })
        } catch (error) {
          if (error instanceof InputError) {
            sendJson(res, 200, { ok: false, error: { code: error.code, message: error.message } })
            return
          }
          const message = error instanceof Error ? error.message : String(error)
          options.logger(`request ${method} ${path} failed: ${message}`)
          sendJson(res, 500, { ok: false, error: { code: 'internal_error', message } })
        }
      }
      const dispose = webCtx.webServer.register({ kind: 'prefix', path: '/dsh-todo', handler })
      options.logger(`browser API listening on /dsh-todo (data: ${options.dataFile})`)
      return () => dispose()
    })
  })

  // Read the document eagerly so the first request is not the one paying for IO.
  store.ready().catch((error) => options.logger(`could not load the todo document: ${error.message}`))
}
