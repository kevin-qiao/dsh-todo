/**
 * `dsh-sticker-todo` — Host AI layer (`lib/ai.js`).
 *
 * ## Model call path (verified against the installed Harness)
 *
 * 1. Services are optional lookups — `ctx.get('llm')` (`@deepseek-ai/dsh-llm`) and
 *    `ctx.get('agentDefaultModel')` (`@deepseek-ai/dsh-agent-default-model`). Both are
 *    checked for `undefined`/missing methods before anything is called.
 * 2. Model selection: `agentDefaultModel.currentSelection()` is synchronous and returns
 *    `{ provider: string, model: string, reasoningEffort?: ReasoningEffortId }`
 *    (`ModelSelection`). `config.provider` / `config.model` / `config.reasoningEffort`
 *    override it when set.
 * 3. A call is one `llm.stream(options: GenerateOptions)` iteration. No
 *    `prepareCall` / `resolveCallConfig` step is needed for a plain request:
 *
 *      llm.stream({
 *        provider, model, system, temperature, maxTokens, signal,
 *        messages: [{ role: 'user', content: [{ type: 'text', text }] }], // RequestUserInput
 *      }) : AsyncIterable<StreamChunk>
 *
 *    Text is the concatenation of `{ type: 'text-delta', text }` chunks. Every stream
 *    ends with exactly one terminal `{ type: 'finish', reason }` chunk whose
 *    `reason.kind` is `'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error'`;
 *    `'aborted'` and `'error'` carry `reason.failure = { code, message }` (stable codes
 *    such as `NO_ADAPTER`, `MISSING_CREDENTIAL`, `AUTH`, `RATE_LIMIT`,
 *    `CONTEXT_WINDOW_EXCEEDED`). We break on `finish` and never rely on message text.
 * 4. Cancellation is an `AbortController` passed as `options.signal`. Our own
 *    `setTimeout` abort bounds the whole call (`config.aiTimeoutMs`, default 30 s); an
 *    abort surfaces either as an `'aborted'` finish chunk or as a rejected iteration,
 *    and both paths report `ai_timeout`.
 * 5. `llm.listProviders()` is synchronous, so `available()` can stay synchronous and
 *    cheap (`LlmProviderInfo[]` → `{ id, name }`).
 *
 * ## Fallback policy
 *
 * `plan()` / `advice()` / `tag()` / `noteAdvice()` never throw and never reject. Every failure
 * — service absent, no default model, provider not registered, timeout, stream failure, empty
 * output, unparsable JSON, or a shape that does not survive `normalizePlan` /
 * `normalizeAdvice` / `normalizeTagging` / `normalizeNoteAdvice` — degrades to the deterministic
 * local heuristic, whose result carries `source: 'fallback'`. A validated model result carries
 * `source: 'model'`.
 *
 * `noteAdvice()` drives one round of the per-note advisory conversation: the model may answer
 * with one concrete suggestion (`{"kind":"advice","text":…,"options":[…]}`, where `options` are
 * 0–3 alternative approaches) or one short follow-up question
 * (`{"kind":"question","question":…,"options":[…]}`, where 2–4 short answers are mandatory), but
 * at most three questions may be asked. Once the history already holds three questions the Host
 * forces an advice answer, and the fallback path never asks a question at all. A model question
 * without a usable choice list is rejected by `normalizeNoteAdvice` and degrades to advice, so
 * the client never receives a question without options.
 *
 * The tagging fallback is a keyword classifier: it puts a note into the practical groups
 * 工作 / 学习 / 生活 / 健康 / 财务 / 社交 / 想法 (with 事务 as the catch-all) using Chinese and
 * English keywords over the note text and note body, giving 1–2 tags per open note and a
 * Chinese one-line grouping summary.
 *
 * The schedule heuristic always works in the machine's local time zone (no hardcoded offset; the
 * configured time zone is used only to word the prompt), respects working hours
 * (09:00–22:00 by default), derives each duration from priority (1 → 60 min, 2 → 45 min,
 * 3 → 30 min), schedules backwards from deadlines so work lands before `dueAt` (with a
 * 30-minute buffer in front of it), leaves breaks between slots, and never plans a slot
 * earlier than ~10 minutes from now rounded up to the next 5-minute mark.
 *
 * Pure helpers are exported for unit tests (they touch no service):
 *   `heuristicPlan(todos, now?, options?)`, `heuristicAdvice(todos, now?, options?)`,
 *   `heuristicTagging(todos, now?, options?)`, `heuristicNoteAdvice(todo, round?, now?)`,
 *   `normalizePlan(raw, todos, now?, options?)`, `normalizeAdvice(raw, todos, now?, options?)`,
 *   `normalizeTagging(raw, todos, now?)`, `normalizeNoteAdvice(raw, round)`
 * where `raw` is the parsed model JSON and `options` are the schedule options
 * (`timeZone`, `workStartHour`, `workEndHour`, `breakMinutes`, `leadMinutes`, `horizonDays`);
 * the tagging helper only reads `maxTags` (1–3) from them.
 */
import { normalizeTags } from './store.js';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SLOT_STEP_MS = 5 * MINUTE_MS;

const DEFAULT_WORK_START_HOUR = 9;
const DEFAULT_WORK_END_HOUR = 22;
const DEFAULT_BREAK_MINUTES = 10;
const DEFAULT_LEAD_MINUTES = 10;
const DEFAULT_DEADLINE_BUFFER_MINUTES = 30;
const DEFAULT_HORIZON_DAYS = 21;

const DEFAULT_TIMEOUT_MS = 30 * 1000;
const MIN_TIMEOUT_MS = 3 * 1000;
const MAX_TIMEOUT_MS = 3 * 60 * 1000;

const MAX_PLAN_ITEMS = 20;
const MAX_PROMPT_TODOS = 40;
const MAX_TIPS = 5;
const MAX_SUMMARY_CHARS = 200;
const MAX_NOTE_CHARS = 120;
const MAX_TIP_CHARS = 160;
const MAX_HEADLINE_CHARS = 80;
const MAX_TAG_COUNT = 3;
const MAX_TAG_CHARS = 12;
const MAX_TAG_SUMMARY_CHARS = 200;
const MAX_ADVICE_CHARS = 400;
const MAX_QUESTION_CHARS = 120;
const MAX_ADVICE_HISTORY = 3;
const MIN_QUESTION_OPTIONS = 2;
const MAX_QUESTION_OPTIONS = 4;
const MAX_QUESTION_OPTION_CHARS = 24;
const MAX_ADVICE_OPTIONS = 3;
const MAX_ADVICE_OPTION_CHARS = 120;
const MAX_DETAILS_PROMPT_CHARS = 800;
const MAX_ANSWER_PROMPT_CHARS = 800;

const PRIORITY_DURATIONS = { 1: 60, 2: 45, 3: 30 };
const PRIORITY_LABELS = { 1: '高', 2: '中', 3: '低' };
const TIP_KINDS = ['focus', 'breakdown', 'deadline', 'rest', 'scope'];
const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

const PLAN_SYSTEM_PROMPT = [
  '你是中文个人日程助手，负责给用户的待办安排具体的开始时间。',
  '严格只输出一个 JSON 对象：不要 markdown 代码块，不要任何解释文字，不要多余字段。',
  '输出结构：{"summary":"一句话总体安排","items":[{"id":"待办 id","planAt":"ISO-8601 时间","note":"一句话说明"}]}',
  '规则：',
  '1. id 必须是输入待办列表里出现过的 id，不要编造，不要安排已完成的待办。',
  '2. planAt 是带时区偏移的 ISO-8601 时间（例如 2026-11-04T09:30:00+08:00），必须晚于当前时间，并落在工作时间内。',
  '3. 先安排逾期和即将到期的待办，再安排其余待办；同类里重要的先做，每项之间留 10 分钟休息。',
  '4. note 用中文说明为什么这个时间做这件事，一句话。summary 也用中文，一句话。',
].join('\n');

const ADVICE_SYSTEM_PROMPT = [
  '你是中文待办整理助手，负责给用户具体、可执行的建议。',
  '严格只输出一个 JSON 对象：不要 markdown 代码块，不要任何解释文字，不要多余字段。',
  '输出结构：{"headline":"一句话结论","tips":[{"text":"一条短建议","kind":"focus|breakdown|deadline|rest|scope"}],"priorityOrder":["待办 id"]}',
  '规则：',
  '1. tips 给 3-5 条，每条不超过 40 个字，必须具体可执行（说清做哪件事、怎么做）。',
  '2. kind 只能是 focus、breakdown、deadline、rest、scope 之一。',
  '3. priorityOrder 只使用输入里出现过的 id，按你建议的处理先后排列，覆盖尽量多的待办。',
  '4. 语言用中文。',
].join('\n');

const TAG_SYSTEM_PROMPT = [
  '你是中文待办整理助手，负责给每条待办打 1-3 个短标签。',
  '严格只输出一个 JSON 对象：不要 markdown 代码块，不要任何解释文字，不要多余字段。',
  '输出结构：{"summary":"一句话分组说明","items":[{"id":"待办 id","tags":["标签"]}]}',
  '规则：',
  '1. id 必须是输入待办列表里出现过的 id，不要编造，不要给已完成的待办打标签。',
  `2. tags 每条 1-${MAX_TAG_COUNT} 个，每个 1-${MAX_TAG_CHARS} 个字，不要带 #，不要重复；输入里已有合适的标签优先沿用。`,
  '3. 标签用中文名词，优先用 工作、学习、生活、健康、财务、社交、想法、事务 这些大类，必要时才用更具体的词（如 周报、健身、房租）。',
  '4. summary 用中文一句话说明分组结果，可以带上每类的数量。',
].join('\n');

