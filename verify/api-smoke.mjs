#!/usr/bin/env node
/**
 * verify/api-smoke.mjs — black-box HTTP smoke test for the sticker TODO
 * Host route mounted at `/dsh-todo` on a running DSH Web GUI.
 *
 * Usage:
 *   node verify/api-smoke.mjs                       # http://127.0.0.1:55609
 *   node verify/api-smoke.mjs http://127.0.0.1:58383
 *   DSH_WEB_URL=http://127.0.0.1:58383 node verify/api-smoke.mjs
 *
 * Node built-ins only (`fetch`, `AbortController`). The script only talks to
 * `<base>/dsh-todo/state` and `<base>/dsh-todo/action`, and removes every todo
 * it creates; it never touches other routes or files.
 *
 * v1.1.0: also covers `tags` on add/update and the `aiTag` classification action.
 * Those checks are SKIP-ped (not failed) while the running Host still predates the
 * feature — the Host half only reloads when DSH restarts. `aiTag` rewrites the tags of
 * every open note, so the suite restores the pre-existing notes' tags afterwards and
 * skips the store-wide `clearCompleted` path while the board holds finished notes.
 * v1.2.0: also covers the per-note `aiNoteAdvice` conversation (question/advice rounds,
 * the three-round cap, unknown id and bad history), SKIP-ped on a Host without it.
 * v1.7.0: also covers the memory surface — the `state.memory` block, a clearly-marked
 * temporary fact's remember / updateFact / forget round-trip, and the read-only `review`
 * and `memoryCandidates` actions. Temp facts are always forgotten in cleanup; the checks
 * never touch the user's own facts, threads, events or notes.
 * v1.8.0: also covers the untagged-only `aiTag` contract — notes that already carried tags
 * before the run must keep exactly those tags and must not appear in `tagResult.items`.
 *
 * Exit codes:
 *   0  all checks passed (skips allowed)
 *   1  one or more contract checks failed
 *   2  the plugin route is not mounted yet (GET /dsh-todo/state unreachable / non-JSON)
 *
 * Every request is bounded: 10 s normally, 45 s for the AI actions, so a
 * hung route is a reportable failure rather than a stall.
 */

const DEFAULT_BASE = process.env.DSH_WEB_URL || 'http://127.0.0.1:55609';
const BASE = (process.argv[2] || DEFAULT_BASE).replace(/\/+$/, '');
const ROUTE = '/dsh-todo';
const TIMEOUT_MS = 10_000;
const AI_TIMEOUT_MS = 45_000;
const COLORS = ['yellow', 'pink', 'blue', 'green', 'purple', 'orange'];
const ADVICE_KINDS = ['focus', 'breakdown', 'deadline', 'rest', 'scope'];
const AI_SOURCES = ['model', 'fallback'];

if (typeof fetch !== 'function' || typeof AbortController !== 'function') {
  console.error('[FAIL] this Node runtime lacks global fetch/AbortController (Node >= 18 required)');
  process.exit(1);
}

const results = { pass: 0, fail: 0, skip: 0 };
const createdIds = new Set();
/** Temporary memory facts created by this run; forgotten in cleanup. */
const createdFactIds = new Set();
const state = {
  primaryId: null,
  openId: null,
  clearMeId: null,
  taggedId: null,
  aiTagItemIds: [],
};
let cleanupRemoved = 0;
let cleanupFailed = 0;
/** Board facts read before the first mutation, used to keep cleanup non-destructive. */
let initialBoard = { total: 0, done: 0, ids: new Set(), tags: new Map() };

/* ------------------------------------------------------------------ *
 * Output helpers
 * ------------------------------------------------------------------ */

function pass(name, detail = '') {
  results.pass += 1;
  console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name, detail = '') {
  results.fail += 1;
  console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
}
function skip(name, detail = '') {
  results.skip += 1;
  console.log(`[SKIP] ${name}${detail ? ` — ${detail}` : ''}`);
}
function info(text) { console.log(text); }

/* ------------------------------------------------------------------ *
 * HTTP helpers (bounded, JSON-aware)
 * ------------------------------------------------------------------ */

async function request(path, { method = 'GET', body, timeoutMs = TIMEOUT_MS } = {}) {
  const url = `${BASE}${ROUTE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  const init = { method, signal: controller.signal, headers: {} };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json; charset=utf-8';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  try {
    const response = await fetch(url, init);
    const text = await response.text();
    let json = null;
    if (text.length > 0) {
      try { json = JSON.parse(text); } catch { json = null; }
    }
    return { url, status: response.status, json, text, ms: Date.now() - startedAt };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`${method} ${path} timed out after ${timeoutMs} ms`);
    }
    const cause = error?.cause?.code || error?.cause?.message || error?.message || String(error);
    throw new Error(`${method} ${path} failed: ${cause}`);
  } finally {
    clearTimeout(timer);
  }
}

function action(name, params = {}, timeoutMs = TIMEOUT_MS) {
  return request('/action', { method: 'POST', body: { action: name, ...params }, timeoutMs });
}

async function requestState() {
  const response = await request('/state');
  return requireEnvelope(response, 'GET /state');
}

function requireEnvelope(response, label) {
  if (response.status !== 200) {
    throw new Error(`${label}: expected HTTP 200, got ${response.status} (${truncate(response.text)})`);
  }
  if (!response.json || typeof response.json !== 'object') {
    throw new Error(`${label}: expected a JSON envelope, got non-JSON (${truncate(response.text)})`);
  }
  return response.json;
}

function expectOkData(response, label) {
  const envelope = requireEnvelope(response, label);
  if (envelope.ok !== true) {
    throw new Error(`${label}: ok !== true (${JSON.stringify(envelope.error ?? envelope).slice(0, 240)})`);
  }
  return envelope.data;
}

function truncate(text, length = 180) {
  return String(text ?? '').replace(/\s+/g, ' ').slice(0, length);
}

/* ------------------------------------------------------------------ *
 * Assertions
 * ------------------------------------------------------------------ */

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function ensureObject(value, label) {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object, got ${JSON.stringify(value)}`);
  return value;
}

function ensureArray(value, label) {
  ensure(Array.isArray(value), `${label} must be an array, got ${JSON.stringify(value)}`);
  return value;
}

function ensureString(value, label, { nonEmpty = true } = {}) {
  ensure(typeof value === 'string', `${label} must be a string, got ${JSON.stringify(value)}`);
  if (nonEmpty) ensure(value.trim() !== '', `${label} must be non-empty`);
  return value;
}

