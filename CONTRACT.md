# Sticker TODO plugin — shared contract

Bundle directory: the repository root (`.`)

Package name: `dsh-sticker-todo`
Loader row id: `sticker-todo`
Client panel id (the `main` slot key): `sticker-todo`
Sidebar panellist entry id: `sticker-todo`
Client locale namespace: `stickerTodo`

## File ownership (do not edit files owned by someone else)

| File | Owner |
|---|---|
| `package.json`, `cordis.patch.yml`, `icon.svg`, `locale/*.json` | Lead |
| `index.js`, `lib/ai.js` | unchanged in round 6 |
| `lib/store.js`, `lib/tools.js` | unchanged in round 6 |
| `client.js`, `verify/client-render.mjs` | ui-panel (round 6: view modes) |
| `verify/host-actions.mjs`, `verify/api-smoke.mjs`, `verify/check-static.mjs` | Lead |
| `CONTRACT.md`, `README.md`, `HANDOFF.md` | Lead |

Round 2 (v1.1.0, "AI 分类打标签") changed: Todo gains `tags`, POST action `aiTag`, TagResult,
and the host/client notes below. Anything not listed here keeps its v1.0.0 behaviour.

Round 3 (v1.2.0, "新建便签弹窗 + 每张便签的 AI 建议 + 字体/分组") changes the panel UX and adds
the POST action `aiNoteAdvice`. It introduces **no Todo field change**: `text` is the note **标题**
(required, short) and `note` is the **详情** (long, multi-line) — the same fields, relabelled by the
client. Everything else below stays in force.

Round 4 (v1.3.0, "去掉全局建议 + 可选项式 AI 建议 + 动效与美化") adds `options` to
`NoteAdviceResult`, removes the board-wide advice button from the panel, and reworks the client's
motion and visual design. No Todo field change. Host work is limited to `lib/ai.js` (prompt +
`normalizeNoteAdvice` carry/validate `options`).

Round 5 (v1.4.0, "双语界面") is client-only: the panel gains its own language switch
(自动 / 中文 / English) on top of the existing DSH-locale dictionaries. No host change, no API change.

Round 6 (v1.5.0, "双视图：便利贴 / 极简列表") is client-only: a view-format switch next to the
font/language controls, a minimal title-only list with click-to-expand details, persisted locally.
No host change, no Todo field change, no API change.


## Host HTTP API (the only host<->client data path)

The Host half registers one prefix route: `ctx.webServer.register({ kind: 'prefix', path: '/dsh-todo', handler })`.
Everything is JSON, UTF-8. Same-origin `fetch` from the Client half. No auth token (loopback Web GUI).

### GET /dsh-todo/state
Response `200`:
```json
{
  "ok": true,
  "data": {
    "now": "2026-11-03T14:30:00.000Z",
    "todos": [ /* Todo[] sorted: not done first, then dueAt asc nulls last, then createdAt asc */ ],
    "dueReminders": [ /* Todo[] whose remindAt <= now, done === false, remindFiredAt === null */ ],
    "ai": { "available": true, "reason": null }
  }
}
```

### POST /dsh-todo/action
Request body `{ "action": "<name>", ...params }`. Response `200` with `{ "ok": true, "data": <result> }`
or `{ "ok": false, "error": { "code": "<code>", "message": "<human readable>" } }`.
Unknown action => code `unknown_action`. Validation failure => `invalid_input`. AI failure => `ai_unavailable`.

Actions:

| action | params | result |
|---|---|---|
| `add` | `text` (required), `note?`, `dueAt?`, `remindAt?`, `priority?` (1..3, default 2), `color?`, `tags?` | the created Todo |
| `update` | `id` (required), plus any of `text`, `note`, `dueAt`, `remindAt`, `priority`, `color`, `tags` | the updated Todo |
| `toggle` | `id`, `done?` (boolean; toggles when omitted) | the updated Todo |
| `remove` | `id` | `{ "removed": "<id>" }` |
| `clearCompleted` | — | `{ "removed": n }` |
| `ackReminders` | `ids: string[]` | `{ "acked": n }` — sets `remindFiredAt` |
| `aiPlan` | — | `{ "plan": PlanResult, "todos": Todo[] }` — applies `planAt` to todos and returns the fresh list |
| `aiAdvice` | — | `{ "advice": AdviceResult }` |
| `aiClearPlan` | — | `{ "todos": Todo[] }` — clears `planAt` |
| `aiTag` | — | `{ "tagResult": TagResult, "todos": Todo[] }` — classifies every open note **that has no tags yet** (already-tagged notes are never overwritten), writes `tags`, returns the fresh list |
| `aiNoteAdvice` | `id` (required), `history?`: `[{ question, answer }]` (0–3 entries) | `{ "kind": "advice", "advice": { "text", "source" }, "round": n }` or `{ "kind": "question", "question": "…", "round": n, "source": "model" }` — one round of the per-note advisory conversation |