const NOTE_ADVICE_SYSTEM_PROMPT = [
  '你是中文待办教练，负责围绕一张便签和用户对话，帮他把事情变小、变清楚、真正推进。',
  '严格只输出一个 JSON 对象：不要 markdown 代码块，不要任何解释文字，不要多余字段。',
  '两种合法输出，一次只输出一种：',
  '{"kind":"advice","text":"一条具体、可以立刻执行的中文建议","options":["备选做法 A","备选做法 B"]}',
  '{"kind":"question","question":"一个最关键的中文追问","options":["选项一","选项二","选项三"]}',
  '规则：',
  `1. 信息足够时给建议：说清现在先做什么、做多久、做到什么程度，text 不超过 ${MAX_ADVICE_CHARS} 个字，不要空话套话；另可给 0-${MAX_ADVICE_OPTIONS} 个具体的备选做法（options），每个不超过 ${MAX_ADVICE_OPTION_CHARS} 个字，没有备选就不写这个字段。`,
  `2. 信息不足时才追问：一次只问一个最有价值的问题，不要一次问好几件事，question 不超过 ${MAX_QUESTION_CHARS} 个字；必须同时给 ${MIN_QUESTION_OPTIONS}-${MAX_QUESTION_OPTIONS} 个用户可以直接点的简短回答（options），每个不超过 ${MAX_QUESTION_OPTION_CHARS} 个字，互不重复，并且是这个问题真实可能的答案。`,
  `3. 输入里的 round 是已经问过的轮数；round 达到 ${MAX_ADVICE_HISTORY} 时必须直接给建议，不能再追问。`,
  '4. 全部用中文，具体、口语化；不要用 markdown、列表符号、表情或引号包裹整段 JSON 以外的内容。',
  '5. 不要编造用户没说过的信息；建议要结合标题、详情、优先级、截止时间、提醒和标签。',
].join('\n');

/* ------------------------------------------------------------------------- *
 * Small value helpers
 * ------------------------------------------------------------------------- */

/** Round `ms` up to the next 5-minute boundary. */
function alignUp(ms) {
  return Math.ceil(ms / SLOT_STEP_MS) * SLOT_STEP_MS;
}

/** Round `ms` down to the previous 5-minute boundary. */
function alignDown(ms) {
  return Math.floor(ms / SLOT_STEP_MS) * SLOT_STEP_MS;
}

/**
 * Coerce a timestamp-like value to epoch milliseconds.
 * Accepts `Date`, finite numbers (epoch ms), and parseable strings (ISO-8601).
 * @returns {number | null} epoch milliseconds, or null when the value is not a valid time.
 */
function toTime(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

/** Format epoch milliseconds as an ISO-8601 UTC string, or the current time when invalid. */
function isoOf(ms) {
  try {
    return new Date(ms).toISOString();
  } catch (error) {
    return new Date().toISOString();
  }
}

/** Clamp an arbitrary value into an integer range. */
function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/** Clip text to `max` characters, appending an ellipsis when truncated. */
function clip(value, max) {
  const text = String(value == null ? '' : value).trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** Local `HH:MM` for a timestamp (machine local time; no hardcoded offset). */
function hhmm(ms) {
  const date = new Date(ms);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Local midnight for a timestamp, in epoch milliseconds. */
function localMidnightMs(ms) {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Chinese day label (今天 / 明天 / 周四 / 11月9日) relative to `nowMs`. */
function dayLabel(ms, nowMs) {
  const diff = Math.round((localMidnightMs(ms) - localMidnightMs(nowMs)) / DAY_MS);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === 2) return '后天';
  if (diff === -1) return '昨天';
  const date = new Date(ms);
  if (diff > 0 && diff < 7) return `周${WEEKDAY_LABELS[date.getDay()]}`;
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/** Whether two timestamps fall on the same local calendar day. */
function sameLocalDay(aMs, bMs) {
  return localMidnightMs(aMs) === localMidnightMs(bMs);
}

/** The machine's IANA time zone, used only for prompt wording. */
function machineTimeZone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone ? zone : 'UTC';
  } catch (error) {
    return 'UTC';
  }
}

/**
 * Read one option from a plugin config value, tolerating both plain values and
 * Cordis/schemastery refs (`{ get() }`). Empty strings are treated as absent.
 */
function readOption(source, key) {
  if (!source || typeof source !== 'object') return undefined;
  let value;
  try {
    value = source[key];
  } catch (error) {
    return undefined;
  }
  if (value && typeof value === 'object' && typeof value.get === 'function') {
    try {
      value = value.get();
    } catch (error) {
      return undefined;
    }
  }
  if (value == null) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  return value;
}

/**
 * Look up an optional Cordis service without throwing.
 * Tries `ctx.get(name)` first (the documented optional-access form), then the plain
 * property so the module also works with a minimal stub context.
 */
function getService(ctx, name) {
  if (!ctx || typeof ctx !== 'object') return undefined;
  try {
    if (typeof ctx.get === 'function') {
      const service = ctx.get(name);
      if (service != null) return service;
    }
  } catch (error) {
    // fall through to the property form
  }
  try {
    const service = ctx[name];
    if (service != null) return service;
  } catch (error) {
    // absent service proxies may throw; that simply means "not available"
  }
  return undefined;
}

/* ------------------------------------------------------------------------- *
 * Todo normalization
 * ------------------------------------------------------------------------- */

/** The todo's display text, never empty. */
function todoText(todo) {
  const text = todo && typeof todo.text === 'string' ? todo.text.trim() : '';
  return text === '' ? '未命名待办' : text;
}

/** Priority as 1 (高) / 2 (中) / 3 (低), defaulting to 2. */
function priorityOf(todo) {
  const value = Number(todo && todo.priority);
  if (value === 1) return 1;
  if (value === 3) return 3;
  return 2;
}

/** Slot length in minutes derived from priority. */
function priorityDuration(todo) {
  return PRIORITY_DURATIONS[priorityOf(todo)];
}

/**
 * Keep only open, addressable todos (deduplicated, original order preserved).
 * Entries without a usable `id` and completed todos are dropped.
 */
function openTodos(todos) {
  if (!Array.isArray(todos)) return [];
  const seen = new Set();
  const open = [];
  for (const todo of todos) {
    if (!todo || typeof todo !== 'object') continue;
    if (todo.done === true) continue;
    const id = typeof todo.id === 'string' ? todo.id.trim() : '';
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    open.push(todo);
  }
  return open;
}

/* ------------------------------------------------------------------------- *
 * Schedule options and working-hour windows
 * ------------------------------------------------------------------------- */

/** Normalize the heuristic schedule options (clamped, with sensible defaults). */
function resolveScheduleOptions(options) {
  const source = options && typeof options === 'object' ? options : {};
  const workStartHour = clampInt(source.workStartHour, 0, 23, DEFAULT_WORK_START_HOUR);
  const workEndHour = clampInt(source.workEndHour, workStartHour + 1, 24, Math.max(workStartHour + 1, DEFAULT_WORK_END_HOUR));
  return {
    timeZone: typeof source.timeZone === 'string' && source.timeZone.trim() ? source.timeZone.trim() : machineTimeZone(),
    workStartHour,
    workEndHour,
    breakMinutes: clampInt(source.breakMinutes, 0, 60, DEFAULT_BREAK_MINUTES),
    leadMinutes: clampInt(source.leadMinutes, 0, 120, DEFAULT_LEAD_MINUTES),
    deadlineBufferMinutes: clampInt(source.deadlineBufferMinutes, 0, 240, DEFAULT_DEADLINE_BUFFER_MINUTES),
    horizonDays: clampInt(source.horizonDays, 1, 60, DEFAULT_HORIZON_DAYS),
  };
}

/** Build the per-day working windows `{ start, end }` (epoch ms) from today onward. */
function buildWindows(nowMs, options) {
  const base = new Date(nowMs);
  const windows = [];
  for (let index = 0; index < options.horizonDays; index += 1) {
    const start = new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate() + index,
      options.workStartHour,
      0,
      0,
      0,
    ).getTime();
    const end = new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate() + index,
      options.workEndHour,
      0,
      0,
      0,
    ).getTime();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) windows.push({ start, end });
  }
  return windows;
}

/** Build the schedule options from the plugin config, reading through refs safely. */
function scheduleOptionsFromConfig(settings) {
  return resolveScheduleOptions({
    timeZone: readOption(settings, 'timeZone'),
    workStartHour: readOption(settings, 'workStartHour'),
    workEndHour: readOption(settings, 'workEndHour'),
    breakMinutes: readOption(settings, 'breakMinutes'),
    leadMinutes: readOption(settings, 'leadMinutes'),
    deadlineBufferMinutes: readOption(settings, 'deadlineBufferMinutes'),
    horizonDays: readOption(settings, 'horizonDays'),
  });
}

/** A simple reserved-interval timeline; reservations are work slots (breaks are gaps). */
function createTimeline() {
  const blocks = [];
  return {
    reserve(start, end) {
      blocks.push({ start, end });
      blocks.sort((a, b) => a.start - b.start);
    },
    conflict(start, end) {
      return blocks.find((block) => start < block.end && end > block.start);
    },
  };
}

/**
 * Earliest free slot not before `fromMs`, scanning working windows forward.
 * Always returns a usable timestamp (last resort: 5-minute-aligned `fromMs`).
 */
function findForwardSlot(timeline, windows, fromMs, durationMs, options) {
  const breakMs = options.breakMinutes * MINUTE_MS;
  for (const window of windows) {
    if (window.end - window.start < durationMs) continue;
    let candidate = Math.max(alignUp(fromMs), window.start);
    if (candidate + durationMs > window.end) continue;
    for (let guard = 0; guard < 128; guard += 1) {
      const conflict = timeline.conflict(candidate, candidate + durationMs);
      if (!conflict) return candidate;
      candidate = alignUp(conflict.end + breakMs);
      if (candidate + durationMs > window.end) break;
    }
  }
  return alignUp(fromMs);
}

/**
 * Latest free slot that ends at or before `latestEndMs`, scanning working windows
 * backwards — this is the "plan backwards from the deadline" placement.
 * @returns {number | null} slot start, or null when no slot fits before the deadline.
 */
function findBackwardSlot(timeline, windows, latestEndMs, durationMs, earliestMs, options) {
  const breakMs = options.breakMinutes * MINUTE_MS;
  for (let index = windows.length - 1; index >= 0; index -= 1) {
    const window = windows[index];
    const lower = Math.max(window.start, earliestMs);
    if (window.end - lower < durationMs) continue;
    let end = alignDown(Math.min(latestEndMs, window.end));
    for (let guard = 0; guard < 128; guard += 1) {
      const start = end - durationMs;
      if (start < lower) break;
      const conflict = timeline.conflict(start, end);
      if (!conflict) return start;
      end = alignDown(conflict.start - breakMs);
    }
  }
  return null;
}

/* ------------------------------------------------------------------------- *
 * Plan heuristic (fallback path)
 * ------------------------------------------------------------------------- */

function compareByDue(a, b) {
  const dueA = toTime(a.dueAt);
  const dueB = toTime(b.dueAt);
  return (dueA == null ? Number.POSITIVE_INFINITY : dueA) - (dueB == null ? Number.POSITIVE_INFINITY : dueB);
}

