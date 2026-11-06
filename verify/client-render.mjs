#!/usr/bin/env node
/**
 * verify/client-render.mjs — offline render smoke tests for the client half.
 *
 * Loads `client.js` with a `window.__ModuleLoader__` shim and a tiny hook-ordered
 * React shim (no DOM, no network, no Harness packages), then renders the real
 * `StickerTodoPanel` component against seeded state snapshots and asserts the
 * v1.2.0 panel UX plus the v1.3.0 polish:
 *
 *   - tag board grouping by first tag + 未分类 section and the 分组/平铺 toggle
 *   - the 全部 / per-tag filter (kept working on top of grouping)
 *   - the create/edit modal (title + dominant details textarea, quick due chips,
 *     visual-only priority, colour palette, tags, save wiring)
 *   - the four persisted note-text font presets and their CSS stacks
 *   - the per-note AI advice dialog: question rounds with option chips (pick-or-type),
 *     advice with option chips that fill the editable text, append-to-details,
 *     old-Host restart hint
 *   - v1.3.0 polish: no global advice button / no `aiAdvice` call, entrance + dialog
 *     motion and the reduced-motion opt-out
 *   - v1.4.0 bilingual panel: 自动 / 中文 / English switch, forced dictionaries + Intl
 *     locales, persistence/restore and storage-failure fallback
 *   - v1.5.0 dual view: 便利贴 board (default) / 极简 title-only list with click-to-expand
 *     details, persisted view choice, one expanded row
 *   - v1.7.0 memory: header 记忆/Memory dialog (facts list, weekly review with six stat
 *     chips, AI candidate proposals), the 改期 N 次 badge at >= 2 postponements, and the
 *     per-note advice dialog resuming a persisted `memory.threads` conversation
 *   - v1.8.0 handoff: the 「交给 DSH」/「Ask DSH」 button in both views (open and done notes),
 *     the zh/en prompt built from the note, delivery through the optional `uiWorkspace`
 *     `startSession(undefined, { prompt, whenDraftExists: 'append' })` (draft only, never
 *     sent, zero Host calls) and its clipboard / failure fallbacks
 *   - legacy Host rows without `tags` / without `data.memory` and old-Host `unknown_action`
 *     handling
 *
 * Usage: node verify/client-render.mjs
 * Node built-ins only; writes no files and performs no network access.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = join(SCRIPT_DIR, '..', 'client.js');

/* ------------------------------------------------------------------ *
 * Mini React: a real hook-order queue, no rendering to the DOM.
 * ------------------------------------------------------------------ */

let hooks = [];
let hookIndex = 0;

function resetHooks(seed = []) {
  hooks = new Array(seed.length);
  for (let index = 0; index < seed.length; index += 1) {
    if (index in seed) hooks[index] = seed[index];
  }
  hookIndex = 0;
}

const React = {
  Fragment: 'Fragment',
  createElement(type, props, ...children) {
    const next = { ...(props || {}) };
    if (children.length > 0) next.children = children.length === 1 ? children[0] : children;
    return { type, props: next };
  },
  useState(initial) {
    const index = hookIndex;
    hookIndex += 1;
    if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
    return [hooks[index], (next) => {
      hooks[index] = typeof next === 'function' ? next(hooks[index]) : next;
    }];
  },
  useMemo(run) {
    return run();
  },
  useCallback(fn) {
    return fn;
  },
  useRef(initial) {
    const index = hookIndex;
    hookIndex += 1;
    if (!(index in hooks)) hooks[index] = { current: initial };
    return hooks[index];
  },
  useEffect() {
    /* effects are not needed by these render assertions */
  },
};

/* ------------------------------------------------------------------ *
 * Browser shims: module loader, localStorage, document, fetch.
 * ------------------------------------------------------------------ */

const storage = {
  font: null, lang: null, view: null,
  failGet: false, failSet: false,
  setCalls: [], langSetCalls: [], viewSetCalls: [],
};
const localStorageShim = {
  getItem(key) {
    if (storage.failGet) throw new Error('storage unavailable');
    if (key === 'sticker-todo:font') return storage.font;
    if (key === 'sticker-todo:lang') return storage.lang;
    if (key === 'sticker-todo:view') return storage.view;
    return null;
  },
  setItem(key, value) {
    if (storage.failSet) throw new Error('storage unavailable');
    if (key === 'sticker-todo:font') {
      storage.font = value;
      storage.setCalls.push(value);
    } else if (key === 'sticker-todo:lang') {
      storage.lang = value;
      storage.langSetCalls.push(value);
    } else if (key === 'sticker-todo:view') {
      storage.view = value;
      storage.viewSetCalls.push(value);
    }
  },
};

let factory = null;
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      factory = spec.factory;
    },
  },
  localStorage: localStorageShim,
  addEventListener() {},
  removeEventListener() {},
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
};
globalThis.document = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };

let fetchCalls = [];
function stubFetch(payload) {
  fetchCalls = [];
  const queue = Array.isArray(payload) ? [...payload] : null;
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
    const next = queue === null ? payload : (queue.length > 1 ? queue.shift() : queue[0]);
    return { status: 200, json: async () => next };
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 25));
// Dialog close runs a ~150 ms exit animation before the state clears.
const flushClose = () => new Promise((resolve) => setTimeout(resolve, 220));

/* ------------------------------------------------------------------ *
 * Optional client services (v1.8.0 handoff) and clipboard shims.
 * The service map is opt-in: every pre-existing check runs with no
 * `uiWorkspace` and therefore keeps the old behaviour byte for byte.
 * ------------------------------------------------------------------ */

/** Services returned by the fake context's `get(name)` (e.g. `uiWorkspace`). */
const clientServices = {};
let hostContext = null;

/** Install (or clear) a fake `uiWorkspace` service for the next check. */
function stubUiWorkspace(service) {
  if (service === undefined) delete clientServices.uiWorkspace;
  else clientServices.uiWorkspace = service;
}

/** Remove both lookup forms of the service between checks. */
function resetUiWorkspace() {
  delete clientServices.uiWorkspace;
  if (hostContext) delete hostContext.uiWorkspace;
}

const savedNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

/** Install a fake `navigator` (`{ clipboard: ... }`); pass undefined for "no navigator". */
function stubNavigator(value) {
  Object.defineProperty(globalThis, 'navigator', {
    value, configurable: true, enumerable: true, writable: true,
  });
}

/** Restore the runtime's real navigator after a clipboard check. */
function restoreNavigator() {
  if (savedNavigatorDescriptor) Object.defineProperty(globalThis, 'navigator', savedNavigatorDescriptor);
  else delete globalThis.navigator;
}

/* ------------------------------------------------------------------ *
 * Load the client module and register it with a fake Host context.
 * ------------------------------------------------------------------ */

let source;
try {
  source = readFileSync(CLIENT_PATH, 'utf8');
} catch (error) {
  console.error(`[FAIL] could not read client.js: ${error.message}`);
  process.exit(1);
}

// eslint-disable-next-line no-new-func
new Function(source)();
if (typeof factory !== 'function') {
  console.error('[FAIL] client.js did not call window.__ModuleLoader__.load');
  process.exit(1);
}

const plugin = factory((name) => {
  if (name === 'react') return React;
  throw new Error(`unexpected require(${JSON.stringify(name)})`);
});

const components = {};
const dictionaries = {};
hostContext = {
  get(name) {
    return Object.prototype.hasOwnProperty.call(clientServices, name) ? clientServices[name] : undefined;
  },
  effect(fn, label) {
    if (label === 'sticker-todo: dictionaries') fn();
  },
  locale: {
    register(namespace, dictionary) {
      dictionaries[namespace] = dictionary;
    },
    bind() {
      return (key) => key;
    },
  },
  layout: { selectPanel() {} },
  slots: {
    inject(scope, register) {
      if (typeof register === 'function') register();
    },
    register(options, component) {
      components[options.name] = component;
      return { dispose() {} };
    },
  },
};
plugin.apply(hostContext);

const Panel = components.main;
if (typeof Panel !== 'function') {
  console.error('[FAIL] client.js did not register the "main" panel');
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * Rendering helpers.
 * ------------------------------------------------------------------ */

const STATE = {
  snapshot: 0,
  loading: 1,
  error: 2,
  busy: 3,
  aiBusy: 4,
  aiView: 5,
  aiError: 6,
  editor: 7,
  font: 8,
  fontMenuOpen: 9,
  grouped: 10,
  tagFilter: 11,
  adviceDialog: 12,
  armedId: 13,
  focusedId: 14,
  toast: 15,
  permission: 16,
  lang: 17,
  langMenuOpen: 18,
  view: 19,
  viewMenuOpen: 20,
  expandedId: 21,
  // v1.7.0 memory dialog state (hook order: client.js declares these after expandedId)
  memoryOpen: 22,
  memoryClosing: 23,
  factsDraft: 24,
  factsEditingId: 25,
  factsEditDraft: 26,
  memoryError: 27,
  memoryBusy: 28,
  memoryReview: 29,
  memoryCandidates: 30,
  memoryArmClear: 31,
};

const BASE_DRAFT = { text: '', note: '', dueAt: '', remindAt: '', color: 'yellow', priority: 2, tags: '' };

function seed(overrides) {
  const seedArray = new Array(Object.keys(STATE).length);
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in STATE)) throw new Error(`unknown seeded state ${key}`);
    seedArray[STATE[key]] = value;
  }
  return seedArray;
}

const panelProps = {
  t: (key, params) => (params === undefined ? key : `${key}${JSON.stringify(params)}`),
  acknowledge: async () => {},
  useLocale: (select) => select({ active: 'en' }),
  useReminders: (select) => select([]),
};

/** Render the panel into a normalized native tree (components expanded). */
function renderTree(extraProps = {}) {
  hookIndex = 0;
  return normalize(Panel({ ...panelProps, ...extraProps }));
}

function normalize(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (Array.isArray(value)) return value.map(normalize).filter((item) => item !== null);
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value.type === 'function') return normalize(value.type(value.props || {}));
  return {
    type: value.type,
    props: { ...(value.props || {}) },
    children: normalize(value.props ? value.props.children : undefined),
  };
}

function flatten(tree, out = []) {
  if (tree === null) return out;
  if (Array.isArray(tree)) {
    for (const item of tree) flatten(item, out);
    return out;
  }
  if (typeof tree === 'string') return out;
  out.push(tree);
  flatten(tree.children, out);
  return out;
}

function textsOf(tree, out = []) {
  if (tree === null) return out;
  if (Array.isArray(tree)) {
    for (const item of tree) textsOf(item, out);
    return out;
  }
  if (typeof tree === 'string') {
    out.push(tree);
    return out;
  }
  textsOf(tree.children, out);
  return out;
}

const classNameOf = (node) => (node && typeof node.props.className === 'string' ? node.props.className : '');
const hasClass = (node, cls) => classNameOf(node).split(' ').includes(cls);
const nodesWithClass = (tree, cls) => flatten(tree).filter((node) => hasClass(node, cls));
const dataIds = (tree) => flatten(tree)
  .map((node) => node.props['data-id'])
  .filter((id) => typeof id === 'string');
const findText = (tree, value) => textsOf(tree).includes(value);
const buttonsWithText = (tree, value) => flatten(tree)
  .filter((node) => node.type === 'button' && textsOf(node.children).includes(value));
const buttonByLabel = (tree, label) => flatten(tree).find((node) => node.type === 'button'
  && (node.props['aria-label'] === label || node.props.title === label || textsOf(node.children).includes(label)));

function sectionSummary(tree) {
  const board = nodesWithClass(tree, 'stk-board')[0];
  if (!board) return [];
  return flatten(board.children)
    .filter((node) => hasClass(node, 'stk-board-group'))
    .map((section) => {
      const tagNode = flatten(section).find((node) => hasClass(node, 'stk-group-tag'));
      const countNode = flatten(section).find((node) => hasClass(node, 'stk-group-count'));
      return {
        tag: tagNode ? textsOf(tagNode.children).join('') : '',
        count: countNode ? textsOf(countNode.children).join('') : '',
        ids: dataIds(section),
        untagged: hasClass(section, 'stk-group-untagged'),
      };
    });
}

/* ------------------------------------------------------------------ *
 * Fixtures.
 * ------------------------------------------------------------------ */

const NOW = '2026-11-05T14:00:00.000Z';

function makeTodo(overrides = {}) {
  return {
    id: 'td_1',
    text: '写周报',
    note: '第一段先写背景',
    done: false,
    createdAt: NOW,
    updatedAt: NOW,
    dueAt: null,
    remindAt: null,
    remindFiredAt: null,
    priority: 2,
    color: 'yellow',
    tags: [],
    planAt: null,
    planNote: '',
    ...overrides,
  };
}

const TAGGED_TODOS = [
  makeTodo({ id: 'td_1', text: '写周报', note: '第一段先写背景', priority: 1, tags: ['工作', '周报'], dueAt: '2026-11-06T10:00:00.000Z' }),
  makeTodo({ id: 'td_2', text: '买牛奶', color: 'blue', priority: 3, tags: ['生活'] }),
  makeTodo({ id: 'td_3', text: '散步', color: 'green', tags: [] }),
];
const TAGGED_SNAPSHOT = { now: NOW, todos: TAGGED_TODOS, dueReminders: [], ai: { available: true, reason: null } };
const LEGACY_TODOS = TAGGED_TODOS.map(({ tags, ...rest }) => rest);
const LEGACY_SNAPSHOT = { now: NOW, todos: LEGACY_TODOS, dueReminders: [], ai: { available: true, reason: null } };