### Todo
```json
{
  "id": "td_1719abc",
  "text": "写周报",
  "note": "",
  "done": false,
  "createdAt": "2026-11-03T14:00:00.000Z",
  "updatedAt": "2026-11-03T14:00:00.000Z",
  "dueAt": "2026-11-04T18:00:00.000Z",
  "remindAt": "2026-11-04T09:00:00.000Z",
  "remindFiredAt": null,
  "priority": 2,
  "color": "yellow",
  "tags": ["工作", "周报"],
  "planAt": "2026-11-04T09:30:00.000Z",
  "planNote": "上午先集中写周报"
}
```
`dueAt`, `remindAt`, `remindFiredAt`, `planAt` are ISO-8601 strings or `null`. `note`, `planNote` are strings (may be empty).
`color` is one of `yellow | pink | blue | green | purple | orange`.
`priority`: 1 = 高, 2 = 中, 3 = 低.
`tags`: `string[]`, 0–3 entries, each trimmed, 1–12 characters, deduplicated case-insensitively,
no leading `#`. Always an array (empty when the note has no tags). Missing tags in the persisted
file are read as `[]`; a persisted value that is not an array of strings is discarded.

### PlanResult (what `lib/ai.js` must return)
```json
{
  "summary": "一句话总体安排说明",
  "items": [
    { "id": "td_1719abc", "planAt": "2026-11-04T09:30:00.000Z", "note": "先做这个，20 分钟" }
  ],
  "generatedAt": "2026-11-03T14:20:00.000Z",
  "source": "model" // or "fallback" when the model was unavailable and a local heuristic produced the plan
}
```

### AdviceResult
```json
{
  "headline": "今天先别硬扛，砍掉一件低价值的事",
  "tips": [ { "text": "把「写周报」拆成 30 分钟一节", "kind": "breakdown" } ],
  "priorityOrder": [ "td_1719abc", "td_1719def" ],
  "generatedAt": "2026-11-03T14:20:00.000Z",
  "source": "model"
}
```
`kind` is one of `focus | breakdown | deadline | rest | scope`.

### TagResult (what `lib/ai.js` must return for `aiTag`)
```json
{
  "summary": "按 4 组整理：工作 3 项、学习 2 项、生活 1 项、想法 1 项",
  "items": [
    { "id": "td_1719abc", "tags": ["工作", "周报"] },
    { "id": "td_1719def", "tags": ["生活"] }
  ],
  "generatedAt": "2026-11-03T14:20:00.000Z",
  "source": "model" // or "fallback" when the model was unavailable and a local keyword classifier produced the tags
}
```
- `items` only covers open (not done) notes that exist on the board; unknown ids and duplicates are dropped.
- Each item carries 1–3 tags in the Todo tag format above (canonicalised by the same rules).
- Notes with no usable tags are simply absent from `items`; their existing tags stay untouched.
- `summary` is one short Chinese sentence describing the grouping (e.g. counts per tag).

### NoteAdviceResult (what `lib/ai.js` must return for `aiNoteAdvice`)
```json
{
  "kind": "advice",
  "advice": {
    "text": "今晚先花 20 分钟把「写周报」的开头两段写完，剩下的交给明天上午",
    "options": ["先写开头两段", "先列提纲再写", "先找上周数据"],
    "source": "model"
  },
  "round": 0
}
```
```json
{
  "kind": "question",
  "question": "这件事现在卡在哪一步：缺资料、缺时间，还是没想清楚怎么做？",
  "options": ["缺资料", "缺时间", "还没想清楚"],
  "round": 0,
  "source": "model"
}
```
- `round` = number of questions already asked in `history` (0–3).
- The Host may ask at most **three** questions. When `history.length >= 3`, the result must be
  `kind: "advice"` (the model prompt is told to answer with what it has; the Host enforces it).
- When the model is unavailable, misconfigured, fails, times out, or returns output that does not
  validate, the Host returns `kind: "advice"` with a deterministic local suggestion and
  `advice.source: "fallback"` — it never asks a question in that case.
- `advice.text` ≤ 400 characters, `question` ≤ 120 characters. Both are Chinese, concrete and short.
- **v1.3.0 options.** A question always carries `options`: **2–4 distinct non-empty short answers**
  (each ≤ 24 characters, Chinese) the user can pick instead of typing. `normalizeNoteAdvice` rejects
  a question that has no valid options, so the Host falls back to advice rather than showing a
  question without choices. An advice result may carry `advice.options`: **0–3 alternative concrete
  suggestions** (each ≤ 120 characters) that the user can pick as the starting point of the
  editable advice text; absent/empty means "no alternatives".
