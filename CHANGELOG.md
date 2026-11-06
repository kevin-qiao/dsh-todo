# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.7.0] — 2026-11-06

### Added
- **Memory** — the board now remembers instead of only holding current state:
  - **Event log** — every mutation appends a compact event (`create` / `update` / `done` / `reopen` /
    `remove` / `plan` / `tag` / `remind` / `clear`) carrying the note title, so a deleted note stays
    readable in a review. `update` events record `{ from, to }` for `dueAt` / `remindAt` / `priority` /
    `tags` / `text`. The log is a 2000-event ring.
  - **Facts** — up to 50 short user-owned preferences (1–120 characters), injected into every AI
    prompt (at most 12 per prompt, newest first); duplicates are rejected case-insensitively.
  - **Weekly review** — trailing-7-day completed / created / postponed / removed counts plus the
    current open / overdue state, rendered as a headline with highlights and tips. Reads only, never
    writes.
  - **Persisted advice threads** — each note's coaching Q&A (up to 3 rounds) and the last advice
    survive restarts; the advice dialog resumes with `继续聊聊` instead of starting over.
- Panel `🧠 记忆` dialog with 我的偏好 (add / edit / delete facts), 本周复盘 (generate a review with six
  stat chips and a model / local source badge) and 可能值得记住 (AI-proposed facts with 记住 / 忽略 —
  proposals are never stored until confirmed) plus a two-step 清空记忆 action.
- `改期 N 次` chip on notes whose deadline was pushed later at least twice (both views).
- Agent tool actions `remember` / `forget` / `memories` / `review`; every read result now echoes
  `memory: { facts, stats }` so the agent can answer “how did my week go” in one call.
- [`docs/MEMORY.md`](./docs/MEMORY.md) — why the memory exists, its four layers, what is explicitly
  out of scope, and the acceptance checks.

### Changed
- The persisted document is now **v2** (`version: 2` plus `events` and `memory.facts` / `memory.threads`);
  a v1 document loads unchanged with empty memory and is upgraded on the next write. The `Todo` shape
  itself is unchanged.
- AI prompts gain a compact memory block (facts + one weekly-statistics line); the per-note coach is
  also given the last advice for that note and told not to repeat it.
- Derived values (`postpones`, weekly statistics, `averageOpenAgeDays`, `lastAdvice`) are computed on
  read and never persisted, so they can always be recomputed from the event log.
- Removing a note keeps its events but drops its advice thread; `clearMemory` is the only action that
  deletes history, and it never touches the notes.

### API
- Six new actions on `POST /dsh-todo/action`: `remember`, `updateFact`, `forget`, `review`,
  `memoryCandidates`, `clearMemory`.
- `GET /dsh-todo/state` gains a top-level `memory` member: `{ facts, stats, postpones, threads }`.
- AiLayer v1.7.0: new `review(input)` / `memoryCandidates(input)` methods; `plan` / `advice` / `tag` /
  `noteAdvice` accept the optional compact `memory` context. Pure helpers exported for the offline
  suites: `memoryPromptBlock`, `heuristicReview`, `normalizeReview`, `heuristicMemoryCandidates`,
  `normalizeMemoryCandidates`.
- `sticker_todo` tool: new `remember` / `forget` / `memories` / `review` actions, and every read result
  gains `memory: { facts: string[], stats }`.

### Docs
- README (English and 中文) adds the memory feature, the `记忆` dialog usage, the v2 data model and the
  new verification baselines; HANDOFF gains the memory data model / clear / reset notes.
- [`docs/MEMORY.md`](./docs/MEMORY.md) documents why the memory exists, its scope, the data model and
  the acceptance checks.
- Verification baselines (offline): `check-static` 67, `host-actions` 43, `client-render` 50 — all
  passing; `api-smoke` covers the live memory round-trips (27 checks).

## [1.6.0] — 2026-11-06