function ensureBoolean(value, label) {
  ensure(typeof value === 'boolean', `${label} must be a boolean, got ${JSON.stringify(value)}`);
  return value;
}

function ensureNumber(value, label) {
  ensure(typeof value === 'number' && Number.isFinite(value), `${label} must be a finite number, got ${JSON.stringify(value)}`);
  return value;
}

function ensureIso(value, label, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined)) return value;
  ensureString(value, label);
  ensure(!Number.isNaN(Date.parse(value)), `${label} is not a parseable ISO-8601 date: ${JSON.stringify(value)}`);
  return value;
}

function ensureIsoEcho(actual, expected, label, { nullable = false } = {}) {
  if (expected === null || expected === undefined) {
    ensure(actual === null || actual === undefined, `${label} expected null, got ${JSON.stringify(actual)}`);
    return;
  }
  ensureIso(actual, label, { nullable });
  ensure(Date.parse(actual) === Date.parse(expected), `${label} expected ${expected}, got ${actual}`);
}

function validateTodo(todo, label) {
  ensureObject(todo, label);
  ensureString(todo.id, `${label}.id`);
  ensureString(todo.text, `${label}.text`);
  ensure(typeof todo.note === 'string', `${label}.note must be a string`);
  ensureBoolean(todo.done, `${label}.done`);
  ensureIso(todo.createdAt, `${label}.createdAt`);
  ensureIso(todo.updatedAt, `${label}.updatedAt`);
  ensureIso(todo.dueAt, `${label}.dueAt`, { nullable: true });
  ensureIso(todo.remindAt, `${label}.remindAt`, { nullable: true });
  ensureIso(todo.remindFiredAt, `${label}.remindFiredAt`, { nullable: true });
  ensure([1, 2, 3].includes(todo.priority), `${label}.priority must be 1..3, got ${JSON.stringify(todo.priority)}`);
  ensure(COLORS.includes(todo.color), `${label}.color must be one of ${COLORS.join('|')}, got ${JSON.stringify(todo.color)}`);
  if (todo.planAt !== undefined) ensureIso(todo.planAt, `${label}.planAt`, { nullable: true });
  if (todo.planNote !== undefined) ensure(typeof todo.planNote === 'string', `${label}.planNote must be a string`);
  // v1.1.0: `tags` is always an array on a new Host; tolerate its absence on a Host
  // that predates tagging so the rest of the suite stays usable after a restart-only rollout.
  if (todo.tags !== undefined) ensureTags(todo.tags, `${label}.tags`);
  return todo;
}

function ensureTags(value, label) {
  ensureArray(value, label);
  ensure(value.length <= 3, `${label} must hold at most 3 tags, got ${JSON.stringify(value)}`);
  const seen = new Set();
  for (const [index, tag] of value.entries()) {
    ensureString(tag, `${label}[${index}]`);
    ensure(tag === tag.trim(), `${label}[${index}] must be trimmed, got ${JSON.stringify(tag)}`);
    ensure(!tag.startsWith('#'), `${label}[${index}] must not start with "#"`);
    ensure(tag.length <= 12, `${label}[${index}] must be at most 12 characters`);
    const key = tag.toLowerCase();
    ensure(!seen.has(key), `${label} repeats "${tag}" case-insensitively`);
    seen.add(key);
  }
  return value;
}

function ensureOptions(value, label, { min, max, maxChars }) {
  ensureArray(value, label);
  ensure(value.length >= min && value.length <= max, `${label} must hold ${min}..${max} entries, got ${value.length}`);
  const seen = new Set();
  for (const [index, option] of value.entries()) {
    ensureString(option, `${label}[${index}]`);
    ensure(option === option.trim(), `${label}[${index}] must be trimmed`);
    ensure([...option].length <= maxChars, `${label}[${index}] must be at most ${maxChars} characters`);
    ensure(!seen.has(option), `${label} repeats "${option}"`);
    seen.add(option);
  }
  return value;
}

/** Validate one v1.7.0 memory Fact (CONTRACT.md round 7). */
function validateFact(fact, label) {
  ensureObject(fact, label);
  ensureString(fact.id, `${label}.id`);
  ensure(/^m_[0-9a-z]{8}$/.test(fact.id), `${label}.id must be "m_" + 8 hex characters, got ${JSON.stringify(fact.id)}`);
  ensureString(fact.text, `${label}.text`);
  ensure([...fact.text].length <= 120, `${label}.text must be at most 120 characters`);
  ensure(fact.text === fact.text.trim(), `${label}.text must be trimmed`);
  ensure(fact.source === 'user', `${label}.source must be "user", got ${JSON.stringify(fact.source)}`);
  ensureIso(fact.createdAt, `${label}.createdAt`);
  ensureIso(fact.updatedAt, `${label}.updatedAt`);
  return fact;
}

async function addTodo(params) {
  const response = await action('add', params);
  const todo = expectOkData(response, `add ${JSON.stringify(params.text ?? '')}`);
  validateTodo(todo, 'add result');
  createdIds.add(todo.id);
  return todo;
}

async function toggleTodo(id, done) {
  const response = await action('toggle', done === undefined ? { id } : { id, done });
  return expectOkData(response, `toggle ${id}`);
}

async function runCheck(name, fn) {
  try {
    const detail = await fn();
    pass(name, typeof detail === 'string' ? detail : '');
  } catch (error) {
    if (error instanceof SkipCheck) skip(name, error.message);
    else fail(name, error?.message || String(error));
  }
}

/* ------------------------------------------------------------------ *
 * Skip support (checks that need data the board cannot safely provide)
 * ------------------------------------------------------------------ */

class SkipCheck extends Error {}

/** Cached v1.1.0 capability probe: true / false / null (not probed yet). */
let v11Supported = null;

/** Detect whether the running Host knows the v1.1.0 `tags` field (read-only probe). */
async function detectV11() {
  if (v11Supported !== null) return v11Supported;
  const envelope = await requestState();
  const todos = ensureArray(envelope?.data?.todos, 'state.data.todos');
  if (todos.length > 0) {
    v11Supported = todos.every((todo) => Array.isArray(todo.tags));
    return v11Supported;
  }
  // Empty board: create a throwaway probe note and read the echo.
  const response = await action('add', { text: 'verify: v1.1.0 probe' });
  const todo = expectOkData(response, 'v1.1.0 probe add');
  createdIds.add(todo.id);
  v11Supported = Array.isArray(todo.tags);
  return v11Supported;
}