function compareByPriority(a, b) {
  const byPriority = priorityOf(a) - priorityOf(b);
  if (byPriority !== 0) return byPriority;
  const createdA = toTime(a.createdAt);
  const createdB = toTime(b.createdAt);
  return (createdA == null ? Number.POSITIVE_INFINITY : createdA) - (createdB == null ? Number.POSITIVE_INFINITY : createdB);
}

/** Chinese `planAt` note explaining the placement. */
function planNoteFor(todo, startMs, durationMinutes, nowMs) {
  const dueAt = toTime(todo.dueAt);
  const day = dayLabel(startMs, nowMs);
  const time = hhmm(startMs);
  if (dueAt != null && dueAt < nowMs) {
    return `已逾期，${day} ${time} 先处理，约 ${durationMinutes} 分钟`;
  }
  if (dueAt != null) {
    const deadline = sameLocalDay(dueAt, startMs) ? hhmm(dueAt) : `${dayLabel(dueAt, nowMs)} ${hhmm(dueAt)}`;
    return `${day} ${time} 开始，赶在 ${deadline} 前做完，约 ${durationMinutes} 分钟`;
  }
  if (priorityOf(todo) === 1) {
    return `${day} ${time} 集中处理，约 ${durationMinutes} 分钟（优先级高）`;
  }
  return `${day} ${time} 开始，约 ${durationMinutes} 分钟`;
}

/** One-line Chinese summary for a plan. */
function planSummary(items, placed, nowMs, options, open) {
  if (items.length === 0 || placed.length === 0) return '当前没有待办，先不用安排日程。';
  const first = placed[0];
  const parts = [`已为 ${items.length} 项待办排好时间：${dayLabel(first.start, nowMs)} ${hhmm(first.start)} 先做「${clip(todoText(first.todo), 18)}」`];
  const overdue = open.filter((todo) => {
    const due = toTime(todo.dueAt);
    return due != null && due < nowMs;
  }).length;
  if (overdue > 0) parts.push(`其中 ${overdue} 项已逾期，排在最前面`);
  else parts.push(`每项之间留了 ${options.breakMinutes} 分钟休息`);
  if (open.length > items.length) parts.push(`另有 ${open.length - items.length} 项未排入`);
  return `${parts.join('，')}。`;
}

/**
 * Deterministic local scheduler used whenever the model cannot be used.
 *
 * Placement rules:
 *  - todos with a deadline are ordered by deadline and placed *backwards* from it, so
 *    the slot ends before `dueAt` (ideally with a 30-minute buffer) whenever the
 *    remaining time allows;
 *  - todos whose deadline has passed (or cannot fit) are placed forward from the
 *    earliest allowed slot, which keeps the most overdue item first;
 *  - todos without a deadline are placed forward afterwards, by priority;
 *  - every slot is at least 10 minutes in the future, 5-minute aligned, inside working
 *    hours, and separated from every other slot by the configured break.
 *
 * @param {Array<object>} todos
 * @param {Date | number | string} [now]
 * @param {object} [options]
 * @returns {{ summary: string, items: Array<{ id: string, planAt: string, note: string }>, generatedAt: string, source: 'fallback' }}
 */
export function heuristicPlan(todos, now = new Date(), options = {}) {
  const nowMs = toTime(now) ?? Date.now();
  const schedule = resolveScheduleOptions(options);
  const open = openTodos(todos);
  const planned = open.slice(0, MAX_PLAN_ITEMS);
  const generatedAt = isoOf(nowMs);

  if (planned.length === 0) {
    return { summary: '当前没有待办，先不用安排日程。', items: [], generatedAt, source: 'fallback' };
  }

  const windows = buildWindows(nowMs, schedule);
  const timeline = createTimeline();
  const earliest = alignUp(nowMs + schedule.leadMinutes * MINUTE_MS);

  const withDue = [];
  const withoutDue = [];
  for (const todo of planned) {
    if (toTime(todo.dueAt) == null) withoutDue.push(todo);
    else withDue.push(todo);
  }
  withDue.sort(compareByDue);
  withoutDue.sort(compareByPriority);

  const placed = [];
  const place = (todo, startMs, durationMinutes) => {
    const durationMs = durationMinutes * MINUTE_MS;
    const slotStart = Number.isFinite(startMs) ? Math.max(alignUp(startMs), earliest) : earliest;
    timeline.reserve(slotStart, slotStart + durationMs);
    placed.push({ todo, start: slotStart, durationMinutes });
  };

  for (const todo of withDue) {
    const durationMinutes = priorityDuration(todo);
    const durationMs = durationMinutes * MINUTE_MS;
    const dueAt = toTime(todo.dueAt);
    let start = null;
    if (dueAt != null && dueAt - earliest >= durationMs) {
      // Backwards from the deadline, ideally with a small buffer before it; drop the
      // buffer when the remaining time is tight so the slot still ends before `dueAt`.
      const bufferedEnd = dueAt - schedule.deadlineBufferMinutes * MINUTE_MS;
      if (bufferedEnd - earliest >= durationMs) {
        start = findBackwardSlot(timeline, windows, bufferedEnd, durationMs, earliest, schedule);
      }
      if (start == null) start = findBackwardSlot(timeline, windows, dueAt, durationMs, earliest, schedule);
    }
    if (start == null) start = findForwardSlot(timeline, windows, earliest, durationMs, schedule);
    place(todo, start, durationMinutes);
  }

  for (const todo of withoutDue) {
    const durationMinutes = priorityDuration(todo);
    const start = findForwardSlot(timeline, windows, earliest, durationMinutes * MINUTE_MS, schedule);
    place(todo, start, durationMinutes);
  }

  placed.sort((a, b) => a.start - b.start);
  const items = placed.map((entry) => ({
    id: entry.todo.id,
    planAt: isoOf(entry.start),
    note: planNoteFor(entry.todo, entry.start, entry.durationMinutes, nowMs),
  }));

  return {
    summary: planSummary(items, placed, nowMs, schedule, open),
    items,
    generatedAt,
    source: 'fallback',
  };
}

/**
 * Validate and normalize a parsed model plan against the contract.
 * Drops unknown/duplicate ids, coerces `planAt` to ISO-8601, never returns a past slot,
 * clamps the item count to the open todos, and fills `generatedAt` / `source`.
 *
 * @param {unknown} raw parsed model JSON
 * @param {Array<object>} todos the open todos the plan must stay within
 * @param {Date | number | string} [now]
 * @param {object} [options]
 * @returns {{ summary: string, items: Array<{ id: string, planAt: string, note: string }>, generatedAt: string, source: 'model' } | null}
 *          null when nothing usable survived validation (caller must fall back).
 */
export function normalizePlan(raw, todos, now = new Date(), options = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const nowMs = toTime(now) ?? Date.now();
  const schedule = resolveScheduleOptions(options);
  const open = openTodos(todos);
  if (open.length === 0) return null;

  const allowed = new Set(open.map((todo) => todo.id));
  const earliest = alignUp(nowMs + schedule.leadMinutes * MINUTE_MS);
  const seen = new Set();
  const items = [];
  const rawItems = Array.isArray(raw.items) ? raw.items : [];

  for (const entry of rawItems) {
    if (!entry || typeof entry !== 'object') continue;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (id === '' || !allowed.has(id) || seen.has(id)) continue;
    let planAt = toTime(entry.planAt);
    if (planAt == null) continue;
    if (planAt < earliest) planAt = earliest;
    seen.add(id);
    items.push({
      id,
      start: planAt,
      planAt: isoOf(planAt),
      note: typeof entry.note === 'string' ? clip(entry.note, MAX_NOTE_CHARS) : '',
    });
    if (items.length >= open.length) break;
  }
  if (items.length === 0) return null;

  items.sort((a, b) => a.start - b.start);
  const summary = typeof raw.summary === 'string' && raw.summary.trim() !== ''
    ? clip(raw.summary, MAX_SUMMARY_CHARS)
    : planSummary(
      items,
      items.map((item) => ({
        todo: open.find((todo) => todo.id === item.id),
        start: item.start,
        durationMinutes: PRIORITY_DURATIONS[2],
      })),
      nowMs,
      schedule,
      open,
    );

  return {
    summary,
    items: items.map((item) => ({ id: item.id, planAt: item.planAt, note: item.note })),
    generatedAt: isoOf(nowMs),
    source: 'model',
  };
}

/* ------------------------------------------------------------------------- *
 * Advice heuristic (fallback path)
 * ------------------------------------------------------------------------- */

/**
 * Urgency score used for `priorityOrder`: overdue dominates, then due-soon, then the
 * deadline horizon, then user priority, with a tiny recency bonus.
 */
function todoScore(todo, nowMs) {
  let score = 0;
  const dueAt = toTime(todo.dueAt);
  if (dueAt != null) {
    const remaining = dueAt - nowMs;
    if (remaining < 0) score += 1000;
    else if (remaining <= DAY_MS) score += 500;
    else if (remaining <= 3 * DAY_MS) score += 200;
    else score += 50;
  }
  const priority = priorityOf(todo);
  score += priority === 1 ? 100 : priority === 2 ? 40 : 0;
  const created = toTime(todo.createdAt);
  if (created != null && nowMs - created <= DAY_MS) score += 5;
  return score;
}

/** Suggested processing order (todo ids) — deterministic. */
function heuristicPriorityOrder(open, nowMs) {
  return open
    .map((todo) => ({
      id: todo.id,
      score: todoScore(todo, nowMs),
      due: toTime(todo.dueAt),
      created: toTime(todo.createdAt),
    }))
    .sort((a, b) => (
      b.score - a.score
      || (a.due == null ? Number.POSITIVE_INFINITY : a.due) - (b.due == null ? Number.POSITIVE_INFINITY : b.due)
      || (a.created == null ? 0 : a.created) - (b.created == null ? 0 : b.created)
    ))
    .map((entry) => entry.id);
}

/** Pick the "biggest" item to break down: highest priority, then longest text. */
function pickBreakdownTarget(open) {
  let best = null;
  for (const todo of open) {
    if (best == null) {
      best = todo;
      continue;
    }
    const byPriority = priorityOf(todo) - priorityOf(best);
    if (byPriority < 0) best = todo;
    else if (byPriority === 0 && todoText(todo).length > todoText(best).length) best = todo;
  }
  return best;
}

