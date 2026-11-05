# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