async function requireV11() {
  if (!(await detectV11())) {
    throw new SkipCheck('the running Host predates v1.1.0 (no Todo.tags, no aiTag) — restart DSH to load the new host code');
  }
}

/** Cached v1.2.0 capability probe: true / false / null (not probed yet). */
let v12Supported = null;
/** Detect whether the running Host knows `aiNoteAdvice` (non-mutating probe). */
async function detectV12() {
  if (v12Supported !== null) return v12Supported;
  if (!state.taggedId) {
    v12Supported = false;
    return false;
  }
  const response = await action('aiNoteAdvice', { id: state.taggedId }, AI_TIMEOUT_MS);
  v12Supported = !(response.status === 200 && response.json?.ok === false && response.json?.error?.code === 'unknown_action');
  return v12Supported;
}

async function requireV12() {
  if (!(await detectV12())) {
    throw new SkipCheck('the running Host predates v1.2.0 (no aiNoteAdvice) — restart DSH to load the new host code');
  }
}

/* ------------------------------------------------------------------ *
 * v1.7.0 memory support (read-only capability probe)
 * ------------------------------------------------------------------ */

/** Cached v1.7.0 capability probe: true / false / null (not probed yet). */
let v17Supported = null;

/** Detect whether the running Host returns the v1.7.0 `state.memory` block. */
async function detectV17() {
  if (v17Supported !== null) return v17Supported;
  const envelope = await requestState();
  const memory = envelope?.data?.memory;
  v17Supported = memory !== null && typeof memory === 'object' && !Array.isArray(memory);
  return v17Supported;
}

async function requireV17() {
  if (!(await detectV17())) {
    throw new SkipCheck('the running Host predates v1.7.0 (no state.memory block) — restart DSH to load the new host code');
  }
}

/* ------------------------------------------------------------------ *
 * Cleanup
 * ------------------------------------------------------------------ */

async function removeQuietly(id) {
  try {
    const response = await action('remove', { id });
    const envelope = response.json;
    if (response.status === 200 && envelope?.ok === true) return true;
    return false;
  } catch {
    return false;
  }
}

async function cleanup() {
  info('\n== Cleanup ==');
  const ids = [...createdIds];
  for (const id of ids) {
    if (await removeQuietly(id)) {
      createdIds.delete(id);
      cleanupRemoved += 1;
    }
  }

  // Forget every temporary memory fact this run created (never the user's own facts).
  for (const factId of [...createdFactIds]) {
    try {
      const response = await action('forget', { id: factId });
      if (response.status === 200 && response.json?.ok === true) {
        createdFactIds.delete(factId);
        info(`[PASS] cleanup: forgot temporary memory fact ${factId}`);
      } else {
        cleanupFailed += 1;
        info(`[FAIL] cleanup: could not forget temporary memory fact ${factId} — HTTP ${response.status} ${truncate(response.text)}`);
      }
    } catch (error) {
      cleanupFailed += 1;
      info(`[FAIL] cleanup: forget temporary memory fact failed — ${error.message}`);
    }
  }
  // clearCompleted is store-wide, so only use it when the board held no finished notes
  // before this run (otherwise every finished note would be ours anyway).
  if (initialBoard.done > 0) {
    info(`[SKIP] cleanup: clearCompleted not called — the board held ${initialBoard.done} pre-existing finished note(s)`);
  } else {
    try {
      const response = await action('clearCompleted');
      const envelope = response.json;
      if (response.status === 200 && envelope?.ok === true) {
        const removed = envelope.data?.removed;
        if (typeof removed === 'number') {
          cleanupRemoved += removed;
          info(`[PASS] cleanup: clearCompleted removed ${removed}`);
        } else {
          info(`[WARN] cleanup: clearCompleted removed is not a number: ${JSON.stringify(removed)}`);
        }
      } else {
        cleanupFailed += 1;
        info(`[FAIL] cleanup: clearCompleted returned HTTP ${response.status} ${truncate(response.text)}`);
      }
    } catch (error) {
      cleanupFailed += 1;
      info(`[FAIL] cleanup: clearCompleted failed — ${error.message}`);
    }
  }

  // Confirm none of our ids survived, and that the route is still healthy.
  try {
    const envelope = await requestState();
    const todos = ensureArray(envelope?.data?.todos, 'state.data.todos');
    const leftovers = todos.filter((todo) => createdIds.has(todo.id));
    if (leftovers.length === 0) {
      info('[PASS] cleanup: no test todos remain in /dsh-todo/state');
    } else {
      cleanupFailed += 1;
      info(`[FAIL] cleanup: test todos still present: ${leftovers.map((todo) => todo.id).join(', ')}`);
    }
  } catch (error) {
    cleanupFailed += 1;
    info(`[FAIL] cleanup: final state check failed — ${error.message}`);
  }
}

/* ------------------------------------------------------------------ *
 * Checks (executed in CONTRACT.md order)
 * ------------------------------------------------------------------ */