/** Pick one item that is safe to defer: no deadline, least urgent, never the only item. */
function pickDeferTarget(open, order) {
  if (open.length < 2) return null;
  const byId = new Map(open.map((todo) => [todo.id, todo]));
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const todo = byId.get(order[index]);
    if (todo && toTime(todo.dueAt) == null) return todo;
  }
  return null;
}

/** Chinese one-line headline for the advice. */
function adviceHeadline(open, overdue, soon, high, nowMs) {
  if (open.length === 0) return '暂时没有待办，先享受一下空档';
  if (overdue.length > 0) return `先把 ${overdue.length} 项逾期的事收掉，今天会轻松一半`;
  if (soon.length > 0) return `${soon.length} 项 24 小时内到期，先守住截止时间`;
  if (high.length >= 3) return '高优先级太多，今天只留 1 件必做';
  const hour = new Date(nowMs).getHours();
  if (hour >= 21) return '今天差不多了，只做最急的一件，早点休息';
  return '按顺序一件件推进，先做最重要的那件';
}

/**
 * Deterministic local advice used whenever the model cannot be used.
 * Flags overdue items, items due within 24 h, scope pressure, one item to defer, and one
 * concrete breakdown for the biggest item.
 *
 * @param {Array<object>} todos
 * @param {Date | number | string} [now]
 * @param {object} [options]
 * @returns {{ headline: string, tips: Array<{ text: string, kind: string }>, priorityOrder: string[], generatedAt: string, source: 'fallback' }}
 */
export function heuristicAdvice(todos, now = new Date(), options = {}) {
  const nowMs = toTime(now) ?? Date.now();
  const generatedAt = isoOf(nowMs);
  const open = openTodos(todos);
  if (open.length === 0) {
    return {
      headline: '暂时没有待办，先享受一下空档',
      tips: [{ text: '可以花 5 分钟列出明天最重要的 3 件事', kind: 'focus' }],
      priorityOrder: [],
      generatedAt,
      source: 'fallback',
    };
  }

  const order = heuristicPriorityOrder(open, nowMs);
  const byId = new Map(open.map((todo) => [todo.id, todo]));
  const overdue = open
    .filter((todo) => {
      const dueAt = toTime(todo.dueAt);
      return dueAt != null && dueAt < nowMs;
    })
    .sort(compareByDue);
  const soon = open
    .filter((todo) => {
      const dueAt = toTime(todo.dueAt);
      return dueAt != null && dueAt >= nowMs && dueAt - nowMs <= DAY_MS;
    })
    .sort(compareByDue);
  const high = open.filter((todo) => priorityOf(todo) === 1);

  const tips = [];
  const seenTexts = new Set();
  const addTip = (text, kind) => {
    if (tips.length >= MAX_TIPS) return;
    const body = clip(text, MAX_TIP_CHARS);
    if (body === '' || seenTexts.has(body)) return;
    seenTexts.add(body);
    tips.push({ text: body, kind: TIP_KINDS.includes(kind) ? kind : 'focus' });
  };

  for (const todo of overdue.slice(0, 2)) {
    addTip(`「${clip(todoText(todo), 16)}」已经逾期，先花 15 分钟处理或直接改期`, 'deadline');
  }
  for (const todo of soon.slice(0, 2)) {
    addTip(`「${clip(todoText(todo), 16)}」24 小时内到期，今天优先保住这个截止时间`, 'deadline');
  }

  const firstTodo = byId.get(order[0]);
  if (firstTodo) addTip(`先动手做「${clip(todoText(firstTodo), 16)}」，不要同时开三件事`, 'focus');

  const breakdownTarget = pickBreakdownTarget(open);
  if (breakdownTarget) {
    addTip(`把「${clip(todoText(breakdownTarget), 16)}」拆成 3 个 25 分钟的小节，先只做第一步`, 'breakdown');
  }

  if (high.length >= 3) {
    addTip(`高优先级有 ${high.length} 件，今天最多只留 1 件必做，其余降级`, 'scope');
  }

  const deferTarget = pickDeferTarget(open, order);
  if (deferTarget) {
    addTip(`「${clip(todoText(deferTarget), 16)}」不急，挪到本周晚些时候也不会误事`, 'scope');
  }

  if (open.length >= 6) {
    addTip(`待办有 ${open.length} 件，今天挑 3 件做完就够了`, 'scope');
  }

  const hour = new Date(nowMs).getHours();
  if (hour >= 21) {
    addTip(`已经 ${hhmm(nowMs)} 了，今天只做最急的 1 件，其余留给明天`, 'rest');
  } else if (overdue.length + soon.length >= 3) {
    addTip('先把时间留给截止最近的两件，其余的明天再排', 'rest');
  }

  return {
    headline: adviceHeadline(open, overdue, soon, high, nowMs),
    tips,
    priorityOrder: order,
    generatedAt,
    source: 'fallback',
  };
}

/**
 * Validate and normalize a parsed model advice result against the contract.
 * Drops unknown ids from `priorityOrder` (then appends the remaining open todos in
 * heuristic order), coerces `kind` into the allowed set, and fills
 * `generatedAt` / `source` / a fallback headline.
 *
 * @param {unknown} raw parsed model JSON
 * @param {Array<object>} todos the open todos the advice must stay within
 * @param {Date | number | string} [now]
 * @param {object} [options]
 * @returns {{ headline: string, tips: Array<{ text: string, kind: string }>, priorityOrder: string[], generatedAt: string, source: 'model' } | null}
 *          null when nothing usable survived validation (caller must fall back).
 */
export function normalizeAdvice(raw, todos, now = new Date(), options = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const nowMs = toTime(now) ?? Date.now();
  const open = openTodos(todos);
  const allowed = new Set(open.map((todo) => todo.id));

  const tips = [];
  const seenTexts = new Set();
  const rawTips = Array.isArray(raw.tips) ? raw.tips : [];
  for (const entry of rawTips) {
    if (tips.length >= MAX_TIPS) break;
    let text = '';
    let kind = 'focus';
    if (typeof entry === 'string') {
      text = entry.trim();
    } else if (entry && typeof entry === 'object') {
      text = typeof entry.text === 'string' ? entry.text.trim() : '';
      if (TIP_KINDS.includes(entry.kind)) kind = entry.kind;
    } else {
      continue;
    }
    if (text === '' || seenTexts.has(text)) continue;
    seenTexts.add(text);
    tips.push({ text: clip(text, MAX_TIP_CHARS), kind });
  }

  const headline = typeof raw.headline === 'string' && raw.headline.trim() !== ''
    ? clip(raw.headline, MAX_HEADLINE_CHARS)
    : null;
  if (headline == null && tips.length === 0) return null;

  const priorityOrder = [];
  if (Array.isArray(raw.priorityOrder)) {
    for (const entry of raw.priorityOrder) {
      if (typeof entry !== 'string') continue;
      const id = entry.trim();
      if (id === '' || !allowed.has(id) || priorityOrder.includes(id)) continue;
      priorityOrder.push(id);
    }
  }
  for (const id of heuristicPriorityOrder(open, nowMs)) {
    if (!priorityOrder.includes(id)) priorityOrder.push(id);
  }

  const overdue = open.filter((todo) => {
    const dueAt = toTime(todo.dueAt);
    return dueAt != null && dueAt < nowMs;
  });
  const soon = open.filter((todo) => {
    const dueAt = toTime(todo.dueAt);
    return dueAt != null && dueAt >= nowMs && dueAt - nowMs <= DAY_MS;
  });
  const high = open.filter((todo) => priorityOf(todo) === 1);

  return {
    headline: headline ?? adviceHeadline(open, overdue, soon, high, nowMs),
    tips,
    priorityOrder,
    generatedAt: isoOf(nowMs),
    source: 'model',
  };
}

/* ------------------------------------------------------------------------- *
 * Tagging heuristic (fallback path)
 * ------------------------------------------------------------------------- */

/**
 * Practical tag groups used by the local classifier. A note is matched against every group;
 * the group with the most keyword hits wins, an exact tie adds the second group as a second
 * tag, and a note with no hit at all is filed under {@link DEFAULT_TAG}. Latin keywords need a
 * word boundary so "read" does not fire inside "already"; Chinese keywords are substrings.
 */
const TAG_RULES = [
  {
    tag: '工作',
    keywords: [
      '工作', '上班', '加班', '开会', '会议', '周报', '日报', '月报', '报告', '汇报',
      '项目', '需求', '评审', '排期', '上线', '发布', '部署', '代码', '开发', '联调',
      '测试', '文档', '邮件', '老板', '领导', '同事', '客户', '甲方', '合同', '面试',
      '简历', '述职', '绩效', '出差', '任务', '方案', '设计稿', '产品', '运营', '报表',
      '演示', '提案', '对接', 'bug', 'work', 'meeting', 'standup', 'report', 'project',
      'deadline', 'client', 'boss', 'email', 'code', 'coding', 'deploy', 'release',
      'review', 'presentation', 'interview', 'resume', 'overtime', 'task', 'sprint',
      'jira', 'docs', 'launch', 'office',
    ],
  },
  {
    tag: '学习',
    keywords: [
      '学习', '复习', '预习', '考试', '备考', '上课', '课程', '作业', '论文', '读书',
      '看书', '单词', '英语', '数学', '刷题', '做题', '题库', '题目', '笔记', '培训',
      '讲座', '网课', '教程', '练习', '认证', '证书', '考研', '考公', '雅思', '托福',
      'study', 'exam', 'learn', 'learning', 'course', 'homework', 'assignment', 'paper',
      'thesis', 'reading', 'book', 'vocabulary', 'english', 'math', 'lecture', 'tutorial',
      'practice', 'certificate', 'training',
    ],
  },
  {
    tag: '生活',
    keywords: [
      '生活', '购物', '超市', '买菜', '做饭', '洗碗', '吃饭', '外卖', '打扫', '清洁',
      '洗衣', '整理房间', '搬家', '水电', '快递', '取件', '理发', '宠物', '旅行', '旅游',
      '出行', '订票', '机票', '酒店', '收拾', '家务', '垃圾', '电影', '娱乐', '游戏',
      '逛街', '买', 'shopping', 'groceries', 'cook', 'cooking', 'clean', 'laundry',
      'rent', 'home', 'house', 'travel', 'trip', 'flight', 'hotel', 'pet', 'hair', 'buy',
    ],
  },
  {
    tag: '健康',
    keywords: [
      '健身', '锻炼', '运动', '跑步', '骑行', '游泳', '瑜伽', '拉伸', '体检', '看病',
      '医院', '医生', '吃药', '药店', '睡觉', '早睡', '睡眠', '休息', '散步', '篮球',
      '足球', '羽毛球', '乒乓球', '爬山', '牙医', '牙齿', '减肥', '体重', '血压', '血糖',
      '疫苗', '打针', '康复', '冥想', 'gym', 'workout', 'exercise', 'running', 'swim',
      'yoga', 'walk', 'doctor', 'hospital', 'medicine', 'sleep', 'rest', 'dentist',
      'checkup', 'vaccine', 'weight', 'diet', 'meditation',
    ],
  },
  {
    tag: '财务',
    keywords: [
      '财务', '记账', '预算', '报销', '发票', '工资', '薪水', '收入', '支出', '缴费',
      '水电费', '房贷', '车贷', '信用卡', '还款', '贷款', '房租', '租金', '保险', '理财',
      '基金', '股票', '投资', '存钱', '省钱', '账单', '税费', '转账', '银行', '退款',
      '花呗', 'budget', 'finance', 'invoice', 'receipt', 'salary', 'payment', 'bill',
      'loan', 'credit', 'mortgage', 'insurance', 'invest', 'tax', 'bank', 'refund',
      'expense', 'money',
    ],
  },
  {
    tag: '社交',
    keywords: [
      '社交', '聚会', '请客', '朋友', '同学', '见面', '生日', '礼物', '婚礼', '聚餐',
      '团建', '拜访', '联系', '沟通', '电话', '微信', '回复消息', '约会', '相亲', '邀请',
      '志愿者', '社区', 'friend', 'party', 'birthday', 'gift', 'wedding', 'dinner',
      'lunch', 'chat', 'invite', 'social', 'gather', 'reunion', 'call',
    ],
  },
  {
    tag: '想法',
    keywords: [
      '想法', '点子', '灵感', '创意', '思考', '复盘', '总结', '计划', '目标', '梦想',
      '愿望', '日记', '感悟', '反思', '构思', '头脑风暴', '脑暴', 'idea', 'ideas',
      'brainstorm', 'thinking', 'plan', 'goal', 'diary', 'journal', 'reflect',
      'reflection',
    ],
  },
];