- `history` items are `{ question: string, answer: string }`; an unknown `id` is `not_found`,
  more than three history entries or non-string answers are `invalid_input`.

## Client half requirements

- Module format (plain JS, no JSX, no imports):
  ```js
  window.__ModuleLoader__.load({
    id: 'dsh-sticker-todo',
    factory(require) {
      const React = require('react');
      ...
      return { inject: ['slots', 'layout', 'locale'], apply(ctx) { ... } };
    },
  });
  ```
- Register the sidebar entry (`sidebar.panellist`) and the panel (`main`, key `sticker-todo`) through
  `ctx.slots.inject(...)`; verify the exact registration options and props with
  `cordis_inspect_query` (client `Slots`, `root: "sidebar.panellist"` and `root: "main"`).
  Use `ctx.layout.selectPanel('sticker-todo')` to open the panel from the sidebar entry if the
  slot does not do it for you.
- Poll `GET /dsh-todo/state` (mount + every 30 s while visible + on `window` focus). Show due
  reminders: in-panel banner + a toast; also `new Notification(...)` when the page has notification
  permission the user already granted. Then `POST {action:'ackReminders', ids}`.
- All network failures must render a small non-blocking inline message; never throw.
- Styles: only `--dsw-alias-*` theme tokens for chrome/text; sticker note colors are artwork
  (literal pastel hex is allowed there). Render the stylesheet as a React element
  (`<style>` with the CSS text) inside the component tree so unmounting removes it.
- Do not import any Harness Client package. Do not touch `document.body`.
- **Tags (v1.1.0)** — every note may carry up to three tags. The panel must:
  - render each note's tags as small `#tag` chips inside the note (separate class from the existing
    date/priority chips, e.g. `stk-chip stk-chip--tag`), and let a click filter the board by that tag;
  - show a filter row above the board: an "全部" chip plus one chip per tag currently in use, each
    with its note count; the selected chip filters the board, and the empty result renders a small
    explanation instead of a blank board; filters are client-side only (no API call);
  - offer a third AI action **"AI 分类打标签"** next to plan/advice, which `POST`s `{action:'aiTag'}`,
    renders `tagResult.summary` plus the resulting tag list (tag → count), and replaces the board
    with `data.todos` exactly like `aiPlan` does; failures render inline like the other AI actions;
  - let the user edit tags by hand in the add/edit form with one text field (space or comma
    separated, `#` stripped, at most three), sent as `tags: string[]` on `add`/`update`;
  - tolerate a Host that does not know `aiTag`: an `unknown_action` error must show a short
    "restart DSH to enable this" hint instead of a raw error string.