### Changed
- **Package renamed to `dsh-sticker-todo` and published to npm** so it can be installed with one
  command and appear in the DSH in-app plugin center:
  `dsh plugin --profile web add dsh-sticker-todo`. The bundle row name in `cordis.patch.yml` follows
  the package name.
- README split into two files: [`README.md`](./README.md) (English, repository default) and
  [`README.zh-CN.md`](./README.zh-CN.md) (中文), with language links at the top of each.
- README cross-links and screenshots use absolute URLs, so the npm package page renders them too.

### Added
- README preview screenshots (`docs/preview-*.png`) and a GitHub-style preview section.
- Contributing guide, security policy and GitHub issue/PR templates.
- CI workflow that runs the offline verification suites on Node 20/22/24.
- dsh-plugin.org market readiness: the `dsh-plugin` GitHub topic and the install command in both
  READMEs.

### Docs
- Market submission filed at
  [dshplugin/dsh-plugin-hub#649](https://github.com/dshplugin/dsh-plugin-hub/issues/649).
- AI co-author trailer convention documented in [`HANDOFF.md`](./HANDOFF.md); commits created by the
  AI assistant carry `Co-authored-by: DeepSeek Harness (deepseek-flash) <noreply@deepseek.com>`.

### Release
- Published to npm as [`dsh-sticker-todo@1.6.0`](https://www.npmjs.com/package/dsh-sticker-todo)
  (2026-11-06) — the first npm release, so the DSH in-app plugin center can install it in one command.
- Listed on [dsh-plugin.org](https://dsh-plugin.org/plugins/kevin-qiao/dsh-todo) (category 界面与体验,
  verified); the README now carries the `listed.svg` badge.

## [1.5.0] — 2026-11-05

### Added
- Dual view switch in the header: `便利贴` (sticky board, default) and `极简` (minimal title-only
  list). In minimal mode a row expands in place to show its details, tags, dates and actions
  (edit / AI advice / remind / delete), one row at a time.
- Persisted view choice in `localStorage['sticker-todo:view']`.

### Changed
- Both views share the same data and actions; grouping is hidden in minimal mode while the tag
  filter keeps working.

## [1.4.0] — 2026-11-05

### Added
- In-panel language switch (`自动` / `中文` / `English`) on top of the DSH locale, persisted in
  `localStorage['sticker-todo:lang']`. Every label and date format follows it; the reminder overlay,
  desktop notification title and sidebar label follow too.

### Changed
- README rewritten as a bilingual, GitHub-style document.
- Package description and Plugin Manager locale descriptions mention the bilingual UI.

## [1.3.0] — 2026-11-05

### Added
- Question rounds in the per-note AI advice dialog now carry 2–4 pickable answer options plus a
  free-text box; advice results may carry 0–3 alternative suggestions as chips.
- Motion: staggered note entrances, dialog open/close transitions, hover/focus micro-interactions,
  AI loading shimmer and toast slide-in, all disabled under `prefers-reduced-motion`.

### Removed
- The board-wide “AI advice” button and its result view (the Host action and agent tool action remain).

### Changed
- Full stylesheet refresh: calmer spacing/typography, refined sticky-note surfaces, header/filter/AI
  card hierarchy, larger-radius dialogs, icon empty state.

## [1.2.0] — 2026-11-05

### Added
- Composer dialog (title + dominant details area), visual-only priority, quick due chips
  (今天 / 明天 / 后天 / 下周), reminder button, font presets, per-tag grouping, and per-note AI
  advice with up to three clarifying questions (`aiNoteAdvice`).

### Changed
- Todo `text` is the note title and `note` is the details — same fields, relabelled.

## [1.1.0] — 2026-11-03

### Added
- `tags: string[]` on every note (max 3), `aiTag` classification action plus a deterministic
  keyword fallback, tag chips/filter row, tag editing, grouped board after classification.

## [1.0.0] — 2026-11-03

### Added
- Initial release: sidebar panel with sticky notes, due dates, timed reminders, AI schedule planning
  (`aiPlan`), AI board advice (`aiAdvice`) and the `sticker_todo` agent tool.