/** The catch-all group used when no keyword matched. */
const DEFAULT_TAG = '事务';

/** Group labels in display order; also the deterministic tie-break for summary counts. */
const TAG_ORDER = [...TAG_RULES.map((rule) => rule.tag), DEFAULT_TAG];

/** Compiled keyword matchers, built once per keyword. */
const keywordMatchers = new Map();

/**
 * Build (and cache) the matcher for one keyword.
 * @param {string} keyword lower-case keyword.
 * @returns {(haystack: string) => boolean} the matcher.
 */
function keywordMatcher(keyword) {
  const cached = keywordMatchers.get(keyword);
  if (cached) return cached;
  let matcher;
  if (/^[a-z0-9][a-z0-9 .+#-]*$/.test(keyword)) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`);
    matcher = (haystack) => regex.test(haystack);
  } else {
    matcher = (haystack) => haystack.includes(keyword);
  }
  keywordMatchers.set(keyword, matcher);
  return matcher;
}

/** The text the classifier reads: title plus note body, lower-cased and space-normalised. */
function tagHaystack(todo) {
  const text = typeof todo.text === 'string' ? todo.text : '';
  const note = typeof todo.note === 'string' ? todo.note : '';
  return `${text} ${note}`.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Deterministic 1–2 tags for one note.
 * @param {object} todo open note.
 * @param {number} limit maximum number of tags to keep.
 * @returns {string[]} the tags.
 */
function tagForTodo(todo, limit) {
  const haystack = tagHaystack(todo);
  const scored = TAG_RULES.map((rule, order) => {
    let hits = 0;
    for (const keyword of rule.keywords) {
      if (keywordMatcher(keyword)(haystack)) hits += 1;
    }
    return { tag: rule.tag, hits, order };
  }).sort((a, b) => b.hits - a.hits || a.order - b.order);

  const best = scored[0];
  if (!best || best.hits === 0) return [DEFAULT_TAG].slice(0, limit);
  const tags = [best.tag];
  const second = scored[1];
  if (second && second.hits === best.hits) tags.push(second.tag);
  return tags.slice(0, limit);
}

/**
 * Count how many notes each tag covers.
 * @param {Array<{ tags: string[] }>} items tagging items.
 * @returns {Map<string, number>} tag → note count.
 */
function countTags(items) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const item of items) {
    for (const tag of item.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return counts;
}

/**
 * Chinese one-line summary of a tagging result, groups ordered by size then by group order.
 * @param {Map<string, number>} counts tag → note count.
 * @param {number} total number of open notes considered.
 * @returns {string} the summary.
 */
function tagSummary(counts, total) {
  if (total <= 0) return '当前没有待办，暂时不用整理标签。';
  const entries = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || TAG_ORDER.indexOf(a[0]) - TAG_ORDER.indexOf(b[0]),
  );
  const parts = entries.map(([tag, count]) => `${tag} ${count} 项`);
  return clip(`已按 ${entries.length} 组整理 ${total} 项待办：${parts.join('、')}`, MAX_TAG_SUMMARY_CHARS);
}

/**
 * Deterministic local tagger used whenever the model cannot be used.
 *
 * Every open note gets 1–2 tags from the keyword groups; a note that matches no group is
 * filed under 事务. Existing tags are not consulted, so the same board produces the same
 * items for the same `now`.
 *
 * @param {Array<object>} todos the board.
 * @param {Date | number | string} [now] reference clock (only used for `generatedAt`).
 * @param {{ maxTags?: number }} [options] optional tag-count cap (1–3).
 * @returns {{ summary: string, items: Array<{ id: string, tags: string[] }>, generatedAt: string, source: 'fallback' }}
 */
export function heuristicTagging(todos, now = new Date(), options = {}) {
  const nowMs = toTime(now) ?? Date.now();
  const limit = clampInt(options && options.maxTags, 1, MAX_TAG_COUNT, MAX_TAG_COUNT);
  const open = openTodos(todos);
  const items = open.map((todo) => ({ id: todo.id, tags: tagForTodo(todo, limit) }));
  return {
    summary: tagSummary(countTags(items), open.length),
    items,
    generatedAt: isoOf(nowMs),
    source: 'fallback',
  };
}

/**
 * Canonicalise the tags the model proposed for one note. A malformed item (a fourth tag, an
 * over-long tag) is salvaged by keeping the leading usable tags; nothing usable → `[]`.
 * @param {unknown} value raw `tags` from one model item.
 * @returns {string[]} canonical tags (may be empty).
 */
function modelTags(value) {
  try {
    return normalizeTags(value);
  } catch (error) {
    // fall through to the salvage path
  }
  /** @type {unknown[]} */
  const candidates = typeof value === 'string'
    ? value.split(/[,，;；、\s]+/)
    : Array.isArray(value)
      ? value
      : [];
  /** @type {string[]} */
  const kept = [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    try {
      const single = normalizeTags([candidate]);
      if (single.length > 0) kept.push(single[0]);
    } catch (error) {
      // drop this tag only
    }
    if (kept.length >= MAX_TAG_COUNT) break;
  }
  return kept;
}

/**
 * Validate and normalize a parsed model tagging result against the contract.
 * Drops unknown/duplicate ids and items whose tags do not survive canonicalisation (extra tags
 * are cut, over-long tags are dropped), keeps the model summary when it is a non-empty string,
 * and fills `generatedAt` / `source`.
 *
 * @param {unknown} raw parsed model JSON.
 * @param {Array<object>} todos the board the tagging must stay within.
 * @param {Date | number | string} [now]
 * @returns {{ summary: string, items: Array<{ id: string, tags: string[] }>, generatedAt: string, source: 'model' } | null}
 *          null when nothing usable survived validation (caller must fall back).
 */
export function normalizeTagging(raw, todos, now = new Date()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const nowMs = toTime(now) ?? Date.now();
  const open = openTodos(todos);
  if (open.length === 0) return null;

  const allowed = new Set(open.map((todo) => todo.id));
  const seen = new Set();
  const items = [];
  const rawItems = Array.isArray(raw.items) ? raw.items : [];

  for (const entry of rawItems) {
    if (items.length >= open.length) break;
    if (!entry || typeof entry !== 'object') continue;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (id === '' || !allowed.has(id) || seen.has(id)) continue;
    const tags = modelTags(entry.tags);
    if (tags.length === 0) continue;
    seen.add(id);
    items.push({ id, tags });
  }
  if (items.length === 0) return null;

  const summary = typeof raw.summary === 'string' && raw.summary.trim() !== ''
    ? clip(raw.summary.trim(), MAX_TAG_SUMMARY_CHARS)
    : tagSummary(countTags(items), open.length);

  return {
    summary,
    items,
    generatedAt: isoOf(nowMs),
    source: 'model',
  };
}

/* ------------------------------------------------------------------------- *
 * Per-note advice (conversational fallback + validation)
 * ------------------------------------------------------------------------- */

/** Chinese `M月D日 HH:MM` label for a deadline (local time). */
function dueLabel(ms) {
  const date = new Date(ms);
  return `${date.getMonth() + 1}月${date.getDate()}日 ${hhmm(ms)}`;
}

/**
 * Build the deterministic local suggestion for one note.
 *
 * The branches are ordered by urgency: overdue, due within 24 h, any other deadline, a note
 * with details, high priority, low priority, then the generic "shrink the first step" nudge.
 * Every branch embeds the note's own title (and details / deadline where they exist) and stays
 * within 60–160 characters so it reads like a coach, not a generic template.
 *
 * @param {object} todo the note.
 * @param {number} nowMs reference clock, epoch milliseconds.
 * @returns {string} the suggestion text.
 */
function noteAdviceText(todo, nowMs) {
  const title = clip(todoText(todo), 24);
  const details = typeof todo.note === 'string' ? todo.note.trim().replace(/\s+/g, ' ') : '';
  const detailSnippet = details === '' ? '' : clip(details, 40);
  const priority = priorityOf(todo);
  const dueAt = toTime(todo.dueAt);

  if (dueAt != null && dueAt < nowMs) {
    return `「${title}」已经逾期了，先花 20 分钟只做能推进它的第一步：比如先写出开头两段，或先把那条消息发出去；做完再决定是继续做完，还是和对方商量改期。`;
  }
  if (dueAt != null && dueAt - nowMs <= DAY_MS) {
    const when = `${dayLabel(dueAt, nowMs)} ${hhmm(dueAt)}`;
    if (detailSnippet !== '') {
      return `「${title}」${when} 前要交，详情里提到「${detailSnippet}」：先花 20 分钟把这一块做出最小可交付的一版，先交框架再补细节，剩下的明天上午再说。`;
    }
    return `「${title}」最晚 ${when} 要交，先花 20 分钟列出最小可交付的一版：先交框架再补细节，别一开始就追求完美，做完再看要不要继续。`;
  }
  if (dueAt != null) {
    const when = dueLabel(dueAt);
    if (detailSnippet !== '') {
      return `「${title}」${when} 到期，时间还够：今天先花 25 分钟做详情里「${clip(details, 24)}」的第一步，把剩下两步写进备注，剩下的明天再继续，别都留到最后一天。`;
    }
    return `「${title}」${when} 到期，时间还够：今天先花 25 分钟做出第一步，把剩下两步写进备注，明天再继续，这样到最后一天不会全堆在一起。`;
  }
  if (detailSnippet !== '') {
    return `「${title}」详情里写到「${detailSnippet}」：先把最不确定的那一点写下来，再花 20 分钟做出一个能看的草稿，卡住的地方先用一句话记到备注里。`;
  }
  if (priority === 1) {
    return `「${title}」优先级高，现在就定一个 25 分钟的专注时段：只做第一步，把任务拆成三个小动作并写下第一个，其余先排队，做完再决定要不要继续。`;
  }
  if (priority === 3) {
    return `「${title}」不急，排到本周一个固定的 30 分钟空档里做完就好：先定一个提醒时间，再写下第一步是什么，避免一直拖着却始终没开始。`;
  }
  return `先花 20 分钟把「${title}」拆出第一步，只做这一小步；把结果写进备注，做完再决定要不要继续，别一上来就想把整件事做完，先让事情动起来。`;
}

/**
 * Deterministic local suggestion for one note, used whenever the model cannot be used.
 * Never asks a question: the fallback path always answers with advice.
 *
 * @param {object} todo the note.
 * @param {number} [round] number of questions already asked in the history; echoed in the result.
 * @param {Date | number | string} [now] reference clock (only drives the deadline wording).
 * @returns {{ kind: 'advice', advice: { text: string, source: 'fallback' }, round: number }}
 */
export function heuristicNoteAdvice(todo, round = 0, now = new Date()) {
  const nowMs = toTime(now) ?? Date.now();
  const note = todo && typeof todo === 'object' ? todo : {};
  const safeRound = clampInt(round, 0, MAX_ADVICE_HISTORY, 0);
  const text = clip(noteAdviceText(note, nowMs), MAX_ADVICE_CHARS);
  return { kind: 'advice', advice: { text, source: 'fallback' }, round: safeRound };
}

/** First non-empty trimmed string among the candidates ('' when none is usable). */
function firstText(candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (trimmed !== '') return trimmed;
    }
  }
  return '';
}