function registerChecks(initialEnvelope) {
  return [
    ['GET /state shape', async () => {
      const envelope = initialEnvelope;
      ensure(envelope.ok === true, `state envelope ok must be true, got ${JSON.stringify(envelope.ok)}`);
      const data = ensureObject(envelope.data, 'state.data');
      ensureIso(data.now, 'state.data.now');
      ensureArray(data.todos, 'state.data.todos').forEach((todo, index) => validateTodo(todo, `state.todos[${index}]`));
      ensureArray(data.dueReminders, 'state.data.dueReminders').forEach((todo, index) => {
        validateTodo(todo, `state.dueReminders[${index}]`);
        ensure(todo.done === false, 'dueReminders entries must not be done');
        ensure(todo.remindFiredAt === null || todo.remindFiredAt === undefined, 'dueReminders entries must have remindFiredAt null');
      });
      ensureObject(data.ai, 'state.data.ai');
      ensureBoolean(data.ai.available, 'state.data.ai.available');
      ensure(data.ai.reason === null || typeof data.ai.reason === 'string', 'state.data.ai.reason must be null or string');
      const initialCount = data.todos.length;
      if (initialCount > 0) {
        info(`[WARN] store already contains ${initialCount} todo(s); only ids created by this script are removed (clearCompleted is store-wide)`);
      }
      return `${data.todos.length} todo(s), ai.available=${data.ai.available}`;
    }],

    ['action add (text, dueAt, remindAt, priority, color)', async () => {
      const dueAt = new Date(Date.now() + 3_600_000).toISOString();
      const remindAt = new Date(Date.now() + 1_800_000).toISOString();
      const todo = await addTodo({
        text: 'verify: full-field sticker todo',
        dueAt,
        remindAt,
        priority: 1,
        color: 'blue',
      });
      state.primaryId = todo.id;
      ensure(todo.text === 'verify: full-field sticker todo', `text echo mismatch: ${JSON.stringify(todo.text)}`);
      ensureIsoEcho(todo.dueAt, dueAt, 'dueAt');
      ensureIsoEcho(todo.remindAt, remindAt, 'remindAt');
      ensure(todo.priority === 1, `priority echo mismatch: ${JSON.stringify(todo.priority)}`);
      ensure(todo.color === 'blue', `color echo mismatch: ${JSON.stringify(todo.color)}`);
      ensure(todo.done === false, 'new todo must not be done');
      return `id=${todo.id}`;
    }],

    ['action add without text -> ok:false, invalid_input', async () => {
      const response = await action('add', { priority: 2 });
      const envelope = requireEnvelope(response, 'add without text');
      ensure(envelope.ok === false, `expected ok:false, got ${JSON.stringify(envelope.ok)}`);
      ensureObject(envelope.error, 'add.error');
      ensure(envelope.error.code === 'invalid_input', `expected error.code "invalid_input", got ${JSON.stringify(envelope.error.code)}`);
      ensureString(envelope.error.message, 'add.error.message');
      return envelope.error.code;
    }],

    ['action update (text + dueAt)', async () => {
      ensure(state.primaryId, 'no todo id from the earlier add');
      const text = 'verify: updated sticker todo';
      const dueAt = new Date(Date.now() + 7_200_000).toISOString();
      const response = await action('update', { id: state.primaryId, text, dueAt });
      const todo = expectOkData(response, 'update');
      validateTodo(todo, 'update result');
      ensure(todo.id === state.primaryId, `updated id changed: ${todo.id} !== ${state.primaryId}`);
      ensure(todo.text === text, `text not updated: ${JSON.stringify(todo.text)}`);
      ensureIsoEcho(todo.dueAt, dueAt, 'dueAt');
      return `id=${todo.id}`;
    }],

    ['action add (second, open item for sorting)', async () => {
      const todo = await addTodo({ text: 'verify: keep-open item', priority: 3, color: 'green' });
      state.openId = todo.id;
      ensure(todo.done === false, 'second item must start open');
      return `id=${todo.id}`;
    }],

    ['action toggle done=true', async () => {
      ensure(state.primaryId, 'no todo id from the earlier add');
      const todo = await toggleTodo(state.primaryId, true);
      validateTodo(todo, 'toggle result');
      ensure(todo.id === state.primaryId, `toggled id changed: ${todo.id} !== ${state.primaryId}`);
      ensure(todo.done === true, `done not applied: ${JSON.stringify(todo.done)}`);
      return `id=${todo.id}`;
    }],

    ['state: done item present and sorted after open items', async () => {
      ensure(state.primaryId, 'no todo id from the earlier add');
      ensure(state.openId, 'no open todo to compare against');
      const envelope = await requestState();
      const data = ensureObject(envelope.data, 'state.data');
      const todos = ensureArray(data.todos, 'state.data.todos');
      todos.forEach((todo, index) => validateTodo(todo, `state.todos[${index}]`));

      const mineIndex = todos.findIndex((todo) => todo.id === state.primaryId);
      ensure(mineIndex >= 0, `toggled todo ${state.primaryId} missing from state`);
      ensure(todos[mineIndex].done === true, 'toggled todo is not done in state');

      const firstDone = todos.findIndex((todo) => todo.done === true);
      ensure(firstDone >= 0, 'state contains no done item');
      const openAfterDone = todos.slice(firstDone).filter((todo) => todo.done !== true);
      ensure(openAfterDone.length === 0,
        `open item(s) sorted after done items: ${openAfterDone.map((todo) => todo.id).join(', ')}`);
      return `${todos.length} todo(s); done block starts at index ${firstDone}`;
    }],

    ['action aiAdvice -> advice headline/tips/source', async () => {
      const response = await action('aiAdvice', {}, AI_TIMEOUT_MS);
      const data = expectOkData(response, 'aiAdvice');
      const advice = ensureObject(data.advice, 'aiAdvice.advice');
      ensureString(advice.headline, 'advice.headline');
      ensureArray(advice.tips, 'advice.tips');
      for (const [index, tip] of advice.tips.entries()) {
        ensureObject(tip, `advice.tips[${index}]`);
        ensureString(tip.text, `advice.tips[${index}].text`);
        ensure(ADVICE_KINDS.includes(tip.kind), `advice.tips[${index}].kind must be one of ${ADVICE_KINDS.join('|')}, got ${JSON.stringify(tip.kind)}`);
      }
      ensure(AI_SOURCES.includes(advice.source), `advice.source must be model|fallback, got ${JSON.stringify(advice.source)}`);
      ensureIso(advice.generatedAt, 'advice.generatedAt');
      if (advice.priorityOrder !== undefined) {
        ensureArray(advice.priorityOrder, 'advice.priorityOrder')
          .forEach((id, index) => ensureString(id, `advice.priorityOrder[${index}]`));
      }
      return `headline="${truncate(advice.headline, 48)}", tips=${advice.tips.length}, source=${advice.source}`;
    }],

    ['action aiPlan -> plan items, ISO planAt, todos reflect planAt', async () => {
      const response = await action('aiPlan', {}, AI_TIMEOUT_MS);
      const data = expectOkData(response, 'aiPlan');
      const plan = ensureObject(data.plan, 'aiPlan.plan');
      ensure(Array.isArray(plan.items), `plan.items must be an array`);
      ensure(AI_SOURCES.includes(plan.source), `plan.source must be model|fallback, got ${JSON.stringify(plan.source)}`);
      ensureIso(plan.generatedAt, 'plan.generatedAt');
      if (plan.summary !== undefined) ensureString(plan.summary, 'plan.summary', { nonEmpty: false });

      const todos = ensureArray(data.todos, 'aiPlan.todos');
      const byId = new Map();
      todos.forEach((todo, index) => {
        validateTodo(todo, `aiPlan.todos[${index}]`);
        byId.set(todo.id, todo);
      });

      for (const [index, item] of plan.items.entries()) {
        ensureObject(item, `plan.items[${index}]`);
        ensureString(item.id, `plan.items[${index}].id`);
        ensureIso(item.planAt, `plan.items[${index}].planAt`);
        if (item.note !== undefined) ensureString(item.note, `plan.items[${index}].note`, { nonEmpty: false });
        const todo = byId.get(item.id);
        ensure(todo, `plan.items[${index}].id ${item.id} missing from returned todos`);
        ensure(todo.planAt !== null && todo.planAt !== undefined, `todo ${item.id}.planAt is null after aiPlan`);
        ensureIsoEcho(todo.planAt, item.planAt, `todos[${item.id}].planAt`);
      }
      return `items=${plan.items.length}, source=${plan.source}, todos=${todos.length}`;
    }],

    ['action ackReminders with [] -> ok:true', async () => {
      const response = await action('ackReminders', { ids: [] });
      const data = expectOkData(response, 'ackReminders');
      ensureNumber(data.acked, 'ackReminders.acked');
      ensure(data.acked === 0, `expected acked 0 for an empty list, got ${data.acked}`);
      return 'acked=0';
    }],

    ['action remove', async () => {
      ensure(state.primaryId, 'no todo id from the earlier add');
      const id = state.primaryId;
      const response = await action('remove', { id });
      const data = expectOkData(response, 'remove');
      ensure(data.removed === id, `expected removed=${id}, got ${JSON.stringify(data.removed)}`);
      createdIds.delete(id);
      state.primaryId = null;

      const envelope = await requestState();
      const todos = ensureArray(envelope?.data?.todos, 'state.data.todos');
      ensure(!todos.some((todo) => todo.id === id), `removed todo ${id} still present in state`);
      return `removed=${id}`;
    }],

    ['action clearCompleted removes done todos', async () => {
      if (initialBoard.done > 0) {
        throw new SkipCheck(`the board already held ${initialBoard.done} finished note(s); clearCompleted is store-wide and would delete user data`);
      }
      const clearMe = await addTodo({ text: 'verify: clear-me item', priority: 2, color: 'pink' });
      state.clearMeId = clearMe.id;
      const toggled = await toggleTodo(clearMe.id, true);
      ensure(toggled.done === true, 'clear-me item was not marked done');

      const response = await action('clearCompleted');
      const data = expectOkData(response, 'clearCompleted');
      ensureNumber(data.removed, 'clearCompleted.removed');
      ensure(data.removed >= 1, `expected removed >= 1, got ${data.removed}`);

      const envelope = await requestState();
      const todos = ensureArray(envelope?.data?.todos, 'state.data.todos');
      ensure(!todos.some((todo) => todo.id === clearMe.id), `done todo ${clearMe.id} survived clearCompleted`);
      createdIds.delete(clearMe.id);
      state.clearMeId = null;
      return `removed=${data.removed}`;
    }],

    /* ------------------------- v1.1.0: AI 分类打标签 ------------------------- */

    ['action add with tags -> canonical tags echoed', async () => {
      await requireV11();
      const response = await action('add', { text: 'verify: tagged item', tags: ['#工作', ' 汇报 ', '工作'] });
      const todo = validateTodo(expectOkData(response, 'add tags'), 'add result');
      createdIds.add(todo.id);
      ensureTags(todo.tags, 'add.tags');
      ensure(todo.tags.length === 2, `expected 2 tags after dedupe, got ${JSON.stringify(todo.tags)}`);
      ensure(todo.tags[0] === '工作' && todo.tags[1] === '汇报', `unexpected tags: ${JSON.stringify(todo.tags)}`);
      state.taggedId = todo.id;
      return `tags=${JSON.stringify(todo.tags)}`;
    }],

    ['action add with a delimited tag string', async () => {
      await requireV11();
      const response = await action('add', { text: 'verify: delimited tags', tags: '生活, 采购；生活' });
      const todo = validateTodo(expectOkData(response, 'add delimited tags'), 'add result');
      createdIds.add(todo.id);
      ensure(todo.tags.length === 2 && todo.tags.includes('生活') && todo.tags.includes('采购'),
        `unexpected tags from delimited input: ${JSON.stringify(todo.tags)}`);
      return JSON.stringify(todo.tags);
    }],

    ['action update with tags -> tags replaced', async () => {
      await requireV11();
      ensure(state.taggedId, 'no tagged todo from the earlier add');
      const response = await action('update', { id: state.taggedId, tags: ['学习'] });
      const todo = validateTodo(expectOkData(response, 'update tags'), 'update result');
      ensure(todo.tags.length === 1 && todo.tags[0] === '学习', `tags not replaced: ${JSON.stringify(todo.tags)}`);
      return JSON.stringify(todo.tags);
    }],

    ['action aiTag -> tagResult shape, tags written onto notes', async () => {
      await requireV11();
      const response = await action('aiTag', {}, AI_TIMEOUT_MS);
      const data = expectOkData(response, 'aiTag');
      const tagResult = ensureObject(data.tagResult, 'aiTag.tagResult');
      ensureString(tagResult.summary, 'tagResult.summary', { nonEmpty: false });
      ensure(AI_SOURCES.includes(tagResult.source), `tagResult.source must be model|fallback, got ${JSON.stringify(tagResult.source)}`);
      ensureIso(tagResult.generatedAt, 'tagResult.generatedAt');
      const items = ensureArray(tagResult.items, 'tagResult.items');
      ensure(items.length > 0, 'tagResult.items is empty although the board has open notes');
      state.aiTagItemIds = items.map((item) => item?.id).filter((id) => typeof id === 'string');

      const todos = ensureArray(data.todos, 'aiTag.todos');
      const byId = new Map();
      todos.forEach((todo, index) => {
        validateTodo(todo, `aiTag.todos[${index}]`);
        byId.set(todo.id, todo);
      });
      for (const [index, item] of items.entries()) {
        ensureObject(item, `tagResult.items[${index}]`);
        ensureString(item.id, `tagResult.items[${index}].id`);
        ensureTags(item.tags, `tagResult.items[${index}].tags`);
        ensure(item.tags.length >= 1, `tagResult.items[${index}].tags must carry at least one tag`);
        const todo = byId.get(item.id);
        ensure(todo, `tagResult.items[${index}].id ${item.id} missing from the returned todos`);
        ensure(JSON.stringify(todo.tags) === JSON.stringify(item.tags),
          `todo ${item.id} tags ${JSON.stringify(todo.tags)} do not match tagResult ${JSON.stringify(item.tags)}`);
      }
      return `items=${items.length}, source=${tagResult.source}`;
    }],

    ['aiTag leaves pre-existing tags untouched (v1.8.0)', async () => {
      await requireV11();
      const envelope = await requestState();
      const todos = ensureArray(envelope?.data?.todos, 'state.data.todos');
      const byId = new Map(todos.map((todo) => [todo.id, todo]));
      const classified = new Set(Array.isArray(state.aiTagItemIds) ? state.aiTagItemIds : []);
      // A Host that still reclassifies tagged notes predates v1.8.0; report SKIP rather than a
      // false failure (the Host half only reloads when DSH restarts).
      if (state.taggedId && classified.has(state.taggedId)) {
        throw new SkipCheck('the running Host predates v1.8.0 (aiTag still reclassifies tagged notes) — restart DSH to load the new host code');
      }
      let protectedCount = 0;
      for (const [id, tags] of initialBoard.tags) {
        if (tags.length === 0) continue; // untagged notes are the ones aiTag is supposed to classify
        const todo = byId.get(id);
        if (!todo) continue;
        ensure(
          JSON.stringify(todo.tags) === JSON.stringify(tags),
          `aiTag changed the tags of the pre-existing tagged note ${id}: ${JSON.stringify(todo.tags)} !== ${JSON.stringify(tags)}`,
        );
        ensure(!classified.has(id), `aiTag must not reclassify the already-tagged note ${id}`);
        protectedCount += 1;
      }
      // The note this suite tagged by hand must keep its tags too.
      if (state.taggedId && byId.has(state.taggedId)) {
        ensure(
          JSON.stringify(byId.get(state.taggedId).tags) === JSON.stringify(['学习']),
          `the suite's tagged note ${state.taggedId} lost its tags: ${JSON.stringify(byId.get(state.taggedId).tags)}`,
        );
        ensure(!classified.has(state.taggedId), `the suite's tagged note ${state.taggedId} must not be reclassified`);
        protectedCount += 1;
      }
      return protectedCount === 0 ? 'no pre-existing tagged notes on the board' : `${protectedCount} already-tagged note(s) untouched`;
    }],

    ['state carries tags after aiTag', async () => {
      await requireV11();
      const envelope = await requestState();
      const todos = ensureArray(envelope?.data?.todos, 'state.data.todos');
      todos.forEach((todo, index) => validateTodo(todo, `state.todos[${index}]`));
      ensure(todos.some((todo) => Array.isArray(todo.tags) && todo.tags.length > 0), 'no note carries tags in /state after aiTag');
      return `${todos.length} todo(s)`;
    }],

    ['pre-existing note tags restored (suite is non-destructive)', async () => {
      await requireV11();
      if (initialBoard.tags.size === 0) return 'no pre-existing notes';
      const envelope = await requestState();
      const todos = ensureArray(envelope?.data?.todos, 'state.data.todos');
      const byId = new Map(todos.map((todo) => [todo.id, todo]));
      let restored = 0;
      for (const [id, tags] of initialBoard.tags) {
        const todo = byId.get(id);
        if (!todo) continue;
        const current = Array.isArray(todo.tags) ? todo.tags : [];
        if (JSON.stringify(current) === JSON.stringify(tags)) continue;
        expectOkData(await action('update', { id, tags }), `restore tags ${id}`);
        restored += 1;
      }
      return restored === 0 ? 'nothing to restore' : `restored ${restored} note(s)`;
    }],

    /* --------------------- v1.2.0: per-note AI advice --------------------- */

    ['action aiNoteAdvice -> question or advice', async () => {
      await requireV11();
      await requireV12();
      ensure(state.taggedId, 'no tagged todo from the earlier add');
      const response = await action('aiNoteAdvice', { id: state.taggedId }, AI_TIMEOUT_MS);
      const data = expectOkData(response, 'aiNoteAdvice');
      ensure(typeof data.round === 'number' && data.round >= 0 && data.round <= 3,
        `aiNoteAdvice.round must be 0..3, got ${JSON.stringify(data.round)}`);
      if (data.kind === 'question') {
        ensureString(data.question, 'aiNoteAdvice.question');
        ensure(data.round === 0, `a question must come with round 0, got ${data.round}`);
        ensure(data.source === 'model', `a question must come from the model, got ${JSON.stringify(data.source)}`);
        // v1.3.0: a question should carry 2-4 short answer options. A Host that predates
        // v1.3.0 answers without them, so absence is reported rather than failed.
        if (data.options !== undefined) {
          ensureOptions(data.options, 'aiNoteAdvice.options', { min: 2, max: 4, maxChars: 24 });
          return `question(round 0, ${data.options.length} options): ${truncate(data.question, 40)}`;
        }
        return `question(round 0, no options — Host predates v1.3.0?): ${truncate(data.question, 40)}`;
      }
      ensure(data.kind === 'advice', `aiNoteAdvice.kind must be advice|question, got ${JSON.stringify(data.kind)}`);
      const advice = ensureObject(data.advice, 'aiNoteAdvice.advice');
      ensureString(advice.text, 'aiNoteAdvice.advice.text', { nonEmpty: false });
      ensure(AI_SOURCES.includes(advice.source), `advice.source must be model|fallback, got ${JSON.stringify(advice.source)}`);
      if (advice.options !== undefined) {
        ensureOptions(advice.options, 'aiNoteAdvice.advice.options', { min: 1, max: 3, maxChars: 120 });
      }
      return `advice(${advice.source}): ${truncate(advice.text, 48)}`;
    }],

    ['action aiNoteAdvice with three rounds -> advice', async () => {
      await requireV11();
      await requireV12();
      ensure(state.taggedId, 'no tagged todo from the earlier add');
      const history = [0, 1, 2].map((index) => ({
        question: `第 ${index + 1} 个问题？`,
        answer: `第 ${index + 1} 个回答`,
      }));
      const response = await action('aiNoteAdvice', { id: state.taggedId, history }, AI_TIMEOUT_MS);
      const data = expectOkData(response, 'aiNoteAdvice round 3');
      ensure(data.kind === 'advice', `round 3 must be advice, got ${JSON.stringify(data.kind)}`);
      ensure(data.round === 3, `round must be 3, got ${JSON.stringify(data.round)}`);
      ensureObject(data.advice, 'aiNoteAdvice round 3 advice');
      ensureString(data.advice.text, 'aiNoteAdvice round 3 advice.text', { nonEmpty: false });
      return `advice(round 3, ${data.advice.source})`;
    }],

    ['action aiNoteAdvice unknown id -> not_found', async () => {
      await requireV11();
      await requireV12();
      const response = await action('aiNoteAdvice', { id: 'td_missing_note' });
      const envelope = requireEnvelope(response, 'aiNoteAdvice unknown id');
      ensure(envelope.ok === false, `expected ok:false, got ${JSON.stringify(envelope.ok)}`);
      ensure(envelope.error?.code === 'not_found', `expected not_found, got ${JSON.stringify(envelope.error?.code)}`);
      return envelope.error.code;
    }],

    ['action aiNoteAdvice bad history -> invalid_input', async () => {
      await requireV11();
      await requireV12();
      ensure(state.taggedId, 'no tagged todo from the earlier add');
      const cases = [
        [{ q: 1 }, { q: 2 }, { q: 3 }, { q: 4 }],
        [{ question: '问题', answer: '' }],
        'not-an-array',
      ];
      for (const history of cases) {
        const response = await action('aiNoteAdvice', { id: state.taggedId, history });
        const envelope = requireEnvelope(response, 'aiNoteAdvice bad history');
        ensure(envelope.ok === false, `expected ok:false, got ${JSON.stringify(envelope.ok)}`);
        ensure(envelope.error?.code === 'invalid_input', `expected invalid_input, got ${JSON.stringify(envelope.error?.code)}`);
      }
      return `${cases.length} case(s) rejected`;
    }],

    /* --------------------------- v1.7.0: memory --------------------------- */

    ['GET /state -> memory block (facts / stats / postpones / threads)', async () => {
      await requireV17();
      const envelope = await requestState();
      const data = ensureObject(envelope.data, 'state.data');
      const memory = ensureObject(data.memory, 'state.memory');
      ensureArray(memory.facts, 'state.memory.facts')
        .forEach((fact, index) => validateFact(fact, `state.memory.facts[${index}]`));
      const stats = ensureObject(memory.stats, 'state.memory.stats');
      for (const key of ['open', 'done', 'overdue', 'averageOpenAgeDays']) {
        ensureNumber(stats[key], `state.memory.stats.${key}`);
      }
      const week = ensureObject(stats.week, 'state.memory.stats.week');
      for (const key of ['completed', 'created', 'postponed', 'removed']) {
        ensureNumber(week[key], `state.memory.stats.week.${key}`);
      }
      const postpones = ensureObject(memory.postpones, 'state.memory.postpones');
      for (const [id, count] of Object.entries(postpones)) {
        ensureString(id, 'state.memory.postpones id');
        ensureNumber(count, `state.memory.postpones[${id}]`);
        ensure(count >= 1, `state.memory.postpones[${id}] must be >= 1, got ${JSON.stringify(count)}`);
      }
      ensureObject(memory.threads, 'state.memory.threads');
      const todos = ensureArray(data.todos, 'state.data.todos');
      for (const todo of todos) {
        for (const leaked of ['memory', 'facts', 'threads', 'postpones']) {
          ensure(!(leaked in todo), `the Todo shape must not gain a "${leaked}" member (memory is a sibling object)`);
        }
      }
      return `facts=${memory.facts.length}, week=${JSON.stringify(week)}`;
    }],

    ['action remember / updateFact / forget round-trip with a clearly-marked temp fact', async () => {
      await requireV17();
      const marker = `verify: temp memory ${Date.now()}`;
      const created = expectOkData(await action('remember', { text: marker }), 'remember temp fact');
      const fact = validateFact(ensureObject(created, 'remember result'), 'remember result');
      createdFactIds.add(fact.id);
      ensure(fact.text === marker, `remember text echo mismatch: ${JSON.stringify(fact.text)}`);

      let envelope = await requestState();
      let facts = ensureArray(envelope?.data?.memory?.facts, 'state.memory.facts');
      ensure(facts.some((entry) => entry.id === fact.id), 'the remembered fact must appear in state.memory.facts');
      ensure(facts[0]?.id === fact.id, 'state.memory.facts must be newest first');

      const duplicate = await action('remember', { text: marker });
      const duplicateEnvelope = requireEnvelope(duplicate, 'remember duplicate');
      ensure(duplicateEnvelope.ok === false, `a duplicate fact must be rejected, got ok=${JSON.stringify(duplicateEnvelope.ok)}`);
      ensure(
        duplicateEnvelope.error?.code === 'invalid_input',
        `a duplicate fact must fail with invalid_input, got ${JSON.stringify(duplicateEnvelope.error?.code)}`,
      );

      const renamed = `${marker} (updated)`;
      const updated = validateFact(expectOkData(await action('updateFact', { id: fact.id, text: renamed }), 'updateFact'), 'updateFact result');
      ensure(updated.id === fact.id && updated.text === renamed, `updateFact echo mismatch: ${JSON.stringify(updated)}`);

      const forgotten = expectOkData(await action('forget', { id: fact.id }), 'forget temp fact');
      createdFactIds.delete(fact.id);
      ensure(forgotten.forgotten === fact.id, `forget must echo the id, got ${JSON.stringify(forgotten.forgotten)}`);
      envelope = await requestState();
      facts = ensureArray(envelope?.data?.memory?.facts, 'state.memory.facts');
      ensure(!facts.some((entry) => entry.id === fact.id), 'the forgotten temp fact must disappear from state');
      return `temp fact ${fact.id} created, updated, forgotten`;
    }],

    ['action review / memoryCandidates return shapes and write nothing', async () => {
      await requireV17();
      const before = await requestState();
      const beforeData = ensureObject(before.data, 'state before review');

      const reviewData = expectOkData(await action('review', {}, AI_TIMEOUT_MS), 'review');
      const review = ensureObject(reviewData.review, 'review.review');
      ensureString(review.headline, 'review.headline', { nonEmpty: false });
      ensure([...review.headline].length <= 100, 'review.headline must be at most 100 characters');
      const range = ensureObject(review.range, 'review.range');
      ensureIso(range.from, 'review.range.from');
      ensureIso(range.to, 'review.range.to');
      ensure(range.days === 7, `review.range.days must be 7, got ${JSON.stringify(range.days)}`);
      const stats = ensureObject(review.stats, 'review.stats');
      for (const key of ['completed', 'created', 'postponed', 'removed', 'open', 'overdue']) {
        ensureNumber(stats[key], `review.stats.${key}`);
      }
      const highlights = ensureArray(review.highlights, 'review.highlights');
      ensure(highlights.length <= 4, `review.highlights must hold at most 4 entries, got ${highlights.length}`);
      highlights.forEach((line, index) => ensureString(line, `review.highlights[${index}]`));
      const tips = ensureArray(review.tips, 'review.tips');
      ensure(tips.length <= 3, `review.tips must hold at most 3 entries, got ${tips.length}`);
      tips.forEach((tip, index) => {
        ensureObject(tip, `review.tips[${index}]`);
        ensureString(tip.text, `review.tips[${index}].text`);
        ensure(ADVICE_KINDS.includes(tip.kind), `review.tips[${index}].kind must be one of ${ADVICE_KINDS.join('|')}, got ${JSON.stringify(tip.kind)}`);
      });
      ensure(AI_SOURCES.includes(review.source), `review.source must be model|fallback, got ${JSON.stringify(review.source)}`);
      ensureIso(review.generatedAt, 'review.generatedAt');

      const candidatesData = expectOkData(await action('memoryCandidates', {}, AI_TIMEOUT_MS), 'memoryCandidates');
      const candidates = ensureArray(candidatesData.candidates, 'memoryCandidates.candidates');
      ensure(candidates.length <= 5, `memoryCandidates.candidates must hold at most 5 entries, got ${candidates.length}`);
      for (const [index, candidate] of candidates.entries()) {
        ensureObject(candidate, `memoryCandidates.candidates[${index}]`);
        ensureString(candidate.text, `memoryCandidates.candidates[${index}].text`);
        ensure([...candidate.text].length <= 60, `memoryCandidates.candidates[${index}].text must be at most 60 characters`);
        ensureString(candidate.reason, `memoryCandidates.candidates[${index}].reason`);
        ensure([...candidate.reason].length <= 80, `memoryCandidates.candidates[${index}].reason must be at most 80 characters`);
      }
      ensure(AI_SOURCES.includes(candidatesData.source), `memoryCandidates.source must be model|fallback, got ${JSON.stringify(candidatesData.source)}`);
      ensureIso(candidatesData.generatedAt, 'memoryCandidates.generatedAt');

      // Both actions are read-only: the board and the stored memory must be untouched.
      const after = await requestState();
      const afterData = ensureObject(after.data, 'state after review');
      ensure(JSON.stringify(afterData.todos) === JSON.stringify(beforeData.todos), 'review/memoryCandidates must not change the notes');
      ensure(JSON.stringify(afterData.memory?.facts) === JSON.stringify(beforeData.memory?.facts), 'review/memoryCandidates must not store facts');
      ensure(
        JSON.stringify(afterData.memory?.threads) === JSON.stringify(beforeData.memory?.threads),
        'review/memoryCandidates must not change advice threads',
      );
      return `review(source=${review.source}), candidates=${candidates.length}`;
    }],

    ['unknown action -> ok:false, unknown_action', async () => {
      const response = await action('definitely_not_a_real_action_xyz');
      const envelope = requireEnvelope(response, 'unknown action');
      ensure(envelope.ok === false, `expected ok:false, got ${JSON.stringify(envelope.ok)}`);
      ensureObject(envelope.error, 'unknown error object');
      ensure(envelope.error.code === 'unknown_action', `expected error.code "unknown_action", got ${JSON.stringify(envelope.error.code)}`);
      ensureString(envelope.error.message, 'unknown error message');
      return envelope.error.code;
    }],

    ['malformed JSON body -> 4xx or ok:false, server stays alive', async () => {
      const response = await request('/action', {
        method: 'POST',
        body: '{ "action": "add", "text": ',
      });
      const non2xx = response.status < 200 || response.status >= 300;
      const envelopeFalse = response.json !== null && response.json?.ok === false;
      ensure(non2xx || envelopeFalse,
        `malformed JSON body was accepted: HTTP ${response.status} ${truncate(response.text)}`);

      // The malformed request must not have taken the route down.
      const health = await request('/state');
      ensure(health.status === 200 && health.json?.ok === true,
        `GET /state unhealthy after malformed body: HTTP ${health.status} ${truncate(health.text)}`);
      return `HTTP ${response.status}, server still healthy`;
    }],
  ];
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

async function main() {
  info('Sticker TODO — HTTP API smoke test');
  info(`Base:  ${BASE}`);
  info(`Route: ${ROUTE}/state, ${ROUTE}/action\n`);

  let mountEnvelope;
  try {
    const response = await request('/state');
    if (response.status !== 200) {
      info(`NOT_MOUNTED: GET ${BASE}${ROUTE}/state returned HTTP ${response.status} (${truncate(response.text)})`);
      process.exit(2);
    }
    if (!response.json || typeof response.json !== 'object') {
      info(`NOT_MOUNTED: GET ${BASE}${ROUTE}/state returned non-JSON HTTP 200 (${truncate(response.text)})`);
      process.exit(2);
    }
    if (response.json.ok !== true) {
      console.error(`[FAIL] GET ${BASE}${ROUTE}/state is mounted but returned an error envelope: ${truncate(response.text)}`);
      process.exit(1);
    }
    mountEnvelope = response.json;
  } catch (error) {
    info(`NOT_MOUNTED: GET ${BASE}${ROUTE}/state failed: ${error.message}`);
    info('The plugin may not be installed/activated yet; re-run after the Lead installs it.');
    process.exit(2);
  }

  const initialTodos = Array.isArray(mountEnvelope?.data?.todos) ? mountEnvelope.data.todos : [];
  initialBoard = {
    total: initialTodos.length,
    done: initialTodos.filter((todo) => todo.done === true).length,
    ids: new Set(initialTodos.map((todo) => todo.id)),
    tags: new Map(
      initialTodos
        .filter((todo) => todo.done !== true)
        .map((todo) => [todo.id, Array.isArray(todo.tags) ? [...todo.tags] : []]),
    ),
  };

  const checks = registerChecks(mountEnvelope);
  for (const [name, fn] of checks) {
    await runCheck(name, fn);
  }

  await cleanup();

  const total = results.pass + results.fail + cleanupFailed;
  info(`\n${'='.repeat(56)}`);
  console.log(`OK ${results.pass}/${total}`);
  if (results.skip > 0) {
    console.log(`skipped: ${results.skip} check(s)`);
  }
  if (cleanupFailed > 0) {
    console.log(`cleanup failures: ${cleanupFailed}`);
  }
  if (results.fail > 0 || cleanupFailed > 0) {
    console.log(`RESULT: FAIL (${results.fail} check(s) failed, ${cleanupFailed} cleanup failure(s))`);
    process.exitCode = 1;
  } else {
    console.log('RESULT: PASS');
    process.exitCode = 0;
  }
}

main().catch(async (error) => {
  console.error(`[FAIL] unexpected error: ${error?.stack || error}`);
  try { await cleanup(); } catch { /* best effort */ }
  process.exitCode = 1;
});
