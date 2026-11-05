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
 *   - legacy Host rows without `tags` and old-Host `unknown_action` handling
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
plugin.apply({
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
});

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
      '.stk-list-item{', '.stk-list-row{', '.stk-list-details{', '.stk-list-due',
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