/**
 * Canonicalise one raw model `options` list.
 *
 * Non-string entries are dropped, every option is trimmed, over-long options are clipped to
 * `maxChars` (never rejected), duplicates are removed case-insensitively while keeping the first
 * spelling, and the list is capped at `max` entries. Malformed input yields an empty list.
 *
 * @param {unknown} value raw `options` value from the model.
 * @param {{ max: number, maxChars: number }} limits maximum count and maximum option length.
 * @returns {string[]} the usable options (possibly empty).
 */
function modelOptions(value, limits) {
  if (!Array.isArray(value)) return [];
  /** @type {string[]} */
  const options = [];
  const seen = new Set();
  for (const entry of value) {
    if (options.length >= limits.max) break;
    if (typeof entry !== 'string') continue;
    const text = clip(entry.trim(), limits.maxChars);
    if (text === '') continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(text);
  }
  return options;
}

/**
 * Question choices: 2–4 distinct short answers. A question without that many usable choices is
 * invalid (the caller returns null and the layer falls back to advice).
 * @param {unknown} value raw `options` value from the model.
 * @returns {string[] | null} the validated options, or null when fewer than two survive.
 */
function questionOptions(value) {
  const options = modelOptions(value, { max: MAX_QUESTION_OPTIONS, maxChars: MAX_QUESTION_OPTION_CHARS });
  return options.length >= MIN_QUESTION_OPTIONS ? options : null;
}

/**
 * Advice alternatives: 0–3 concrete suggestions. An empty list means "no alternatives" and the
 * field is omitted from the result.
 * @param {unknown} value raw `options` value from the model.
 * @returns {string[]} the usable alternatives (possibly empty).
 */
function adviceOptions(value) {
  return modelOptions(value, { max: MAX_ADVICE_OPTIONS, maxChars: MAX_ADVICE_OPTION_CHARS });
}

/**
 * Validate and normalize one parsed model reply for the per-note conversation.
 *
 * Accepts the flat form the prompt asks for (`{kind:'advice', text, options}` /
 * `{kind:'question', question, options}`) and, leniently, a nested `advice.text` /
 * `advice.options`. Trims and clamps the text (advice ≤ 400, question ≤ 120 characters),
 * canonicalises `options`, infers the kind when `kind` is missing or invalid, and enforces the
 * two hard rules: a `question` is rejected once `round >= 3`, and a `question` **without at
 * least two usable short options** is rejected too (the caller then falls back to advice, so the
 * client never shows a question without choices). Advice alternatives are optional and clamped
 * to three; an empty list is omitted from the result.
 *
 * @param {unknown} raw parsed model JSON.
 * @param {number} round number of questions already asked in the history (0–3).
 * @returns {{ kind: 'advice', advice: { text: string, options?: string[], source: 'model' }, round: number }
 *         | { kind: 'question', question: string, options: string[], round: number, source: 'model' }
 *         | null} the validated result, or null when nothing usable survived.
 */
export function normalizeNoteAdvice(raw, round) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const safeRound = clampInt(round, 0, MAX_ADVICE_HISTORY, 0);
  const adviceText = firstText([
    raw.text,
    raw.advice && typeof raw.advice === 'object' ? raw.advice.text : undefined,
  ]);
  const questionText = firstText([raw.question]);
  const nestedOptions = raw.advice && typeof raw.advice === 'object' ? raw.advice.options : undefined;
  const rawOptions = Array.isArray(raw.options) ? raw.options : nestedOptions;

  let kind = raw.kind === 'advice' || raw.kind === 'question' ? raw.kind : '';
  if (kind === 'advice' && adviceText === '') kind = '';
  if (kind === 'question' && questionText === '') kind = '';
  if (kind === '') {
    if (adviceText !== '') kind = 'advice';
    else if (questionText !== '' && safeRound < MAX_ADVICE_HISTORY) kind = 'question';
    else return null;
  }

  if (kind === 'question') {
    // The Host may ask at most three questions: the model's fourth question becomes advice
    // via the caller's fallback, never another question.
    if (safeRound >= MAX_ADVICE_HISTORY) return null;
    const options = questionOptions(raw.options);
    // A question without choices is unusable: fall back to advice rather than showing the user
    // a question they cannot answer with one click.
    if (options === null) return null;
    return {
      kind: 'question',
      question: clip(questionText, MAX_QUESTION_CHARS),
      options,
      round: safeRound,
      source: 'model',
    };
  }

  /** @type {{ text: string, options?: string[], source: 'model' }} */
  const advice = { text: clip(adviceText, MAX_ADVICE_CHARS) };
  const alternatives = adviceOptions(rawOptions);
  if (alternatives.length > 0) advice.options = alternatives;
  advice.source = 'model';
  return {
    kind: 'advice',
    advice,
    round: safeRound,
  };
}

/**
 * Keep only the usable Q&A pairs from a history value, capped at three rounds.
 * @param {unknown} history raw history (the HTTP layer validates it strictly first).
 * @returns {Array<{ question: string, answer: string }>} the safe history.
 */
function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  /** @type {Array<{ question: string, answer: string }>} */
  const entries = [];
  for (const entry of history) {
    if (entries.length >= MAX_ADVICE_HISTORY) break;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const question = typeof entry.question === 'string' ? entry.question.trim() : '';
    const answer = typeof entry.answer === 'string' ? entry.answer.trim() : '';
    if (question === '' || answer === '') continue;
    entries.push({ question: clip(question, MAX_QUESTION_CHARS), answer: clip(answer, MAX_ANSWER_PROMPT_CHARS) });
  }
  return entries;
}

/* ------------------------------------------------------------------------- *
 * Prompt building
 * ------------------------------------------------------------------------- */

/** Compact Chinese payload describing the open todos for the model. */
function todoPayload(open, nowMs) {
  return open.slice(0, MAX_PROMPT_TODOS).map((todo) => {
    const dueAt = toTime(todo.dueAt);
    const priority = priorityOf(todo);
    const entry = {
      id: todo.id,
      text: clip(todoText(todo), 120),
      priority,
      priorityLabel: PRIORITY_LABELS[priority],
      dueAt: dueAt == null ? null : isoOf(dueAt),
      dueAtLocal: dueAt == null ? null : `${dayLabel(dueAt, nowMs)} ${hhmm(dueAt)}`,
      overdue: dueAt != null && dueAt < nowMs,
      durationMinutes: priorityDuration(todo),
    };
    const note = typeof todo.note === 'string' ? todo.note.trim() : '';
    if (note !== '') entry.note = clip(note, MAX_NOTE_CHARS);
    const existingPlan = toTime(todo.planAt);
    if (existingPlan != null) entry.existingPlanAt = isoOf(existingPlan);
    return entry;
  });
}

/** User prompt for the scheduling call: compact JSON plus local-time context. */
function buildPlanPrompt(open, nowMs, schedule) {
  const todos = todoPayload(open, nowMs);
  const payload = {
    now: isoOf(nowMs),
    nowLocal: `${dayLabel(nowMs, nowMs)} ${hhmm(nowMs)}`,
    timezone: schedule.timeZone,
    workingHours: `${schedule.workStartHour}:00-${schedule.workEndHour}:00`,
    todos,
  };
  const truncated = open.length > MAX_PROMPT_TODOS ? `\n（待办较多，只提供最紧急的 ${todos.length} 项）` : '';
  return [
    `当前本地时间：${payload.nowLocal}（${schedule.timeZone}）`,
    `工作时间：${payload.workingHours}`,
    `请为以下待办安排开始时间，返回严格 JSON：${truncated}`,
    JSON.stringify(payload),
  ].join('\n');
}