/* ---------------- v1.7.0 memory fixture ---------------- */

const MEMORY_THREAD = {
  rounds: [{ round: 1, question: '这一步卡在哪？', answer: '缺资料', at: '2026-11-04T09:00:00.000Z' }],
  advice: { text: '先花 20 分钟写出开头两段', source: 'model', at: '2026-11-04T09:05:00.000Z' },
  updatedAt: '2026-11-04T09:05:00.000Z',
};

const MEMORY_BLOCK = (overrides = {}) => ({
  facts: [
    { id: 'm_ab12cd34', text: '周报固定在周五下午发', source: 'user', createdAt: NOW, updatedAt: NOW },
    { id: 'm_ef56gh78', text: '每天先做最重要的一件', source: 'user', createdAt: NOW, updatedAt: NOW },
  ],
  stats: { open: 3, done: 2, overdue: 1, averageOpenAgeDays: 1.5, week: { completed: 4, created: 5, postponed: 2, removed: 1 } },
  postpones: { td_1: 3, td_2: 1 },
  threads: { td_1: MEMORY_THREAD },
  ...overrides,
});

const MEMORY_SNAPSHOT = {
  now: NOW,
  todos: TAGGED_TODOS,
  dueReminders: [],
  ai: { available: true, reason: null },
  memory: MEMORY_BLOCK(),
};

const REVIEW_FIXTURE = {
  headline: '这周做完 4 件，改期 2 次',
  range: { from: '2026-10-30T00:00:00.000Z', to: NOW, days: 7 },
  stats: { completed: 4, created: 5, postponed: 2, removed: 1, open: 3, overdue: 1 },
  highlights: ['「写周报」这周改期 2 次，建议拆成两步'],
  tips: [{ text: '把改期最多的一件砍成 3 个小步', kind: 'breakdown' }],
  generatedAt: NOW,
  source: 'fallback',
};

const CANDIDATE_FIXTURE = [
  { text: '「周报」相关的事比较多', reason: '3 张未完成便签都带着「周报」标签' },
  { text: '「写周报」这件事容易一拖再拖', reason: '最近有 3 次把它的截止时间往后推' },
];

const zhDict = () => dictionaries.stickerTodo.zh;
const enDict = () => dictionaries.stickerTodo.en;