- **v1.2.0 panel UX** — the panel is redesigned around one creation dialog:
  - **Create button + modal.** A single prominent "新建便签" button (header) opens a modal dialog
    (overlay rendered inside the panel tree, no `document.body` writes) for creating a note; editing
    an existing note reuses the same dialog pre-filled. The inline add card and inline editor go away.
  - **Title + details.** The dialog has a 标题 input (required) and a 详情 textarea that is the
    dominant element (multi-line, at least 6 rows, grows with the dialog height, autofocus on 标题).
    `text` carries the title, `note` carries the details.
  - **Colour + priority.** Both are choosers in the dialog. On the note card the priority is shown
    **visually only** (colour-coded edge/flag/dot): no visible 高 / 中 / 低 text anywhere; keep an
    `aria-label`/`title` for accessibility.
  - **Quick due dates.** In the dialog, one-click chips 今天 / 明天 / 后天 / 下周 set `dueAt` to
    that day 23:59 local time (下周 = next Monday 23:59, advancing a week when today is Monday); a
    custom date-time control stays available for any other moment. The chose date is visible and
    can be cleared.
  - **Reminder.** A button opens/sets `remindAt` with a date-time control; the chosen reminder is
    shown and can be cleared.
  - **Font settings.** A font button in the header opens a small chooser for the note text and
    persists the choice in `localStorage['sticker-todo:font']` (degrade silently when storage is
    unavailable). Default `default`: **Latin text uses the app UI font (`--dsw-font-family`,
    falling back to the DSH font stack) while CJK text uses a handwritten face (楷体 first, then
    华文楷体 / 行楷)**. Other presets: `hand` (both scripts handwritten, 楷体), `xingkai` (both
    scripts 行楷 when installed), `ui` (both scripts app UI font). The choice applies to note text
    only, never to panel chrome.
  - **Grouping after classification.** When at least one note carries a tag, the board renders
    per-tag sections (tag header + count) and places each note in its first tag's section; untagged
    notes go to a final 未分类 section. Within a section the existing card order is preserved. A
    small toggle may switch back to a flat board; the tag filter keeps working on top of the grouping.
  - **Per-note AI advice.** Every note card has an AI advice button. It opens a dialog that calls
    `POST {action:'aiNoteAdvice', id, history}`:
    - `kind: "question"` → show the question, a free-text answer box, and a submit button; repeat up
      to three rounds;
    - `kind: "advice"` → show the suggestion in an **editable** textarea with
      「追加到备注」 (append it to the note's 详情 through `update`) and 「关闭」;
    - `unknown_action` (old Host) renders the same restart hint as the other AI actions; all errors
      stay inline and never throw.
- **v1.3.0 panel polish + optioned answers** — the board gets its final look and motion, and the
  per-note advice becomes a pick-or-type interaction:
  - **Remove the global advice button.** The panel-level AI card keeps only 自动安排日程 / 分类打标签 /
    清除安排. The board-wide 建议 button and its result block disappear from the UI (the Host action
    `aiAdvice` and the tool's `advice` action stay for the agent; no client code may call them).
  - **Question rounds are optioned.** When the Host returns `kind: "question"`, render its
    `options` (2–4) as selectable chips/buttons plus the free-text answer box. Picking an option
    fills the answer box (visible selected state) and the box stays freely editable; 提交 sends the
    box content. Typing without picking an option is the free-input path. Max three rounds.
  - **Advice alternatives.** When `advice.options` is present (0–3), render them as selectable
    chips that replace the editable suggestion text with the chosen option; the textarea remains
    freely editable and 追加到备注/关闭 work as before.
  - **Motion.** Add tasteful animations: board sections and note cards enter with a short
    fade + lift (staggered), dialogs open with a fade + scale (and animate out on close), buttons /
    cards / chips get smooth hover and focus transitions, the AI loading state gets a shimmer or
    spinner, toasts slide in. Only `transform`/`opacity` (plus colour) animate, durations 120–400 ms,
    and everything must be disabled by `@media (prefers-reduced-motion: reduce)`; no infinite
    animation except a loading indicator; no layout thrash.
  - **Visual polish.** Refresh the panel's look: a calmer, more consistent spacing/typography scale,
    a cleaner sticky-note surface (soft layered shadow, subtle paper grain, tidier tape), a refined
    header/filter row/toolbar hierarchy, better empty state, and consistent hover/focus/disabled
    states. Chrome and text must use `--dsw-alias-*` tokens so light and dark themes both stay
    correct; sticker artwork may keep pastel hex colours with sufficient text contrast. Keep the
    existing structural rules (single rendered `<style>`, no `document.body`, no imports).
- **v1.4.0 bilingual panel** — the client owns an explicit language switch on top of the DSH locale:
  - a header control offering `自动` (follow the DSH/client locale, the default), `中文` and `English`;
  - the choice persists in `localStorage['sticker-todo:lang']` (values `auto|zh|en`), degrades
    silently when storage is unavailable, and restores on the next page load;
  - in `zh`/`en` mode **every** visible string of the plugin uses that language (the existing
    `TEXT` dictionaries remain the single source), and date/time formatting follows that locale
    (`zh-CN` / `en-US` style); in `auto` mode the panel keeps following the DSH locale live,
    including when the app language changes;
  - the switch must not change any data or call the Host; no host/API change is involved.
- **v1.5.0 dual view (便利贴 / 极简)** — the panel offers two display formats for the same board:
  - **View switch.** A header control next to the font/language buttons offering 便利贴 (the current
    sticky-note board, the default) and 极简 (minimal list); the chosen format persists in
    `localStorage['sticker-todo:view']` (`notes|list`, invalid/absent → `notes`, storage failures
    degrade silently) and restores on the next load. Switching never calls the Host.
  - **Sticky-note mode** keeps the current grouped board exactly as-is.
  - **Minimal list mode** renders the filtered board as a compact vertical list: each row shows the
    priority accent, the completion checkbox and **only the title** (single line, ellipsis) plus a
    small due indicator when the note has a deadline; nothing else from the details is visible until
    the row is activated. Activating a row (click / Enter / Space) expands that row in place to show
    the full 详情, tags, due/remind/plan chips and the card actions (edit / `✦` AI advice / remind in
    1 hour / two-step delete); activating another row collapses the previous one (one expanded row at
    a time), and the expanded state resets on reload. The list is a real list (`ul`/`li`, row button
    with `aria-expanded`) and rows keep the board's existing sort order. Grouping is not applied in
    minimal mode (the 分组/平铺 toggle is hidden); the tag filter, the reminder banner, the AI card,
    the create button and every dialog keep working in both views.
  - Both views share one data source and one set of actions; the mode is presentation-only.

## Host half notes (for host-ai)

`lib/ai.js` exports `createAiLayer(ctx, config)` returning:
```js
{
  available(): { available: boolean, reason: string | null },
  async plan(todos): Promise<PlanResult>,
  async advice(todos): Promise<AdviceResult>,
  async tag(todos): Promise<TagResult>,   // v1.1.0 — classify and tag the open notes
}
```
`ctx.llm` may be absent (optional service). When the model is unavailable or fails, `plan`/`advice`/`tag`
must fall back to a deterministic local heuristic and set `source: "fallback"`. Never throw.

Pure helpers exported for the offline tests (no service touched):

- `heuristicTagging(todos, now?, options?)` → TagResult with `source: "fallback"`;
- `normalizeTagging(raw, todos, now?)` → TagResult with `source: "model"`, or `null` when nothing
  usable survived validation (caller then falls back).

`lib/store.js` additionally exports `normalizeTags(value)` (array or delimited string → canonical
`string[]`, throws `InputError` with code `invalid_input` on bad input) and the store gains
`applyTags(items)` — for each `{ id, tags }` whose id exists, replace that todo's `tags` and bump
`updatedAt`; unknown ids are ignored; resolves to the fresh `sortTodos(all())` list.

`index.js` maps action `aiTag` to `{ tagResult: await ai.tag(all), todos: await store.applyTags(tagResult.items) }`
and `add` / `update` accept `tags`; `lib/tools.js` gains tool action `tag` and `tags` on add/update,
and echoes `tags` in its result rows. The tool's `tag` action echoes the HTTP `aiTag` result as
`tagResult` (same shape) and its note rows gain `tags`.

### Round 3 host additions (v1.2.0)

`lib/ai.js` additionally exposes on the layer returned by `createAiLayer`:
```js
async noteAdvice(todo, history = []) // → NoteAdviceResult, never throws
```
Pure exports for the offline tests:
- `heuristicNoteAdvice(todo, round = 0)` → `{ kind: 'advice', advice: { text, source: 'fallback' }, round }`
  — a short, deterministic, concrete suggestion derived from the note's text/priority/deadline
  (e.g. a first 20-minute step, or a deadline-specific nudge). The layer passes `round = history.length`
  so a fallback after the third question still reports the round it answered.
- `normalizeNoteAdvice(raw, round)` → `{ kind: 'advice'|'question', … , round, source: 'model' }`
  or `null` when the model output cannot be salvaged; it must reject a `question` when `round >= 3`.

### Round 4 host additions (v1.3.0 — options only)

`lib/ai.js` changes, no new action:

- The note-advice system prompt must ask for `options` on both shapes:
  `{"kind":"question","question":"…","options":["…","…","…"]}` (2–4 short answers, each ≤ 24 chars)
  and `{"kind":"advice","text":"…","options":["备选做法 A","备选做法 B"]}` (0–3 alternatives, each
  ≤ 120 chars; may be omitted).
- `normalizeNoteAdvice(raw, round)` must:
  - carry a valid `options` array on a question (2–4 distinct non-empty trimmed strings, each ≤ 24
    characters) and **return `null` for a question without valid options** — the layer then falls
    back to `heuristicNoteAdvice`, so the UI never shows a question without choices;
  - carry `options` inside `advice` when 0–3 valid strings (each ≤ 120 characters) survive; omit the
    field when empty/invalid (clamp, never throw).
- `heuristicNoteAdvice` stays as is (advice, no options); the layer's fallback result therefore has
  no `advice.options` and the client shows only the editable text.

`index.js` maps action `aiNoteAdvice`:
- `id` is required and must exist (`not_found`);
- `history` must be an array of at most 3 `{ question, answer }` objects with non-empty answers
  (`invalid_input` otherwise);
- the action calls `ai.noteAdvice(todo, history)` and returns its result unchanged.

## Round 7 (v1.7.0 — 记忆 / memory)

The plugin starts remembering. Three additions, all inside the existing local JSON document:

1. **Event log** — every mutation appends a compact event, so a note's history survives its own
   deletion and can be summarised.
2. **Memory facts** — short user-owned statements (preferences, routines) injected into the AI prompts.
3. **Advice threads** — the per-note advisory conversation and the last advice are persisted, so the
   coach resumes instead of starting over.

Hard rule for every implementation: **only the user writes memory.** The model may *propose* a fact
through `memoryCandidates`; the Host never stores a proposal until the user confirms it via `remember`.

### File ownership (round 7)

| File | Owner |
|---|---|
| `CONTRACT.md`, `docs/MEMORY.md`, `package.json`, `locale/*.json`, `lib/store.js`, `index.js`, `lib/tools.js` | lead |
| `lib/ai.js` | host-ai |
| `client.js` | ui-panel |
| `verify/*.mjs`, `CHANGELOG.md`, `README*.md`, `HANDOFF.md` | verifier |

### Persisted document v2

`~/.dsh-sticker-todo/todos.json` becomes:

```json
{
  "version": 2,
  "todos": [ /* unchanged Todo[] */ ],
  "events": [ /* Event[], oldest first, at most 2000 */ ],
  "memory": {
    "facts": [ /* Fact[], at most 50 */ ],
    "threads": { "td_x": { /* Thread */ } }
  }
}
```

Read rules: a v1 document (no `events` / `memory`) loads as `events: []`, `facts: []`,
`threads: {}`; missing or malformed members are dropped, never thrown (`store.js` keeps its current
tolerance). Every write bumps `version` to 2 and rewrites the whole document atomically, exactly as
today. `clearMemory` is the only action that removes history.

**Event**

```json
{
  "at": "2026-11-06T14:00:00.000Z",
  "kind": "update",
  "id": "td_x",
  "text": "写周报",
  "changes": { "dueAt": { "from": "2026-11-06T02:00:00.000Z", "to": "2026-11-07T02:00:00.000Z" } }
}
```

`kind` ∈ `create | update | done | reopen | remove | plan | tag | remind | clear`.
`id` + `text` are present on every note-scoped event (`text` = the note title at that moment, ≤ 500
chars, so a removed note stays readable in a review); `plan` / `tag` / `clear` are board-scoped and
carry `count` instead. `changes` exists only on `update`, only for fields that actually changed
(`dueAt`, `remindAt`, `priority`, `tags`, `text`), each `{ "from": <old>, "to": <new> }`. The log is a
ring: appending past 2000 drops the oldest event.

**Fact**

```json
{
  "id": "m_ab12cd34",
  "text": "周报固定在周五 16:00 发",
  "source": "user",
  "createdAt": "2026-11-06T14:00:00.000Z",
  "updatedAt": "2026-11-06T14:00:00.000Z"
}
```

`text` is trimmed, 1–120 characters; `id` is `m_` + 8 hex characters; `source` is `user` (the only
value the Host writes today — the field exists so a later version can mark model-confirmed facts).
At most 50 facts. A second fact whose text equals an existing one after trim + lower-casing is
rejected with `invalid_input` ("already remembered") instead of being silently duplicated.

**Thread**

```json
"threads": {
  "td_x": {
    "rounds": [ { "round": 1, "question": "卡在哪一步？", "answer": "缺资料", "at": "2026-11-06T14:00:00.000Z" } ],
    "advice": { "text": "先花 20 分钟…", "source": "model", "at": "2026-11-06T14:05:00.000Z" },
    "updatedAt": "2026-11-06T14:05:00.000Z"
  }
}
```

`rounds` is the Q&A history (≤ 3 entries, `question` ≤ 120 chars, `answer` ≤ 800 chars), `advice` is
the last advice returned for that note (`null` until the first one). At most 200 threads; when the
cap is reached the thread with the oldest `updatedAt` is dropped. `remove` / `clearCompleted` delete
the note's thread but keep its events.

### Derived values (computed on read, never persisted)

- `postpones[id]` — number of `update` events whose `changes.dueAt` has both `from` and `to`
  non-null and `to > from`. Setting a first deadline, or moving it earlier, is **not** a postponement.
- `stats.week` — trailing 7 days (`now` − 7 d, machine-local clock): `completed` = `done` events,
  `created` = `create` events, `postponed` = the updates counted above, `removed` = `remove` events.
- `stats` also carries `open`, `done`, `overdue` (same counts the tool already reports) and
  `averageOpenAgeDays`.
- `lastAdvice[id]` = `threads[id].advice`.

### GET /dsh-todo/state — memory block

The response gains one top-level member beside `todos` / `dueReminders` / `ai`:

```json
"memory": {
  "facts": [ /* Fact[], newest first */ ],
  "stats": {
    "open": 5, "done": 12, "overdue": 1, "averageOpenAgeDays": 2.4,
    "week": { "completed": 8, "created": 6, "postponed": 3, "removed": 2 }
  },
  "postpones": { "td_x": 3 },
  "threads": { "td_x": { /* Thread */ } }
}
```

`postpones` lists only notes with at least one postponement; `threads` only notes that still exist.
The `Todo` shape itself does not change — clients read memory from this sibling object.

### POST /dsh-todo/action — new actions

| action | params | result |
|---|---|---|
| `remember` | `text` (required, ≤ 120) | the created Fact |
| `updateFact` | `id` (required), `text` (required) | the updated Fact |
| `forget` | `id` (required) | `{ "forgotten": "<id>" }` |
| `review` | — | `{ "review": ReviewResult }` — no write |
| `memoryCandidates` | — | `{ "candidates": Candidate[], "generatedAt": "…", "source": "model" \| "fallback" }` — no write |
| `clearMemory` | — | `{ "cleared": { "facts": n, "threads": n, "events": n } }` |

`aiNoteAdvice` keeps its request/response but now also writes the thread: after the call the Host
stores the submitted `history` as `rounds` and, for `kind: "advice"`, the returned text + its
`source` as `advice`. A failed write is logged, never surfaced.

`ReviewResult`

```json
{
  "headline": "这周做完 8 件，改期 3 次",
  "range": { "from": "2026-10-31T…", "to": "2026-11-06T…", "days": 7 },
  "stats": { "completed": 8, "created": 6, "postponed": 3, "removed": 2, "open": 5, "overdue": 1 },
  "highlights": [ "「写周报」这周改期 2 次，建议拆成两步" ],
  "tips": [ { "text": "把改期最多的一件砍成 3 个小步", "kind": "breakdown" } ],
  "generatedAt": "2026-11-06T14:20:00.000Z",
  "source": "model"
}
```

`headline` ≤ 100 chars, `highlights` ≤ 4 (each ≤ 120 chars), `tips` ≤ 3 (`kind` as in
`AdviceResult`). `source: "fallback"` whenever the model was unavailable or its output did not
survive `normalizeReview`; the fallback is deterministic and derived only from events + todos.

`Candidate`

```json
{ "text": "周报固定在周五下午", "reason": "最近 3 张便签都提到周五交周报" }
```

≤ 5 candidates, `text` ≤ 60 chars, `reason` ≤ 80 chars, both trimmed and non-empty. The model only
proposes; **nothing is written** until the user calls `remember` with one of the texts. The fallback
derives candidates from measurable patterns only (postpone ≥ 3, ≥ 3 notes sharing a tag, chronic
overdue) and reports `source: "fallback"`.

### AiLayer v1.7.0 (`lib/ai.js`)

```js
available(): { available: boolean, reason: string | null }
async plan(todos, memory?)              // PlanResult
async advice(todos, memory?)            // AdviceResult
async tag(todos, memory?)               // TagResult
async noteAdvice(todo, history?, memory?) // NoteAdviceResult
async review(input)                     // ReviewResult
async memoryCandidates(input)           // { candidates, generatedAt, source }
```

`memory` is the compact context built by `index.js`:

```json
{
  "facts": ["周报固定在周五下午"],
  "stats": { "open": 5, "done": 12, "overdue": 1, "averageOpenAgeDays": 2.4,
             "week": { "completed": 8, "created": 6, "postponed": 3, "removed": 2 } },
  "postpones": { "td_x": 3 },
  "lastAdvice": { "td_x": "先花 20 分钟写出开头两段" }
}
```

`review(input)` and `memoryCandidates(input)` take `{ todos, events, facts, now? }` and reuse the
existing `resolveTarget` / `callModel` / timeout / fallback plumbing: never throw,
`source: "fallback"` on any failure.

Every prompt gains one compact memory block (pure helper `memoryPromptBlock(memory)` returning a
short Chinese text, `''` when there is nothing to say):

- facts, at most 12 (each ≤ 120 chars; when there are more, keep the most recently updated);
- one weekly-statistics line (完成 / 新建 / 改期 / 删除);
- a note's payload gains `postpones` (a count) when it has been postponed at least once;
- the per-note coach prompt additionally carries `lastAdvice` (≤ 200 chars) and is told **not to
  repeat the previous suggestion**;
- the tagging prompt may mention tag words that appear in the facts (advisory only).

No prompt ever asks the model to *write* memory; the only model-produced memory-adjacent output is
`memoryCandidates`, which the user confirms.

Pure exports for the offline tests: `memoryPromptBlock(memory)`, `heuristicReview(input)`,
`normalizeReview(raw, input)`, `heuristicMemoryCandidates(input)`,
`normalizeMemoryCandidates(raw, input)`.

### `sticker_todo` tool v1.7.0

New actions: `remember` (needs `text`), `forget` (needs `id`), `memories` (list facts without
changing anything), `review` (weekly review, no write). `list` (and the other read results) gain
`memory: { facts: string[], stats: { ... } }` so the agent can answer "我这周做得怎么样" without a
second call. `plan` / `advice` / `tag` pass the memory context through, exactly like the HTTP route.

### Client half (client.js)

- **Header `记忆` button** (zh `记忆` / en `Memory`) opens one modal dialog with three sections plus
  a 清空记忆 action (two-step confirm, same 3.5 s window as delete):
  - **我的偏好** — facts list (text + 编辑 + 删除), one input + 记住 to add, inline error when the
    Host rejects a duplicate / too-long fact;
  - **本周复盘** — a 生成复盘 button that POSTs `review`, then renders headline, six stat chips
    (完成 / 新建 / 改期 / 删除 / 未完成 / 逾期), highlights, tips and a 模型 / 本地 source badge;
  - **可能值得记住** — a 发现记忆 button that POSTs `memoryCandidates` and renders each candidate
    (text + reason) with 记住 / 忽略 (dismiss is client-side only).
- **Note card / list row** shows `改期 N 次` when `memory.postpones[id] >= 2` — a small chip obeying
  the same artwork rules as the other chips; in minimal mode it lives in the expanded meta row.
- **Per-note advice dialog** seeds itself from `memory.threads[id]`: when a stored last advice
  exists it is shown with the usual 追加到备注 / 关闭 actions plus a `继续聊聊` button that
  re-requests with the stored rounds as `history`. A fresh conversation keeps the three-round
  behaviour unchanged.
- Every new string goes into the existing `TEXT` dictionaries in **both** languages; `data.memory`
  must be tolerated when absent (older Host): no badge, empty memory dialog, no crash.

## Round 8 (v1.8.0 — 只给未分类的便签打标签 + 把便签交给 DSH 处理)

Two changes, no storage change, no new HTTP action.

### `aiTag` only classifies untagged notes

`ai.tag(todos, memory?)` filters the open board down to notes with **no tags at all**
(`tags.length === 0`) before building the prompt, validating model output, or running the local
keyword fallback. Matching `applyTags` keeps working on the returned items, so a note the user
already tagged — by hand or by an earlier pass — keeps its tags; a second pass can never overwrite
or extend them.

- When at least one untagged note exists, the result is exactly the v1.7.0 `TagResult` for just
  those notes (`items` only covers them, `summary` counts only them).
- When the board has open notes but all of them carry tags, the Host returns
  `{ summary: '所有未完成便签都已经有标签，不用再分类。', items: [], generatedAt, source: 'fallback' }`.
- When there are no open notes at all, the summary is `当前没有待办，暂时不用整理标签。`.
- Both empty cases are `source: 'fallback'`, are not written to disk, and never call the model.
- The `sticker_todo` tool's `tag` action and the panel's 「分类打标签」 button inherit this
  behaviour because they share `runAction`.

### Client: 「交给 DSH」 handoff

Every note gets a way to move itself into the chat composer so the main agent can help with it.
This is **client-only**: no Host call, no new action, no data change.

- **Button.** A `↗ 交给 DSH` / `↗ Ask DSH` button in the sticky-card action row and in the expanded
  minimal-list row (same button style as the other note actions, `aria-label` + `title` from the
  same string, `title` also carries a one-line hint).
- **Prompt.** Clicking builds one plain-text prompt from the note and hands it to DSH **without
  sending it**:

  ```
  帮我处理这条待办：<text>
  详情：<note>                # this line is omitted when the note has no details
  截止：<localized due> ｜ 优先级：<高/中/低> ｜ 标签：#a #b   # one line, only the parts that exist
  便签 id：<id>
  （来自便利贴待办面板，可以用 sticker_todo 工具更新它）

  请直接推进：先判断这件事要怎么做，需要时用 sticker_todo 更新这条便签（补备注、拆成子项、改期或标记完成），不用先反问。
  ```

  In `en` mode the same prompt is written in English. The id always appears so the agent can address
  the exact note.
- **Delivery.** Obtain the client service from the plugin context:
  `ctx.get('uiWorkspace')` (also accept the `ctx.uiWorkspace` property form). When it exposes a
  `startSession` function, call

  ```js
  workspace.startSession(undefined, { prompt, whenDraftExists: 'append' })
  ```

  which opens the New Session draft and appends the prompt as new paragraphs — existing user text
  and attachments are preserved, and nothing is submitted. On success show the toast
  `已放进主对话框，检查后按回车发送` (en: `Added to the chat draft — review, then press Enter`).
- **Fallback.** When the service is missing (older DSH), throws, or `startSession` is not a
  function, copy the same prompt with `navigator.clipboard.writeText` and toast
  `已复制，粘贴到主对话框即可`; if the clipboard is unavailable too, toast a short failure line.
  The handler never throws and never blocks the panel.
- **i18n.** New keys in the single `TEXT` table, both languages, same key set:
  `note.handoff`, `note.handoffHint`, `note.handoffDraft`, `note.handoffCopied`, `note.handoffFailed`.
- The button works in both views, for done and open notes, and needs no Host version check beyond
  the optional service lookup.