/** User prompt for the advice call. */
function buildAdvicePrompt(open, nowMs, schedule) {
  const todos = todoPayload(open, nowMs);
  const payload = {
    now: isoOf(nowMs),
    nowLocal: `${dayLabel(nowMs, nowMs)} ${hhmm(nowMs)}`,
    timezone: schedule.timeZone,
    todos,
  };
  const truncated = open.length > MAX_PROMPT_TODOS ? `\n（待办较多，只提供最紧急的 ${todos.length} 项）` : '';
  return [
    `当前本地时间：${payload.nowLocal}（${schedule.timeZone}）`,
    `请针对以下待办给出建议，返回严格 JSON：${truncated}`,
    JSON.stringify(payload),
  ].join('\n');
}

/** User prompt for the tagging call: id, text, optional note and the tags the note already has. */
function buildTagPrompt(open, nowMs) {
  const todos = open.slice(0, MAX_PROMPT_TODOS).map((todo) => {
    const entry = { id: todo.id, text: clip(todoText(todo), 120) };
    const note = typeof todo.note === 'string' ? todo.note.trim() : '';
    if (note !== '') entry.note = clip(note, MAX_NOTE_CHARS);
    const existing = Array.isArray(todo.tags) ? todo.tags.filter((tag) => typeof tag === 'string' && tag !== '') : [];
    if (existing.length > 0) entry.existingTags = existing.slice(0, MAX_TAG_COUNT);
    return entry;
  });
  const truncated = open.length > MAX_PROMPT_TODOS ? `\n（待办较多，只提供前 ${todos.length} 项）` : '';
  const payload = { now: isoOf(nowMs), nowLocal: `${dayLabel(nowMs, nowMs)} ${hhmm(nowMs)}`, todos };
  return [
    `当前本地时间：${payload.nowLocal}（${machineTimeZone()}）`,
    `请给以下待办分类打标签，返回严格 JSON：${truncated}`,
    JSON.stringify(payload),
  ].join('\n');
}

/** Compact Chinese description of one note for the per-note coach prompt. */
function noteAdvicePayload(todo, nowMs) {
  const dueAt = toTime(todo.dueAt);
  const remindAt = toTime(todo.remindAt);
  const planAt = toTime(todo.planAt);
  const priority = priorityOf(todo);
  const details = typeof todo.note === 'string' ? todo.note.trim() : '';
  const planNote = typeof todo.planNote === 'string' ? todo.planNote.trim() : '';
  const tags = Array.isArray(todo.tags) ? todo.tags.filter((tag) => typeof tag === 'string' && tag !== '') : [];
  const payload = {
    title: clip(todoText(todo), 120),
    details: details === '' ? '' : clip(details, MAX_DETAILS_PROMPT_CHARS),
    priority,
    priorityLabel: PRIORITY_LABELS[priority],
    overdue: dueAt != null && dueAt < nowMs,
    dueAt: dueAt == null ? null : isoOf(dueAt),
    dueAtLocal: dueAt == null ? null : `${dayLabel(dueAt, nowMs)} ${hhmm(dueAt)}`,
    remindAtLocal: remindAt == null ? null : `${dayLabel(remindAt, nowMs)} ${hhmm(remindAt)}`,
    planAtLocal: planAt == null ? null : `${dayLabel(planAt, nowMs)} ${hhmm(planAt)}`,
    tags,
    done: todo.done === true,
  };
  if (planNote !== '') payload.planNote = clip(planNote, MAX_NOTE_CHARS);
  return payload;
}

/** User prompt for the per-note advisory round: the note, the Q&A history and the round limit. */
function buildNoteAdvicePrompt(todo, history, round, nowMs) {
  const payload = {
    now: isoOf(nowMs),
    nowLocal: `${dayLabel(nowMs, nowMs)} ${hhmm(nowMs)}`,
    timezone: machineTimeZone(),
    round,
    remainingQuestions: Math.max(0, MAX_ADVICE_HISTORY - round),
    note: noteAdvicePayload(todo, nowMs),
    history: history.map((entry) => ({
      question: clip(entry.question, MAX_QUESTION_CHARS),
      answer: clip(entry.answer, MAX_ANSWER_PROMPT_CHARS),
    })),
  };
  const limitLine = round >= MAX_ADVICE_HISTORY
    ? `已经问过 ${MAX_ADVICE_HISTORY} 轮问题，这一轮必须直接给出建议，不要再追问。`
    : `这是第 ${round + 1} 轮，最多还可以再问 ${MAX_ADVICE_HISTORY - round} 个问题。`;
  return [
    `当前本地时间：${payload.nowLocal}（${payload.timezone}）`,
    limitLine,
    '请根据下面这条便签和对话历史回答，返回严格 JSON：',
    JSON.stringify(payload),
  ].join('\n');
}

/* ------------------------------------------------------------------------- *
 * Model call
 * ------------------------------------------------------------------------- */

/** Error type used internally so callers can distinguish our own failures. */
function aiFailure(code, message) {
  const error = new Error(message);
  error.name = 'AiLayerError';
  error.code = code;
  return error;
}

function errorMessage(error) {
  if (error && typeof error === 'object') {
    const message = typeof error.message === 'string' ? error.message : '';
    const code = typeof error.code === 'string' ? error.code : '';
    if (code && message) return `${code}: ${message}`;
    if (message) return message;
    if (code) return code;
  }
  return String(error == null ? '模型调用失败' : error);
}

/**
 * Extract one JSON object from model output. Tolerates a markdown fence the model may
 * add despite the instruction, then parses the outermost `{ ... }` slice.
 * @returns {object | null}
 */
function parseJsonObject(text) {
  if (typeof text !== 'string') return null;
  let source = text.trim();
  if (source === '') return null;
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(source);
  if (fenced) source = fenced[1].trim();
  const first = source.indexOf('{');
  const last = source.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const candidate = source.slice(first, last + 1);
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (error) {
      // fall through to the raw-text attempt
    }
  }
  try {
    const parsed = JSON.parse(source);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (error) {
    // not JSON at all
  }
  return null;
}

/**
 * Resolve the model route once per call: `config` overrides win over the shared
 * `agentDefaultModel` selection, and a registered-adapter sanity check keeps
 * `available()` honest.
 * @returns {{ ok: true, llm: object, provider: string, model: string, reasoningEffort?: string } | { ok: false, reason: string }}
 */
function resolveTarget(ctx, settings) {
  const llm = getService(ctx, 'llm');
  if (!llm || typeof llm !== 'object' || typeof llm.stream !== 'function') {
    return { ok: false, reason: '未启用大模型服务（llm）' };
  }

  let selection = null;
  const selector = getService(ctx, 'agentDefaultModel');
  if (selector && typeof selector.currentSelection === 'function') {
    try {
      selection = selector.currentSelection();
    } catch (error) {
      selection = null;
    }
  }

  const provider = readOption(settings, 'provider')
    || (selection && typeof selection.provider === 'string' ? selection.provider.trim() : '');
  const model = readOption(settings, 'model')
    || (selection && typeof selection.model === 'string' ? selection.model.trim() : '');
  if (!provider || !model) return { ok: false, reason: '还没有选择默认模型' };

  if (typeof llm.listProviders === 'function') {
    try {
      const providers = llm.listProviders();
      if (Array.isArray(providers) && providers.length > 0 && !providers.some((item) => item && item.id === provider)) {
        return { ok: false, reason: `模型服务「${provider}」未启用` };
      }
    } catch (error) {
      // A registry hiccup must not disable the feature; the call itself will report it.
    }
  }

  const configuredEffort = readOption(settings, 'reasoningEffort');
  const selectedEffort = selection && selection.reasoningEffort != null ? String(selection.reasoningEffort) : '';
  return {
    ok: true,
    llm,
    provider,
    model,
    reasoningEffort: configuredEffort || selectedEffort || undefined,
  };
}

/**
 * One bounded model call: build the request, iterate `StreamChunk`s, concatenate
 * `text-delta`s, and stop at the terminal `finish` chunk.
 *
 * @param {{ llm: object, provider: string, model: string, reasoningEffort?: string }} target
 * @param {string} system system prompt
 * @param {string} prompt user prompt
 * @param {number} timeoutMs hard bound for the whole call
 * @returns {Promise<string>} the trimmed model text (never empty)
 */