/** Independent implementation of the contract's quick-due rule, used to check the UI value. */
function expectedQuickDue(kind) {
  const date = new Date();
  date.setHours(23, 59, 0, 0);
  if (kind === 'tomorrow') date.setDate(date.getDate() + 1);
  if (kind === 'dayAfter') date.setDate(date.getDate() + 2);
  if (kind === 'nextWeek') {
    let delta = (1 - date.getDay() + 7) % 7;
    if (delta === 0) delta = 7;
    date.setDate(date.getDate() + delta);
  }
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function localInputToTime(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function localInputFromIso(iso) {
  const date = new Date(iso);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/* ------------------------------------------------------------------ *
 * Checks.
 * ------------------------------------------------------------------ */

const results = [];

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`[PASS] ${name}`);
  } catch (error) {
    results.push({ name, ok: false, detail: error.message });
    console.log(`[FAIL] ${name} — ${error.message}`);
    if (process.env.STICKER_RENDER_DEBUG && error.stack) console.log(error.stack);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

function assertIncludes(haystack, needle, message) {
  assert(haystack.includes(needle), message || `expected to include ${JSON.stringify(needle)}; got ${JSON.stringify(haystack)}`);
}

async function main() {
  console.log('Sticker TODO — client render smoke tests');
  console.log(`client: ${CLIENT_PATH}`);

  /* ---------------- dictionaries ---------------- */
  await check('i18n: zh/en dictionaries share one key set and include the v1.5.0 strings', () => {
    const dictionary = dictionaries.stickerTodo;
    assert(dictionary && dictionary.zh && dictionary.en, 'stickerTodo dictionaries were not registered');
    const zhKeys = Object.keys(dictionary.zh).sort();
    const enKeys = Object.keys(dictionary.en).sort();
    assert(JSON.stringify(zhKeys) === JSON.stringify(enKeys), 'zh and en key sets differ');
    for (const key of [
      'action.create', 'action.font', 'group.grouped', 'group.flat', 'group.untagged',
      'dialog.createTitle', 'dialog.editTitle', 'dialog.titleLabel', 'dialog.detailsLabel',
      'dialog.dueLabel', 'dialog.remindLabel', 'dialog.tagsPlaceholder', 'dialog.setRemind',
      'dialog.quick.today', 'dialog.quick.tomorrow', 'dialog.quick.dayAfter', 'dialog.quick.nextWeek',
      'font.title', 'font.default', 'font.hand', 'font.xingkai', 'font.ui',
      'note.advice', 'advice.title', 'advice.questionTag', 'advice.optionsLabel',
      'advice.alternativesLabel', 'advice.answerLabel', 'advice.submit',
      'advice.round', 'advice.resultLabel', 'advice.append', 'advice.close', 'advice.hint',
      'lang.title', 'lang.auto', 'lang.autoFollow', 'lang.hint', 'lang.zh', 'lang.en',
      'view.label', 'view.notes', 'view.list', 'view.hint',
      'list.expand', 'list.collapse', 'list.details',
      'ai.needRestart',
      'memory.button', 'memory.title', 'memory.factsTitle', 'memory.reviewTitle',
      'memory.candidatesTitle', 'memory.clear', 'memory.postponeTimes', 'memory.continueThread',
      'memory.stats.completed', 'memory.stats.created', 'memory.stats.postponed',
      'memory.stats.removed', 'memory.stats.open', 'memory.stats.overdue',
      'note.handoff', 'note.handoffHint', 'note.handoffDraft', 'note.handoffCopied', 'note.handoffFailed',
    ]) {
      assert(typeof dictionary.zh[key] === 'string' && dictionary.zh[key] !== '', `zh missing ${key}`);
      assert(typeof dictionary.en[key] === 'string' && dictionary.en[key] !== '', `en missing ${key}`);
    }
    // v1.3.0 removes the client-side global advice surface; its strings must be gone.
    for (const key of ['ai.advice', 'ai.loadingAdvice', 'ai.priorityOrder', 'ai.kind.focus', 'ai.kind.breakdown', 'ai.kind.deadline', 'ai.kind.rest', 'ai.kind.scope']) {
      assert(!(key in dictionary.zh), `removed i18n key still present: ${key}`);
    }
  });

  /* ---------------- stylesheet + motion ---------------- */
  await check('style: one rendered stylesheet with fonts, modal chrome and motion tokens', () => {
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false }));
    const tree = renderTree();
    const styleNodes = flatten(tree).filter((node) => node.type === 'style');
    assert(styleNodes.length === 1, `expected exactly one <style>, got ${styleNodes.length}`);
    const css = textsOf(styleNodes[0].children).join('');
    for (const needle of [
      "@font-face{font-family:'STK Hand CJK'", "@font-face{font-family:'STK Xingkai'",
      '.stk-modal-layer{position:fixed', '.stk-modal{', '.stk-field-textarea',
      '.stk-note-priority{', '.stk-board-group', 'font-family:var(--stk-note-font',
      '--stk-note-font:', '.stk-chip--option', '.stk-lang-menu', '.stk-view-menu',
      '.stk-list-item{', '.stk-list-row{', '.stk-list-details{', '.stk-list-due{',
      '.stk-modal--memory', '.stk-memory-section', '.stk-memory-stat', '.stk-chip--postpone',
      '.stk-note-action--handoff',
    ]) {
      assertIncludes(css, needle, `stylesheet missing ${needle}`);
    }
  });

  await check('motion: entrance/dialog/toast animations and reduced-motion opt-out exist', () => {
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false }));
    const css = textsOf(flatten(renderTree()).filter((node) => node.type === 'style')[0].children).join('');
    for (const needle of [
      '@keyframes stk-note-in', '@keyframes stk-rise', '@keyframes stk-dialog-in',
      '@keyframes stk-dialog-out', '@keyframes stk-layer-out', '@keyframes stk-toast-in',
      '@keyframes stk-shimmer', '@keyframes stk-expand', 'animation-delay:var(--stk-delay',
      '.stk-modal--closing', '.stk-modal-layer--closing',
      'animation:stk-dialog-in', 'animation:stk-note-in',
    ]) {
      assertIncludes(css, needle, `motion CSS missing ${needle}`);
    }
    const reduced = /@media \(prefers-reduced-motion:reduce\)\{([\s\S]*?)\n\}/.exec(css);
    assert(reduced, 'missing @media (prefers-reduced-motion: reduce) block');
    for (const selector of ['.stk-note', '.stk-board-group', '.stk-list-item', '.stk-list-details', '.stk-modal', '.stk-modal-layer', '.stk-toast', '.stk-spinner']) {
      assertIncludes(reduced[1], selector, `reduced-motion block does not disable ${selector}`);
    }
    assertIncludes(reduced[1], 'animation:none!important', 'reduced motion must disable animations');
    assertIncludes(reduced[1], 'transition:none!important', 'reduced motion must disable transitions');
  });

  /* ---------------- grouping ---------------- */
  await check('board: grouped by first tag with a final 未分类 section and counts', () => {
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false }));
    const tree = renderTree();
    const sections = sectionSummary(tree);
    assert(sections.length === 3, `expected 工作/生活/未分类 sections, got ${JSON.stringify(sections.map((section) => section.tag))}`);
    const byTag = new Map(sections.map((section) => [section.tag, section]));
    assert(byTag.has('#工作') && byTag.get('#工作').ids.join() === 'td_1', 'td_1 should sit under #工作');
    assert(byTag.has('#生活') && byTag.get('#生活').ids.join() === 'td_2', 'td_2 should sit under #生活');
    assert(byTag.has('group.untagged') && byTag.get('group.untagged').ids.join() === 'td_3', 'untagged note should sit in 未分类');
    for (const section of byTag.values()) assert(section.count === String(section.ids.length), `count mismatch for ${section.tag}`);
    assert(hasClass(nodesWithClass(tree, 'stk-board')[0], 'stk-board'), 'board rendered');
    const grouped = buttonByLabel(tree, 'group.grouped');
    const flat = buttonByLabel(tree, 'group.flat');
    assert(grouped && grouped.props['aria-pressed'] === true, '分组 toggle should be pressed by default');
    assert(flat && flat.props['aria-pressed'] === false, '平铺 toggle should be unpressed by default');
    assert(!hasClass(nodesWithClass(tree, 'stk-note')[0], 'stk-note--add'), 'inline add card must be gone');
  });

  await check('board: 平铺 toggle switches the board back to a flat grid', () => {
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false, grouped: false }));
    const tree = renderTree();
    assert(sectionSummary(tree).length === 0, 'flat board must not render tag sections');
    const grids = nodesWithClass(tree, 'stk-board-grid');
    assert(grids.length === 1, `expected one flat grid, got ${grids.length}`);
    assert(dataIds(grids[0]).join() === 'td_1,td_2,td_3', 'flat grid keeps the existing card order');
    const flat = buttonByLabel(tree, 'group.flat');
    assert(flat && flat.props['aria-pressed'] === true, '平铺 should be pressed');
  });

  await check('board: clicking 平铺 flips the grouped state', () => {
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false }));
    const tree = renderTree();
    buttonByLabel(tree, 'group.flat').props.onClick();
    assert(hooks[STATE.grouped] === false, 'grouped state should become false');
  });

  /* ---------------- filter ---------------- */
  await check('filter: a tag chip narrows the board client-side (on top of grouping)', () => {
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false, tagFilter: '工作' }));
    const tree = renderTree();
    assert(dataIds(tree).join() === 'td_1', `filtered board should only show td_1, got ${dataIds(tree)}`);
    const filterChips = nodesWithClass(tree, 'stk-chip--filter');
    assert(filterChips.some((chip) => chip.props['aria-pressed'] === true && textsOf(chip.children).join('').includes('#工作')), 'the #工作 filter chip should be pressed');
    const sections = sectionSummary(tree);
    assert(sections.length === 1 && sections[0].tag === '#工作' && sections[0].ids.join() === 'td_1', 'grouped filter should keep td_1 under #工作');
  });

  await check('filter: empty filtered result renders an explanation instead of a blank board', () => {
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false, tagFilter: '工作' }));
    // simulate the notes changing between renders: the filter tag is gone from the board
    hooks[STATE.snapshot] = { ...TAGGED_SNAPSHOT, todos: [makeTodo({ id: 'td_9', text: '别的', tags: ['生活'] })] };
    const tree = renderTree();
    const empty = nodesWithClass(tree, 'stk-empty--filter');
    assert(empty.length === 1, 'expected the empty-filter explanation');
    assert(findText(empty[0], 'filter.empty{"tag":"工作"') || textsOf(empty[0].children).some((text) => text.startsWith('filter.empty')), 'empty-filter text missing');
    assert(findText(empty[0], 'filter.clear'), 'empty-filter clear button missing');
  });

  /* ---------------- create dialog ---------------- */
  await check('dialog: header 新建便签 button opens the create modal', () => {
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false }));
    let tree = renderTree();
    assert(nodesWithClass(tree, 'stk-modal').length === 0, 'no modal before clicking');
    buttonByLabel(tree, 'action.create').props.onClick();
    assert(hooks[STATE.editor] && hooks[STATE.editor].mode === 'create', 'editor state should open in create mode');
    tree = renderTree();
    const modal = nodesWithClass(tree, 'stk-modal')[0];
    assert(modal && modal.props.role === 'dialog' && modal.props['aria-modal'] === 'true', 'dialog node missing');
    const inputs = flatten(tree).filter((node) => node.type === 'input');
    const titleInput = inputs.find((node) => node.props.id === 'stk-dialog-title');
    assert(titleInput && titleInput.props.autoFocus === true, '标题 input should autofocus');
    const details = flatten(tree).find((node) => node.type === 'textarea' && node.props.id === 'stk-dialog-details');
    assert(details && details.props.rows >= 6, '详情 textarea should have at least 6 rows');
    assert(hasClass(nodesWithClass(tree, 'stk-dialog-details')[0], 'stk-dialog-details'), 'details field wrapper missing');
    const quickLabels = ['dialog.quick.today', 'dialog.quick.tomorrow', 'dialog.quick.dayAfter', 'dialog.quick.nextWeek'];
    for (const label of quickLabels) assert(buttonByLabel(tree, label), `quick due chip ${label} missing`);
    const save = flatten(tree).find((node) => node.type === 'button' && node.props.type === 'submit');
    assert(save && save.props.disabled === true, '保存 should stay disabled while the title is empty');
  });

  await check('dialog: quick due chips compute 23:59 local values (下周 = next Monday)', () => {
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false, editor: { mode: 'create', id: null, draft: { ...BASE_DRAFT } } }));
    let tree = renderTree();
    const clickQuick = (label) => {
      buttonByLabel(tree, label).props.onClick();
      const draft = hooks[STATE.editor].draft;
      tree = renderTree();
      return draft.dueAt;
    };
    assert(clickQuick('dialog.quick.today') === expectedQuickDue('today'), '今天 should be today 23:59');
    assert(clickQuick('dialog.quick.tomorrow') === expectedQuickDue('tomorrow'), '明天 should be tomorrow 23:59');
    assert(clickQuick('dialog.quick.dayAfter') === expectedQuickDue('dayAfter'), '后天 should be the day after tomorrow 23:59');
    assert(clickQuick('dialog.quick.nextWeek') === expectedQuickDue('nextWeek'), '下周 should be next Monday 23:59');
    assert(hooks[STATE.editor].draft.dueAt.endsWith('T23:59'), 'quick due must land on 23:59 local');
    const clear = buttonByLabel(tree, 'dialog.clear');
    assert(clear, 'a clear action should appear once a due date is chosen');
    clear.props.onClick();
    assert(hooks[STATE.editor].draft.dueAt === '', 'clear should empty dueAt');
  });

  await check('dialog: saving posts title/details/colour/priority/tags/quick due', async () => {
    stubFetch({
      ok: true,
      data: makeTodo({ id: 'td_new', text: '新便签', note: '详情内容', color: 'pink', priority: 1, tags: ['工作', '学习'] }),
    });
    resetHooks(seed({
      snapshot: TAGGED_SNAPSHOT,
      loading: false,
      editor: {
        mode: 'create',
        id: null,
        draft: { text: '新便签', note: '详情内容', dueAt: expectedQuickDue('today'), remindAt: '', color: 'pink', priority: 1, tags: '工作, #学习 工作 额外' },
      },
    }));
    const tree = renderTree();
    const form = flatten(tree).find((node) => node.type === 'form');
    assert(form, 'editor form missing');
    form.props.onSubmit({ preventDefault() {} });
    await flush();
    const posted = fetchCalls[fetchCalls.length - 1].body;
    assert(posted.action === 'add', `expected add, got ${posted.action}`);
    assert(posted.text === '新便签' && posted.note === '详情内容', 'title/details mismatch');
    assert(posted.color === 'pink' && posted.priority === 1, 'colour/priority mismatch');
    assert(JSON.stringify(posted.tags) === JSON.stringify(['工作', '学习', '额外']), `tags parsing mismatch: ${JSON.stringify(posted.tags)}`);
    assert(posted.dueAt && new Date(posted.dueAt).getHours() === 23 && new Date(posted.dueAt).getMinutes() === 59, 'quick due not posted');
    assert(hooks[STATE.editor] !== null && hooks[STATE.editor].closing === true, 'dialog should animate out after saving');
    await flushClose();
    assert(hooks[STATE.editor] === null, 'dialog should close after saving');
    assert(dataIds(renderTree()).includes('td_new'), 'created note should be added to the board');
  });

  await check('dialog: a reminder can be set with one button and cleared', () => {
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false, editor: { mode: 'create', id: null, draft: { ...BASE_DRAFT } } }));
    let tree = renderTree();
    buttonByLabel(tree, 'dialog.setRemind').props.onClick();
    const remindAt = hooks[STATE.editor].draft.remindAt;
    assert(typeof remindAt === 'string' && remindAt.length > 0, '设置提醒 should fill remindAt');
    assert(localInputToTime(remindAt) > Date.now(), 'the quick reminder should be in the future');
    tree = renderTree();
    buttonByLabel(tree, 'dialog.clear').props.onClick();
    assert(hooks[STATE.editor].draft.remindAt === '', '清除 should empty remindAt');
  });

  await check('dialog: editing a card opens the same modal pre-filled', () => {
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false }));
    const tree = renderTree();
    const editButton = buttonByLabel(tree, 'note.edit');
    assert(editButton, 'card edit button missing');
    editButton.props.onClick();
    const editor = hooks[STATE.editor];
    assert(editor && editor.mode === 'edit' && editor.id === 'td_1', 'editor should open in edit mode for td_1');
    assert(editor.draft.text === '写周报', 'title prefill mismatch');
    assert(editor.draft.note === '第一段先写背景', 'details prefill mismatch');
    assert(editor.draft.tags === '工作 周报', `tags prefill mismatch: ${editor.draft.tags}`);
    assert(editor.draft.priority === 1 && editor.draft.color === 'yellow', 'priority/colour prefill mismatch');
    assert(editor.draft.dueAt === localInputFromIso('2026-11-06T10:00:00.000Z'), `due prefill mismatch: ${editor.draft.dueAt}`);
    const rendered = renderTree();
    const titleInput = flatten(rendered).find((node) => node.type === 'input' && node.props.id === 'stk-dialog-title');
    assert(titleInput.props.value === '写周报', 'title input should be pre-filled');
    assert(findText(rendered, 'dialog.editTitle'), 'edit dialog title missing');
  });

  await check('dialog: backdrop click cancels with the exit animation', async () => {
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false, editor: { mode: 'create', id: null, draft: { ...BASE_DRAFT } } }));
    let tree = renderTree();
    const layer = nodesWithClass(tree, 'stk-modal-layer')[0];
    const event = { target: layer, currentTarget: layer };
    layer.props.onMouseDown(event);
    assert(hooks[STATE.editor] !== null && hooks[STATE.editor].closing === true, 'backdrop click should start the closing animation');
    tree = renderTree();
    assert(nodesWithClass(tree, 'stk-modal-layer--closing').length === 1, 'closing layer class missing');
    assert(nodesWithClass(tree, 'stk-modal--closing').length === 1, 'closing modal class missing');
    await flushClose();
    assert(hooks[STATE.editor] === null, 'backdrop click should close the dialog');
  });

  /* ---------------- fonts ---------------- */
  await check('fonts: four presets apply the expected note stacks via --stk-note-font', () => {
    const expectations = {
      default: ['STK Hand CJK', 'var(--dsw-font-family'],
      hand: ['STK Hand CJK', "'KaiTi'"],
      xingkai: ['STK Xingkai', '行楷'],
      ui: ['var(--dsw-font-family'],
    };
    for (const [preset, needles] of Object.entries(expectations)) {
      resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false, font: preset }));
      const tree = renderTree();
      const root = nodesWithClass(tree, 'stk-root')[0];
      assert(root, `root missing for font ${preset}`);
      const stack = root.props.style['--stk-note-font'];
      assert(typeof stack === 'string' && stack.length > 0, `${preset}: no --stk-note-font custom property`);
      for (const needle of needles) assertIncludes(stack, needle, `${preset}: stack missing ${needle}`);
      if (preset === 'default' || preset === 'hand' || preset === 'xingkai') {
        assert(!stack.startsWith('var(--dsw-font-family'), `${preset}: handwriting should not start with the UI font`);
      }
      if (preset === 'ui') assert(!stack.includes('STK Hand CJK'), 'ui preset must not use the handwriting face');
    }
  });

  await check('fonts: a persisted preset is restored, storage failures fall back to default', () => {
    storage.font = 'xingkai';
    storage.failGet = false;
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false }));
    let tree = renderTree();
    assert(hooks[STATE.font] === 'xingkai', 'stored preset should be restored');
    assertIncludes(nodesWithClass(tree, 'stk-root')[0].props.style['--stk-note-font'], 'STK Xingkai');

    storage.failGet = true;
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false }));
    tree = renderTree();
    assert(hooks[STATE.font] === 'default', 'storage failure should fall back to default');
    storage.failGet = false;
  });

  await check('fonts: the header menu switches and persists the preset, never touching chrome', () => {
    storage.font = null;
    storage.setCalls = [];
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false }));
    let tree = renderTree();
    const fontButton = flatten(tree).find((node) => node.type === 'button' && node.props.title === 'font.title');
    assert(fontButton, 'header font button missing');
    fontButton.props.onClick();
    assert(hooks[STATE.fontMenuOpen] === true, 'font menu should open');
    tree = renderTree();
    for (const preset of ['font.default', 'font.hand', 'font.xingkai', 'font.ui']) assert(buttonByLabel(tree, preset), `menu item ${preset} missing`);
    buttonByLabel(tree, 'font.ui').props.onClick();
    assert(hooks[STATE.font] === 'ui', 'selecting a preset should apply it');
    assert(storage.setCalls.includes('ui'), 'the choice should be persisted under sticker-todo:font');
    assert(hooks[STATE.fontMenuOpen] === false, 'the menu should close after choosing');
    const stack = nodesWithClass(renderTree(), 'stk-root')[0].props.style['--stk-note-font'];
    assertIncludes(stack, 'var(--dsw-font-family');
  });

  /* ---------------- v1.1.0 tags + priority visuals ---------------- */
  await check('cards: tag chips still filter and priority is visual-only', () => {
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false }));
    let tree = renderTree();
    const tagButton = flatten(tree).find((node) => node.type === 'button' && textsOf(node.children).join('') === '#工作');
    assert(tagButton, 'note tag chip missing');
    tagButton.props.onClick({ stopPropagation() {} });
    assert(hooks[STATE.tagFilter] === '工作', 'clicking a note tag should filter by it');
    hooks[STATE.tagFilter] = null; // show the whole board again for the priority checks
    tree = renderTree();
    const flags = nodesWithClass(tree, 'stk-note-priority');
    assert(flags.length === 3, `every card needs a priority flag, got ${flags.length}`);
    assert(flags.every((flag) => typeof flag.props['aria-label'] === 'string' && flag.props['aria-label'].startsWith('priority.')), 'priority flags need accessible labels');
    const visible = textsOf(tree).join('|');
    for (const word of ['priority.1', 'priority.2', 'priority.3', '高', '中', '低']) {
      assert(!visible.includes(word), `priority should not be visible text (found ${word})`);
    }
  });

  /* ---------------- per-note AI advice ---------------- */
  await check('advice: question round without options degrades to the editable answer box', async () => {
    stubFetch({
      ok: true,
      data: { kind: 'question', question: '这件事现在卡在哪一步？', round: 0, source: 'model' },
    });
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false }));
    let tree = renderTree();
    const adviceButton = buttonByLabel(tree, 'note.advice');
    assert(adviceButton, 'card AI advice button missing');
    adviceButton.props.onClick();
    await flush();
    const dialog = hooks[STATE.adviceDialog];
    assert(dialog && dialog.phase === 'question', 'advice dialog should enter the question phase');
    assert(Array.isArray(dialog.options) && dialog.options.length === 0, 'missing Host options must degrade to []');
    tree = renderTree();
    assert(findText(tree, '这件事现在卡在哪一步？'), 'question text should be rendered');
    assert(findText(tree, 'advice.questionTag') && findText(tree, 'advice.answerLabel'), 'question labels missing');
    assert(findText(tree, 'advice.round{"round":1}'), 'round indicator missing');
    assert(nodesWithClass(tree, 'stk-chip--option').length === 0, 'no option chips should render without Host options');
    const answerField = flatten(tree).find((node) => node.type === 'textarea' && node.props.id === 'stk-advice-answer');
    assert(answerField, 'editable answer textarea missing');
    answerField.props.onChange({ target: { value: '卡在等数据' } });
    tree = renderTree();
    const submit = buttonByLabel(tree, 'advice.submit');
    assert(submit && submit.props.disabled === false, 'submit should enable after typing an answer');
    submit.props.onClick();
    await flush();
    const posted = fetchCalls[fetchCalls.length - 1].body;
    assert(posted.action === 'aiNoteAdvice' && posted.id === 'td_1', 'aiNoteAdvice should be posted with the note id');
    assert(JSON.stringify(posted.history) === JSON.stringify([{ question: '这件事现在卡在哪一步？', answer: '卡在等数据' }]), `history mismatch: ${JSON.stringify(posted.history)}`);
  });

  await check('advice: question option chips fill the answer box, stay selected and remain editable', async () => {
    stubFetch({
      ok: true,
      data: { kind: 'question', question: '这件事现在卡在哪一步？', options: ['缺资料', '缺时间', '还没想清楚'], round: 0, source: 'model' },
    });
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false }));
    let tree = renderTree();
    buttonByLabel(tree, 'note.advice').props.onClick();
    await flush();
    const dialog = hooks[STATE.adviceDialog];
    assert(dialog && dialog.phase === 'question', 'question phase expected');
    assert(JSON.stringify(dialog.options) === JSON.stringify(['缺资料', '缺时间', '还没想清楚']), `options not carried: ${JSON.stringify(dialog.options)}`);
    tree = renderTree();
    const optionButtons = flatten(tree).filter((node) => node.type === 'button' && hasClass(node, 'stk-chip--option'));
    assert(optionButtons.length === 3, `expected three option chips, got ${optionButtons.length}`);
    const optionsGroup = nodesWithClass(tree, 'stk-advice-options')[0];
    assert(optionsGroup && optionsGroup.props['aria-label'] === 'advice.optionsLabel', 'option group label missing');
    const timeOption = optionButtons.find((node) => textsOf(node.children).join('') === '缺时间');
    assert(timeOption, '缺时间 option chip missing');
    timeOption.props.onClick();
    assert(hooks[STATE.adviceDialog].answer === '缺时间', 'picking an option should fill the answer box');
    tree = renderTree();
    const pressed = flatten(tree).filter((node) => node.type === 'button' && hasClass(node, 'stk-chip--option') && node.props['aria-pressed'] === true);
    assert(pressed.length === 1 && textsOf(pressed[0].children).join('') === '缺时间', 'selected option should be marked pressed');
    const answerField = flatten(tree).find((node) => node.type === 'textarea' && node.props.id === 'stk-advice-answer');
    assert(answerField.props.value === '缺时间', 'answer textarea should show the picked option');
    answerField.props.onChange({ target: { value: '缺时间，但今晚能挤出半小时' } });
    assert(hooks[STATE.adviceDialog].answer.startsWith('缺时间，但今晚'), 'answer box must stay freely editable');
    tree = renderTree();
    assert(flatten(tree).filter((node) => node.type === 'button' && hasClass(node, 'stk-chip--option') && node.props['aria-pressed'] === true).length === 0, 'editing should clear the option selection');
    const submit = buttonByLabel(tree, 'advice.submit');
    submit.props.onClick();
    await flush();
    const posted = fetchCalls[fetchCalls.length - 1].body;
    assert(posted.history[0].answer === '缺时间，但今晚能挤出半小时', 'submit must send the edited box content');
  });

  await check('advice: advice alternatives render as chips and fill the editable suggestion', async () => {
    stubFetch({
      ok: true,
      data: {
        kind: 'advice',
        advice: { text: '今晚先写开头两段', options: ['先列提纲再写', '先找上周数据', '先写 20 分钟'], source: 'model' },
        round: 1,
      },
    });
    resetHooks(seed({
      snapshot: TAGGED_SNAPSHOT,
      loading: false,
      adviceDialog: {
        id: 'td_1',
        title: '写周报',
        history: [],
        phase: 'question',
        question: '卡在哪？',
        options: [],
        answer: '缺时间',
        adviceText: '',
        adviceOptions: [],
        source: 'model',
        round: 0,
        busy: false,
        error: null,
      },
    }));
    const tree = renderTree();
    buttonByLabel(tree, 'advice.submit').props.onClick();
    await flush();
    let dialog = hooks[STATE.adviceDialog];
    assert(dialog.phase === 'advice', 'advice phase expected');
    assert(JSON.stringify(dialog.adviceOptions) === JSON.stringify(['先列提纲再写', '先找上周数据', '先写 20 分钟']), `advice options not carried: ${JSON.stringify(dialog.adviceOptions)}`);
    let rendered = renderTree();
    const optionButtons = flatten(rendered).filter((node) => node.type === 'button' && hasClass(node, 'stk-chip--option'));
    assert(optionButtons.length === 3, `expected three advice chips, got ${optionButtons.length}`);
    const alternativesGroup = nodesWithClass(rendered, 'stk-advice-options')[0];
    assert(alternativesGroup && alternativesGroup.props['aria-label'] === 'advice.alternativesLabel', 'alternatives group label missing');
    optionButtons.find((node) => textsOf(node.children).join('') === '先找上周数据').props.onClick();
    assert(hooks[STATE.adviceDialog].adviceText === '先找上周数据', 'picking an alternative should replace the suggestion text');
    rendered = renderTree();
    const adviceField = flatten(rendered).find((node) => node.type === 'textarea' && node.props.id === 'stk-advice-text');
    assert(adviceField.props.value === '先找上周数据', 'editable text should show the picked alternative');
    adviceField.props.onChange({ target: { value: '我自己改的建议' } });
    assert(hooks[STATE.adviceDialog].adviceText === '我自己改的建议', 'advice text must stay freely editable');
    rendered = renderTree();
    assert(flatten(rendered).filter((node) => node.type === 'button' && hasClass(node, 'stk-chip--option') && node.props['aria-pressed'] === true).length === 0, 'editing should clear the alternative selection');
  });

  await check('advice: 3-round history guard never sends a fourth answer', async () => {
    stubFetch({ ok: true, data: { kind: 'question', question: '问题？', round: 3, source: 'model' } });
    resetHooks(seed({
      snapshot: TAGGED_SNAPSHOT,
      loading: false,
      adviceDialog: {
        id: 'td_1',
        title: '写周报',
        history: [
          { question: 'q1', answer: 'a1' },
          { question: 'q2', answer: 'a2' },
          { question: 'q3', answer: 'a3' },
        ],
        phase: 'question',
        question: 'q4?',
        answer: 'a4',
        adviceText: '',
        source: 'model',
        round: 3,
        busy: false,
        error: null,
      },
    }));
    const before = fetchCalls.length;
    const tree = renderTree();
    buttonByLabel(tree, 'advice.submit').props.onClick();
    await flush();
    assert(fetchCalls.length === before, 'a fourth question round must not reach the Host');
    assert(hooks[STATE.adviceDialog].busy === false, 'dialog should stay idle');
  });

  await check('advice: advice round renders editable text and appends it to the note details', async () => {
    stubFetch([
      {
        ok: true,
        data: {
          kind: 'advice',
          advice: { text: '今晚先写开头两段', source: 'fallback' },
          round: 1,
        },
      },
      {
        ok: true,
        data: makeTodo({ id: 'td_1', text: '写周报', note: '第一段先写背景\n\n今晚先写开头两段（已修改）', priority: 1, tags: ['工作', '周报'] }),
      },
    ]);
    resetHooks(seed({
      snapshot: TAGGED_SNAPSHOT,
      loading: false,
      adviceDialog: {
        id: 'td_1',
        title: '写周报',
        history: [{ question: '卡在哪？', answer: '等数据' }],
        phase: 'question',
        question: '卡在哪？',
        answer: '',
        adviceText: '',
        source: 'model',
        round: 0,
        busy: false,
        error: null,
      },
    }));
    let tree = renderTree();
    // simulate the Host answering the submitted question with advice
    const answerField = flatten(tree).find((node) => node.type === 'textarea' && node.props.id === 'stk-advice-answer');
    answerField.props.onChange({ target: { value: '已经想清楚了' } });
    tree = renderTree();
    buttonByLabel(tree, 'advice.submit').props.onClick();
    await flush();
    assert(hooks[STATE.adviceDialog].phase === 'advice', 'advice phase expected');
    tree = renderTree();
    const adviceField = flatten(tree).find((node) => node.type === 'textarea' && node.props.id === 'stk-advice-text');
    assert(adviceField, 'editable advice textarea missing');
    assert(adviceField.props.value === '今晚先写开头两段', 'advice text mismatch');
    assert(nodesWithClass(tree, 'stk-chip--option').length === 0, 'fallback advice without alternatives must not render option chips');
    assert(findText(tree, 'advice.append') && findText(tree, 'advice.close'), 'append/close buttons missing');
    assert(findText(tree, 'ai.source.fallback'), 'advice source chip missing');
    adviceField.props.onChange({ target: { value: '今晚先写开头两段（已修改）' } });
    tree = renderTree();
    buttonByLabel(tree, 'advice.append').props.onClick();
    await flush();
    const update = fetchCalls[fetchCalls.length - 1].body;
    assert(update.action === 'update' && update.id === 'td_1', 'append should update the note');
    assert(update.note === '第一段先写背景\n\n今晚先写开头两段（已修改）', `appended note mismatch: ${JSON.stringify(update.note)}`);
    assert(hooks[STATE.adviceDialog] !== null && hooks[STATE.adviceDialog].closing === true, 'append should animate the dialog out');
    await flushClose();
    assert(hooks[STATE.adviceDialog] === null, 'advice dialog should close after appending');
    const stored = hooks[STATE.snapshot].todos.find((todo) => todo.id === 'td_1');
    assert(stored.note.includes('已修改'), 'the board snapshot should refresh the note');
    assert(hooks[STATE.toast] && hooks[STATE.toast].text === 'advice.appended', 'append toast missing');
  });

  await check('advice: old Host unknown_action shows the restart hint inline', async () => {
    stubFetch({ ok: false, error: { code: 'unknown_action', message: 'unknown action: aiNoteAdvice' } });
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false }));
    let tree = renderTree();
    buttonByLabel(tree, 'note.advice').props.onClick();
    await flush();
    const dialog = hooks[STATE.adviceDialog];
    assert(dialog && dialog.error && dialog.error.hint === true && dialog.error.text === 'ai.needRestart', 'restart hint expected');
    tree = renderTree();
    assert(nodesWithClass(tree, 'stk-ai-error--hint').length === 1, 'hint should use the muted hint style');
    assert(findText(tree, 'ai.needRestart'), 'restart hint text missing');
  });

  await check('advice: closing the dialog animates out without throwing', async () => {
    resetHooks(seed({
      snapshot: TAGGED_SNAPSHOT,
      loading: false,
      adviceDialog: {
        id: 'td_1', title: '写周报', history: [], phase: 'advice', question: '', answer: '',
        options: [], adviceText: '先写两段', adviceOptions: [], source: 'model', round: 0, busy: false, error: null,
      },
    }));
    const tree = renderTree();
    const close = buttonByLabel(tree, 'action.dismiss');
    assert(close, 'dialog close button missing');
    close.props.onClick();
    assert(hooks[STATE.adviceDialog] !== null && hooks[STATE.adviceDialog].closing === true, 'close should start the exit animation');
    await flushClose();
    assert(hooks[STATE.adviceDialog] === null, 'close should dismiss the advice dialog');
  });

  /* ---------------- v1.7.0 memory ---------------- */
  const memorySection = (tree, label) => nodesWithClass(tree, 'stk-memory-section')
    .find((node) => node.props['aria-label'] === label);
  const cardOf = (tree, id) => nodesWithClass(tree, 'stk-note')
    .find((node) => node.props['data-id'] === id);
  /** The 建议 (AI advice) action of one note card, scoped to that card. */
  const noteAdviceButton = (tree, id) => {
    const card = cardOf(tree, id);
    return card
      ? flatten(card).find((node) => node.type === 'button' && node.props['aria-label'] === zhDict()['note.advice'])
      : undefined;
  };

  await check('memory: header 记忆 button opens the three-section dialog with facts', () => {
    const zh = zhDict();
    resetHooks(seed({ snapshot: MEMORY_SNAPSHOT, loading: false, lang: 'zh' }));
    let tree = renderTree();
    assert(nodesWithClass(tree, 'stk-modal--memory').length === 0, 'memory dialog must start closed');
    const memoryButton = flatten(tree).find((node) => node.type === 'button' && node.props['aria-label'] === zh['memory.button']);
    assert(memoryButton, 'header 记忆 button missing');
    memoryButton.props.onClick();
    assert(hooks[STATE.memoryOpen] === true, 'clicking 记忆 should open the dialog');
    tree = renderTree();
    const modal = nodesWithClass(tree, 'stk-modal--memory')[0];
    assert(modal && modal.props.role === 'dialog' && modal.props['aria-modal'] === 'true', 'memory dialog semantics missing');
    assert(modal.props['aria-label'] === zh['memory.title'], `memory dialog label mismatch: ${JSON.stringify(modal.props['aria-label'])}`);
    const sections = nodesWithClass(tree, 'stk-memory-section');
    assert(sections.length === 3, `expected three memory sections, got ${sections.length}`);
    const labels = sections.map((section) => section.props['aria-label']);
    assert(
      labels.includes(zh['memory.factsTitle']) && labels.includes(zh['memory.reviewTitle']) && labels.includes(zh['memory.candidatesTitle']),
      `section labels mismatch: ${JSON.stringify(labels)}`,
    );
    const factSection = memorySection(tree, zh['memory.factsTitle']);
    const factTexts = nodesWithClass(factSection, 'stk-memory-text').map((node) => textsOf(node.children).join(''));
    assert(factTexts.includes('周报固定在周五下午发') && factTexts.includes('每天先做最重要的一件'), `fact list mismatch: ${JSON.stringify(factTexts)}`);
    assert(textsOf(nodesWithClass(factSection, 'stk-memory-section-count')[0].children).join('') === '2', 'fact count badge mismatch');
    assert(findText(tree, zh['memory.hint']), 'memory hint missing');
    assert(findText(tree, zh['memory.clear']), '清空记忆 button missing');
    assert(findText(tree, zh['memory.reviewHint']), 'the not-yet-generated review hint missing');
    assert(findText(tree, zh['memory.candidatesHint']), 'the not-yet-discovered candidates hint missing');
    const form = nodesWithClass(tree, 'stk-memory-form')[0];
    const rememberButton = flatten(form).find((node) => node.type === 'button');
    assert(rememberButton && rememberButton.props.disabled === true, '记住 should stay disabled while the draft is empty');
  });

  await check('memory: the dialog and its sections render in English too', () => {
    const en = enDict();
    resetHooks(seed({ snapshot: MEMORY_SNAPSHOT, loading: false, lang: 'en', memoryOpen: true }));
    const tree = renderTree();
    const sections = nodesWithClass(tree, 'stk-memory-section');
    assert(sections.length === 3, `expected three memory sections, got ${sections.length}`);
    for (const label of [
      en['memory.title'], en['memory.factsTitle'], en['memory.reviewTitle'],
      en['memory.candidatesTitle'], en['memory.clear'], en['memory.hint'],
    ]) {
      assert(findText(tree, label), `English memory label missing: ${label}`);
    }
    assert(findText(tree, '周报固定在周五下午发'), 'facts should render their text verbatim');
    assert(!findText(tree, zhDict()['memory.factsTitle']), 'forced English must not render the Chinese section title');
  });

  await check('memory: 记住 posts the draft; 编辑 saves updateFact; delete sends forget', async () => {
    const en = enDict();
    /* remember */
    stubFetch([
      { ok: true, data: { id: 'm_new00001', text: '周五写周报', source: 'user', createdAt: NOW, updatedAt: NOW } },
      { ok: true, data: MEMORY_SNAPSHOT },
    ]);
    resetHooks(seed({ snapshot: MEMORY_SNAPSHOT, loading: false, lang: 'en', memoryOpen: true, factsDraft: '周五写周报' }));
    let tree = renderTree();
    const rememberButton = flatten(nodesWithClass(tree, 'stk-memory-form')[0]).find((node) => node.type === 'button');
    assert(rememberButton.props.disabled === false, '记住 should enable once the draft is non-empty');
    rememberButton.props.onClick();
    await flush();
    const posted = fetchCalls.find((call) => call.body && call.body.action === 'remember');
    assert(posted && posted.body.text === '周五写周报', `remember body mismatch: ${JSON.stringify(posted && posted.body)}`);
    assert(hooks[STATE.factsDraft] === '', 'the draft should clear after remembering');
    assert(hooks[STATE.memoryBusy] === null, 'the dialog should leave the busy state');
    assert(hooks[STATE.toast] && hooks[STATE.toast].text === en['memory.saved'], 'saved-to-memory toast missing');

    /* an invalid_input keeps the dialog open with an inline error */
    stubFetch({ ok: false, error: { code: 'invalid_input', message: '这条记忆已经记过了' } });
    resetHooks(seed({ snapshot: MEMORY_SNAPSHOT, loading: false, lang: 'en', memoryOpen: true, factsDraft: '周报固定在周五下午发' }));
    tree = renderTree();
    flatten(nodesWithClass(tree, 'stk-memory-form')[0]).find((node) => node.type === 'button').props.onClick();
    await flush();
    assert(hooks[STATE.memoryError] === '这条记忆已经记过了', `inline memory error mismatch: ${JSON.stringify(hooks[STATE.memoryError])}`);
    assert(nodesWithClass(renderTree(), 'stk-ai-error').length === 1, 'the inline memory error must render');

    /* edit */
    stubFetch([
      { ok: true, data: { id: 'm_ab12cd34', text: '周报固定在周五 16:00 发', source: 'user', createdAt: NOW, updatedAt: NOW } },
      { ok: true, data: MEMORY_SNAPSHOT },
    ]);
    resetHooks(seed({ snapshot: MEMORY_SNAPSHOT, loading: false, lang: 'en', memoryOpen: true }));
    tree = renderTree();
    const editButton = flatten(nodesWithClass(tree, 'stk-memory-item')[0])
      .find((node) => node.type === 'button' && node.props['aria-label'] === en['note.edit']);
    assert(editButton, 'fact edit button missing');
    editButton.props.onClick();
    assert(hooks[STATE.factsEditingId] === 'm_ab12cd34', 'editing state should point at the fact');
    assert(hooks[STATE.factsEditDraft] === '周报固定在周五下午发', 'edit draft should start from the fact text');
    tree = renderTree();
    const editInput = flatten(nodesWithClass(tree, 'stk-memory-edit')[0]).find((node) => node.type === 'input');
    assert(editInput && editInput.props.value === '周报固定在周五下午发', 'inline edit input missing');
    editInput.props.onChange({ target: { value: '周报固定在周五 16:00 发' } });
    assert(hooks[STATE.factsEditDraft] === '周报固定在周五 16:00 发', 'edit draft did not update');
    tree = renderTree();
    const saveButton = flatten(nodesWithClass(tree, 'stk-memory-edit')[0])
      .find((node) => node.type === 'button' && textsOf(node.children).join('') === en['edit.submit']);
    assert(saveButton, 'save-edit button missing');
    saveButton.props.onClick();
    await flush();
    const updated = fetchCalls.find((call) => call.body && call.body.action === 'updateFact');
    assert(
      updated && updated.body.id === 'm_ab12cd34' && updated.body.text === '周报固定在周五 16:00 发',
      `updateFact body mismatch: ${JSON.stringify(updated && updated.body)}`,
    );
    assert(hooks[STATE.factsEditingId] === null, 'the edit row should close after saving');

    /* forget */
    stubFetch([
      { ok: true, data: { forgotten: 'm_ef56gh78' } },
      { ok: true, data: MEMORY_SNAPSHOT },
    ]);
    resetHooks(seed({ snapshot: MEMORY_SNAPSHOT, loading: false, lang: 'en', memoryOpen: true }));
    tree = renderTree();
    const deleteButton = flatten(nodesWithClass(tree, 'stk-memory-item')[1])
      .find((node) => node.type === 'button' && node.props['aria-label'] === en['note.delete']);
    assert(deleteButton, 'fact delete button missing');
    deleteButton.props.onClick();
    await flush();
    const forgotten = fetchCalls.find((call) => call.body && call.body.action === 'forget');
    assert(forgotten && forgotten.body.id === 'm_ef56gh78', `forget body mismatch: ${JSON.stringify(forgotten && forgotten.body)}`);
  });

  await check('memory: 本周复盘 renders headline, six stat chips, highlights, tips and the source', async () => {
    const zh = zhDict();
    resetHooks(seed({ snapshot: MEMORY_SNAPSHOT, loading: false, lang: 'zh', memoryOpen: true, memoryReview: REVIEW_FIXTURE }));
    let tree = renderTree();
    const reviewSection = memorySection(tree, zh['memory.reviewTitle']);
    assert(reviewSection, 'review section missing');
    assert(findText(tree, REVIEW_FIXTURE.headline), 'review headline missing');
    const stats = nodesWithClass(reviewSection, 'stk-memory-stat');
    assert(stats.length === 6, `expected six stat chips, got ${stats.length}`);
    const statTexts = stats.map((node) => textsOf(node.children).join(''));
    for (const [label, value] of [
      [zh['memory.stats.completed'], '4'], [zh['memory.stats.created'], '5'], [zh['memory.stats.postponed'], '2'],
      [zh['memory.stats.removed'], '1'], [zh['memory.stats.open'], '3'], [zh['memory.stats.overdue'], '1'],
    ]) {
      assert(statTexts.some((entry) => entry.includes(label) && entry.includes(value)), `stat chip ${label} ${value} missing: ${JSON.stringify(statTexts)}`);
    }
    assert(findText(tree, zh['ai.source.fallback']), 'the fallback source badge missing');
    assert(findText(tree, zh['memory.highlights']) && findText(tree, REVIEW_FIXTURE.highlights[0]), 'review highlights missing');
    assert(findText(tree, zh['memory.tips']) && findText(tree, REVIEW_FIXTURE.tips[0].text), 'review tips missing');

    stubFetch({ ok: true, data: { review: REVIEW_FIXTURE } });
    resetHooks(seed({ snapshot: MEMORY_SNAPSHOT, loading: false, lang: 'zh', memoryOpen: true }));
    tree = renderTree();
    buttonByLabel(tree, zh['memory.generateReview']).props.onClick();
    await flush();
    assert(fetchCalls.some((call) => call.body && call.body.action === 'review'), '生成复盘 should POST the review action');
    assert(hooks[STATE.memoryReview] && hooks[STATE.memoryReview].headline === REVIEW_FIXTURE.headline, 'the review result should be stored');
  });

  await check('memory: 可能值得记住 renders proposals; 忽略 is local; 记住 calls remember', async () => {
    const zh = zhDict();
    resetHooks(seed({ snapshot: MEMORY_SNAPSHOT, loading: false, lang: 'zh', memoryOpen: true, memoryCandidates: CANDIDATE_FIXTURE }));
    let tree = renderTree();
    let candidates = nodesWithClass(tree, 'stk-memory-candidate');
    assert(candidates.length === 2, `expected two candidates, got ${candidates.length}`);
    assert(findText(tree, CANDIDATE_FIXTURE[0].text) && findText(tree, CANDIDATE_FIXTURE[0].reason), 'candidate text/reason missing');
    fetchCalls = [];
    const ignoreButton = flatten(candidates[1]).find((node) => node.type === 'button' && textsOf(node.children).join('') === zh['memory.ignore']);
    assert(ignoreButton, '忽略 button missing');
    ignoreButton.props.onClick();
    assert(fetchCalls.length === 0, '忽略 must not call the Host');
    assert(hooks[STATE.memoryCandidates].length === 1, '忽略 should drop the candidate locally');
    tree = renderTree();
    assert(nodesWithClass(tree, 'stk-memory-candidate').length === 1, 'the ignored candidate should disappear');

    stubFetch([
      { ok: true, data: { id: 'm_cand0001', text: CANDIDATE_FIXTURE[0].text, source: 'user', createdAt: NOW, updatedAt: NOW } },
      { ok: true, data: MEMORY_SNAPSHOT },
    ]);
    resetHooks(seed({ snapshot: MEMORY_SNAPSHOT, loading: false, lang: 'zh', memoryOpen: true, memoryCandidates: CANDIDATE_FIXTURE }));
    tree = renderTree();
    flatten(nodesWithClass(tree, 'stk-memory-candidate')[0])
      .find((node) => node.type === 'button' && textsOf(node.children).join('') === zh['memory.remember'])
      .props.onClick();
    await flush();
    const posted = fetchCalls.find((call) => call.body && call.body.action === 'remember');
    assert(posted && posted.body.text === CANDIDATE_FIXTURE[0].text, `candidate remember body mismatch: ${JSON.stringify(posted && posted.body)}`);
    assert(hooks[STATE.memoryCandidates].length === 1, 'the confirmed candidate should be removed from the list');

    stubFetch({ ok: true, data: { candidates: CANDIDATE_FIXTURE, generatedAt: NOW, source: 'fallback' } });
    resetHooks(seed({ snapshot: MEMORY_SNAPSHOT, loading: false, lang: 'zh', memoryOpen: true, memoryCandidates: null }));
    tree = renderTree();
    assert(findText(tree, zh['memory.candidatesHint']), 'the not-yet-fetched hint should render');
    buttonByLabel(tree, zh['memory.findCandidates']).props.onClick();
    await flush();
    assert(fetchCalls.some((call) => call.body && call.body.action === 'memoryCandidates'), '发现记忆 should POST memoryCandidates');
    assert(hooks[STATE.memoryCandidates].length === 2, 'the proposals should populate the candidate list');
  });

  await check('badge: 改期 N 次 appears only at >= 2 postponements, in both views', () => {
    const zh = zhDict();
    const en = enDict();
    resetHooks(seed({ snapshot: MEMORY_SNAPSHOT, loading: false, lang: 'zh' }));
    let tree = renderTree();
    const zhBadge = (id) => nodesWithClass(cardOf(tree, id), 'stk-chip--postpone');
    assert(zhBadge('td_1').length === 1, 'td_1 (3 postponements) should show the 改期 badge');
    assert(zhBadge('td_2').length === 0, 'td_2 (1 postponement) must not show the badge');
    assert(zhBadge('td_3').length === 0, 'td_3 (0 postponements) must not show the badge');
    assert(textsOf(zhBadge('td_1')[0].children).join('') === '改期 3 次', `zh badge text mismatch: ${JSON.stringify(textsOf(zhBadge('td_1')[0].children))}`);

    resetHooks(seed({ snapshot: MEMORY_SNAPSHOT, loading: false, lang: 'en' }));
    tree = renderTree();
    const enChip = nodesWithClass(cardOf(tree, 'td_1'), 'stk-chip--postpone')[0];
    assert(enChip, 'English postponement badge missing');
    assert(textsOf(enChip.children).join('') === 'Postponed 3×', `en badge text mismatch: ${JSON.stringify(textsOf(enChip.children))}`);

    /* minimal list: the badge lives in the expanded meta row */
    resetHooks(seed({ snapshot: MEMORY_SNAPSHOT, loading: false, lang: 'zh', view: 'list' }));
    tree = renderTree();
    assert(nodesWithClass(tree, 'stk-chip--postpone').length === 0, 'collapsed minimal rows must hide the badge');
    const rows = flatten(tree).filter((node) => node.type === 'button' && hasClass(node, 'stk-list-row'));
    rows[0].props.onClick();
    tree = renderTree();
    const listChips = nodesWithClass(tree, 'stk-chip--postpone');
    assert(listChips.length === 1, `the expanded minimal row should show exactly one badge, got ${listChips.length}`);
    assert(textsOf(listChips[0].children).join('') === '改期 3 次', 'the expanded row badge text mismatch');
    assert(hasClass(listChips[0], 'stk-chip--list'), 'the list badge should use the list chip variant');
  });

  await check('advice: a stored thread resumes from memory.threads and 继续聊聊 re-requests it', async () => {
    const zh = zhDict();
    stubFetch({ ok: true, data: { kind: 'advice', advice: { text: '这次先写提纲', source: 'model' }, round: 1 } });
    resetHooks(seed({ snapshot: MEMORY_SNAPSHOT, loading: false, lang: 'zh' }));
    let tree = renderTree();
    const adviceButton = noteAdviceButton(tree, 'td_1');
    assert(adviceButton, 'card AI advice button missing');
    adviceButton.props.onClick();
    await flush();
    const dialog = hooks[STATE.adviceDialog];
    assert(dialog && dialog.phase === 'advice', `a stored thread should resume in the advice phase, got ${JSON.stringify(dialog && dialog.phase)}`);
    assert(dialog.resumed === true, 'the resumed flag missing');
    assert(dialog.adviceText === MEMORY_THREAD.advice.text, `stored advice mismatch: ${JSON.stringify(dialog.adviceText)}`);
    assert(
      JSON.stringify(dialog.history) === JSON.stringify([{ question: '这一步卡在哪？', answer: '缺资料' }]),
      `resumed history mismatch: ${JSON.stringify(dialog.history)}`,
    );
    assert(fetchCalls.length === 0, 'opening a stored thread must not call the Host');
    tree = renderTree();
    const adviceField = flatten(tree).find((node) => node.type === 'textarea' && node.props.id === 'stk-advice-text');
    assert(adviceField && adviceField.props.value === MEMORY_THREAD.advice.text, 'the stored advice should be shown');
    const continueButton = buttonByLabel(tree, zh['memory.continueThread']);
    assert(continueButton, '继续聊聊 button missing on a resumed thread');

    stubFetch({ ok: true, data: { kind: 'advice', advice: { text: '这次先写提纲', source: 'model' }, round: 1 } });
    continueButton.props.onClick();
    await flush();
    const posted = fetchCalls[fetchCalls.length - 1].body;
    assert(posted.action === 'aiNoteAdvice' && posted.id === 'td_1', `continue-thread request mismatch: ${JSON.stringify(posted)}`);
    assert(
      JSON.stringify(posted.history) === JSON.stringify([{ question: '这一步卡在哪？', answer: '缺资料' }]),
      `continue-thread history mismatch: ${JSON.stringify(posted.history)}`,
    );
  });

  await check('legacy: a snapshot without data.memory shows no badge and an empty memory dialog', async () => {
    const zh = zhDict();
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false, lang: 'zh' }));
    let tree = renderTree();
    assert(nodesWithClass(tree, 'stk-chip--postpone').length === 0, 'an old Host snapshot must not show postponement badges');
    const memoryButton = flatten(tree).find((node) => node.type === 'button' && node.props['aria-label'] === zh['memory.button']);
    assert(memoryButton, '记忆 button should exist for an old Host too');
    memoryButton.props.onClick();
    tree = renderTree();
    assert(nodesWithClass(tree, 'stk-modal--memory').length === 1, 'the memory dialog should open empty instead of crashing');
    assert(findText(tree, zh['memory.emptyFacts']), 'empty-facts message missing');
    assert(findText(tree, zh['memory.reviewHint']), 'review hint missing');
    assert(findText(tree, zh['memory.candidatesHint']), 'candidates hint missing');

    /* a fresh conversation keeps the three-round path (no stored thread) */
    stubFetch({ ok: true, data: { kind: 'advice', advice: { text: '先写两段', source: 'fallback' }, round: 0 } });
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false, lang: 'zh' }));
    tree = renderTree();
    noteAdviceButton(tree, 'td_1').props.onClick();
    await flush();
    const dialog = hooks[STATE.adviceDialog];
    assert(dialog && dialog.phase === 'advice', 'a fresh conversation still reaches the advice phase');
    assert(dialog.resumed !== true, 'a fresh conversation must not be marked as resumed');
    assert(!buttonByLabel(renderTree(), zh['memory.continueThread']), '继续聊聊 must not render without a stored thread');
  });

  await check('memory: 清空记忆 uses the two-step confirm and posts clearMemory', async () => {
    const en = enDict();
    stubFetch([
      { ok: true, data: { cleared: { facts: 2, threads: 1, events: 7 } } },
      { ok: true, data: MEMORY_SNAPSHOT },
    ]);
    resetHooks(seed({
      snapshot: MEMORY_SNAPSHOT,
      loading: false,
      lang: 'en',
      memoryOpen: true,
      memoryReview: REVIEW_FIXTURE,
      memoryCandidates: CANDIDATE_FIXTURE,
    }));
    let tree = renderTree();
    const clearButton = flatten(tree).find((node) => node.type === 'button' && textsOf(node.children).join('') === en['memory.clear']);
    assert(clearButton, 'Clear memory button missing');
    clearButton.props.onClick();
    assert(hooks[STATE.memoryArmClear] === true, 'the first click should only arm the button');
    assert(fetchCalls.length === 0, 'arming the button must not call the Host');
    tree = renderTree();
    const armedButton = flatten(tree).find((node) => node.type === 'button' && textsOf(node.children).join('') === en['memory.clearConfirm']);
    assert(armedButton, 'the armed confirm label missing');
    armedButton.props.onClick();
    await flush();
    assert(fetchCalls.some((call) => call.body && call.body.action === 'clearMemory'), 'the second click should POST clearMemory');
    assert(hooks[STATE.memoryReview] === null && hooks[STATE.memoryCandidates] === null, 'clearing should reset the review/candidate views');
    assert(hooks[STATE.toast] && hooks[STATE.toast].text === en['memory.cleared'], 'cleared toast missing');
  });

  /* ---------------- v1.8.0 交给 DSH handoff ---------------- */
  /** Independent implementation of the client's `formatDateTime` (Intl, same options). */
  const expectedDateTime = (iso, localeId) => new Intl.DateTimeFormat(localeId, {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso));

  const handoffButton = (tree, id, dict = zhDict()) => {
    const card = cardOf(tree, id);
    return card
      ? flatten(card).find((node) => node.type === 'button' && node.props['aria-label'] === dict['note.handoff'])
      : undefined;
  };

  /** Independent implementation of the Round 8 prompt template for one note. */
  function expectedHandoffPrompt(todo, { language, localeId, t }) {
    const zh = language === 'zh';
    const colon = zh ? '：' : ': ';
    const separator = zh ? ' ｜ ' : ' | ';
    const lines = [zh ? `帮我处理这条待办：${todo.text}` : `Help me handle this todo: ${todo.text}`];
    const note = typeof todo.note === 'string' ? todo.note.trim() : '';
    if (note !== '') lines.push(`${zh ? '详情' : 'Details'}${colon}${note}`);
    const priority = todo.priority === 1 || todo.priority === 3 ? todo.priority : 2;
    const meta = [];
    if (typeof todo.dueAt === 'string' && todo.dueAt !== '') meta.push(`${zh ? '截止' : 'Due'}${colon}${expectedDateTime(todo.dueAt, localeId)}`);
    meta.push(`${zh ? '优先级' : 'Priority'}${colon}${t(`priority.${priority}`)}`);
    if (todo.tags.length > 0) meta.push(`${zh ? '标签' : 'Tags'}${colon}${todo.tags.map((tag) => `#${tag}`).join(' ')}`);
    lines.push(meta.join(separator));
    lines.push(`${zh ? '便签 id' : 'Note id'}${colon}${todo.id}`);
    lines.push(zh
      ? '（来自便利贴待办面板，可以用 sticker_todo 工具更新它）'
      : '(From the Sticker TODO panel — you can update it with the sticker_todo tool)');
    lines.push('');
    lines.push(zh
      ? '请直接推进：先判断这件事要怎么做，需要时用 sticker_todo 更新这条便签（补备注、拆成子项、改期或标记完成），不用先反问。'
      : 'Please move it forward directly: work out what needs doing first, and when useful update this note with sticker_todo (add details, break it into steps, reschedule, or mark it done) rather than asking first.');
    return lines.join('\n');
  }

  await check('handoff: the 交给 DSH button exists in both views, for open and done notes', () => {
    resetUiWorkspace();
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false, lang: 'zh' }));
    let tree = renderTree();
    assert(
      nodesWithClass(tree, 'stk-note-action--handoff').length === 3,
      `expected one handoff button per card, got ${nodesWithClass(tree, 'stk-note-action--handoff').length}`,
    );
    const button = handoffButton(tree, 'td_1');
    assert(button, 'td_1 handoff button missing');
    assert(
      button.props.title === `${zhDict()['note.handoff']} · ${zhDict()['note.handoffHint']}`,
      `the button title should carry the hint, got ${JSON.stringify(button.props.title)}`,
    );

    const doneTodo = makeTodo({ id: 'td_done', text: '已完成的事', done: true });
    resetHooks(seed({
      snapshot: { now: NOW, todos: [doneTodo], dueReminders: [], ai: { available: true, reason: null } },
      loading: false,
      lang: 'zh',
    }));
    tree = renderTree();
    const doneButton = handoffButton(tree, 'td_done');
    assert(doneButton, 'a done note must still offer the handoff button');
    assert(!doneButton.props.disabled, 'the handoff button must not be disabled');

    /* minimal view: only the expanded row carries the button */
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false, lang: 'zh', view: 'list' }));
    tree = renderTree();
    assert(nodesWithClass(tree, 'stk-note-action--handoff').length === 0, 'collapsed minimal rows must not render the handoff button');
    flatten(tree).filter((node) => node.type === 'button' && hasClass(node, 'stk-list-row'))[0].props.onClick();
    tree = renderTree();
    assert(nodesWithClass(tree, 'stk-note-action--handoff').length === 1, 'the expanded minimal row must render the handoff button');
  });

  await check('handoff: zh prompt is built from the note and opens a draft session without sending', async () => {
    resetUiWorkspace();
    const sessions = [];
    const clipboardCalls = [];
    stubUiWorkspace({ startSession: (...args) => { sessions.push(args); } });
    stubNavigator({ clipboard: { writeText: async (text) => { clipboardCalls.push(text); } } });
    stubFetch({ ok: true, data: TAGGED_SNAPSHOT });
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false, lang: 'zh' }));
    const tree = renderTree();
    handoffButton(tree, 'td_1').props.onClick();
    await flush();
    assert(sessions.length === 1, `expected exactly one startSession call, got ${sessions.length}`);
    assert(sessions[0][0] === undefined, `the session id must be undefined, got ${JSON.stringify(sessions[0][0])}`);
    const options = sessions[0][1];
    assert(options && options.whenDraftExists === 'append', `whenDraftExists must be "append", got ${JSON.stringify(options && options.whenDraftExists)}`);
    const expected = expectedHandoffPrompt(TAGGED_TODOS[0], { language: 'zh', localeId: 'zh-CN', t: (key) => zhDict()[key] });
    assert(options.prompt === expected, `zh prompt mismatch:\n--- got ---\n${options.prompt}\n--- expected ---\n${expected}`);
    assert(hooks[STATE.toast] && hooks[STATE.toast].text === zhDict()['note.handoffDraft'], `draft toast missing: ${JSON.stringify(hooks[STATE.toast])}`);
    assert(clipboardCalls.length === 0, 'the clipboard must not be used when the service works');
    assert(fetchCalls.length === 0, 'the handoff must never call the /dsh-todo route');
    resetUiWorkspace();
    restoreNavigator();
  });

  await check('handoff: the prompt only includes the notes parts that exist', async () => {
    resetUiWorkspace();
    const bareTodo = makeTodo({ id: 'td_bare', text: '只有标题', note: '', dueAt: null, remindAt: null, tags: [], priority: 2 });
    const bareSnapshot = { now: NOW, todos: [bareTodo], dueReminders: [], ai: { available: true, reason: null } };
    const sessions = [];
    stubUiWorkspace({ startSession: (...args) => { sessions.push(args); } });
    stubNavigator({ clipboard: { writeText: async () => {} } });
    resetHooks(seed({ snapshot: bareSnapshot, loading: false, lang: 'zh' }));
    let tree = renderTree();
    handoffButton(tree, 'td_bare').props.onClick();
    await flush();
    assert(sessions.length === 1, 'startSession should have been called for the bare note');
    const prompt = sessions[0][1].prompt;
    assert(!prompt.includes('详情：'), 'a note without details must not get a details line');
    assert(!prompt.includes('截止：') && !prompt.includes('标签：'), 'due/tag parts must be omitted when absent');
    assert(prompt.includes('优先级：中'), `the priority part must always be present, got ${JSON.stringify(prompt)}`);
    assert(
      prompt === expectedHandoffPrompt(bareTodo, { language: 'zh', localeId: 'zh-CN', t: (key) => zhDict()[key] }),
      `bare prompt mismatch: ${JSON.stringify(prompt)}`,
    );
    resetUiWorkspace();
    restoreNavigator();
  });

  await check('handoff: en mode builds the English prompt', async () => {
    resetUiWorkspace();
    const sessions = [];
    stubUiWorkspace({ startSession: (...args) => { sessions.push(args); } });
    stubNavigator({ clipboard: { writeText: async () => {} } });
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false, lang: 'en' }));
    const tree = renderTree();
    const button = handoffButton(tree, 'td_1', enDict());
    assert(button, 'English handoff button missing');
    button.props.onClick();
    await flush();
    assert(sessions.length === 1, 'startSession should have been called in English mode');
    const expected = expectedHandoffPrompt(TAGGED_TODOS[0], { language: 'en', localeId: 'en-US', t: (key) => enDict()[key] });
    assert(sessions[0][1].prompt === expected, `en prompt mismatch:\n--- got ---\n${sessions[0][1].prompt}\n--- expected ---\n${expected}`);
    assert(hooks[STATE.toast] && hooks[STATE.toast].text === enDict()['note.handoffDraft'], 'English draft toast missing');
    resetUiWorkspace();
    restoreNavigator();
  });

  await check('handoff: no uiWorkspace service copies the prompt to the clipboard', async () => {
    resetUiWorkspace();
    const copied = [];
    stubNavigator({ clipboard: { writeText: async (text) => { copied.push(text); } } });
    stubFetch({ ok: true, data: TAGGED_SNAPSHOT });
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false, lang: 'zh' }));
    const tree = renderTree();
    handoffButton(tree, 'td_1').props.onClick();
    await flush();
    const expected = expectedHandoffPrompt(TAGGED_TODOS[0], { language: 'zh', localeId: 'zh-CN', t: (key) => zhDict()[key] });
    assert(copied.length === 1 && copied[0] === expected, `the prompt should be copied verbatim, got ${JSON.stringify(copied)}`);
    assert(hooks[STATE.toast] && hooks[STATE.toast].text === zhDict()['note.handoffCopied'], 'copied toast missing');
    assert(fetchCalls.length === 0, 'the clipboard fallback must not call the Host');
    restoreNavigator();
  });

  await check('handoff: a missing / throwing / rejecting startSession degrades to the clipboard', async () => {
    const cases = [
      ['not a function', { startSession: 'not-a-function' }],
      ['throws synchronously', { startSession() { throw new Error('boom'); } }],
      ['rejects its promise', { startSession() { return Promise.reject(new Error('boom')); } }],
    ];
    for (const [label, service] of cases) {
      resetUiWorkspace();
      stubUiWorkspace(service);
      const copied = [];
      stubNavigator({ clipboard: { writeText: async (text) => { copied.push(text); } } });
      stubFetch({ ok: true, data: TAGGED_SNAPSHOT });
      resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false, lang: 'zh' }));
      const tree = renderTree();
      handoffButton(tree, 'td_1').props.onClick();
      await flush();
      assert(copied.length === 1, `${label}: expected the clipboard fallback, got ${copied.length} copy call(s)`);
      assert(hooks[STATE.toast] && hooks[STATE.toast].text === zhDict()['note.handoffCopied'], `${label}: copied toast missing`);
      assert(fetchCalls.length === 0, `${label}: the fallback must not call the Host`);
    }
    resetUiWorkspace();
    restoreNavigator();
  });

  await check('handoff: failure toast when neither the service nor the clipboard is usable', async () => {
    resetUiWorkspace();
    stubNavigator({ clipboard: {} });
    stubFetch({ ok: true, data: TAGGED_SNAPSHOT });
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false, lang: 'zh' }));
    let tree = renderTree();
    handoffButton(tree, 'td_1').props.onClick();
    await flush();
    assert(
      hooks[STATE.toast] && hooks[STATE.toast].text === zhDict()['note.handoffFailed'],
      `failure toast missing, got ${JSON.stringify(hooks[STATE.toast])}`,
    );
    assert(fetchCalls.length === 0, 'the failure path must not call the Host');

    /* navigator itself missing behaves the same */
    resetUiWorkspace();
    stubNavigator(undefined);
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false, lang: 'zh' }));
    tree = renderTree();
    handoffButton(tree, 'td_1').props.onClick();
    await flush();
    assert(
      hooks[STATE.toast] && hooks[STATE.toast].text === zhDict()['note.handoffFailed'],
      'a missing navigator must also show the failure toast',
    );
    restoreNavigator();
  });

  await check('handoff: an async startSession resolves to the draft toast (ctx property form)', async () => {
    resetUiWorkspace();
    const sessions = [];
    if (hostContext) hostContext.uiWorkspace = { startSession: (...args) => { sessions.push(args); return Promise.resolve(); } };
    stubNavigator({ clipboard: { writeText: async () => { throw new Error('the clipboard should not be used'); } } });
    stubFetch({ ok: true, data: TAGGED_SNAPSHOT });
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false, lang: 'zh' }));
    const tree = renderTree();
    handoffButton(tree, 'td_1').props.onClick();
    await flush();
    assert(sessions.length === 1, 'the ctx.uiWorkspace property form must be used when get() finds nothing');
    assert(hooks[STATE.toast] && hooks[STATE.toast].text === zhDict()['note.handoffDraft'], 'draft toast missing after the async session resolves');
    resetUiWorkspace();
    restoreNavigator();
  });

  /* ---------------- legacy Host ---------------- */
  await check('legacy: old Host rows without tags render flat with no filter row', () => {
    resetHooks(seed({ snapshot: LEGACY_SNAPSHOT, loading: false }));
    const tree = renderTree();
    assert(nodesWithClass(tree, 'stk-filter').length === 0, 'legacy board must not render the tag filter');
    assert(sectionSummary(tree).length === 0, 'legacy board must not render tag sections');
    const grid = nodesWithClass(tree, 'stk-board-grid');
    assert(grid.length === 1 && dataIds(grid[0]).length === 3, 'legacy board should render all notes flat');
    assert(nodesWithClass(tree, 'stk-note-tags').length === 0, 'legacy notes have no tag chips');
    assert(nodesWithClass(tree, 'stk-modal').length === 0, 'no dialog should be open');
    // cards still offer the AI advice button; the Host handles unknown_action
    assert(buttonByLabel(tree, 'note.advice'), 'advice button should exist for legacy notes too');
  });

  await check('legacy: old Host aiTag/unknown_action still renders the restart hint', async () => {
    stubFetch({ ok: false, error: { code: 'unknown_action', message: 'unknown action: aiTag' } });
    resetHooks(seed({ snapshot: LEGACY_SNAPSHOT, loading: false }));
    const tree = renderTree();
    buttonByLabel(tree, 'ai.tag').props.onClick();
    await flush();
    assert(hooks[STATE.aiError] && hooks[STATE.aiError].hint === true && hooks[STATE.aiError].text === 'ai.needRestart', 'aiTag restart hint expected');
    assert(nodesWithClass(renderTree(), 'stk-ai-error--hint').length === 1, 'aiTag hint style missing');
  });

  /* ---------------- v1.3.0: no global advice ---------------- */
  await check('global advice: button and result are gone, client never calls aiAdvice', async () => {
    assert(!source.includes('aiAdvice'), 'client.js must not contain an aiAdvice call');
    stubFetch({ ok: true, data: { plan: { summary: 's', items: [], source: 'fallback' }, todos: [] } });
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false }));
    let tree = renderTree();
    assert(!findText(tree, 'ai.advice'), 'global 建议 button label must not render');
    const aiActions = nodesWithClass(tree, 'stk-ai-actions')[0];
    assert(aiActions, 'AI actions row missing');
    const actionLabels = flatten(aiActions).filter((node) => node.type === 'button').map((node) => textsOf(node.children).join(''));
    assert(JSON.stringify(actionLabels) === JSON.stringify(['ai.plan', 'ai.tag']), `unexpected panel AI actions: ${JSON.stringify(actionLabels)}`);
    // Clicking every panel AI action must never post aiAdvice.
    for (const label of ['ai.plan', 'ai.tag']) {
      buttonByLabel(renderTree(), label).props.onClick();
      await flush();
    }
    assert(fetchCalls.every((call) => call.body && call.body.action !== 'aiAdvice'), 'client posted aiAdvice');
    assert(fetchCalls.every((call) => call.body.action === 'aiPlan' || call.body.action === 'aiTag'), `unexpected AI calls: ${JSON.stringify(fetchCalls.map((call) => call.body.action))}`);
  });

  /* ---------------- other preserved behaviour ---------------- */
  await check('preserved: reminder banner, plan/tag AI buttons and empty board', () => {
    const reminder = makeTodo({ id: 'td_r', text: '提醒项', remindAt: '2026-11-05T13:00:00.000Z' });
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false }));
    let tree = renderTree({ useReminders: (select) => select([reminder]) });
    assert(nodesWithClass(tree, 'stk-banner').length === 1, 'reminder banner missing');
    for (const label of ['ai.plan', 'ai.tag', 'action.refresh']) assert(buttonByLabel(tree, label), `${label} button missing`);

    resetHooks(seed({ snapshot: { now: NOW, todos: [], dueReminders: [], ai: { available: false, reason: null } }, loading: false }));
    tree = renderTree();
    assert(findText(tree, 'empty'), 'empty board message missing');
    assert(buttonByLabel(tree, 'action.create'), 'empty board should offer the create button');
  });

  /* ---------------- v1.4.0 bilingual panel ---------------- */
  const langSwitch = (tree) => flatten(tree).find((node) => node.type === 'button' && hasClass(node, 'stk-lang-btn'));
  const langMenuItems = (tree) => {
    const menu = nodesWithClass(tree, 'stk-lang-menu')[0];
    return menu ? flatten(menu).filter((node) => node.type === 'button') : [];
  };
  const menuItemByText = (tree, text) => langMenuItems(tree).find((node) => textsOf(node.children).join('').includes(text));

  await check('language: header switch exists, is accessible and defaults to auto', () => {
    storage.lang = null;
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false, lang: 'auto' }));
    const tree = renderTree();
    const button = langSwitch(tree);
    assert(button, 'header language switch missing');
    assert(button.props['aria-expanded'] === false, 'menu should start closed');
    assertIncludes(textsOf(button.children).join(''), 'lang.auto', 'auto mode label missing');
    assert(hooks[STATE.lang] === 'auto', 'default language mode must be auto');
    assert(nodesWithClass(tree, 'stk-lang').length === 1, 'switch should sit in its own header slot');
    assert(findText(tree, 'action.create'), 'auto mode keeps following the DSH translator');
  });

  await check('language: menu lists 自动/中文/English and forcing English switches every label', () => {
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false, lang: 'auto' }));
    let tree = renderTree();
    langSwitch(tree).props.onClick();
    assert(hooks[STATE.langMenuOpen] === true, 'language menu should open');
    tree = renderTree();
    const menu = nodesWithClass(tree, 'stk-lang-menu')[0];
    assert(menu && menu.props.role === 'menu' && menu.props['aria-label'] === 'lang.title', 'language menu semantics missing');
    const items = langMenuItems(tree);
    assert(items.length === 3, `expected three language options, got ${items.length}`);
    assert(items.every((item) => item.props.role === 'menuitemradio'), 'options need menuitemradio roles');
    assert(items.filter((item) => item.props['aria-checked'] === true).length === 1, 'exactly one option is checked');
    menuItemByText(tree, 'lang.en').props.onClick();
    assert(hooks[STATE.lang] === 'en', 'English mode should be forced');
    assert(storage.lang === 'en' && storage.langSetCalls.includes('en'), 'English mode should persist');
    assert(hooks[STATE.langMenuOpen] === false, 'menu should close after choosing');
    tree = renderTree();
    assertIncludes(textsOf(langSwitch(tree).children).join(''), 'English', 'current mode should be visible on the button');
    for (const label of ['New note', 'Sticker TODO', 'All', 'AI schedule', 'AI tag']) {
      assert(findText(tree, label), `English label missing: ${label}`);
    }
    assert(!findText(tree, 'action.create'), 'forced English must not fall back to DSH keys');
    assert(findText(tree, 'Filter by tag'), 'filter row should be English');
    assert(findText(tree, '3 open · 0 done'), 'interpolated English subtitle missing');
  });

  await check('language: forcing 中文 renders Chinese labels, auto restores the DSH locale', () => {
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false, lang: 'en' }));
    let tree = renderTree();
    langSwitch(tree).props.onClick();
    tree = renderTree();
    menuItemByText(tree, '中文').props.onClick();
    assert(hooks[STATE.lang] === 'zh', 'Chinese mode should be forced');
    assert(storage.lang === 'zh', 'Chinese mode should persist');
    tree = renderTree();
    for (const label of ['新建便签', '便利贴待办', '全部', 'AI 自动安排日程', 'AI 分类打标签']) {
      assert(findText(tree, label), `Chinese label missing: ${label}`);
    }
    assert(!findText(tree, 'action.create'), 'forced Chinese must not fall back to DSH keys');
    assert(findText(tree, '3 条待办 · 0 条已完成'), 'interpolated Chinese subtitle missing');
    // back to auto: the DSH-bound translator (the harness stub returns keys) takes over again
    langSwitch(tree).props.onClick();
    tree = renderTree();
    menuItemByText(tree, '自动（跟随 DSH 语言）').props.onClick();
    assert(hooks[STATE.lang] === 'auto', 'auto mode should be restorable');
    tree = renderTree();
    assert(findText(tree, 'action.create'), 'auto mode should follow the DSH translator again');
    assert(!findText(tree, '新建便签'), 'auto mode must not force a dictionary');
  });

  await check('language: persisted choice is restored and storage failures degrade to auto', () => {
    storage.lang = 'en';
    storage.failGet = false;
    storage.failSet = false;
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false }));
    let tree = renderTree();
    assert(hooks[STATE.lang] === 'en', 'stored English mode should be restored');
    assert(findText(tree, 'New note'), 'restored English labels missing');

    storage.failGet = true;
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false }));
    tree = renderTree();
    assert(hooks[STATE.lang] === 'auto', 'storage failure should fall back to auto');

    storage.failGet = false;
    storage.failSet = true;
    const writesBefore = storage.langSetCalls.length;
    langSwitch(renderTree()).props.onClick();
    tree = renderTree();
    menuItemByText(tree, 'lang.zh').props.onClick();
    assert(hooks[STATE.lang] === 'zh', 'switching should work even when storage writes fail');
    assert(storage.langSetCalls.length === writesBefore, 'failed persistence should not record a write');
    storage.failSet = false;
    storage.lang = null;
  });

  await check('language: date/time formatting follows the forced locale', () => {
    const dated = makeTodo({ id: 'td_d', text: '提醒测试', remindAt: '2026-11-06T20:30:00.000Z' });
    const snapshot = { now: NOW, todos: [dated], dueReminders: [], ai: { available: false, reason: null } };
    resetHooks(seed({ snapshot, loading: false, lang: 'en' }));
    let tree = renderTree();
    const enChip = textsOf(tree).find((text) => text.includes('⏰'));
    assert(enChip, 'English reminder chip missing');
    assert(/AM|PM/.test(enChip), `en-US should format 12-hour time, got ${JSON.stringify(enChip)}`);

    resetHooks(seed({ snapshot, loading: false, lang: 'zh' }));
    tree = renderTree();
    const zhChip = textsOf(tree).find((text) => text.includes('⏰'));
    assert(zhChip, 'Chinese reminder chip missing');
    assert(!/AM|PM/.test(zhChip), `zh-CN should not use AM/PM, got ${JSON.stringify(zhChip)}`);
    assert(zhChip !== enChip, 'forced locales should format the same timestamp differently');
  });

  await check('language: switching never calls the Host', () => {
    fetchCalls = [];
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false, lang: 'auto' }));
    let tree = renderTree();
    langSwitch(tree).props.onClick();
    tree = renderTree();
    menuItemByText(tree, 'lang.en').props.onClick();
    tree = renderTree();
    langSwitch(tree).props.onClick();
    tree = renderTree();
    menuItemByText(tree, '中文').props.onClick();
    assert(fetchCalls.length === 0, `language switch must not call the Host (saw ${fetchCalls.length})`);
    storage.lang = null;
  });

  /* ---------------- v1.5.0 dual view ---------------- */
  const viewSwitch = (tree) => flatten(tree).find((node) => node.type === 'button' && hasClass(node, 'stk-view-btn'));
  const viewMenuItems = (tree) => {
    const menu = nodesWithClass(tree, 'stk-view-menu')[0];
    return menu ? flatten(menu).filter((node) => node.type === 'button') : [];
  };
  const pickView = (tree, text) => viewMenuItems(tree).find((node) => textsOf(node.children).join('').includes(text));
  const listItems = (tree) => nodesWithClass(tree, 'stk-list-item');
  const listRows = (tree) => flatten(tree).filter((node) => node.type === 'button' && hasClass(node, 'stk-list-row'));

  await check('view: header switch exists, is accessible and defaults to the sticky board', () => {
    storage.view = null;
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false }));
    const tree = renderTree();
    const button = viewSwitch(tree);
    assert(button, 'header view switch missing');
    assert(button.props['aria-haspopup'] === 'menu' && button.props['aria-expanded'] === false, 'view menu should start closed');
    assertIncludes(textsOf(button.children).join(''), 'view.notes', 'default view label missing');
    assert(hooks[STATE.view] === 'notes', 'default view must be the sticky board');
    assert(nodesWithClass(tree, 'stk-note').length === 3, 'sticky board should render note cards');
    assert(nodesWithClass(tree, 'stk-list').length === 0, 'minimal list must not render by default');
    assert(nodesWithClass(tree, 'stk-layout-toggle').length === 1, 'grouping toggle should be present in sticky mode');
  });

  await check('view: switching to 极简 renders title-only rows, due indicator, no grouping toggle', () => {
    fetchCalls = [];
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false, view: 'notes' }));
    let tree = renderTree();
    viewSwitch(tree).props.onClick();
    assert(hooks[STATE.viewMenuOpen] === true, 'view menu should open');
    tree = renderTree();
    const items = viewMenuItems(tree);
    assert(items.length === 2, `expected two view options, got ${items.length}`);
    assert(items.every((item) => item.props.role === 'menuitemradio'), 'view options need menuitemradio roles');
    assert(items.filter((item) => item.props['aria-checked'] === true).length === 1, 'exactly one view option is checked');
    pickView(tree, 'view.list').props.onClick();
    assert(hooks[STATE.view] === 'list', 'minimal view should be selected');
    assert(storage.view === 'list' && storage.viewSetCalls.includes('list'), 'view choice should persist');
    assert(hooks[STATE.viewMenuOpen] === false, 'view menu should close after choosing');
    assert(fetchCalls.length === 0, 'switching the view must not call the Host');
    tree = renderTree();
    assert(nodesWithClass(tree, 'stk-list').length === 1, 'minimal list should render');
    assert(listItems(tree).length === 3, `expected three list rows, got ${listItems(tree).length}`);
    const rows = listRows(tree);
    assert(rows.length === 3 && rows.every((row) => row.props['aria-expanded'] === false), 'rows should start collapsed');
    for (const title of ['写周报', '买牛奶', '散步']) assert(findText(tree, title), `row title missing: ${title}`);
    assert(!findText(tree, '第一段先写背景'), 'details must stay hidden before activation');
    assert(nodesWithClass(tree, 'stk-chip--tag').length === 0, 'tag chips must stay hidden before activation');
    assert(nodesWithClass(tree, 'stk-list-due').length === 1, 'only the note with a deadline shows a due indicator');
    assert(nodesWithClass(tree, 'stk-layout-toggle').length === 0, 'grouping toggle must be hidden in minimal mode');
    assert(nodesWithClass(tree, 'stk-chip--filter').length > 0, 'tag filter should remain in minimal mode');
  });

  await check('view: activating a row expands details + actions in place, one at a time', () => {
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false, view: 'list' }));
    let tree = renderTree();
    listRows(tree)[0].props.onClick();
    assert(hooks[STATE.expandedId] === 'td_1', 'first row should expand');
    tree = renderTree();
    let items = listItems(tree);
    assert(hasClass(items[0], 'stk-list-item--open'), 'expanded row class missing');
    let rows = listRows(tree);
    assert(rows[0].props['aria-expanded'] === true && rows[1].props['aria-expanded'] === false, 'aria-expanded mismatch');
    const details = nodesWithClass(tree, 'stk-list-details')[0];
    assert(details && details.props.id === rows[0].props['aria-controls'], 'details region should match aria-controls');
    assert(findText(tree, '第一段先写背景'), 'full details should be revealed');
    assert(nodesWithClass(tree, 'stk-chip--tag').length >= 1 && findText(tree, '#工作'), 'tag chips should be revealed');
    assert(nodesWithClass(tree, 'stk-list-meta').length === 1, 'due/remind/plan chips should be revealed');
    for (const label of ['note.edit', 'note.advice', 'note.remind', 'note.delete']) {
      assert(buttonByLabel(tree, label), `expanded row action missing: ${label}`);
    }
    // expanding another row collapses the first one
    listRows(tree)[1].props.onClick();
    assert(hooks[STATE.expandedId] === 'td_2', 'second row should expand');
    tree = renderTree();
    items = listItems(tree);
    assert(items.filter((item) => hasClass(item, 'stk-list-item--open')).length === 1, 'only one row may be expanded');
    const openRows = listRows(tree);
    assert(openRows[0].props['aria-expanded'] === false && openRows[1].props['aria-expanded'] === true, 'the previous row should collapse');
    const openDetails = nodesWithClass(tree, 'stk-list-details');
    assert(openDetails.length === 1 && String(openDetails[0].props.id).endsWith('td_2'), 'only the second row details should remain');
    // activating the open row again collapses it
    listRows(tree)[1].props.onClick();
    assert(hooks[STATE.expandedId] === null, 'clicking the open row should collapse it');
    // expanded state is not persisted: a fresh mount starts collapsed
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false, view: 'list' }));
    tree = renderTree();
    assert(listItems(tree).every((item) => !hasClass(item, 'stk-list-item--open')), 'expanded state must reset on reload');
    assert(!findText(tree, '第一段先写背景'), 'details must stay hidden after reload');
  });

  await check('view: persisted choice restored, switching persists, storage failures fall back', () => {
    storage.view = 'list';
    storage.failGet = false;
    storage.failSet = false;
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false }));
    let tree = renderTree();
    assert(hooks[STATE.view] === 'list', 'stored minimal view should be restored');
    assert(listItems(tree).length === 3, 'restored minimal view should render rows');

    viewSwitch(tree).props.onClick();
    tree = renderTree();
    pickView(tree, 'view.notes').props.onClick();
    assert(hooks[STATE.view] === 'notes', 'switching back to sticky should work');
    assert(storage.view === 'notes', 'sticky choice should persist');

    storage.failGet = true;
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false }));
    tree = renderTree();
    assert(hooks[STATE.view] === 'notes', 'storage failure should fall back to notes');

    storage.failGet = false;
    storage.failSet = true;
    const writesBefore = storage.viewSetCalls.length;
    viewSwitch(renderTree()).props.onClick();
    tree = renderTree();
    pickView(tree, 'view.list').props.onClick();
    assert(hooks[STATE.view] === 'list', 'switching should work even when storage writes fail');
    assert(storage.viewSetCalls.length === writesBefore, 'failed persistence should not record a write');
    storage.failSet = false;
    storage.view = null;
  });

  await check('view: filter narrows the minimal list and rows keep the board order', () => {
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false, view: 'list' }));
    let tree = renderTree();
    assert(listItems(tree).map((item) => item.props['data-id']).join() === 'td_1,td_2,td_3', 'list should keep the board sort order');

    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false, view: 'list', tagFilter: '工作' }));
    tree = renderTree();
    const items = listItems(tree);
    assert(items.length === 1 && items[0].props['data-id'] === 'td_1', `filtered list should only show td_1, got ${items.map((item) => item.props['data-id'])}`);
    assert(findText(tree, '写周报'), 'filtered row title missing');
    assert(nodesWithClass(tree, 'stk-layout-toggle').length === 0, 'grouping toggle stays hidden when filtered');
  });

  await check('view: edit and AI advice dialogs open from an expanded minimal row', async () => {
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false, view: 'list' }));
    let tree = renderTree();
    listRows(tree)[0].props.onClick();
    tree = renderTree();
    buttonByLabel(tree, 'note.edit').props.onClick();
    const editor = hooks[STATE.editor];
    assert(editor && editor.mode === 'edit' && editor.id === 'td_1', 'edit dialog should open from a list row');
    assert(editor.draft.text === '写周报', 'edit dialog should be pre-filled from the list row');

    stubFetch({
      ok: true,
      data: { kind: 'question', question: '卡在哪？', options: ['缺资料', '缺时间'], round: 0, source: 'model' },
    });
    resetHooks(seed({ snapshot: TAGGED_SNAPSHOT, loading: false, view: 'list' }));
    tree = renderTree();
    listRows(tree)[1].props.onClick();
    tree = renderTree();
    buttonByLabel(tree, 'note.advice').props.onClick();
    await flush();
    assert(hooks[STATE.adviceDialog] && hooks[STATE.adviceDialog].id === 'td_2', 'advice dialog should open from a list row');
    assert(hooks[STATE.adviceDialog].phase === 'question', 'advice dialog should reach the question phase');
  });

  /* ---------------- summary ---------------- */
  const failed = results.filter((result) => !result.ok);
  console.log(`\nchecks: ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) {
    console.log('failures:');
    for (const failure of failed) console.log(`  - ${failure.name}: ${failure.detail}`);
    console.log('RESULT: FAIL');
    process.exitCode = 1;
    return;
  }
  console.log('RESULT: PASS');
}

main().catch((error) => {
  console.error(`[FAIL] harness crashed: ${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