async function callModel(target, system, prompt, timeoutMs) {
  const controller = new AbortController();
  const timeoutError = aiFailure('ai_timeout', `模型响应超时（超过 ${timeoutMs} 毫秒）`);
  let timedOut = false;
  let timer = null;

  // The deadline is enforced by racing the iterator, not only by `signal`: an adapter that
  // ignores the signal and never yields must still not be able to hang plan()/advice().
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        controller.abort();
      } catch (error) {
        // abort() does not throw in practice
      }
      reject(timeoutError);
    }, timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  // The race below consumes this rejection only when the timeout wins; mark it handled.
  deadline.catch(() => {});

  let iterator = null;
  try {
    const request = {
      provider: target.provider,
      model: target.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      temperature: 0.2,
      maxTokens: 1200,
      signal: controller.signal,
    };
    if (target.reasoningEffort !== undefined) request.reasoningEffort = target.reasoningEffort;

    const stream = target.llm.stream(request);
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
      throw aiFailure('llm_failure', '模型服务没有返回可迭代的响应流');
    }
    iterator = stream[Symbol.asyncIterator]();

    let text = '';
    let failure = null;
    for (;;) {
      const next = iterator.next();
      if (next && typeof next.catch === 'function') next.catch(() => {});
      const step = await Promise.race([next, deadline]);
      if (!step || step.done) break;
      const chunk = step.value;
      if (!chunk || typeof chunk !== 'object') continue;
      if (chunk.type === 'text-delta') {
        if (typeof chunk.text === 'string') text += chunk.text;
        continue;
      }
      if (chunk.type === 'finish') {
        const reason = chunk.reason && typeof chunk.reason === 'object' ? chunk.reason : null;
        const kind = reason ? reason.kind : undefined;
        if (kind === 'error' || kind === 'aborted') {
          failure = reason && reason.failure && typeof reason.failure === 'object'
            ? reason.failure
            : { code: kind === 'aborted' ? 'ABORTED' : 'LLM_ERROR' };
        }
        break;
      }
    }

    if (timedOut) throw timeoutError;
    if (failure) throw aiFailure(String(failure.code || 'llm_failure'), String(failure.message || '模型调用失败'));
    const output = text.trim();
    if (output === '') throw aiFailure('ai_empty', '模型没有返回内容');
    return output;
  } catch (error) {
    if (timedOut) throw timeoutError;
    if (error && error.name === 'AiLayerError') throw error;
    throw aiFailure('llm_failure', errorMessage(error));
  } finally {
    clearTimeout(timer);
    // Asking the adapter to release the stream must never block us: fire and forget.
    try {
      const closed = iterator && typeof iterator.return === 'function' ? iterator.return() : undefined;
      if (closed && typeof closed.catch === 'function') closed.catch(() => {});
    } catch (error) {
      // ignore cleanup failures
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Public layer
 * ------------------------------------------------------------------------- */

/** Safe wrapper: the heuristic must never propagate a throw to `plan()`. */
function safeHeuristicPlan(open, now, schedule) {
  try {
    return heuristicPlan(open, now, schedule);
  } catch (error) {
    return {
      summary: '待办已经准备好，按优先级一件件来就行。',
      items: [],
      generatedAt: isoOf(toTime(now) ?? Date.now()),
      source: 'fallback',
    };
  }
}

/** Safe wrapper: the heuristic must never propagate a throw to `advice()`. */
function safeHeuristicAdvice(open, now, schedule) {
  try {
    return heuristicAdvice(open, now, schedule);
  } catch (error) {
    return {
      headline: '按优先级一件件推进',
      tips: [],
      priorityOrder: [],
      generatedAt: isoOf(toTime(now) ?? Date.now()),
      source: 'fallback',
    };
  }
}

/** Safe wrapper: the heuristic must never propagate a throw to `tag()`. */
function safeHeuristicTagging(open, now) {
  try {
    return heuristicTagging(open, now);
  } catch (error) {
    return {
      summary: '待办已经准备好，可以按标签分组查看。',
      items: [],
      generatedAt: isoOf(toTime(now) ?? Date.now()),
      source: 'fallback',
    };
  }
}

/** Safe wrapper: the fallback must never propagate a throw to `noteAdvice()`. */
function safeHeuristicNoteAdvice(todo, round) {
  try {
    return heuristicNoteAdvice(todo, round);
  } catch (error) {
    return {
      kind: 'advice',
      advice: {
        text: '先花 20 分钟把这张便签的第一步做完：写下结果再决定下一步，别一上来就想着把整件事做完，先让事情真的动起来。',
        source: 'fallback',
      },
      round: clampInt(round, 0, MAX_ADVICE_HISTORY, 0),
    };
  }
}

/**
 * Create the Host AI layer.
 *
 * @param {object} ctx Cordis plugin context. `ctx.get('llm')` and
 *        `ctx.get('agentDefaultModel')` are both optional; the layer still works with a
 *        stub context (everything then falls back to the local heuristic).
 * @param {object} [config] plugin config. Recognized keys:
 *        `aiTimeoutMs` (call bound, 3 s–3 min; `timeoutMs` is accepted as an alias),
 *        `logger(message)` (diagnostic line when a model call falls back),
 *        `provider` / `model` / `reasoningEffort` (override the shared default model),
 *        `timeZone`, `workStartHour`, `workEndHour`, `breakMinutes`, `leadMinutes`,
 *        `deadlineBufferMinutes`, `horizonDays` (heuristic schedule shaping).
 * @returns {{
 *   available: () => { available: boolean, reason: string | null },
 *   plan: (todos: Array<object>) => Promise<object>,
 *   advice: (todos: Array<object>) => Promise<object>,
 *   tag: (todos: Array<object>) => Promise<object>,
 *   noteAdvice: (todo: object, history?: Array<{ question: string, answer: string }>) => Promise<object>,
 * }}
 */
export function createAiLayer(ctx, config) {
  const settings = config && typeof config === 'object' ? config : {};
  // `aiTimeoutMs` is the documented key; `timeoutMs` is accepted because the Host entry
  // passes the resolved plugin timeout under that name.
  const configuredTimeout = readOption(settings, 'aiTimeoutMs') ?? readOption(settings, 'timeoutMs');
  const timeoutMs = clampInt(configuredTimeout, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  /** Report one line through the host-provided logger; logging never changes a result. */
  const log = (message) => {
    try {
      const logger = readOption(settings, 'logger');
      if (typeof logger === 'function') logger(message);
    } catch (error) {
      // ignore logger failures
    }
  };

  return {
    /**
     * Synchronous capability probe (cheap: no network, no timer).
     * @returns {{ available: boolean, reason: string | null }}
     */
    available() {
      try {
        const target = resolveTarget(ctx, settings);
        if (target.ok) return { available: true, reason: null };
        return { available: false, reason: target.reason };
      } catch (error) {
        return { available: false, reason: 'AI 服务不可用' };
      }
    },

    /**
     * Produce a concrete schedule for the open todos.
     * Never throws: the model is tried first, and any failure returns the local
     * heuristic with `source: 'fallback'`.
     * @param {Array<object>} todos
     * @returns {Promise<{ summary: string, items: Array<{ id: string, planAt: string, note: string }>, generatedAt: string, source: 'model' | 'fallback' }>}
     */
    async plan(todos) {
      const now = new Date();
      const open = openTodos(todos);
      let schedule;
      try {
        schedule = scheduleOptionsFromConfig(settings);
      } catch (error) {
        schedule = resolveScheduleOptions({});
      }
      if (open.length > 0) {
        try {
          const target = resolveTarget(ctx, settings);
          if (target.ok) {
            const text = await callModel(target, PLAN_SYSTEM_PROMPT, buildPlanPrompt(open, now.getTime(), schedule), timeoutMs);
            const parsed = parseJsonObject(text);
            const normalized = normalizePlan(parsed, open, now, schedule);
            if (normalized) return normalized;
            log('AI 排程返回的内容未通过校验，改用本地规则');
          }
        } catch (error) {
          // Any model-path failure degrades to the deterministic heuristic below.
          log(`AI 排程失败，改用本地规则：${errorMessage(error)}`);
        }
      }
      return safeHeuristicPlan(open, now, schedule);
    },

    /**
     * Produce prioritized, actionable advice for the open todos.
     * Never throws: the model is tried first, and any failure returns the local
     * heuristic with `source: 'fallback'`.
     * @param {Array<object>} todos
     * @returns {Promise<{ headline: string, tips: Array<{ text: string, kind: string }>, priorityOrder: string[], generatedAt: string, source: 'model' | 'fallback' }>}
     */
    async advice(todos) {
      const now = new Date();
      const open = openTodos(todos);
      let schedule;
      try {
        schedule = scheduleOptionsFromConfig(settings);
      } catch (error) {
        schedule = resolveScheduleOptions({});
      }
      if (open.length > 0) {
        try {
          const target = resolveTarget(ctx, settings);
          if (target.ok) {
            const text = await callModel(target, ADVICE_SYSTEM_PROMPT, buildAdvicePrompt(open, now.getTime(), schedule), timeoutMs);
            const parsed = parseJsonObject(text);
            const normalized = normalizeAdvice(parsed, open, now, schedule);
            if (normalized) return normalized;
            log('AI 建议返回的内容未通过校验，改用本地规则');
          }
        } catch (error) {
          // Any model-path failure degrades to the deterministic heuristic below.
          log(`AI 建议失败，改用本地规则：${errorMessage(error)}`);
        }
      }
      return safeHeuristicAdvice(open, now, schedule);
    },

    /**
     * Classify the open todos into 1–3 short Chinese tags each.
     * Never throws: the model is tried first, and any failure (or output that does not pass
     * `normalizeTagging`) returns the local keyword classifier with `source: 'fallback'`.
     * @param {Array<object>} todos
     * @returns {Promise<{ summary: string, items: Array<{ id: string, tags: string[] }>, generatedAt: string, source: 'model' | 'fallback' }>}
     */
    async tag(todos) {
      const now = new Date();
      const open = openTodos(todos);
      if (open.length > 0) {
        try {
          const target = resolveTarget(ctx, settings);
          if (target.ok) {
            const text = await callModel(target, TAG_SYSTEM_PROMPT, buildTagPrompt(open, now.getTime()), timeoutMs);
            const parsed = parseJsonObject(text);
            const normalized = normalizeTagging(parsed, open, now);
            if (normalized) return normalized;
            log('AI 打标签返回的内容未通过校验，改用本地规则');
          }
        } catch (error) {
          // Any model-path failure degrades to the deterministic keyword classifier below.
          log(`AI 打标签失败，改用本地规则：${errorMessage(error)}`);
        }
      }
      return safeHeuristicTagging(open, now);
    },

    /**
     * One round of the per-note advisory conversation.
     *
     * Never throws. The model is asked for either one concrete suggestion or one short
     * follow-up question (at most three questions in total); when the model is unavailable,
     * fails, times out, or returns output that `normalizeNoteAdvice` cannot salvage — including
     * a fourth question — the deterministic local suggestion is returned instead. Both paths
     * report `round = history.length`, so the client always knows which round was answered.
     *
     * @param {object} todo the note the user is asking about.
     * @param {Array<{ question?: unknown, answer?: unknown }>} [history] Q&A pairs so far (0–3).
     * @returns {Promise<
     *   { kind: 'advice', advice: { text: string, source: 'model' | 'fallback' }, round: number }
     *   | { kind: 'question', question: string, round: number, source: 'model' }
     * >}
     */
    async noteAdvice(todo, history = []) {
      const note = todo && typeof todo === 'object' ? todo : {};
      const rounds = safeHistory(history);
      const round = rounds.length;
      const now = new Date();
      try {
        const target = resolveTarget(ctx, settings);
        if (target.ok) {
          const text = await callModel(
            target,
            NOTE_ADVICE_SYSTEM_PROMPT,
            buildNoteAdvicePrompt(note, rounds, round, now.getTime()),
            timeoutMs,
          );
          const normalized = normalizeNoteAdvice(parseJsonObject(text), round);
          if (normalized) return normalized;
          log('AI 便签建议返回的内容未通过校验，改用本地规则');
        }
      } catch (error) {
        // Any model-path failure degrades to the deterministic suggestion below.
        log(`AI 便签建议失败，改用本地规则：${errorMessage(error)}`);
      }
      return safeHeuristicNoteAdvice(note, round);
    },
  };
}

export default createAiLayer;
