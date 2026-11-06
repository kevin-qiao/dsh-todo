/**
 * Sticker TODO — browser half.
 *
 * One sidebar entry (`sidebar.panellist`, id `sticker-todo`) and one full page in the keyed
 * `main` slot (key `sticker-todo`): a sticky-note todo board with a create/edit dialog, due dates
 * and timed reminders, tag filtering/grouping, note-text font presets, an in-panel bilingual
 * switch (自动 / 中文 / English), the panel-level AI actions (schedule / classify) and a per-note AI
 * advice conversation with pick-or-type options. Every piece of data comes from the Host route
 * `/dsh-todo` (CONTRACT.md); there is no other data path.
 *
 * Plain-JS client module: React comes from the browser module table — no JSX, no imports.
 */
window.__ModuleLoader__.load({
  id: 'dsh-sticker-todo',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'stickerTodo' // locale namespace owned by this client half
    const PANEL_ID = 'sticker-todo' // shared by the sidebar entry and the main panel it opens
    const STATE_URL = '/dsh-todo/state'
    const ACTION_URL = '/dsh-todo/action'
    const POLL_MS = 30000 // state poll period while mounted and visible
    const TOAST_MS = 6000
    const DELETE_ARM_MS = 3500 // two-press delete window
    const QUICK_REMIND_MS = 60 * 60 * 1000
    const COLORS = ['yellow', 'pink', 'blue', 'green', 'purple', 'orange'] // Host palette keys
    const PRIORITIES = [1, 2, 3] // 1 high, 2 medium, 3 low
    const PRIORITY_KEYS = { 1: 'high', 2: 'medium', 3: 'low' }
    const MAX_TAGS = 3 // contract cap: every note carries at most three tags
    const TAG_MAX_LENGTH = 12 // contract cap per tag; mirrored here so the form cannot send rejected input
    const MAX_ADVICE_ROUNDS = 3 // contract cap: the per-note advisory conversation asks at most three questions
    const MAX_QUESTION_OPTIONS = 4 // contract cap for question options
    const QUESTION_OPTION_LENGTH = 24 // contract cap per question option
    const MAX_ADVICE_OPTIONS = 3 // contract cap for advice alternatives
    const ADVICE_OPTION_LENGTH = 120 // contract cap per advice alternative
    const DIALOG_CLOSE_MS = 150 // exit-animation window before a dialog unmounts
    const FONT_STORAGE_KEY = 'sticker-todo:font' // localStorage key for the note-text font preset
    const LANG_STORAGE_KEY = 'sticker-todo:lang' // localStorage key for the panel language mode
    const VIEW_STORAGE_KEY = 'sticker-todo:view' // localStorage key for the board display format
    const LANG_MODES = ['auto', 'zh', 'en'] // auto = follow the DSH locale, zh/en = force that language
    const VIEW_MODES = ['notes', 'list'] // notes = sticky-note board (default), list = minimal rows
    const FORCED_LOCALES = { zh: 'zh-CN', en: 'en-US' } // Intl locale used by the forced language modes
    const FONT_PRESETS = ['default', 'hand', 'xingkai', 'ui']
    const FONT_STACKS = {
      // Latin from the app UI font, CJK from the script-scoped handwriting face declared in STYLE.
      default: "'STK Hand CJK', var(--dsw-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif)",
      hand: "'STK Hand CJK', 'KaiTi', 'Kaiti SC', 'STKaiti', 'KaiTi_GB2312', '华文楷体', 'LXGW WenKai', 'Microsoft YaHei', sans-serif",
      xingkai: "'STK Xingkai', 'STXingkai', '行楷', 'Xingkai SC', '华文行楷', 'KaiTi', 'Microsoft YaHei', sans-serif",
      ui: "var(--dsw-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif)",
    }
    const DUE_QUICKS = ['today', 'tomorrow', 'dayAfter', 'nextWeek']
    const EMPTY_DRAFT = { text: '', note: '', dueAt: '', remindAt: '', color: 'yellow', priority: 2, tags: '' }
    const EMPTY_TODOS = [] // stable identity for renders before/without a snapshot
    const ROTATIONS = [-1.1, 0.7, -0.5, 1.15, -0.85, 0.95, -0.2] // per-note hand-written tilt

    /**
     * Every visible string as `[zh, en]`. Building both dictionaries from this table keeps the
     * two key sets identical by construction.
     */
    const TEXT = {
      'panel.label': ['便利贴待办', 'Sticker TODO'],
      'panel.title': ['便利贴待办', 'Sticker TODO'],
      'panel.subtitle': ['{open} 条待办 · {done} 条已完成', '{open} open · {done} done'],
      'action.refresh': ['刷新', 'Refresh'],
      'action.create': ['新建便签', 'New note'],
      'action.font': ['字体', 'Font'],
      'lang.title': ['面板语言', 'Panel language'],
      'lang.auto': ['自动', 'Auto'],
      'lang.autoFollow': ['自动（跟随 DSH 语言）', 'Auto (follow DSH language)'],
      'lang.hint': ['只影响这个面板', 'This panel only'],
      'lang.zh': ['中文', '中文'],
      'lang.en': ['English', 'English'],
      'view.label': ['显示格式', 'Display format'],
      'view.notes': ['便利贴', 'Sticky notes'],
      'view.list': ['极简', 'Minimal'],
      'view.hint': ['切换便签的展示方式', 'Change how notes are displayed'],
      'list.expand': ['展开详情', 'Show details'],
      'list.collapse': ['收起详情', 'Hide details'],
      'list.details': ['详情', 'Details'],
      'action.clearCompleted': ['清除已完成（{count}）', 'Clear done ({count})'],
      'action.enableDesktop': ['开启桌面提醒', 'Enable desktop alerts'],
      'action.desktopOn': ['桌面提醒已开启', 'Desktop alerts on'],
      'action.dismiss': ['关闭', 'Dismiss'],
      'action.retry': ['重试', 'Retry'],
      'loading': ['正在读取便利贴…', 'Loading your notes…'],
      'error.load': ['无法读取待办数据', 'Could not load your notes'],
      'error.generic': ['操作失败，请重试', 'That did not work — please retry'],
      'error.emptyText': ['先写点什么吧', 'Write something first'],
      'empty': ['还没有便利贴，先贴一张吧', 'No sticky notes yet — add one above'],
      'filter.label': ['按标签筛选', 'Filter by tag'],
      'filter.all': ['全部', 'All'],
      'filter.count': ['{count} 条', '{count} note(s)'],
      'filter.empty': ['没有带「#{tag}」的便利贴', 'No notes tagged #{tag}'],
      'filter.clear': ['清除筛选', 'Clear filter'],
      'group.label': ['分组方式', 'Board layout'],
      'group.grouped': ['分组', 'Group'],
      'group.flat': ['平铺', 'Flat'],
      'group.untagged': ['未分类', 'Uncategorized'],
      'tag.filter': ['按 #{tag} 筛选', 'Filter by #{tag}'],
      'dialog.createTitle': ['新建便签', 'New note'],
      'dialog.editTitle': ['编辑便签', 'Edit note'],
      'dialog.titleLabel': ['标题', 'Title'],
      'dialog.titlePlaceholder': ['要做什么？', 'What needs doing?'],
      'dialog.detailsLabel': ['详情', 'Details'],
      'dialog.detailsPlaceholder': ['补充背景、步骤或细节…', 'Background, steps, details…'],
      'dialog.dueLabel': ['到期', 'Due'],
      'dialog.remindLabel': ['提醒', 'Reminder'],
      'dialog.tagsPlaceholder': ['工作 学习 #生活（最多 3 个）', 'work study #life (max 3)'],
      'dialog.clear': ['清除', 'Clear'],
      'dialog.setRemind': ['设置提醒', 'Set reminder'],
      'dialog.quick.today': ['今天', 'Today'],
      'dialog.quick.tomorrow': ['明天', 'Tomorrow'],
      'dialog.quick.dayAfter': ['后天', 'In 2 days'],
      'dialog.quick.nextWeek': ['下周', 'Next week'],
      'field.remind': ['提醒时间', 'Remind'],
      'field.tags': ['标签', 'Tags'],
      'field.color': ['颜色', 'Color'],
      'field.priority': ['优先级', 'Priority'],
      'color.yellow': ['黄色', 'Yellow'],
      'color.pink': ['粉色', 'Pink'],
      'color.blue': ['蓝色', 'Blue'],
      'color.green': ['绿色', 'Green'],
      'color.purple': ['紫色', 'Purple'],
      'color.orange': ['橙色', 'Orange'],
      'priority.1': ['高', 'High'],
      'priority.2': ['中', 'Medium'],
      'priority.3': ['低', 'Low'],
      'edit.submit': ['保存', 'Save'],
      'edit.cancel': ['取消', 'Cancel'],
      'note.toggle': ['标记完成', 'Toggle done'],
      'note.edit': ['编辑', 'Edit'],
      'note.delete': ['删除', 'Delete'],
      'note.deleteConfirm': ['确认删除', 'Confirm delete'],
      'note.remind': ['1 小时后提醒', 'Remind in 1 hour'],
      'note.focus': ['定位这张便利贴', 'Focus this note'],
      'note.advice': ['AI 建议', 'AI advice'],
      'note.handoff': ['交给 DSH', 'Ask DSH'],
      'note.handoffHint': ['把这条便签放进 DSH 主对话框（不自动发送）', 'Put this note into the DSH chat draft (does not send)'],
      'note.handoffDraft': ['已放进主对话框，检查后按回车发送', 'Added to the chat draft — review, then press Enter'],
      'note.handoffCopied': ['已复制，粘贴到主对话框即可', 'Copied — paste it into the chat'],
      'note.handoffFailed': ['无法放入主对话框，请手动复制', 'Could not add it to the chat — please copy manually'],
      'due.overdue': ['逾期', 'Overdue'],
      'due.today': ['今天', 'Today'],
      'due.tomorrow': ['明天', 'Tomorrow'],
      'ai.title': ['AI 助手', 'AI helper'],
      'ai.ready': ['AI 已就绪', 'AI ready'],
      'ai.unavailable': ['AI 不可用，将使用本地规则', 'AI unavailable — local rules will be used'],
      'ai.plan': ['AI 自动安排日程', 'AI schedule'],
      'ai.clear': ['清除 AI 安排', 'Clear AI plan'],
      'ai.loadingPlan': ['AI 正在安排日程…', 'AI is scheduling…'],
      'ai.loadingClear': ['正在清除 AI 安排…', 'Clearing the AI plan…'],
      'ai.source.model': ['模型生成', 'Model'],
      'ai.source.fallback': ['本地规则', 'Local rules'],
      'ai.noSummary': ['暂无总体说明', 'No summary'],
      'ai.noItems': ['这次没有可安排的时间段', 'No slots to schedule'],
      'ai.unknownNote': ['（已删除的便利贴）', '(deleted note)'],
      'ai.tag': ['AI 分类打标签', 'AI tag'],
      'ai.loadingTag': ['AI 正在分类打标签…', 'AI is tagging…'],
      'ai.tagList': ['标签分布', 'Tag breakdown'],
      'ai.noTagItems': ['这次没有生成标签', 'No tags generated'],
      'ai.needRestart': ['重启 DSH 后可用', 'Restart DSH to enable this'],
      'advice.title': ['AI 建议', 'AI advice'],
      'advice.thinking': ['AI 正在阅读这张便签…', 'AI is reading this note…'],
      'advice.questionTag': ['AI 想先了解', 'AI asks'],
      'advice.optionsLabel': ['点选一个回答', 'Pick an answer'],
      'advice.alternativesLabel': ['备选做法', 'Alternative ideas'],
      'advice.answerLabel': ['你的回答', 'Your answer'],
      'advice.answerPlaceholder': ['补充一些背景，AI 会据此给出建议…', 'Add background so the AI can advise…'],
      'advice.submit': ['提交回答', 'Send answer'],
      'advice.round': ['第 {round} / 3 轮', 'Question {round} of 3'],
      'advice.resultLabel': ['建议', 'Suggestion'],
      'advice.append': ['追加到备注', 'Append to details'],
      'advice.appended': ['已追加到详情', 'Added to details'],
      'advice.hint': ['这段建议可以直接修改', 'You can edit this advice'],
      'advice.close': ['关闭', 'Close'],
      'memory.button': ['记忆', 'Memory'],
      'memory.title': ['记忆', 'Memory'],
      'memory.hint': ['只有你确认的内容才会被记住', 'Only what you confirm is remembered'],
      'memory.factsTitle': ['我的偏好', 'My preferences'],
      'memory.emptyFacts': ['还没有记住任何偏好', 'No saved preferences yet'],
      'memory.factPlaceholder': ['例如：周报固定在周五下午发', 'e.g. Weekly report goes out Friday afternoon'],
      'memory.remember': ['记住', 'Remember'],
      'memory.reviewTitle': ['本周复盘', 'Weekly review'],
      'memory.generateReview': ['生成复盘', 'Generate review'],
      'memory.reviewing': ['正在生成复盘…', 'Generating review…'],
      'memory.reviewHint': ['生成后可以看看这一周的节奏', 'Generate to see how your week went'],
      'memory.highlights': ['要点', 'Highlights'],
      'memory.tips': ['建议', 'Tips'],
      'memory.candidatesTitle': ['可能值得记住', 'Worth remembering'],
      'memory.findCandidates': ['发现记忆', 'Find memories'],
      'memory.finding': ['正在发现…', 'Finding…'],
      'memory.candidatesEmpty': ['暂时没有新的记忆候选', 'No new memory candidates'],
      'memory.candidatesHint': ['AI 只做提议，你确认后才会记住', 'The AI only suggests — nothing is saved until you confirm'],
      'memory.ignore': ['忽略', 'Ignore'],
      'memory.clear': ['清空记忆', 'Clear memory'],
      'memory.clearConfirm': ['确认清空记忆？', 'Really clear memory?'],
      'memory.cleared': ['记忆已清空', 'Memory cleared'],
      'memory.saved': ['已记住', 'Saved to memory'],
      'memory.postponeTimes': ['改期 {count} 次', 'Postponed {count}×'],
      'memory.postponeHint': ['这张便签被改期了多次', 'This note has been postponed several times'],
      'memory.continueThread': ['继续聊聊', 'Keep chatting'],
      'memory.stats.completed': ['完成', 'Done'],
      'memory.stats.created': ['新建', 'New'],
      'memory.stats.postponed': ['改期', 'Postponed'],
      'memory.stats.removed': ['删除', 'Removed'],
      'memory.stats.open': ['未完成', 'Open'],
      'memory.stats.overdue': ['逾期', 'Overdue'],
      'font.title': ['字体设置', 'Note font'],
      'font.hint': ['只影响便签文字', 'Note text only'],
      'font.default': ['默认（英文界面字体 · 中文楷体）', 'Default (UI Latin · KaiTi CJK)'],
      'font.hand': ['楷体手写', 'Handwritten KaiTi'],
      'font.xingkai': ['行楷', 'Xingkai'],
      'font.ui': ['系统界面字体', 'System UI font'],
      'reminder.title': ['到点提醒', 'Reminders due'],
      'reminder.body': ['{count} 条提醒到点了', '{count} reminder(s) due'],
      'reminder.ack': ['知道了', 'Got it'],
      'reminder.open': ['打开待办', 'Open board'],
      'reminder.more': ['还有 {count} 条', '{count} more'],
      'toast.reminder': ['{count} 条提醒到点了', '{count} reminder(s) due'],
      'toast.reminderSet': ['已设置 {time} 的提醒', 'Reminder set for {time}'],
      'toast.cleared': ['已清除 {count} 条已完成', 'Cleared {count} finished note(s)'],
      'toast.desktopOn': ['桌面提醒已开启', 'Desktop alerts enabled'],
      'toast.desktopDenied': ['浏览器拒绝了桌面提醒', 'The browser denied desktop alerts'],
      'toast.planCleared': ['已清除 AI 安排', 'AI plan cleared'],
      'notify.title': ['便利贴提醒', 'Sticker TODO reminder'],
      'footer.count': ['共 {total} 条 · 未完成 {open} 条', '{total} notes · {open} open'],
      'footer.updated': ['更新于 {time}', 'Updated {time}'],
      'footer.hint': ['数据保存在本机 · 每 30 秒自动刷新', 'Saved on this device · refreshes every 30 s'],
    }

    const zh = {}
    const en = {}
    for (const [key, pair] of Object.entries(TEXT)) {
      zh[key] = pair[0]
      en[key] = pair[1]
    }

    /* -------------------------------------------------------------- language */

    /** Replace `{placeholder}` tokens using the same rule as the Host locale binder. */
    function formatMessage(template, params) {
      if (params === undefined || params === null) return template
      return String(template).replace(/\{(\w+)\}/g, (match, name) => (
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
      ))
    }

    /** Build a translator over one of the two panel dictionaries (used when forcing a language). */
    function translateFrom(dictionary) {
      return (key, params) => {
        const template = Object.prototype.hasOwnProperty.call(dictionary, key) ? dictionary[key] : key
        return params === undefined ? template : formatMessage(template, params)
      }
    }

    /**
     * Effective translator: `auto` delegates to the DSH-bound translator (live locale), `zh`/`en`
     * use the panel's own dictionaries so the whole panel switches language.
     */
    function translatorFor(mode, dshTranslator) {
      if (mode === 'zh') return translateFrom(zh)
      if (mode === 'en') return translateFrom(en)
      return dshTranslator
    }

    /** Effective Intl locale: forced modes use zh-CN / en-US, auto keeps the DSH locale. */
    function localeFor(mode, dshLocale) {
      if (mode === 'zh' || mode === 'en') return FORCED_LOCALES[mode]
      return dshLocale
    }

    /** Persisted language mode; storage failures fall back to `auto`. */
    function readStoredLang() {
      try {
        const stored = window.localStorage.getItem(LANG_STORAGE_KEY)
        return LANG_MODES.includes(stored) ? stored : 'auto'
      } catch {
        return 'auto'
      }
    }

    /** Persist the language mode, degrading silently when storage is unavailable. */
    function storeLang(mode) {
      try {
        window.localStorage.setItem(LANG_STORAGE_KEY, mode)
      } catch {
        /* private mode / storage disabled: the choice still applies for this page session */
      }
    }

    /** Persisted board display format; storage failures / unknown values fall back to `notes`. */
    function readStoredView() {
      try {
        const stored = window.localStorage.getItem(VIEW_STORAGE_KEY)
        return VIEW_MODES.includes(stored) ? stored : 'notes'
      } catch {
        return 'notes'
      }
    }

    /** Persist the display format, degrading silently when storage is unavailable. */
    function storeView(mode) {
      try {
        window.localStorage.setItem(VIEW_STORAGE_KEY, mode)
      } catch {
        /* private mode / storage disabled: the choice still applies for this page session */
      }
    }

    /* ---------------------------------------------------------------- memory */

    /** How often one note's deadline was postponed, from the state's memory block (0 when absent). */
    function postponeCountOf(memory, id) {
      const map = memory && typeof memory.postpones === 'object' && memory.postpones !== null ? memory.postpones : null
      if (map === null) return 0
      const value = map[String(id)]
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
    }

    /** Persisted coaching thread for one note, or null (old Host / no thread yet). */
    function threadOf(memory, id) {
      const threads = memory && typeof memory.threads === 'object' && memory.threads !== null ? memory.threads : null
      if (threads === null) return null
      const thread = threads[String(id)]
      return thread && typeof thread === 'object' ? thread : null
    }

    /** Facts from the state's memory block, newest first as the Host sends them. */
    function memoryFactsOf(memory) {
      return memory && Array.isArray(memory.facts) ? memory.facts.filter((fact) => fact && typeof fact.text === 'string') : []
    }

    /** Stored coaching rounds (question/answer pairs only) for re-requesting a thread. */
    function threadHistory(thread) {
      const rounds = thread && Array.isArray(thread.rounds) ? thread.rounds : []
      return rounds
        .filter((round) => round && typeof round.question === 'string' && typeof round.answer === 'string')
        .map((round) => ({ question: round.question, answer: round.answer }))
        .slice(0, MAX_ADVICE_ROUNDS)
    }

    /* ---------------------------------------------------------------- handoff */

    /** Client context captured in apply(); lets the panel reach optional client services. */
    let pluginContext = null

    /** Resolve the optional `uiWorkspace` client service from the captured plugin context. */
    function resolveUiWorkspace() {
      if (pluginContext === null) return null
      try {
        if (typeof pluginContext.get === 'function') {
          const service = pluginContext.get('uiWorkspace')
          if (service) return service
        }
      } catch {
        /* fall through to the property form */
      }
      try {
        return pluginContext.uiWorkspace ?? null
      } catch {
        return null
      }
    }

    /**
     * Build the plain-text prompt handed to the DSH chat draft for one note (Round 8 template):
     * title, optional details, the parts of due/priority/tags that exist, the note id, and a
     * closing instruction telling the main agent to update the note with the sticker_todo tool.
     * @param {Record<string, any>} todo one note.
     * @param {{ t: Function, localeId: string, language: 'zh'|'en' }} options translator + locale.
     * @returns {string} the prompt text.
     */
    function buildHandoffPrompt(todo, { t, localeId, language }) {
      const zh = language === 'zh'
      const text = String(todo?.text ?? '')
      const note = typeof todo?.note === 'string' ? todo.note.trim() : ''
      const priority = todo?.priority === 1 || todo?.priority === 3 ? todo.priority : 2
      const tags = todoTags(todo)
      const colon = zh ? '：' : ': '
      const separator = zh ? ' ｜ ' : ' | '
      const lines = [zh ? `帮我处理这条待办：${text}` : `Help me handle this todo: ${text}`]
      if (note !== '') lines.push(`${zh ? '详情' : 'Details'}${colon}${note}`)
      const meta = []
      if (typeof todo?.dueAt === 'string' && todo.dueAt !== '') {
        meta.push(`${zh ? '截止' : 'Due'}${colon}${formatDateTime(todo.dueAt, localeId)}`)
      }
      meta.push(`${zh ? '优先级' : 'Priority'}${colon}${t(`priority.${priority}`)}`)
      if (tags.length > 0) meta.push(`${zh ? '标签' : 'Tags'}${colon}${tags.map((tag) => `#${tag}`).join(' ')}`)
      lines.push(meta.join(separator))
      lines.push(`${zh ? '便签 id' : 'Note id'}${colon}${String(todo?.id ?? '')}`)
      lines.push(zh
        ? '（来自便利贴待办面板，可以用 sticker_todo 工具更新它）'
        : '(From the Sticker TODO panel — you can update it with the sticker_todo tool)')
      lines.push('')
      lines.push(zh
        ? '请直接推进：先判断这件事要怎么做，需要时用 sticker_todo 更新这条便签（补备注、拆成子项、改期或标记完成），不用先反问。'
        : 'Please move it forward directly: work out what needs doing first, and when useful update this note with sticker_todo (add details, break it into steps, reschedule, or mark it done) rather than asking first.')
      return lines.join('\n')
    }

    /**
     * Panel language broadcast: the board owns the switch, but the frame-wide reminder notice
     * (a separate slot component) must render in the same language, so the mode lives here.
     */
    const languageBus = (() => {
      let mode = readStoredLang()
      const listeners = new Set()
      const publish = () => {
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch {
            /* a crashed subscriber must not break the panel */
          }
        }
      }
      return {
        getSnapshot: () => mode,
        set(next) {
          if (!LANG_MODES.includes(next) || next === mode) return
          mode = next
          publish()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
      }
    })()

    /* --------------------------------------------------------------- helpers */

    const pad2 = (value) => String(value).padStart(2, '0')

    /** ISO timestamp → the local `YYYY-MM-DDTHH:mm` a datetime-local input expects. */
    function toLocalInput(iso) {
      if (typeof iso !== 'string' || iso === '') return ''
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return ''
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`
    }

    /** datetime-local value (local wall time) → ISO string, or null when empty/invalid. */
    function fromLocalInput(value) {
      const text = typeof value === 'string' ? value.trim() : ''
      if (text === '') return null
      const date = new Date(text)
      return Number.isNaN(date.getTime()) ? null : date.toISOString()
    }

    /** Display order, mirroring the Host store's sortTodos(). */
    function sortTodos(todos) {
      const time = (value) => {
        if (typeof value !== 'string') return Number.POSITIVE_INFINITY
        const parsed = new Date(value).getTime()
        return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed
      }
      const rank = (todo) => (todo.done ? 2 : todo.dueAt ? 0 : 1)
      return [...todos].sort((left, right) => {
        const byRank = rank(left) - rank(right)
        if (byRank !== 0) return byRank
        if (left.done && right.done) return time(right.updatedAt) - time(left.updatedAt)
        const byDue = time(left.dueAt) - time(right.dueAt)
        if (byDue !== 0) return byDue
        if (left.priority !== right.priority) return (left.priority || 2) - (right.priority || 2)
        return time(left.createdAt) - time(right.createdAt)
      })
    }

    const DATE_FORMATS = new Map() // locale|options -> Intl.DateTimeFormat

    function dateFormatter(localeId, options) {
      const key = `${localeId}|${JSON.stringify(options)}`
      const cached = DATE_FORMATS.get(key)
      if (cached !== undefined) return cached
      let formatter
      try {
        formatter = new Intl.DateTimeFormat(localeId, options)
      } catch {
        formatter = new Intl.DateTimeFormat(undefined, options)
      }
      DATE_FORMATS.set(key, formatter)
      return formatter
    }

    /** Local midnight of a date/time value. */
    function startOfDay(value) {
      const date = new Date(value)
      date.setHours(0, 0, 0, 0)
      return date.getTime()
    }

    /** Whole calendar days from `from` to `to`. */
    const dayOffset = (from, to) => Math.round((startOfDay(to) - startOfDay(from)) / 86400000)

    function formatClock(iso, localeId) {
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return ''
      return dateFormatter(localeId, { hour: '2-digit', minute: '2-digit' }).format(date)
    }

    function formatDateShort(iso, localeId) {
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return ''
      return dateFormatter(localeId, { month: 'numeric', day: 'numeric' }).format(date)
    }

    function formatDateTime(iso, localeId) {
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return ''
      return dateFormatter(localeId, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
    }

    /** Deadline chip: overdue / today / tomorrow / plain date. */
    function dueInfo(iso, nowIso, localeId, t) {
      if (typeof iso !== 'string') return null
      const due = new Date(iso)
      if (Number.isNaN(due.getTime())) return null
      const days = dayOffset(typeof nowIso === 'string' ? nowIso : Date.now(), due)
      const clock = formatClock(iso, localeId)
      const title = formatDateTime(iso, localeId)
      if (days < 0) return { text: `${t('due.overdue')} ${formatDateShort(iso, localeId)} ${clock}`.trim(), tone: 'stk-chip--overdue', title }
      if (days === 0) return { text: `${t('due.today')} ${clock}`.trim(), tone: 'stk-chip--today', title }
      if (days === 1) return { text: `${t('due.tomorrow')} ${clock}`.trim(), tone: 'stk-chip--tomorrow', title }
      return { text: `${formatDateShort(iso, localeId)} ${clock}`.trim(), tone: 'stk-chip--future', title }
    }

    /** Stable hand-written tilt (deg) for one note id. */
    function rotationFor(id) {
      let sum = 0
      for (let index = 0; index < id.length; index += 1) sum += id.charCodeAt(index)
      return ROTATIONS[sum % ROTATIONS.length]
    }

    /* ------------------------------------------------------------------- tags */

    /**
     * Canonical tags of one note as a clean `string[]`, capped at three.
     * Tolerates an older Host (no `tags` field) and a malformed persisted value.
     * @param {Record<string, any> | null | undefined} todo one note.
     * @returns {string[]} trimmed, length-bounded tags.
     */
    function todoTags(todo) {
      const raw = todo && Array.isArray(todo.tags) ? todo.tags : []
      const tags = []
      const seen = new Set()
      for (const value of raw) {
        if (typeof value !== 'string') continue
        const tag = clampTag(value.trim())
        if (tag === '') continue
        const key = tag.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        tags.push(tag)
        if (tags.length >= MAX_TAGS) break
      }
      return tags
    }

    /** Case-insensitive identity of one tag (the Host dedupes the same way). */
    const tagKeyOf = (tag) => tag.trim().toLowerCase()

    /** Clamp a tag to the contract's 12-character cap, counting code points like the Host does. */
    function clampTag(tag) {
      const chars = [...tag]
      return chars.length > TAG_MAX_LENGTH ? chars.slice(0, TAG_MAX_LENGTH).join('') : tag
    }

    /** Whether one note carries the tag identified by `key`. */
    const todoHasTag = (todo, key) => typeof key === 'string' && key !== '' && todoTags(todo).some((tag) => tagKeyOf(tag) === key)

    /**
     * Count how many entries carry each tag, case-insensitively, sorted count desc then name.
     * @param {string[][]} tagLists one tag list per entry (notes or TagResult items).
     * @returns {Array<{ key: string, tag: string, count: number }>} tag statistics.
     */
    function countTags(tagLists) {
      const stats = new Map()
      for (const tags of tagLists) {
        const seen = new Set()
        for (const tag of tags) {
          const key = tagKeyOf(tag)
          if (seen.has(key)) continue
          seen.add(key)
          const entry = stats.get(key)
          if (entry) entry.count += 1
          else stats.set(key, { key, tag, count: 1 })
        }
      }
      return [...stats.values()].sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag))
    }

    /**
     * Parse the form's tag field: space/comma separated, leading `#` stripped, at most three
     * unique tags (case-insensitively, first spelling wins), each bounded to the contract length.
     * @param {unknown} value raw textarea/input value.
     * @returns {string[]} canonical tags for `add`/`update`.
     */
    function parseTagsInput(value) {
      if (typeof value !== 'string') return []
      const seen = new Set()
      const tags = []
      for (const piece of value.split(/[\s,，、;；]+/)) {
        const tag = piece.trim().replace(/^#+/, '').trim()
        if (tag === '') continue
        const text = clampTag(tag)
        const key = tagKeyOf(text)
        if (seen.has(key)) continue
        seen.add(key)
        tags.push(text)
        if (tags.length >= MAX_TAGS) break
      }
      return tags
    }

    /** Render a note's tags back into the form field (space separated, no `#`). */
    const formatTagsInput = (tags) => todoTags({ tags }).join(' ')

    /* --------------------------------------------------------------- dialogs */

    /**
     * Local `datetime-local` value for one of the dialog's quick due choices.
     * Today / tomorrow / day-after are that day 23:59 local; next week is next Monday 23:59
     * (a full week ahead when today already is Monday).
     * @param {'today'|'tomorrow'|'dayAfter'|'nextWeek'} kind quick choice.
     * @param {Date} [now] reference clock (tests pass one).
     * @returns {string} value for a datetime-local input.
     */
    function quickDueValue(kind, now = new Date()) {
      const date = new Date(now.getTime())
      date.setHours(23, 59, 0, 0)
      if (kind === 'tomorrow') date.setDate(date.getDate() + 1)
      else if (kind === 'dayAfter') date.setDate(date.getDate() + 2)
      else if (kind === 'nextWeek') {
        const weekday = date.getDay() // 0 Sunday .. 6 Saturday
        let delta = (1 - weekday + 7) % 7 // days until the next Monday
        if (delta === 0) delta = 7 // today is Monday → advance a full week
        date.setDate(date.getDate() + delta)
      }
      return toLocalInput(date.toISOString())
    }

    /** Dialog draft prefilled from one note (or the empty draft when absent). */
    function draftFromTodo(todo) {
      return {
        text: String(todo?.text ?? ''),
        note: String(todo?.note ?? ''),
        dueAt: toLocalInput(todo?.dueAt),
        remindAt: toLocalInput(todo?.remindAt),
        color: COLORS.includes(todo?.color) ? todo.color : 'yellow',
        priority: todo?.priority === 1 || todo?.priority === 3 ? todo.priority : 2,
        tags: formatTagsInput(todo?.tags),
      }
    }

    /** Local `datetime-local` value one hour from now (the dialog's quick reminder). */
    function nextHourValue(now = new Date()) {
      return toLocalInput(new Date(now.getTime() + QUICK_REMIND_MS).toISOString())
    }

    /**
     * Read the advisory `options` a Host may send: trimmed, distinct, non-empty strings bounded by
     * the contract's count/length caps. Anything malformed is silently dropped so an old or
     * partially-conforming Host degrades to the free-input / editable-text experience.
     * @param {unknown} raw raw options array.
     * @param {number} maxCount maximum number of options to keep.
     * @param {number} maxLength maximum code-point length per option.
     * @returns {string[]} usable option labels.
     */
    function normalizeOptions(raw, maxCount, maxLength) {
      const candidates = Array.isArray(raw) ? raw : []
      const seen = new Set()
      const options = []
      for (const value of candidates) {
        if (typeof value !== 'string') continue
        const trimmed = value.trim()
        if (trimmed === '' || [...trimmed].length > maxLength) continue
        const key = trimmed.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        options.push(trimmed)
        if (options.length >= maxCount) break
      }
      return options
    }

    /** Persisted note-text font preset; storage failures fall back to `default`. */
    function readStoredFont() {
      try {
        const stored = window.localStorage.getItem(FONT_STORAGE_KEY)
        return FONT_PRESETS.includes(stored) ? stored : 'default'
      } catch {
        return 'default'
      }
    }

    /** Persist the font preset, degrading silently when storage is unavailable. */
    function storeFont(preset) {
      try {
        window.localStorage.setItem(FONT_STORAGE_KEY, preset)
      } catch {
        /* private mode / storage disabled: the choice still applies for this page session */
      }
    }

    /* ------------------------------------------------------------------- API */

    function networkFailure(error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[sticker-todo] request failed:', message)
      return { ok: false, error: { code: 'network', message } }
    }

    /** Normalize a fetch/parse result into the Host's `{ ok, data | error }` envelope. */
    async function requestJson(url, init) {
      try {
        const response = await fetch(url, init)
        const payload = await response.json().catch(() => null)
        if (payload !== null && payload.ok === true) return payload
        return {
          ok: false,
          error: {
            code: payload?.error?.code ?? 'http_error',
            message: payload?.error?.message ?? `HTTP ${response.status}`,
          },
        }
      } catch (error) {
        return networkFailure(error)
      }
    }

    const apiGet = () => requestJson(STATE_URL, { cache: 'no-store', headers: { Accept: 'application/json' } })

    const apiPost = (action, params = {}) =>
      requestJson(ACTION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ action, ...params }),
      })

    /* ------------------------------------------------------- reminder delivery */

    /**
     * Reminder id → the `remindAt` value already surfaced in this page session. A reminder is
     * announced once; because the key carries the scheduled time, editing a note's reminder to a
     * new time makes it announce again.
     */
    const announcedReminders = new Map()

    /**
     * Reminders surfaced but not acknowledged yet. Both the in-board banner and the global
     * `shell.overlay` notice render this one list and clear it through the same acknowledge
     * callback, so dismissing on either surface clears both.
     */
    const reminderBus = (() => {
      let items = []
      const listeners = new Set()
      const publish = (next) => {
        items = next
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch {
            /* a crashed subscriber must not break delivery to the others */
          }
        }
      }
      return {
        getSnapshot: () => items,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        /** Add not-yet-listed reminders, keeping the current order. */
        push(next) {
          const known = new Set(items.map((item) => String(item.id)))
          const fresh = next.filter((item) => !known.has(String(item.id)))
          if (fresh.length > 0) publish([...items, ...fresh])
        },
        /** Drop acknowledged reminders from every surface. */
        remove(ids) {
          const drop = new Set(ids.map(String))
          const next = items.filter((item) => !drop.has(String(item.id)))
          if (next.length !== items.length) publish(next)
        },
      }
    })()

    /** Browser notification for reminders — only when permission is already granted. */
    function notifyDesktop(t, items, openPanel) {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || items.length === 0) return
      try {
        const notification = new Notification(t('notify.title'), {
          body: items.map((item) => String(item.text ?? '')).join(' · '),
          tag: 'sticker-todo-reminder',
        })
        notification.onclick = () => {
          if (typeof window !== 'undefined') window.focus()
          try {
            openPanel()
          } catch {
            /* the board may have been unregistered since the reminder fired */
          }
          notification.close()
        }
      } catch {
        /* the host may refuse native notifications; the in-app surfaces still show */
      }
    }

    /**
     * Announce due reminders on every enabled surface exactly once.
     * @param {Array<Record<string, any>>} due dueReminders from the Host.
     * @param {Function} t namespace translator.
     * @param {Function} openPanel opens the board from a desktop notification.
     * @returns {number} how many reminders were newly surfaced.
     */
    function surfaceReminders(due, t, openPanel) {
      const fresh = due.filter((item) => {
        if (!item || typeof item.id !== 'string') return false
        return announcedReminders.get(item.id) !== String(item.remindAt ?? '')
      })
      if (fresh.length === 0) return 0
      for (const item of fresh) announcedReminders.set(item.id, String(item.remindAt ?? ''))
      reminderBus.push(fresh)
      notifyDesktop(t, fresh, openPanel)
      return fresh.length
    }

    /* ------------------------------------------------------------- components */

    /**
     * Sidebar glyph: a hand-drawn note whose corner is folded, with two checked boxes.
     * The host row supplies the accessible name and tooltip from the entry's `label`.
     */
    function StickerTodoIcon({ size = 16, active }) {
      return h(
        'svg',
        {
          width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
          strokeWidth: active ? 2 : 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': 'true', focusable: 'false', style: { display: 'block' },
        },
        h('path', { d: 'M6.4 3.6 C5.5 3.7 5 4.4 5 5.3 L5 18.4 C5 19.3 5.6 20 6.5 20 L17.4 20 C18.3 20 19 19.3 19 18.4 L19 9.4 L13.6 3.6 Z' }),
        h('path', { d: 'M13.6 3.6 L13.6 9.4 L19 9.4' }),
        h('path', { d: 'M7.6 11.6 l1.2 1.2 l2 -2.4' }),
        h('path', { d: 'M13.2 11.9 h3.2' }),
        h('path', { d: 'M7.6 15.5 l1.2 1.2 l2 -2.4' }),
        h('path', { d: 'M13.2 15.8 h3.2' })
      )
    }

    /**
     * The one create/edit dialog. Presentational: the panel owns the draft and the modal state.
     * The 详情 textarea is the dominant element; 标题 is required and autofocused.
     */
    function NoteDialog({ t, mode, draft, onChange, onSubmit, onCancel, busy, closing }) {
      const setField = (field) => (event) => onChange({ ...draft, [field]: event.target.value })
      const submit = (event) => {
        event.preventDefault()
        if (!busy) onSubmit()
      }
      const titleKey = mode === 'edit' ? 'dialog.editTitle' : 'dialog.createTitle'
      const hasDue = typeof draft.dueAt === 'string' && draft.dueAt !== ''
      const hasRemind = typeof draft.remindAt === 'string' && draft.remindAt !== ''
      return h('div', {
        className: `stk-modal-layer${closing ? ' stk-modal-layer--closing' : ''}`,
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onCancel()
        },
      },
        h('div', {
          className: `stk-modal stk-modal--editor${closing ? ' stk-modal--closing' : ''}`,
          role: 'dialog', 'aria-modal': 'true', 'aria-label': t(titleKey),
          onMouseDown: (event) => event.stopPropagation(),
        },
          h('div', { className: 'stk-modal-head' },
            h('span', { className: 'stk-modal-title' }, t(titleKey)),
            h('button', {
              type: 'button', className: 'stk-modal-close',
              title: t('action.dismiss'), 'aria-label': t('action.dismiss'), onClick: onCancel,
            }, '×')),
          h('form', { className: 'stk-modal-form', onSubmit: submit },
            h('div', { className: 'stk-modal-body' },
              h('div', { className: 'stk-dialog-field' },
                h('label', { className: 'stk-dialog-label', htmlFor: 'stk-dialog-title' }, t('dialog.titleLabel')),
                h('input', {
                  id: 'stk-dialog-title', className: 'stk-field-input', type: 'text', autoFocus: true,
                  value: draft.text, placeholder: t('dialog.titlePlaceholder'),
                  'aria-label': t('dialog.titleLabel'), onChange: setField('text'),
                })),
              h('div', { className: 'stk-dialog-field stk-dialog-details' },
                h('label', { className: 'stk-dialog-label', htmlFor: 'stk-dialog-details' }, t('dialog.detailsLabel')),
                h('textarea', {
                  id: 'stk-dialog-details', className: 'stk-field-textarea', rows: 6,
                  value: draft.note, placeholder: t('dialog.detailsPlaceholder'),
                  'aria-label': t('dialog.detailsLabel'), onChange: setField('note'),
                })),
              h('div', { className: 'stk-dialog-row' },
                h('div', { className: 'stk-dialog-field' },
                  h('span', { className: 'stk-dialog-label' }, t('field.color')),
                  h('div', { className: 'stk-colors', role: 'group', 'aria-label': t('field.color') },
                    COLORS.map((color) => h('button', {
                      key: color, type: 'button', className: `stk-color stk-color--${color}`,
                      'aria-label': t(`color.${color}`), 'aria-pressed': draft.color === color,
                      title: t(`color.${color}`), onClick: () => onChange({ ...draft, color }),
                    })))),
                h('div', { className: 'stk-dialog-field' },
                  h('span', { className: 'stk-dialog-label' }, t('field.priority')),
                  h('div', { className: 'stk-priority-choices', role: 'group', 'aria-label': t('field.priority') },
                    PRIORITIES.map((priority) => h('button', {
                      key: priority,
                      type: 'button',
                      className: `stk-priority-choice stk-priority-choice--${PRIORITY_KEYS[priority]}`,
                      'aria-pressed': draft.priority === priority,
                      'aria-label': t(`priority.${priority}`), title: t(`priority.${priority}`),
                      onClick: () => onChange({ ...draft, priority }),
                    }, '⚑'))))),
              h('div', { className: 'stk-dialog-row stk-dialog-row--datetime' },
                h('div', { className: 'stk-dialog-field stk-dialog-field--grow' },
                  h('span', { className: 'stk-dialog-label' }, t('dialog.dueLabel')),
                  h('div', { className: 'stk-quick-row' },
                    DUE_QUICKS.map((kind) => h('button', {
                      key: kind, type: 'button', className: 'stk-chip stk-chip--filter',
                      'aria-pressed': draft.dueAt === quickDueValue(kind),
                      onClick: () => onChange({ ...draft, dueAt: quickDueValue(kind) }),
                    }, t(`dialog.quick.${kind}`))),
                    h('input', {
                      type: 'datetime-local', className: 'stk-field-input stk-field-input--datetime',
                      value: draft.dueAt, 'aria-label': t('dialog.dueLabel'), onChange: setField('dueAt'),
                    }),
                    hasDue
                      ? h('button', { type: 'button', className: 'stk-btn stk-btn--ghost', onClick: () => onChange({ ...draft, dueAt: '' }) }, t('dialog.clear'))
                      : null))),
              h('div', { className: 'stk-dialog-row stk-dialog-row--datetime' },
                h('div', { className: 'stk-dialog-field stk-dialog-field--grow' },
                  h('span', { className: 'stk-dialog-label' }, t('dialog.remindLabel')),
                  h('div', { className: 'stk-quick-row' },
                    h('input', {
                      type: 'datetime-local', className: 'stk-field-input stk-field-input--datetime',
                      value: draft.remindAt, 'aria-label': t('dialog.remindLabel'), onChange: setField('remindAt'),
                    }),
                    hasRemind
                      ? h('button', { type: 'button', className: 'stk-btn stk-btn--ghost', onClick: () => onChange({ ...draft, remindAt: '' }) }, t('dialog.clear'))
                      : h('button', { type: 'button', className: 'stk-btn', 'aria-label': t('dialog.setRemind'), onClick: () => onChange({ ...draft, remindAt: nextHourValue() }) }, `⏰ ${t('dialog.setRemind')}`)))),
              h('div', { className: 'stk-dialog-field' },
                h('label', { className: 'stk-dialog-label', htmlFor: 'stk-dialog-tags' }, t('field.tags')),
                h('input', {
                  id: 'stk-dialog-tags', className: 'stk-field-input', type: 'text',
                  value: draft.tags ?? '', placeholder: t('dialog.tagsPlaceholder'),
                  'aria-label': t('field.tags'), onChange: setField('tags'),
                }))),
            h('div', { className: 'stk-modal-foot' },
              h('button', { type: 'button', className: 'stk-btn', disabled: busy, onClick: onCancel }, t('edit.cancel')),
              h('button', {
                type: 'submit', className: 'stk-btn stk-btn--primary',
                disabled: busy || draft.text.trim() === '',
              }, t('edit.submit')))))
      )
    }

    /**
     * Meta chips (due / reminder / AI plan) shared by the sticky-note card and the minimal list.
     * @param {Record<string, any>} todo one note.
     * @param {Function} t effective translator.
     * @param {string} nowIso current Host clock (for due-wording).
     * @param {string} localeId effective Intl locale.
     * @param {string} [extraClass] extra class(es) for the chip (list variant uses `stk-chip--list`).
     * @returns {Array<any>} chip elements.
     */
    function noteMetaChips(todo, t, nowIso, localeId, extraClass = '', postponeCount = 0) {
      const due = dueInfo(todo.dueAt, nowIso, localeId, t)
      const chips = []
      if (due !== null) chips.push(h('span', { key: 'due', className: `stk-chip ${due.tone}${extraClass}`, title: due.title }, `⏳ ${due.text}`))
      if (todo.remindAt) chips.push(h('span', { key: 'remind', className: `stk-chip${extraClass}`, title: t('field.remind') }, `⏰ ${formatDateTime(todo.remindAt, localeId)}`))
      if (todo.planAt) chips.push(h('span', { key: 'plan', className: `stk-chip stk-chip--plan${extraClass}`, title: todo.planNote || t('ai.plan') }, `🗓 ${formatDateTime(todo.planAt, localeId)}`))
      if (postponeCount >= 2) {
        chips.push(h('span', {
          key: 'postpone', className: `stk-chip stk-chip--postpone${extraClass}`, title: t('memory.postponeHint'),
        }, t('memory.postponeTimes', { count: postponeCount })))
      }
      return chips
    }

    /**
     * Clickable `#tag` chips shared by the sticky-note card and the minimal list; a click filters
     * the board by that tag (no API call).
     * @param {Record<string, any>} todo one note.
     * @param {Function} t effective translator.
     * @param {Function} onTagClick called with the clicked tag.
     * @param {string} [extraClass] extra class(es) for the chip.
     * @returns {Array<any>} tag chip elements.
     */
    function noteTagChips(todo, t, onTagClick, extraClass = '') {
      return todoTags(todo).map((tag) => h('button', {
        key: tag,
        type: 'button',
        className: `stk-chip stk-chip--tag${extraClass}`,
        title: t('tag.filter', { tag }),
        'aria-label': t('tag.filter', { tag }),
        onClick: (event) => {
          event.stopPropagation()
          if (typeof onTagClick === 'function') onTagClick(tag)
        },
      }, `#${tag}`))
    }

    /**
     * One sticky note: title, details, tags, meta chips and hover actions.
     * Priority is conveyed visually by the colour-coded left edge/flag only (accessible via label).
     */
    function NoteCard(props) {
      const { todo, t, nowIso, localeId, armed, busy, registerNode } = props
      const priority = todo.priority === 1 || todo.priority === 3 ? todo.priority : 2
      const palette = COLORS.includes(todo.color) ? todo.color : 'yellow'
      const className = ['stk-note', `stk-note--${palette}`, `stk-note--p${priority}`]
      if (todo.done) className.push('stk-note--done')
      if (props.focused) className.push('stk-note--focus')
      const stagger = Math.max(0, Math.min(Number(props.delay) || 0, 10)) * 28
      const style = { '--stk-rot': `${rotationFor(String(todo.id))}deg`, '--stk-delay': `${stagger}ms` }

      const chips = noteMetaChips(todo, t, nowIso, localeId, '', Number(props.postponeCount) || 0)
      const tags = todoTags(todo)
      const tagChips = noteTagChips(todo, t, props.onTagClick)

      return h(
        'article',
        { className: className.join(' '), style, 'data-id': todo.id, ref: (node) => registerNode(String(todo.id), node) },
        h('span', {
          className: 'stk-note-priority', role: 'img',
          title: t(`priority.${priority}`), 'aria-label': t(`priority.${priority}`),
        }),
        h('div', { className: 'stk-note-top' },
          h('button', {
            type: 'button', role: 'checkbox', className: 'stk-check',
            'aria-checked': todo.done, 'aria-label': t('note.toggle'), title: t('note.toggle'),
            disabled: busy, onClick: props.onToggle,
          }, todo.done ? '✓' : ''),
          h('div', { className: 'stk-note-main' },
            h('div', { className: `stk-note-text${todo.done ? ' stk-note-text--done' : ''}` }, String(todo.text ?? '')),
            todo.note ? h('div', { className: 'stk-note-note' }, String(todo.note)) : null)),
        tags.length === 0 ? null : h('div', { className: 'stk-note-tags' }, tagChips),
        chips.length === 0 ? null : h('div', { className: 'stk-note-chips' }, chips),
        h('div', { className: 'stk-note-actions' },
          h('button', { type: 'button', className: 'stk-note-action', title: t('note.edit'), 'aria-label': t('note.edit'), disabled: busy, onClick: props.onEdit }, '✎'),
          h('button', { type: 'button', className: 'stk-note-action stk-note-action--ai', title: t('note.advice'), 'aria-label': t('note.advice'), onClick: props.onAdvice }, '✦'),
          h('button', { type: 'button', className: 'stk-note-action', title: t('note.remind'), 'aria-label': t('note.remind'), disabled: busy, onClick: props.onRemind }, '⏰'),
          h('button', { type: 'button', className: 'stk-note-action', title: t('note.focus'), 'aria-label': t('note.focus'), onClick: props.onFocus }, '◎'),
          h('button', {
            type: 'button', className: 'stk-note-action stk-note-action--handoff',
            title: `${t('note.handoff')} · ${t('note.handoffHint')}`, 'aria-label': t('note.handoff'),
            onClick: props.onHandoff,
          }, '↗'),
          h('button', {
            type: 'button', className: `stk-note-action${armed ? ' stk-note-action--armed' : ''}`,
            title: armed ? t('note.deleteConfirm') : t('note.delete'), 'aria-label': t('note.delete'),
            disabled: busy, onClick: props.onDelete,
          }, armed ? t('note.deleteConfirm') : '✕'))
      )
    }

    /**
     * One minimal list row: priority accent + checkbox + title-only row button (with a due
     * indicator and chevron); activating it expands the details, tags, meta chips and actions in
     * place. Presentational; the panel owns the expanded id.
     */
    function NoteListRow(props) {
      const { todo, t, nowIso, localeId, expanded, armed, busy, delay } = props
      const priority = todo.priority === 1 || todo.priority === 3 ? todo.priority : 2
      const due = dueInfo(todo.dueAt, nowIso, localeId, t)
      const tags = todoTags(todo)
      const chips = noteMetaChips(todo, t, nowIso, localeId, ' stk-chip--list', Number(props.postponeCount) || 0)
      const tagChips = noteTagChips(todo, t, props.onTagClick, ' stk-chip--list')
      const stagger = Math.max(0, Math.min(Number(delay) || 0, 12)) * 24
      const detailsId = `stk-list-details-${String(todo.id)}`
      const rowLabel = `${String(todo.text ?? '')} — ${t(expanded ? 'list.collapse' : 'list.expand')}`
      return h('li', {
        className: `stk-list-item stk-list-item--p${priority}${expanded ? ' stk-list-item--open' : ''}${todo.done ? ' stk-list-item--done' : ''}`,
        style: { '--stk-delay': `${stagger}ms` },
        'data-id': todo.id,
      },
        h('div', { className: 'stk-list-head' },
          h('button', {
            type: 'button', role: 'checkbox', className: 'stk-check stk-list-check',
            'aria-checked': todo.done, 'aria-label': t('note.toggle'), title: t('note.toggle'),
            disabled: busy, onClick: props.onToggle,
          }, todo.done ? '✓' : ''),
          h('button', {
            type: 'button', className: 'stk-list-row', 'aria-expanded': expanded,
            'aria-controls': detailsId, 'aria-label': rowLabel,
            title: t(expanded ? 'list.collapse' : 'list.expand'),
            onClick: props.onActivate,
          },
            h('span', { className: `stk-list-title${todo.done ? ' stk-list-title--done' : ''}` }, String(todo.text ?? '')),
            due === null ? null : h('span', { className: `stk-list-due ${due.tone}`, title: due.title }, due.text),
            h('span', { className: 'stk-list-chevron', 'aria-hidden': 'true' }, '▸'))),
        expanded ? h('div', {
          className: 'stk-list-details', id: detailsId, role: 'region', 'aria-label': t('list.details'),
        },
          todo.note ? h('div', { className: 'stk-list-note' }, String(todo.note)) : null,
          tags.length === 0 ? null : h('div', { className: 'stk-list-tags' }, tagChips),
          chips.length === 0 ? null : h('div', { className: 'stk-list-meta' }, chips),
          h('div', { className: 'stk-list-actions' },
            h('button', { type: 'button', className: 'stk-note-action', title: t('note.edit'), 'aria-label': t('note.edit'), disabled: busy, onClick: props.onEdit }, '✎'),
            h('button', { type: 'button', className: 'stk-note-action stk-note-action--ai', title: t('note.advice'), 'aria-label': t('note.advice'), onClick: props.onAdvice }, '✦'),
            h('button', { type: 'button', className: 'stk-note-action', title: t('note.remind'), 'aria-label': t('note.remind'), disabled: busy, onClick: props.onRemind }, '⏰'),
            h('button', {
              type: 'button', className: 'stk-note-action stk-note-action--handoff',
              title: `${t('note.handoff')} · ${t('note.handoffHint')}`, 'aria-label': t('note.handoff'),
              onClick: props.onHandoff,
            }, '↗'),
            h('button', {
              type: 'button', className: `stk-note-action${armed ? ' stk-note-action--armed' : ''}`,
              title: armed ? t('note.deleteConfirm') : t('note.delete'), 'aria-label': t('note.delete'),
              disabled: busy, onClick: props.onDelete,
            }, armed ? t('note.deleteConfirm') : '✕')))
        : null
      )
    }

    /**
     * The per-note AI advice dialog: one question round (option chips + editable answer) or the
     * suggestion (option chips + editable text, appending it to the note's details).
     * Presentational; the panel owns all state.
     */
    function AdviceDialog({
      t, dialog, onClose, onAnswerChange, onPickAnswer, onSubmitAnswer,
      onAdviceChange, onPickAlternative, onAppend, onContinue,
    }) {
      const phase = dialog.phase
      const closing = dialog.closing === true
      const questionRound = Math.min(MAX_ADVICE_ROUNDS, Math.max(1, (dialog.round || 0) + 1))
      const answer = String(dialog.answer ?? '')
      const adviceText = String(dialog.adviceText ?? '')
      const questionOptions = Array.isArray(dialog.options) ? dialog.options : []
      const adviceOptions = Array.isArray(dialog.adviceOptions) ? dialog.adviceOptions : []
      const errorNode = dialog.error
        ? h('div', {
            className: `stk-ai-error${dialog.error.hint ? ' stk-ai-error--hint' : ''}`, role: 'alert',
          }, dialog.error.text)
        : null
      const loadingNode = dialog.busy
        ? h('div', { className: 'stk-ai-loading' },
            h('span', { className: 'stk-spinner', 'aria-hidden': 'true' }), t('advice.thinking'))
        : null
      const questionOptionsNode = questionOptions.length === 0 ? null : h('div', {
        className: 'stk-advice-options', role: 'group', 'aria-label': t('advice.optionsLabel'),
      }, questionOptions.map((option) => h('button', {
        key: option,
        type: 'button',
        className: 'stk-chip stk-chip--option',
        'aria-pressed': answer === option,
        title: option,
        onClick: () => onPickAnswer(option),
      }, option)))
      const adviceOptionsNode = adviceOptions.length === 0 ? null : h('div', {
        className: 'stk-advice-options', role: 'group', 'aria-label': t('advice.alternativesLabel'),
      }, adviceOptions.map((option) => h('button', {
        key: option,
        type: 'button',
        className: 'stk-chip stk-chip--option',
        'aria-pressed': adviceText === option,
        title: option,
        onClick: () => onPickAlternative(option),
      }, option)))
      const questionNode = !dialog.busy && phase === 'question'
        ? h('div', { className: 'stk-advice-question' },
            h('div', { className: 'stk-advice-q-label' }, t('advice.questionTag')),
            h('div', { className: 'stk-advice-q-text' }, String(dialog.question ?? '')),
            questionOptionsNode,
            h('div', { className: 'stk-dialog-field' },
              h('label', { className: 'stk-dialog-label', htmlFor: 'stk-advice-answer' }, t('advice.answerLabel')),
              h('textarea', {
                id: 'stk-advice-answer', className: 'stk-field-textarea stk-field-textarea--answer', rows: 3,
                value: answer, placeholder: t('advice.answerPlaceholder'),
                'aria-label': t('advice.answerLabel'), onChange: onAnswerChange,
              })),
            h('div', { className: 'stk-advice-actions' },
              h('span', { className: 'stk-hint' }, t('advice.round', { round: questionRound })),
              h('button', {
                type: 'button', className: 'stk-btn stk-btn--primary',
                disabled: dialog.busy || answer.trim() === '', onClick: onSubmitAnswer,
              }, t('advice.submit'))))
        : null
      const adviceNode = !dialog.busy && phase === 'advice'
        ? h('div', { className: 'stk-advice-result' },
            h('div', { className: 'stk-ai-result-head' },
              h('span', { className: 'stk-ai-summary' }, t('advice.resultLabel')),
              h('span', { className: 'stk-chip stk-chip--plan' }, t(dialog.source === 'fallback' ? 'ai.source.fallback' : 'ai.source.model'))),
            adviceOptionsNode,
            h('textarea', {
              id: 'stk-advice-text', className: 'stk-field-textarea stk-field-textarea--advice', rows: 6,
              value: adviceText, 'aria-label': t('advice.resultLabel'), onChange: onAdviceChange,
            }),
            h('div', { className: 'stk-hint' }, t('advice.hint')),
            h('div', { className: 'stk-advice-actions' },
              h('button', { type: 'button', className: 'stk-btn', onClick: onClose }, t('advice.close')),
              dialog.resumed ? h('button', { type: 'button', className: 'stk-btn', onClick: onContinue }, t('memory.continueThread')) : null,
              h('button', {
                type: 'button', className: 'stk-btn stk-btn--primary',
                disabled: dialog.busy || adviceText.trim() === '', onClick: onAppend,
              }, t('advice.append'))))
        : null
      const idleNode = !dialog.busy && phase !== 'question' && phase !== 'advice' && !dialog.error
        ? h('div', { className: 'stk-ai-loading' },
            h('span', { className: 'stk-spinner', 'aria-hidden': 'true' }), t('advice.thinking'))
        : null
      return h('div', {
        className: `stk-modal-layer${closing ? ' stk-modal-layer--closing' : ''}`,
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onClose()
        },
      },
        h('div', {
          className: `stk-modal stk-modal--advice${closing ? ' stk-modal--closing' : ''}`,
          role: 'dialog', 'aria-modal': 'true', 'aria-label': t('advice.title'),
          onMouseDown: (event) => event.stopPropagation(),
        },
          h('div', { className: 'stk-modal-head' },
            h('span', { className: 'stk-ai-mark', 'aria-hidden': 'true' }, '✦'),
            h('span', { className: 'stk-modal-title' }, t('advice.title')),
            h('span', { className: 'stk-hint stk-advice-note-title', title: dialog.title }, dialog.title),
            h('button', {
              type: 'button', className: 'stk-modal-close',
              title: t('action.dismiss'), 'aria-label': t('action.dismiss'), onClick: onClose,
            }, '×')),
          h('div', { className: 'stk-modal-body stk-modal-body--advice' },
            errorNode, loadingNode, questionNode, adviceNode, idleNode)))
    }

    /**
     * The v1.7.0 memory dialog: user-owned facts, the weekly review and AI-proposed memory
     * candidates. Proposals are never stored until the user confirms. Presentational; the panel
     * owns all state and performs the Host calls.
     */
    function MemoryDialog({
      t, facts, review, candidates, closing, busy, error,
      factDraft, editingId, editDraft, clearArmed,
      onClose, onFactDraftChange, onRememberFact, onEditFact, onEditDraftChange,
      onSaveFactEdit, onCancelFactEdit, onForgetFact, onGenerateReview,
      onFindCandidates, onRememberCandidate, onIgnoreCandidate, onClearMemory,
    }) {
      const isBusy = busy !== null
      const errorNode = error ? h('div', { className: 'stk-ai-error', role: 'alert' }, error) : null
      const statChips = review === null ? [] : [
        ['memory.stats.completed', review.stats?.completed],
        ['memory.stats.created', review.stats?.created],
        ['memory.stats.postponed', review.stats?.postponed],
        ['memory.stats.removed', review.stats?.removed],
        ['memory.stats.open', review.stats?.open],
        ['memory.stats.overdue', review.stats?.overdue],
      ].map(([label, value]) => h('span', { className: 'stk-memory-stat', key: label },
        h('span', { className: 'stk-memory-stat-label' }, t(label)),
        h('span', { className: 'stk-memory-stat-value' }, String(typeof value === 'number' ? value : 0))))
      const highlights = Array.isArray(review?.highlights) ? review.highlights.filter((line) => typeof line === 'string' && line !== '') : []
      const tips = Array.isArray(review?.tips) ? review.tips.filter((tip) => tip && typeof tip.text === 'string' && tip.text !== '') : []

      const factForm = h('div', { className: 'stk-memory-form' },
        h('input', {
          className: 'stk-field-input', type: 'text', value: factDraft, autoFocus: true,
          placeholder: t('memory.factPlaceholder'), 'aria-label': t('memory.factPlaceholder'),
          onChange: onFactDraftChange,
          onKeyDown: (event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              if (!isBusy) onRememberFact()
            }
          },
        }),
        h('button', {
          type: 'button', className: 'stk-btn stk-btn--primary',
          disabled: isBusy || String(factDraft ?? '').trim() === '', onClick: onRememberFact,
        }, t('memory.remember')))

      const factItems = facts.map((fact) => {
        const editing = editingId === fact.id
        if (editing) {
          return h('li', { className: 'stk-memory-item', key: fact.id },
            h('div', { className: 'stk-memory-edit' },
              h('input', {
                className: 'stk-field-input', type: 'text', value: editDraft,
                'aria-label': t('memory.factsTitle'), onChange: onEditDraftChange,
              }),
              h('div', { className: 'stk-memory-actions' },
                h('button', {
                  type: 'button', className: 'stk-btn stk-btn--primary',
                  disabled: isBusy || String(editDraft ?? '').trim() === '', onClick: onSaveFactEdit,
                }, t('edit.submit')),
                h('button', { type: 'button', className: 'stk-btn stk-btn--ghost', onClick: onCancelFactEdit }, t('edit.cancel')))))
        }
        return h('li', { className: 'stk-memory-item', key: fact.id, 'data-fact-id': fact.id },
          h('span', { className: 'stk-memory-text' }, String(fact.text ?? '')),
          h('div', { className: 'stk-memory-actions' },
            h('button', {
              type: 'button', className: 'stk-mini-btn', title: t('note.edit'), 'aria-label': t('note.edit'),
              disabled: isBusy, onClick: () => onEditFact(fact),
            }, '✎'),
            h('button', {
              type: 'button', className: 'stk-mini-btn stk-mini-btn--danger', title: t('note.delete'),
              'aria-label': t('note.delete'), disabled: isBusy, onClick: () => onForgetFact(fact),
            }, '✕')))
      })

      const candidateItems = Array.isArray(candidates) ? candidates : null
      const candidateList = candidateItems === null
        ? h('div', { className: 'stk-memory-empty' }, t('memory.candidatesHint'))
        : candidateItems.length === 0
          ? h('div', { className: 'stk-memory-empty' }, t('memory.candidatesEmpty'))
          : h('ul', { className: 'stk-memory-candidates' }, candidateItems.map((candidate, index) => h('li', {
              className: 'stk-memory-candidate', key: `${String(candidate?.text ?? '')}-${index}`,
            },
              h('div', { className: 'stk-memory-candidate-text' }, String(candidate?.text ?? '')),
              candidate?.reason ? h('div', { className: 'stk-memory-candidate-reason' }, String(candidate.reason)) : null,
              h('div', { className: 'stk-memory-actions' },
                h('button', {
                  type: 'button', className: 'stk-btn stk-btn--primary', disabled: isBusy,
                  onClick: () => onRememberCandidate(candidate, index),
                }, t('memory.remember')),
                h('button', {
                  type: 'button', className: 'stk-btn stk-btn--ghost', disabled: isBusy,
                  onClick: () => onIgnoreCandidate(index),
                }, t('memory.ignore'))))))

      return h('div', {
        className: `stk-modal-layer${closing ? ' stk-modal-layer--closing' : ''}`,
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onClose()
        },
      },
        h('div', {
          className: `stk-modal stk-modal--memory${closing ? ' stk-modal--closing' : ''}`,
          role: 'dialog', 'aria-modal': 'true', 'aria-label': t('memory.title'),
          onMouseDown: (event) => event.stopPropagation(),
        },
          h('div', { className: 'stk-modal-head' },
            h('span', { className: 'stk-ai-mark', 'aria-hidden': 'true' }, '🧠'),
            h('span', { className: 'stk-modal-title' }, t('memory.title')),
            h('span', { className: 'stk-hint stk-advice-note-title' }, t('memory.hint')),
            h('button', {
              type: 'button', className: 'stk-modal-close',
              title: t('action.dismiss'), 'aria-label': t('action.dismiss'), onClick: onClose,
            }, '×')),
          h('div', { className: 'stk-modal-body stk-memory-body' },
            errorNode,
            h('section', { className: 'stk-memory-section', 'aria-label': t('memory.factsTitle') },
              h('div', { className: 'stk-memory-section-head' },
                h('span', { className: 'stk-memory-section-title' }, t('memory.factsTitle')),
                h('span', { className: 'stk-memory-section-count' }, String(facts.length))),
              facts.length === 0 ? h('div', { className: 'stk-memory-empty' }, t('memory.emptyFacts')) : h('ul', { className: 'stk-memory-list' }, factItems),
              factForm),
            h('section', { className: 'stk-memory-section', 'aria-label': t('memory.reviewTitle') },
              h('div', { className: 'stk-memory-section-head' },
                h('span', { className: 'stk-memory-section-title' }, t('memory.reviewTitle')),
                h('button', {
                  type: 'button', className: 'stk-btn', disabled: isBusy,
                  onClick: onGenerateReview,
                }, busy === 'review' ? t('memory.reviewing') : t('memory.generateReview'))),
              review === null
                ? h('div', { className: 'stk-memory-empty' }, t('memory.reviewHint'))
                : h('div', { className: 'stk-memory-review' },
                    h('div', { className: 'stk-ai-result-head' },
                      h('span', { className: 'stk-ai-summary' }, String(review.headline ?? '')),
                      h('span', { className: 'stk-chip stk-chip--plan' }, t(review.source === 'fallback' ? 'ai.source.fallback' : 'ai.source.model'))),
                    h('div', { className: 'stk-memory-stats' }, statChips),
                    highlights.length === 0 ? null : h('div', { className: 'stk-memory-block' },
                      h('div', { className: 'stk-hint' }, t('memory.highlights')),
                      h('ul', { className: 'stk-memory-list' },
                        highlights.map((line, index) => h('li', { className: 'stk-memory-item', key: `highlight-${index}` },
                          h('span', { className: 'stk-memory-text' }, line))))),
                    tips.length === 0 ? null : h('div', { className: 'stk-memory-block' },
                      h('div', { className: 'stk-hint' }, t('memory.tips')),
                      h('ul', { className: 'stk-memory-list' },
                        tips.map((tip, index) => h('li', { className: 'stk-memory-item', key: `tip-${index}` },
                          h('span', { className: 'stk-memory-text' }, String(tip.text)))))))),
            h('section', { className: 'stk-memory-section', 'aria-label': t('memory.candidatesTitle') },
              h('div', { className: 'stk-memory-section-head' },
                h('span', { className: 'stk-memory-section-title' }, t('memory.candidatesTitle')),
                h('button', {
                  type: 'button', className: 'stk-btn', disabled: isBusy,
                  onClick: onFindCandidates,
                }, busy === 'candidates' ? t('memory.finding') : t('memory.findCandidates'))),
              h('div', { className: 'stk-hint' }, t('memory.candidatesHint')),
              candidateList)),
          h('div', { className: 'stk-modal-foot' },
            h('button', {
              type: 'button',
              className: `stk-btn stk-btn--danger${clearArmed ? ' stk-btn--danger-armed' : ''}`,
              disabled: isBusy, onClick: onClearMemory,
            }, clearArmed ? t('memory.clearConfirm') : t('memory.clear')),
            h('span', { className: 'stk-grow' }),
            h('button', { type: 'button', className: 'stk-btn', onClick: onClose }, t('action.dismiss')))))
    }

    /**
     * Frame-wide floating reminder card rendered into `shell.overlay`, so a timed reminder
     * reaches the user on any panel. Hidden while the sticker board itself is the active panel
     * (the board shows its own banner from the same state) and when nothing is due.
     * The card captures pointer events for itself only; the layer never does.
     */
    function StickerTodoNotice(props) {
      const { t: localeT, acknowledge, openPanel } = props
      const remindersHook = typeof props.useReminders === 'function' ? props.useReminders : (select) => select([])
      const localeHook = typeof props.useLocale === 'function' ? props.useLocale : (select) => select({ active: 'en' })
      const panelInfoHook = typeof props.usePanelInfo === 'function' ? props.usePanelInfo : () => null
      const reminders = remindersHook((list) => list) || []
      const dshLocale = localeHook((state) => state.active)
      const activePanel = panelInfoHook((info) => info && info.activePanelId)
      // Follow the panel's language switch so the frame-wide notice stays in the chosen language.
      const [languageMode, setLanguageMode] = useState(languageBus.getSnapshot())
      useEffect(() => languageBus.subscribe(() => setLanguageMode(languageBus.getSnapshot())), [])
      const t = translatorFor(languageMode, localeT)
      const activeLocale = localeFor(languageMode, dshLocale)
      if (activePanel === PANEL_ID || reminders.length === 0) return null
      const shown = reminders.slice(0, 3)
      const extra = reminders.length - shown.length
      const ack = () => {
        void acknowledge(reminders.map((item) => String(item.id)))
      }
      return h(
        React.Fragment,
        null,
        h('style', { key: 'stk-notice-style' }, NOTICE_STYLE),
        h('div', { className: 'stk-notice-layer' },
          h(
            'section',
            { className: 'stk-notice', role: 'status', 'aria-live': 'polite' },
            h('div', { className: 'stk-notice-head' },
              h('span', { className: 'stk-notice-glyph', 'aria-hidden': 'true' }, '⏰'),
              h('span', { className: 'stk-notice-title' }, t('reminder.title')),
              h('span', { className: 'stk-notice-count' }, t('reminder.body', { count: reminders.length }))),
            h('ul', { className: 'stk-notice-list' },
              shown.map((item) => h('li', { className: 'stk-notice-item', key: String(item.id) },
                h('span', { className: 'stk-notice-text', title: String(item.text ?? '') }, String(item.text ?? '')),
                h('span', { className: 'stk-notice-time' }, item.remindAt ? formatDateTime(item.remindAt, activeLocale) : '')))),
            extra > 0 ? h('div', { className: 'stk-notice-more' }, t('reminder.more', { count: extra })) : null,
            h('div', { className: 'stk-notice-actions' },
              h('button', { type: 'button', className: 'stk-notice-btn', onClick: ack }, t('reminder.ack')),
              h('button', {
                type: 'button',
                className: 'stk-notice-btn stk-notice-btn--primary',
                onClick: () => openPanel(),
              }, t('reminder.open')))
          )
        )
      )
    }

    /** Self-contained stylesheet for the global notice (the board's stylesheet may not be mounted). */
    const NOTICE_STYLE = `
.stk-notice-layer{position:fixed;right:20px;bottom:24px;z-index:70;display:flex;flex-direction:column;align-items:flex-end;pointer-events:none}
.stk-notice{pointer-events:auto;display:flex;flex-direction:column;gap:7px;width:min(320px,calc(100vw - 40px));padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-left:3px solid var(--dsw-alias-state-warn-primary);border-radius:12px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 12px 28px rgba(0,0,0,.22);font-size:12px;animation:stk-notice-in .18s ease}
.stk-notice-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.stk-notice-glyph{font-size:13px;line-height:1}
.stk-notice-title{font-size:13px;font-weight:600}
.stk-notice-count{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary)}
.stk-notice-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}
.stk-notice-item{display:flex;gap:8px;align-items:baseline;min-width:0}
.stk-notice-text{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.stk-notice-time{flex:0 0 auto;font-size:11px;color:var(--dsw-alias-state-warn-primary);font-variant-numeric:tabular-nums}
.stk-notice-more{font-size:11px;color:var(--dsw-alias-label-secondary)}
.stk-notice-actions{display:flex;gap:6px;justify-content:flex-end;margin-top:1px}
.stk-notice-btn{pointer-events:auto;font:inherit;font-size:12px;line-height:20px;padding:2px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;transition:border-color .15s ease,color .15s ease,filter .15s ease}
.stk-notice-btn:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.stk-notice-btn--primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.stk-notice-btn--primary:hover{color:#fff;filter:brightness(1.08)}
@keyframes stk-notice-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.stk-notice,.stk-notice-layer,.stk-notice-btn{animation:none!important;transition:none!important}}
`

    /* ----------------------------------------------------------------- style */

    const STYLE = `
@font-face{font-family:'STK Hand CJK';src:local('KaiTi'),local('Kaiti SC'),local('STKaiti'),local('KaiTi_GB2312'),local('华文楷体'),local('LXGW WenKai'),local('STXingkai'),local('行楷');unicode-range:U+2E80-2EFF,U+3000-303F,U+31C0-31EF,U+3200-32FF,U+3400-4DBF,U+4E00-9FFF,U+F900-FAFF,U+FE30-FE4F,U+FF00-FFEF}
@font-face{font-family:'STK Xingkai';src:local('STXingkai'),local('行楷'),local('Xingkai SC'),local('华文行楷')}
/* ---------------------------------------------------------------- shell */
.stk-root{position:relative;display:flex;flex:1 1 auto;flex-direction:column;min-height:0;overflow:auto;color:var(--dsw-alias-label-primary);--stk-note-font:'STK Hand CJK',var(--dsw-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);--stk-radius-sm:8px;--stk-radius:12px;--stk-radius-lg:16px;--stk-shadow-1:0 1px 2px rgba(60,42,20,.05),0 6px 14px rgba(60,42,20,.06);--stk-shadow-2:0 2px 4px rgba(60,42,20,.07),0 14px 28px rgba(60,42,20,.1),0 30px 52px rgba(60,42,20,.05);background:radial-gradient(120% 90% at 8% -4%,rgba(226,190,132,.2),rgba(226,190,132,0) 56%),radial-gradient(110% 85% at 94% 102%,rgba(188,150,102,.17),rgba(188,150,102,0) 60%),repeating-linear-gradient(0deg,rgba(120,86,48,.03) 0 2px,rgba(120,86,48,0) 2px 6px),var(--dsw-alias-bg-base)}
.stk-header{position:sticky;top:0;z-index:6;display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:14px 20px;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1);box-shadow:0 1px 0 rgba(255,255,255,.04),0 8px 22px rgba(0,0,0,.04)}
@supports (background:color-mix(in srgb,red 50%,transparent)){.stk-header{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 87%,transparent);backdrop-filter:saturate(1.2) blur(12px)}}
.stk-heading{display:flex;flex-direction:column;gap:3px;min-width:0}
.stk-title{font-size:18px;font-weight:650;letter-spacing:.015em;line-height:1.25}
.stk-sub{font-size:11.5px;letter-spacing:.01em;color:var(--dsw-alias-label-secondary)}
.stk-grow{flex:1 1 auto}
.stk-toolbar{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.stk-hint{font-size:11px;line-height:1.45;color:var(--dsw-alias-label-secondary)}
/* ------------------------------------------------------------- controls */
.stk-btn{font:inherit;font-size:12px;line-height:20px;display:inline-flex;align-items:center;gap:5px;padding:4px 11px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;transition:transform .16s ease,border-color .16s ease,color .16s ease,background .16s ease,box-shadow .16s ease,filter .16s ease,opacity .16s ease}
.stk-btn:hover:not(:disabled){transform:translateY(-1px);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);box-shadow:0 4px 12px rgba(0,0,0,.08)}
.stk-btn:active:not(:disabled){transform:translateY(0) scale(.985)}
.stk-btn:disabled{opacity:.45;cursor:default;transform:none}
.stk-btn--primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff;box-shadow:0 4px 14px rgba(77,107,254,.26)}
.stk-btn--primary:hover:not(:disabled){color:#fff;filter:brightness(1.06);box-shadow:0 8px 20px rgba(77,107,254,.32)}
.stk-btn--ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary);box-shadow:none}
.stk-btn--ghost:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:none}
.stk-root :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.stk-create{padding:6px 14px;font-weight:600;letter-spacing:.01em}
.stk-create-glyph{font-size:14px;line-height:1}
.stk-font{position:relative}
.stk-lang{position:relative}
.stk-lang-menu{min-width:200px}
.stk-view{position:relative}
.stk-view-menu{min-width:190px}
.stk-font-menu{position:absolute;top:calc(100% + 7px);right:0;z-index:30;display:flex;flex-direction:column;gap:2px;min-width:224px;padding:7px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-overlay);box-shadow:0 2px 6px rgba(0,0,0,.1),0 18px 38px rgba(0,0,0,.2);animation:stk-pop .16s cubic-bezier(.22,.61,.36,1) both}
.stk-font-hint{padding:3px 9px 5px;font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.stk-font-item{display:flex;align-items:center;gap:7px;padding:6px 9px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer;transition:background .14s ease,color .14s ease}
.stk-font-item:hover{background:var(--dsw-alias-bg-layer-2)}
.stk-font-item[aria-checked="true"]{color:var(--dsw-alias-brand-primary)}
.stk-font-check{width:12px;flex:0 0 auto;font-size:11px}
/* ------------------------------------------------------- notices/banner */
.stk-error{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin:14px 20px 0;padding:9px 13px;font-size:12px;color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-left:3px solid var(--dsw-alias-state-error-primary);border-radius:var(--stk-radius);box-shadow:var(--stk-shadow-1)}
.stk-banner{margin:14px 20px 0;padding:13px 15px;border:1px solid var(--dsw-alias-border-l2);border-left:4px solid var(--dsw-alias-state-warn-primary);border-radius:var(--stk-radius);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--stk-shadow-1);animation:stk-rise .28s cubic-bezier(.22,.61,.36,1) both}
.stk-banner-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.stk-banner-list{margin:9px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:5px}
.stk-banner-item{display:flex;gap:8px;align-items:baseline;font-size:12px;color:var(--dsw-alias-label-secondary);min-width:0}
.stk-banner-text{color:var(--dsw-alias-label-primary);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:52%}
.stk-banner-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:11px}
/* ---------------------------------------------------------------- AI card */
.stk-ai{margin:14px 20px 0;padding:14px 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--stk-radius-lg);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--stk-shadow-1)}
.stk-ai-head{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.stk-ai-mark{display:grid;place-items:center;width:22px;height:22px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary);font-size:12px;line-height:1;box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1)}
.stk-ai-title{font-size:13px;font-weight:600}
.stk-ai-actions{display:flex;gap:7px;flex-wrap:wrap;margin-left:auto}
.stk-ai-loading{position:relative;display:flex;align-items:center;gap:9px;margin-top:12px;padding:9px 12px;font-size:12px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--stk-radius-sm);background:linear-gradient(90deg,var(--dsw-alias-bg-layer-2) 0%,var(--dsw-alias-bg-layer-1) 50%,var(--dsw-alias-bg-layer-2) 100%);background-size:280px 100%;animation:stk-shimmer 1.3s linear infinite}
.stk-spinner{width:12px;height:12px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:stk-spin .8s linear infinite;flex:0 0 auto}
.stk-ai-error{margin-top:11px;font-size:12px;color:var(--dsw-alias-state-error-primary)}
.stk-ai-error--hint{color:var(--dsw-alias-label-secondary)}
.stk-ai-result{display:flex;flex-direction:column;gap:9px;margin-top:11px;padding-top:11px;border-top:1px dashed var(--dsw-alias-border-l1);font-size:12px;animation:stk-fade .22s ease both}
.stk-ai-result-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.stk-ai-summary{font-size:13px;font-weight:500;line-height:1.5;flex:1 1 220px;min-width:0}
.stk-ai-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:5px}
.stk-ai-item{display:flex;gap:6px;align-items:baseline;line-height:1.5;min-width:0;flex-wrap:wrap}
.stk-ai-time{flex:0 0 auto;color:var(--dsw-alias-brand-primary);font-variant-numeric:tabular-nums}
.stk-ai-text{flex:0 1 auto;min-width:0;overflow-wrap:anywhere}
.stk-ai-note{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.stk-ai-order-wrap{display:flex;flex-direction:column;gap:5px}
.stk-ai-order{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0;list-style:none}
.stk-ai-order-item{display:inline-flex;align-items:center;gap:5px;max-width:260px;padding:2px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.stk-ai-order-index{color:var(--dsw-alias-brand-primary);font-weight:600}
.stk-ai-tag-count{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
/* ------------------------------------------------------------ filter row */
.stk-filter{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:14px 20px 0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--stk-radius);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--stk-shadow-1)}
.stk-filter-label{font-size:10.5px;letter-spacing:.02em;color:var(--dsw-alias-label-secondary);padding:0 2px}
.stk-chip{display:inline-flex;align-items:center;gap:4px;padding:0 8px;min-height:20px;border-radius:999px;border:1px solid rgba(58,52,43,.28);background:rgba(255,255,255,.34);font-family:var(--dsh-font-family-text,inherit);font-size:11px;line-height:19px;color:rgba(58,52,43,.86);white-space:nowrap;transition:transform .15s ease,border-color .15s ease,background .15s ease,color .15s ease}
.stk-chip--overdue{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);background:rgba(214,69,69,.1)}
.stk-chip--today{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);background:rgba(224,150,32,.12)}
.stk-chip--tomorrow{border-color:rgba(58,52,43,.45)}
.stk-chip--future{border-color:rgba(58,52,43,.3)}
.stk-chip--plan{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:rgba(77,107,254,.1)}
.stk-chip--tag{font:inherit;font-family:var(--dsh-font-family-text,inherit);font-size:11px;line-height:19px;padding:0 8px;cursor:pointer;border-color:rgba(58,52,43,.32);background:rgba(255,255,255,.44)}
.stk-chip--tag:hover{transform:translateY(-1px);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:rgba(255,255,255,.78)}
.stk-chip--filter{font:inherit;font-family:var(--dsh-font-family-text,inherit);font-size:11px;line-height:20px;height:23px;box-sizing:border-box;padding:0 10px;cursor:pointer;border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);transition:transform .15s ease,border-color .15s ease,color .15s ease,background .15s ease,box-shadow .15s ease}
.stk-chip--filter:hover{transform:translateY(-1px);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.stk-chip--filter:active{transform:translateY(0) scale(.98)}
.stk-chip--filter[aria-pressed="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff;box-shadow:0 3px 10px rgba(77,107,254,.28)}
.stk-chip-count{font-size:10px;font-variant-numeric:tabular-nums;opacity:.8}
.stk-layout-toggle{display:flex;gap:5px;margin-left:auto}
.stk-layout-toggle .stk-chip--filter{height:23px}
/* ---------------------------------------------------------------- board */
.stk-board{flex:1 0 auto;display:flex;flex-direction:column;gap:20px;padding:20px 20px 26px}
.stk-board-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(244px,1fr));gap:22px 24px;align-items:start}
.stk-board-group{display:flex;flex-direction:column;gap:11px;animation:stk-fade .26s ease backwards;animation-delay:var(--stk-delay,0ms)}
.stk-board-group-head{display:flex;align-items:center;gap:9px;min-width:0;padding:0 2px 7px;border-bottom:1px dashed var(--dsw-alias-border-l1)}
.stk-group-tag{font-size:13.5px;font-weight:650;letter-spacing:.01em;color:var(--dsw-alias-label-primary)}
.stk-group-count{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:18px;padding:0 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.stk-group-untagged .stk-group-tag{color:var(--dsw-alias-label-secondary)}
.stk-empty{display:flex;flex-direction:column;align-items:center;gap:11px;padding:46px 18px;text-align:center;font-size:13px;color:var(--dsw-alias-label-secondary);border:1px dashed var(--dsw-alias-border-l2);border-radius:var(--stk-radius-lg);background:var(--dsw-alias-bg-layer-1);animation:stk-fade .3s ease both}
.stk-empty--filter{gap:9px}
.stk-empty--loading{animation:none}
.stk-empty-icon{display:grid;place-items:center;width:54px;height:54px;font-size:23px;border-radius:50%;background:var(--dsw-alias-bg-layer-2);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1)}
.stk-empty-text{max-width:340px;line-height:1.55}
.stk-empty .stk-btn{margin-top:2px}
/* ------------------------------------------------------------ note cards */
.stk-note{position:relative;display:flex;flex-direction:column;gap:9px;padding:20px 16px 14px 22px;border-radius:4px 4px 5px 5px;background-color:var(--stk-bg);background-image:repeating-linear-gradient(0deg,rgba(255,255,255,.22) 0 1px,rgba(255,255,255,0) 1px 3px),repeating-linear-gradient(90deg,rgba(120,96,60,.03) 0 1px,rgba(120,96,60,0) 1px 4px);color:#3a342b;box-shadow:0 1px 2px rgba(74,54,27,.12),0 8px 16px rgba(74,54,27,.1),0 22px 34px rgba(74,54,27,.05);transform:rotate(var(--stk-rot,0deg));transition:transform .22s cubic-bezier(.22,.61,.36,1),box-shadow .22s ease,filter .18s ease;font-family:var(--stk-note-font,'KaiTi','Kaiti SC','STKaiti','LXGW WenKai','Microsoft YaHei','PingFang SC','Hiragino Sans GB','Noto Sans CJK SC',sans-serif);animation:stk-note-in .3s cubic-bezier(.22,.61,.36,1) backwards;animation-delay:var(--stk-delay,0ms)}
.stk-note:hover,.stk-note:focus-within{transform:rotate(0deg) translateY(-3px);box-shadow:0 2px 4px rgba(74,54,27,.14),0 18px 30px rgba(74,54,27,.16),0 36px 54px rgba(74,54,27,.08);z-index:2}
.stk-note::before{content:"";position:absolute;top:-10px;left:50%;width:66px;height:17px;margin-left:-33px;border-radius:2px;background:linear-gradient(180deg,rgba(255,255,255,.74),rgba(255,248,230,.5));border-left:1px dashed rgba(120,96,60,.28);border-right:1px dashed rgba(120,96,60,.28);box-shadow:0 1px 3px rgba(74,54,27,.14);transform:rotate(-2deg)}
.stk-note::after{content:"";position:absolute;right:0;bottom:0;width:24px;height:24px;border-bottom-right-radius:5px;background:linear-gradient(135deg,rgba(0,0,0,.09),rgba(0,0,0,.02) 52%,rgba(255,255,255,.42));pointer-events:none}
.stk-note--done{opacity:.6}
.stk-note--focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}
.stk-note--yellow{--stk-bg:#fff3b0}
.stk-note--pink{--stk-bg:#ffd8e4}
.stk-note--blue{--stk-bg:#d7ecff}
.stk-note--green{--stk-bg:#dcf3cf}
.stk-note--purple{--stk-bg:#e9ddff}
.stk-note--orange{--stk-bg:#ffe2c4}
.stk-note--p1{--stk-pri:#d64545}
.stk-note--p2{--stk-pri:#e09620}
.stk-note--p3{--stk-pri:#9aa0a6}
.stk-note-priority{position:absolute;left:0;top:0;bottom:0;width:8px;border-radius:4px 0 0 5px;background:linear-gradient(180deg,var(--stk-pri,#e09620),var(--stk-pri,#e09620));z-index:1;box-shadow:inset -1px 0 0 rgba(255,255,255,.35)}
.stk-note-priority::after{content:"";position:absolute;top:10px;left:2px;width:4px;height:4px;border-radius:50%;background:rgba(255,255,255,.9)}
.stk-note-top{display:flex;align-items:flex-start;gap:9px}
.stk-note-main{display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-width:0}
.stk-check{flex:0 0 auto;width:20px;height:20px;margin-top:1px;padding:0;display:grid;place-items:center;border:1.6px solid rgba(58,52,43,.7);border-radius:6px;background:rgba(255,255,255,.35);color:#3a342b;font:inherit;font-size:12px;line-height:1;cursor:pointer;transition:transform .14s ease,background .14s ease,border-color .14s ease,color .14s ease}
.stk-check:hover:not(:disabled){transform:scale(1.06);border-color:#3a342b}
.stk-check[aria-checked="true"]{background:rgba(58,52,43,.84);border-color:#3a342b;color:var(--stk-bg)}
.stk-check:disabled{opacity:.55;cursor:default}
.stk-note-text{font-size:16px;font-weight:650;line-height:1.4;letter-spacing:.005em;word-break:break-word;overflow-wrap:anywhere;white-space:pre-wrap}
.stk-note-text--done{text-decoration:line-through;text-decoration-thickness:1.5px;opacity:.85}
.stk-note-note{font-family:inherit;font-size:12.5px;line-height:1.55;color:rgba(58,52,43,.76);white-space:pre-wrap;overflow-wrap:anywhere}
.stk-note-tags{display:flex;flex-wrap:wrap;gap:5px;margin-left:29px}
.stk-note-chips{display:flex;flex-wrap:wrap;gap:5px;margin-left:29px}
.stk-note-actions{display:flex;gap:6px;margin-left:29px;opacity:0;transform:translateY(2px);transition:opacity .18s ease,transform .18s ease}
.stk-note:hover .stk-note-actions,.stk-note:focus-within .stk-note-actions{opacity:1;transform:translateY(0)}
.stk-note-action{width:23px;height:23px;padding:0;display:grid;place-items:center;border:1px solid rgba(58,52,43,.28);border-radius:50%;background:rgba(255,255,255,.6);color:#3a342b;font-family:var(--dsh-font-family-text,inherit);font-size:11px;line-height:1;cursor:pointer;transition:transform .14s ease,background .14s ease,border-color .14s ease,color .14s ease,opacity .14s ease}
.stk-note-action:hover:not(:disabled){transform:scale(1.08);background:rgba(255,255,255,.94)}
.stk-note-action:active:not(:disabled){transform:scale(.96)}
.stk-note-action:disabled{opacity:.5;cursor:default}
.stk-note-action--armed{width:auto;padding:0 8px;border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);background:#fff}
.stk-note-action--ai{color:var(--dsw-alias-brand-primary);border-color:rgba(77,107,254,.42);background:rgba(255,255,255,.72)}
.stk-note-action--handoff{color:#3a342b;border-color:rgba(58,52,43,.38);background:rgba(255,255,255,.72);font-weight:600}
@media (hover:none){.stk-note-actions{opacity:1;transform:none}}
/* --------------------------------------------------------------- dialogs */
.stk-modal-layer{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(24,18,10,.5);animation:stk-layer-in .18s ease both}
.stk-modal-layer--closing{animation:stk-layer-out .15s ease forwards}
.stk-modal{display:flex;flex-direction:column;width:min(680px,100%);max-height:min(88vh,820px);overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:18px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 2px 6px rgba(0,0,0,.14),0 26px 64px rgba(0,0,0,.3);animation:stk-dialog-in .2s cubic-bezier(.22,.61,.36,1) both}
.stk-modal--closing{animation:stk-dialog-out .15s ease forwards}
.stk-modal--advice{width:min(560px,100%)}
.stk-modal-head{display:flex;align-items:center;gap:9px;flex:0 0 auto;padding:15px 18px;border-bottom:1px solid var(--dsw-alias-border-l1);background:linear-gradient(180deg,var(--dsw-alias-bg-layer-2),var(--dsw-alias-bg-overlay))}
.stk-modal-title{font-size:15px;font-weight:650;letter-spacing:.01em}
.stk-modal-close{margin-left:auto;flex:0 0 auto;width:26px;height:26px;padding:0;display:grid;place-items:center;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:15px;line-height:1;cursor:pointer;transition:transform .14s ease,background .14s ease,color .14s ease}
.stk-modal-close:hover{transform:scale(1.06);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.stk-modal-form{display:flex;flex-direction:column;flex:1 1 auto;min-height:0}
.stk-modal-body{display:flex;flex-direction:column;gap:13px;flex:1 1 auto;min-height:0;padding:16px 18px;overflow:auto}
.stk-modal-body--advice{gap:11px}
.stk-modal-foot{display:flex;justify-content:flex-end;gap:9px;flex:0 0 auto;padding:13px 18px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.stk-dialog-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.stk-dialog-field--grow{flex:1 1 auto;min-width:0}
.stk-dialog-details{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:6px}
.stk-dialog-label{font-size:11px;font-weight:500;letter-spacing:.02em;color:var(--dsw-alias-label-secondary)}
.stk-dialog-row{display:flex;gap:18px;flex-wrap:wrap;align-items:flex-end}
.stk-dialog-row--datetime{flex-direction:column;align-items:stretch;gap:9px}
.stk-field-input{box-sizing:border-box;width:100%;padding:8px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;outline:none;transition:border-color .16s ease,box-shadow .16s ease,background .16s ease}
.stk-field-input:hover{border-color:var(--dsw-alias-border-l3,var(--dsw-alias-border-l2))}
.stk-field-input:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px rgba(77,107,254,.16);background:var(--dsw-alias-bg-overlay)}
.stk-field-input--datetime{width:auto;max-width:232px;flex:0 1 auto;font-size:12px}
.stk-field-textarea{box-sizing:border-box;width:100%;padding:9px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.55;outline:none;resize:vertical;transition:border-color .16s ease,box-shadow .16s ease,background .16s ease}
.stk-dialog-details .stk-field-textarea{flex:1 1 auto;min-height:150px}
.stk-field-textarea:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px rgba(77,107,254,.16);background:var(--dsw-alias-bg-overlay)}
.stk-field-textarea--answer{min-height:78px}
.stk-field-textarea--advice{min-height:136px}
.stk-quick-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.stk-colors{display:flex;gap:7px;align-items:center}
.stk-color{width:19px;height:19px;padding:0;border:2px solid rgba(58,52,43,.18);border-radius:50%;cursor:pointer;transition:transform .14s ease,box-shadow .14s ease,border-color .14s ease}
.stk-color:hover{transform:scale(1.12)}
.stk-color[aria-pressed="true"]{border-color:#3a342b;box-shadow:0 0 0 2px rgba(58,52,43,.24)}
.stk-color--yellow{background:#f2d64b}
.stk-color--pink{background:#f28aa8}
.stk-color--blue{background:#6fb3ea}
.stk-color--green{background:#7fc46a}
.stk-color--purple{background:#a98bea}
.stk-color--orange{background:#f0a45c}
.stk-priority-choices{display:flex;gap:7px;align-items:center}
.stk-priority-choice{width:30px;height:30px;padding:0;display:grid;place-items:center;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-2);font-size:15px;line-height:1;cursor:pointer;transition:transform .14s ease,border-color .14s ease,box-shadow .14s ease}
.stk-priority-choice:hover{transform:translateY(-1px)}
.stk-priority-choice--high{color:#d64545}
.stk-priority-choice--medium{color:#e09620}
.stk-priority-choice--low{color:#9aa0a6}
.stk-priority-choice[aria-pressed="true"]{border-color:currentColor;box-shadow:0 0 0 3px rgba(0,0,0,.1)}
/* --------------------------------------------------------- advice dialog */
.stk-advice-note-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stk-advice-question{display:flex;flex-direction:column;gap:10px}
.stk-advice-q-label{font-size:10.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-brand-primary)}
.stk-advice-q-text{font-size:13.5px;line-height:1.6;padding:12px 14px;border-left:3px solid var(--dsw-alias-brand-primary);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.stk-advice-options{display:flex;flex-wrap:wrap;gap:7px}
.stk-chip--option{font:inherit;font-family:var(--dsh-font-family-text,inherit);font-size:12px;line-height:1.35;height:auto;min-height:29px;padding:5px 12px;border-radius:10px;white-space:normal;text-align:left;max-width:100%;cursor:pointer;color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);transition:transform .15s ease,border-color .15s ease,background .15s ease,color .15s ease,box-shadow .15s ease}
.stk-chip--option:hover{transform:translateY(-1px);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.stk-chip--option[aria-pressed="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff;box-shadow:0 4px 12px rgba(77,107,254,.26)}
.stk-advice-result{display:flex;flex-direction:column;gap:9px}
.stk-advice-actions{display:flex;align-items:center;justify-content:flex-end;gap:9px;margin-top:3px}
/* ---------------------------------------------------------------- footer */
.stk-footer{position:sticky;bottom:0;z-index:5;display:flex;align-items:center;gap:15px;flex-wrap:wrap;padding:9px 20px;font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border-top:1px solid var(--dsw-alias-border-l1)}
/* ----------------------------------------------------------------- toast */
.stk-toast-layer{position:fixed;left:50%;bottom:28px;z-index:60;transform:translateX(-50%);display:flex;flex-direction:column;gap:8px;pointer-events:none}
.stk-toast{display:flex;align-items:center;gap:9px;max-width:min(520px,80vw);padding:9px 13px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-size:12px;box-shadow:0 2px 6px rgba(0,0,0,.12),0 14px 32px rgba(0,0,0,.2);pointer-events:auto;animation:stk-toast-in .24s cubic-bezier(.22,.61,.36,1)}
.stk-toast--error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.stk-toast--warn{border-color:var(--dsw-alias-state-warn-primary)}
.stk-toast--ok{border-color:var(--dsw-alias-state-success-primary)}
.stk-toast-dismiss{flex:0 0 auto;width:20px;height:20px;padding:0;display:grid;place-items:center;border:0;border-radius:50%;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:1;cursor:pointer;opacity:.7;transition:opacity .14s ease,transform .14s ease}
.stk-toast-dismiss:hover{opacity:1;transform:scale(1.08)}
/* ------------------------------------------------------ minimal list view */
.stk-board--list{padding:18px 20px 26px;gap:0}
.stk-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.stk-list-item{position:relative;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-left:4px solid var(--stk-pri,#e09620);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--stk-shadow-1);transition:border-color .16s ease,box-shadow .16s ease,background .16s ease;animation:stk-rise .26s cubic-bezier(.22,.61,.36,1) backwards;animation-delay:var(--stk-delay,0ms)}
.stk-list-item--p1{--stk-pri:#d64545}
.stk-list-item--p2{--stk-pri:#e09620}
.stk-list-item--p3{--stk-pri:#9aa0a6}
.stk-list-item:hover{box-shadow:0 2px 4px rgba(0,0,0,.06),0 10px 22px rgba(0,0,0,.08);border-color:var(--dsw-alias-border-l2)}
.stk-list-item--open{border-color:var(--dsw-alias-brand-primary);box-shadow:0 2px 6px rgba(0,0,0,.08),0 14px 30px rgba(0,0,0,.1);background:var(--dsw-alias-bg-overlay)}
.stk-list-item--done{opacity:.72}
.stk-list-head{display:flex;align-items:center;gap:10px;padding:9px 12px}
.stk-list-check{flex:0 0 auto;margin-top:0;border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:transparent}
.stk-list-check:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}
.stk-list-check[aria-checked="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.stk-list-row{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:10px;padding:2px 0;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}
.stk-list-title{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:550;transition:color .15s ease}
.stk-list-title--done{text-decoration:line-through;text-decoration-thickness:1.5px;opacity:.62}
.stk-list-due{flex:0 0 auto;padding:1px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;font-family:var(--dsh-font-family-text,inherit);font-size:10.5px;line-height:17px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.stk-list-due.stk-chip--overdue{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);background:rgba(214,69,69,.1)}
.stk-list-due.stk-chip--today{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);background:rgba(224,150,32,.12)}
.stk-list-chevron{flex:0 0 auto;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1;transition:transform .18s ease,color .18s ease}
.stk-list-item--open .stk-list-chevron{transform:rotate(90deg);color:var(--dsw-alias-brand-primary)}
.stk-list-details{display:flex;flex-direction:column;gap:8px;margin:0 12px;padding:10px 2px 13px;border-top:1px dashed var(--dsw-alias-border-l1);animation:stk-expand .22s cubic-bezier(.22,.61,.36,1) both}
.stk-list-note{font-size:12.5px;line-height:1.55;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
.stk-list-tags,.stk-list-meta{display:flex;flex-wrap:wrap;gap:5px}
.stk-list-actions{display:flex;gap:6px;justify-content:flex-end;margin-top:2px}
.stk-list-actions .stk-note-action{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.stk-list-actions .stk-note-action:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
.stk-list-actions .stk-note-action--ai{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.stk-list-actions .stk-note-action--handoff{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.stk-list-actions .stk-note-action--armed{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-overlay)}
.stk-chip--list{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.stk-chip--list.stk-chip--tag:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
.stk-chip--list.stk-chip--plan{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);background:rgba(77,107,254,.1)}
/* ---------------------------------------------------------- memory dialog */
.stk-modal--memory{width:min(640px,100%)}
.stk-memory-body{gap:14px}
.stk-memory-section{display:flex;flex-direction:column;gap:8px;padding:12px 13px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.stk-memory-section-head{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.stk-memory-section-title{font-size:13px;font-weight:650;color:var(--dsw-alias-label-primary)}
.stk-memory-section-count{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:17px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.stk-memory-section-head .stk-btn{margin-left:auto}
.stk-memory-empty{padding:10px 4px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.stk-memory-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}
.stk-memory-item{display:flex;align-items:center;gap:9px;min-width:0;padding:7px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-2)}
.stk-memory-text{flex:1 1 auto;min-width:0;font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.stk-memory-actions{display:flex;gap:6px;flex:0 0 auto;margin-left:auto}
.stk-mini-btn{width:24px;height:24px;padding:0;display:grid;place-items:center;border:1px solid var(--dsw-alias-border-l2);border-radius:50%;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:1;cursor:pointer;transition:transform .14s ease,border-color .14s ease,color .14s ease}
.stk-mini-btn:hover:not(:disabled){transform:scale(1.08);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.stk-mini-btn--danger:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.stk-mini-btn:disabled{opacity:.5;cursor:default}
.stk-memory-edit{display:flex;flex-direction:column;gap:7px;flex:1 1 auto;min-width:0}
.stk-memory-form{display:flex;align-items:center;gap:8px;margin-top:2px}
.stk-memory-form .stk-field-input{flex:1 1 auto}
.stk-memory-form .stk-btn{flex:0 0 auto;white-space:nowrap}
.stk-memory-review{display:flex;flex-direction:column;gap:9px}
.stk-memory-stats{display:flex;flex-wrap:wrap;gap:6px}
.stk-memory-stat{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-2);font-size:11px;color:var(--dsw-alias-label-secondary)}
.stk-memory-stat-value{font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.stk-memory-stat-label{color:var(--dsw-alias-label-secondary)}
.stk-memory-block{display:flex;flex-direction:column;gap:4px}
.stk-memory-block .stk-memory-item{padding:5px 9px}
.stk-memory-candidates{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:7px}
.stk-memory-candidate{display:flex;flex-direction:column;gap:5px;padding:9px 10px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.stk-memory-candidate-text{font-size:12.5px;font-weight:550;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.stk-memory-candidate-reason{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.stk-memory-candidate .stk-memory-actions{margin-left:0}
.stk-btn--danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);background:transparent}
.stk-btn--danger:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);background:rgba(214,69,69,.1)}
.stk-btn--danger-armed{background:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);color:#fff}
.stk-chip--postpone{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);background:rgba(224,150,32,.12)}
.stk-chip--list.stk-chip--postpone{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary);background:rgba(224,150,32,.12)}
/* -------------------------------------------------------------- keyframes */
@keyframes stk-rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
@keyframes stk-fade{from{opacity:0}to{opacity:1}}
@keyframes stk-note-in{from{opacity:0;transform:translateY(10px) rotate(var(--stk-rot,0deg))}to{opacity:1;transform:translateY(0) rotate(var(--stk-rot,0deg))}}
@keyframes stk-dialog-in{from{opacity:0;transform:translateY(10px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}
@keyframes stk-dialog-out{from{opacity:1;transform:translateY(0) scale(1)}to{opacity:0;transform:translateY(6px) scale(.985)}}
@keyframes stk-layer-in{from{opacity:0}to{opacity:1}}
@keyframes stk-layer-out{from{opacity:1}to{opacity:0}}
@keyframes stk-pop{from{opacity:0;transform:translateY(-4px) scale(.98)}to{opacity:1;transform:none}}
@keyframes stk-expand{from{opacity:0;transform:translateY(-5px)}to{opacity:1;transform:translateY(0)}}
@keyframes stk-toast-in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
@keyframes stk-spin{to{transform:rotate(360deg)}}
@keyframes stk-shimmer{from{background-position:-280px 0}to{background-position:280px 0}}
/* ---------------------------------------------------------------- motion */
@media (prefers-reduced-motion:reduce){
  .stk-root,.stk-root *,.stk-root *::before,.stk-root *::after{animation:none!important;transition:none!important}
  .stk-note,.stk-board-group,.stk-list-item,.stk-list-details,.stk-modal,.stk-modal-layer,.stk-toast,.stk-banner,.stk-error,.stk-empty,.stk-ai-result,.stk-font-menu,.stk-ai-loading,.stk-spinner{animation:none!important;transition:none!important}
  .stk-note:hover,.stk-note:focus-within{transform:rotate(var(--stk-rot,0deg))}
  .stk-btn:hover:not(:disabled),.stk-chip--filter:hover,.stk-chip--option:hover,.stk-chip--tag:hover,.stk-color:hover,.stk-priority-choice:hover,.stk-note-action:hover:not(:disabled),.stk-modal-close:hover,.stk-toast-dismiss:hover{transform:none}
  .stk-list-item--open .stk-list-chevron{transform:rotate(90deg)}
  .stk-ai-loading{background:var(--dsw-alias-bg-layer-2)}
}
@media (max-width:720px){
  .stk-header{padding:12px 14px;gap:9px}
  .stk-title{font-size:17px}
  .stk-banner,.stk-ai,.stk-error,.stk-filter{margin-left:14px;margin-right:14px}
  .stk-filter{padding:8px 9px}
  .stk-board{padding:14px 14px 22px;gap:16px}
  .stk-board-grid{grid-template-columns:1fr;gap:18px}
  .stk-board--list{padding:14px 14px 22px}
  .stk-list-head{padding:9px 10px}
  .stk-list-details{margin:0 10px}
  .stk-modal-layer{padding:10px}
  .stk-modal{max-height:94vh}
  .stk-dialog-row{gap:12px}
  .stk-footer{padding:9px 14px}
}
`

    /* ------------------------------------------------------------------ panel */

    /**
     * The full-page sticker board rendered into the `main` slot.
     * @param {{ t: Function, useLocale: Function, useReminders: Function, acknowledge: Function }} props slot kit.
     */
    function StickerTodoPanel(props) {
      const { t: localeT, acknowledge } = props
      const localeHook = typeof props.useLocale === 'function' ? props.useLocale : (select) => select({ active: 'en' })
      const remindersHook = typeof props.useReminders === 'function' ? props.useReminders : (select) => select([])
      const dshLocale = localeHook((state) => state.active)
      // The plugin-scope watcher owns reminder detection; the board renders the same shared list.
      const reminders = remindersHook((list) => list) || []

      const [snapshot, setSnapshot] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [aiBusy, setAiBusy] = useState(null)
      const [aiView, setAiView] = useState(null)
      const [aiError, setAiError] = useState(null)
      const [editor, setEditor] = useState(null) // create/edit dialog: { mode, id, draft } | null
      const [font, setFont] = useState(readStoredFont) // note-text font preset
      const [fontMenuOpen, setFontMenuOpen] = useState(false)
      const [grouped, setGrouped] = useState(true) // group the board by first tag once tags exist
      const [tagFilter, setTagFilter] = useState(null) // selected tag key, null = 全部
      const [adviceDialog, setAdviceDialog] = useState(null) // per-note AI advice conversation
      const [armedId, setArmedId] = useState(null)
      const [focusedId, setFocusedId] = useState(null)
      const [toast, setToast] = useState(null)
      const [permission, setPermission] = useState(() =>
        typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)
      const [lang, setLang] = useState(readStoredLang) // auto | zh | en (v1.4.0 bilingual panel)
      const [langMenuOpen, setLangMenuOpen] = useState(false)
      const [view, setView] = useState(readStoredView) // notes = sticky board (default) | list = minimal rows
      const [viewMenuOpen, setViewMenuOpen] = useState(false)
      const [expandedId, setExpandedId] = useState(null) // minimal-list row expanded in place (session only)
      // v1.7.0 memory dialog state (facts / weekly review / candidates / two-step clear)
      const [memoryOpen, setMemoryOpen] = useState(false)
      const [memoryClosing, setMemoryClosing] = useState(false)
      const [factsDraft, setFactsDraft] = useState('')
      const [factsEditingId, setFactsEditingId] = useState(null)
      const [factsEditDraft, setFactsEditDraft] = useState('')
      const [memoryError, setMemoryError] = useState(null)
      const [memoryBusy, setMemoryBusy] = useState(null) // remember | updateFact | forget | review | candidates | clear
      const [memoryReview, setMemoryReview] = useState(null)
      const [memoryCandidates, setMemoryCandidates] = useState(null) // null = not fetched yet
      const [memoryArmClear, setMemoryArmClear] = useState(false)

      // Effective translator + Intl locale: forced zh/en use the panel dictionaries and a fixed
      // locale, `auto` keeps following the DSH locale (including live changes).
      const t = translatorFor(lang, localeT)
      const activeLocale = localeFor(lang, dshLocale)
      // Language of generated free text (e.g. the 交给 DSH prompt): forced mode wins, otherwise
      // it follows the same DSH locale as the UI.
      const effectiveLanguage = lang === 'auto'
        ? (String(dshLocale ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en')
        : lang

      const tRef = useRef(t)
      tRef.current = t
      const mountedRef = useRef(true)
      const busyRef = useRef(false)
      const primedRemindersRef = useRef(false)
      const seenReminderKeysRef = useRef(new Set())
      const toastSeqRef = useRef(0)
      const nodesRef = useRef(new Map())

      useEffect(() => {
        mountedRef.current = true
        return () => {
          mountedRef.current = false
        }
      }, [])

      // Keep the frame-wide reminder notice in sync with the panel language choice.
      useEffect(() => {
        languageBus.set(lang)
      }, [lang])

      const pushToast = useCallback((text, tone) => {
        toastSeqRef.current += 1
        setToast({ id: toastSeqRef.current, text, tone })
      }, [])

      /** Read the Host state; a silent refresh keeps the current board on screen. */
      const refresh = useCallback(async (silent) => {
        if (!silent) setLoading(true)
        const result = await apiGet()
        if (!mountedRef.current) return
        if (!result.ok) {
          setError(result.error.message || tRef.current('error.load'))
          setLoading(false)
          return
        }
        setError(null)
        setSnapshot(result.data)
        setLoading(false)
      }, [])

      // The panel poller only refreshes board data; reminder detection belongs to the plugin-scope
      // watcher in apply(), so reminders also fire while another panel is selected.
      useEffect(() => {
        const tick = () => {
          if (mountedRef.current && !busyRef.current && (typeof document === 'undefined' || document.visibilityState !== 'hidden')) {
            void refresh(true)
          }
        }
        tick()
        const interval = window.setInterval(tick, POLL_MS)
        window.addEventListener('focus', tick)
        return () => {
          window.clearInterval(interval)
          window.removeEventListener('focus', tick)
        }
      }, [refresh])

      // A newly surfaced reminder toasts on the board too (the banner above lists it).
      useEffect(() => {
        const list = Array.isArray(reminders) ? reminders : []
        const keyOf = (item) => `${String(item.id)}|${String(item.remindAt ?? '')}`
        if (!primedRemindersRef.current) {
          primedRemindersRef.current = true
          for (const item of list) seenReminderKeysRef.current.add(keyOf(item))
          return
        }
        const fresh = list.filter((item) => !seenReminderKeysRef.current.has(keyOf(item)))
        if (fresh.length === 0) return
        for (const item of fresh) seenReminderKeysRef.current.add(keyOf(item))
        pushToast(tRef.current('toast.reminder', { count: fresh.length }), 'warn')
      }, [reminders, pushToast])

      useEffect(() => {
        if (toast === null) return undefined
        const timer = window.setTimeout(() => setToast(null), TOAST_MS)
        return () => window.clearTimeout(timer)
      }, [toast])

      useEffect(() => {
        if (armedId === null) return undefined
        const timer = window.setTimeout(() => setArmedId(null), DELETE_ARM_MS)
        return () => window.clearTimeout(timer)
      }, [armedId])

      useEffect(() => {
        if (focusedId === null) return undefined
        const timer = window.setTimeout(() => setFocusedId(null), 1800)
        return () => window.clearTimeout(timer)
      }, [focusedId])

      // The 清空记忆 button uses the same two-step confirm window as note deletion.
      useEffect(() => {
        if (!memoryArmClear) return undefined
        const timer = window.setTimeout(() => setMemoryArmClear(false), DELETE_ARM_MS)
        return () => window.clearTimeout(timer)
      }, [memoryArmClear])

      // Escape closes whichever surface is open (dialogs first, then a header menu).
      useEffect(() => {
        if (editor === null && adviceDialog === null && !memoryOpen && !fontMenuOpen && !langMenuOpen && !viewMenuOpen) return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          if (editor !== null) closeEditor()
          else if (adviceDialog !== null) closeAdviceDialog()
          else if (memoryOpen) closeMemory()
          else if (fontMenuOpen) setFontMenuOpen(false)
          else if (langMenuOpen) setLangMenuOpen(false)
          else setViewMenuOpen(false)
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [editor, adviceDialog, memoryOpen, fontMenuOpen, langMenuOpen, viewMenuOpen])

      // A click anywhere outside the font / language / view menus closes it.
      useEffect(() => {
        if (!fontMenuOpen && !langMenuOpen && !viewMenuOpen) return undefined
        const onPointerDown = (event) => {
          const target = event.target
          const inside = (selector) => Boolean(target && typeof target.closest === 'function' && target.closest(selector))
          if (!inside('.stk-font')) setFontMenuOpen(false)
          if (!inside('.stk-lang')) setLangMenuOpen(false)
          if (!inside('.stk-view')) setViewMenuOpen(false)
        }
        document.addEventListener('mousedown', onPointerDown)
        return () => document.removeEventListener('mousedown', onPointerDown)
      }, [fontMenuOpen, langMenuOpen, viewMenuOpen])

      const todos = Array.isArray(snapshot?.todos) ? snapshot.todos : EMPTY_TODOS
      const openCount = todos.filter((todo) => !todo.done).length
      const doneCount = todos.length - openCount
      const nowIso = snapshot?.now
      const ai = snapshot?.ai ?? null
      const todoById = useMemo(() => new Map(todos.map((todo) => [String(todo.id), todo])), [todos])
      const hasPlan = todos.some((todo) => todo.planAt)

      // v1.7.0 memory context; an older Host sends no memory block, so all of this stays empty.
      const memory = snapshot?.memory ?? null
      const memoryFacts = useMemo(() => memoryFactsOf(memory), [memory])

      // Tags currently in use, counted client-side across every note on the board.
      const tagStats = useMemo(() => countTags(todos.map(todoTags)), [todos])
      const tagFilterEntry = tagFilter === null ? null : tagStats.find((entry) => entry.key === tagFilter) ?? null
      const filteredTodos = tagFilter === null ? todos : todos.filter((todo) => todoHasTag(todo, tagFilter))

      // A filter only ever points at a tag that is still on the board; notes changing (or an old
      // Host answering without tags) drops it instead of leaving an empty, confusing filter.
      useEffect(() => {
        if (tagFilter === null) return
        if (!tagStats.some((entry) => entry.key === tagFilter)) setTagFilter(null)
      }, [tagStats, tagFilter])

      // The single expanded minimal-list row belongs to the current filtered view.
      useEffect(() => {
        setExpandedId(null)
      }, [tagFilter])

      const registerNode = useCallback((id, node) => {
        if (node === null) nodesRef.current.delete(id)
        else nodesRef.current.set(id, node)
      }, [])

      /** Run one store mutation under the shared busy flag; returns its data or null. */
      async function mutate(action, params) {
        busyRef.current = true
        setBusy(true)
        const result = await apiPost(action, params)
        busyRef.current = false
        if (mountedRef.current) setBusy(false)
        if (!result.ok) {
          pushToast(result.error.message || tRef.current('error.generic'), 'error')
          return null
        }
        return result.data
      }

      /** Upsert one note in local state and re-sort. */
      function putNote(note) {
        setSnapshot((previous) => {
          if (previous === null) return previous
          const list = Array.isArray(previous.todos) ? previous.todos : []
          const exists = list.some((item) => item.id === note.id)
          return { ...previous, todos: sortTodos(exists ? list.map((item) => (item.id === note.id ? note : item)) : [...list, note]) }
        })
      }

      async function toggleNote(todo) {
        const done = !todo.done
        const flip = (value) => (todoItem) => (todoItem.id === todo.id ? { ...todoItem, done: value } : todoItem)
        setSnapshot((previous) => previous === null ? previous : { ...previous, todos: sortTodos((previous.todos || []).map(flip(done))) })
        const updated = await mutate('toggle', { id: todo.id, done })
        if (updated === null) {
          setSnapshot((previous) => previous === null ? previous : { ...previous, todos: sortTodos((previous.todos || []).map(flip(todo.done))) })
          return
        }
        putNote(updated)
      }

      /** Open the create dialog with a fresh draft. */
      function openCreateEditor() {
        setArmedId(null)
        setAdviceDialog(null)
        setMemoryOpen(false)
        setFontMenuOpen(false)
        setLangMenuOpen(false)
        setViewMenuOpen(false)
        setEditor({ mode: 'create', id: null, draft: { ...EMPTY_DRAFT } })
      }

      /** Open the same dialog pre-filled for one note. */
      function openNoteEditor(todo) {
        setArmedId(null)
        setAdviceDialog(null)
        setMemoryOpen(false)
        setFontMenuOpen(false)
        setLangMenuOpen(false)
        setViewMenuOpen(false)
        setEditor({ mode: 'edit', id: String(todo.id), draft: draftFromTodo(todo) })
      }

      function changeEditorDraft(nextDraft) {
        setEditor((previous) => (previous === null ? previous : { ...previous, draft: nextDraft }))
      }

      /** Close the create/edit dialog with its short exit animation. */
      function closeEditor() {
        if (editor === null || editor.closing) return
        setEditor((previous) => (previous === null ? previous : { ...previous, closing: true }))
        window.setTimeout(() => {
          if (!mountedRef.current) return
          setEditor((previous) => (previous !== null && previous.closing ? null : previous))
        }, DIALOG_CLOSE_MS)
      }

      /** Close the per-note advice dialog with its short exit animation. */
      function closeAdviceDialog() {
        if (adviceDialog === null || adviceDialog.closing) return
        setAdviceDialog((previous) => (previous === null ? previous : { ...previous, closing: true }))
        window.setTimeout(() => {
          if (!mountedRef.current) return
          setAdviceDialog((previous) => (previous !== null && previous.closing ? null : previous))
        }, DIALOG_CLOSE_MS)
      }

      async function saveEditor() {
        if (editor === null) return
        const current = editor.draft
        const text = current.text.trim()
        if (text === '') {
          pushToast(t('error.emptyText'), 'error')
          return
        }
        const params = {
          text,
          note: current.note.trim(),
          dueAt: fromLocalInput(current.dueAt),
          remindAt: fromLocalInput(current.remindAt),
          priority: current.priority,
          color: current.color,
          tags: parseTagsInput(current.tags),
        }
        const saved = editor.mode === 'edit'
          ? await mutate('update', { id: editor.id, ...params })
          : await mutate('add', params)
        if (saved === null) return
        putNote(saved)
        closeEditor()
      }

      /** Apply a note-text font preset and persist it (chrome fonts never change). */
      function applyFont(preset) {
        if (!FONT_PRESETS.includes(preset)) return
        setFont(preset)
        storeFont(preset)
        setFontMenuOpen(false)
        setLangMenuOpen(false)
        setViewMenuOpen(false)
      }

      /**
       * Apply a panel language mode: persist it, broadcast it to the reminder notice and switch
       * every panel string + Intl formatting. `auto` hands control back to the DSH locale.
       */
      function applyLang(mode) {
        if (!LANG_MODES.includes(mode)) return
        setLang(mode)
        storeLang(mode)
        languageBus.set(mode)
        setLangMenuOpen(false)
        setFontMenuOpen(false)
        setViewMenuOpen(false)
      }

      /** Apply a display format (sticky-note board or minimal list) and persist the choice. */
      function applyView(mode) {
        if (!VIEW_MODES.includes(mode)) return
        setView(mode)
        storeView(mode)
        setViewMenuOpen(false)
        setFontMenuOpen(false)
        setLangMenuOpen(false)
        setExpandedId(null)
      }

      /* -------------------------------------------------- memory (v1.7.0) */

      /** Map a failed memory action onto the dialog's inline error text. */
      function memoryFailureText(result) {
        const unknownAction = result?.error?.code === 'unknown_action'
        return unknownAction ? tRef.current('ai.needRestart') : (result?.error?.message || tRef.current('error.generic'))
      }

      function openMemory() {
        setEditor(null)
        setAdviceDialog(null)
        setFontMenuOpen(false)
        setLangMenuOpen(false)
        setViewMenuOpen(false)
        setMemoryError(null)
        setMemoryArmClear(false)
        setMemoryOpen(true)
      }

      /** Close the memory dialog with the shared exit animation. */
      function closeMemory() {
        if (!memoryOpen || memoryClosing) return
        setMemoryClosing(true)
        window.setTimeout(() => {
          if (!mountedRef.current) return
          setMemoryOpen(false)
          setMemoryClosing(false)
          setMemoryArmClear(false)
          setFactsEditingId(null)
          setMemoryError(null)
        }, DIALOG_CLOSE_MS)
      }

      async function rememberFact() {
        const text = String(factsDraft ?? '').trim()
        if (text === '') {
          setMemoryError(tRef.current('error.emptyText'))
          return
        }
        if (memoryBusy !== null) return
        setMemoryBusy('remember')
        setMemoryError(null)
        const result = await apiPost('remember', { text })
        if (!mountedRef.current) return
        setMemoryBusy(null)
        if (!result.ok) {
          // Duplicate / too-long facts come back as invalid_input with the Host's wording.
          setMemoryError(memoryFailureText(result))
          return
        }
        setFactsDraft('')
        pushToast(tRef.current('memory.saved'), 'ok')
        void refresh(true)
      }

      function startFactEdit(fact) {
        setFactsEditingId(fact.id)
        setFactsEditDraft(String(fact.text ?? ''))
        setMemoryError(null)
      }

      function cancelFactEdit() {
        setFactsEditingId(null)
        setFactsEditDraft('')
      }

      async function saveFactEdit() {
        if (factsEditingId === null || memoryBusy !== null) return
        const text = String(factsEditDraft ?? '').trim()
        if (text === '') {
          setMemoryError(tRef.current('error.emptyText'))
          return
        }
        setMemoryBusy('updateFact')
        setMemoryError(null)
        const result = await apiPost('updateFact', { id: factsEditingId, text })
        if (!mountedRef.current) return
        setMemoryBusy(null)
        if (!result.ok) {
          setMemoryError(memoryFailureText(result))
          return
        }
        cancelFactEdit()
        pushToast(tRef.current('memory.saved'), 'ok')
        void refresh(true)
      }

      async function forgetFact(fact) {
        if (memoryBusy !== null) return
        setMemoryBusy('forget')
        setMemoryError(null)
        const result = await apiPost('forget', { id: fact.id })
        if (!mountedRef.current) return
        setMemoryBusy(null)
        if (!result.ok) {
          setMemoryError(memoryFailureText(result))
          return
        }
        if (factsEditingId === fact.id) cancelFactEdit()
        void refresh(true)
      }

      async function generateMemoryReview() {
        if (memoryBusy !== null) return
        setMemoryBusy('review')
        setMemoryError(null)
        const result = await apiPost('review', {})
        if (!mountedRef.current) return
        setMemoryBusy(null)
        if (!result.ok) {
          setMemoryError(memoryFailureText(result))
          return
        }
        const review = result.data?.review
        setMemoryReview(review && typeof review === 'object' ? review : null)
      }

      async function findMemoryCandidates() {
        if (memoryBusy !== null) return
        setMemoryBusy('candidates')
        setMemoryError(null)
        const result = await apiPost('memoryCandidates', {})
        if (!mountedRef.current) return
        setMemoryBusy(null)
        if (!result.ok) {
          setMemoryError(memoryFailureText(result))
          return
        }
        const raw = result.data?.candidates
        const list = Array.isArray(raw)
          ? raw
            .filter((candidate) => candidate && typeof candidate.text === 'string')
            .map((candidate) => ({
              text: candidate.text.trim(),
              reason: typeof candidate.reason === 'string' ? candidate.reason.trim() : '',
            }))
            .filter((candidate) => candidate.text !== '')
            .slice(0, 5)
          : []
        setMemoryCandidates(list)
      }

      async function rememberCandidate(candidate, index) {
        if (memoryBusy !== null) return
        const text = String(candidate?.text ?? '').trim()
        if (text === '') return
        setMemoryBusy('remember')
        setMemoryError(null)
        const result = await apiPost('remember', { text })
        if (!mountedRef.current) return
        setMemoryBusy(null)
        if (!result.ok) {
          setMemoryError(memoryFailureText(result))
          return
        }
        setMemoryCandidates((previous) => (Array.isArray(previous) ? previous.filter((_, position) => position !== index) : previous))
        pushToast(tRef.current('memory.saved'), 'ok')
        void refresh(true)
      }

      /** Dismissing a candidate is purely local: the Host never stored the proposal. */
      function ignoreCandidate(index) {
        setMemoryCandidates((previous) => (Array.isArray(previous) ? previous.filter((_, position) => position !== index) : previous))
      }

      async function clearMemory() {
        if (memoryBusy !== null) return
        if (!memoryArmClear) {
          setMemoryArmClear(true)
          return
        }
        setMemoryArmClear(false)
        setMemoryBusy('clear')
        setMemoryError(null)
        const result = await apiPost('clearMemory', {})
        if (!mountedRef.current) return
        setMemoryBusy(null)
        if (!result.ok) {
          setMemoryError(memoryFailureText(result))
          return
        }
        setMemoryReview(null)
        setMemoryCandidates(null)
        setFactsEditingId(null)
        pushToast(tRef.current('memory.cleared'), 'ok')
        void refresh(true)
      }

      /* -------------------------------------------------- per-note AI advice */

      /**
       * Run one round of the advisory conversation and fold the answer into the open dialog.
       * Never throws: failures land in the dialog's inline error area.
       */
      async function requestNoteAdvice(dialogId, history) {
        const result = await apiPost('aiNoteAdvice', { id: dialogId, history })
        if (!mountedRef.current) return
        setAdviceDialog((previous) => {
          if (previous === null || previous.id !== dialogId) return previous
          if (!result.ok) {
            const unknownAction = result.error?.code === 'unknown_action'
            return {
              ...previous,
              busy: false,
              error: {
                text: unknownAction ? tRef.current('ai.needRestart') : (result.error?.message || tRef.current('error.generic')),
                hint: unknownAction,
              },
            }
          }
          const data = result.data ?? {}
          const round = Number.isFinite(data.round) ? data.round : history.length
          if (data.kind === 'question' && typeof data.question === 'string' && history.length < MAX_ADVICE_ROUNDS) {
            return {
              ...previous, busy: false, error: null, phase: 'question',
              question: data.question,
              options: normalizeOptions(data.options, MAX_QUESTION_OPTIONS, QUESTION_OPTION_LENGTH),
              answer: '', round, source: data.source ?? null, history,
            }
          }
          const advice = data.kind === 'advice' && data.advice && typeof data.advice.text === 'string'
            ? data.advice
            : null
          if (advice === null) {
            return { ...previous, busy: false, error: { text: tRef.current('error.generic'), hint: false } }
          }
          return {
            ...previous, busy: false, error: null, phase: 'advice',
            adviceText: advice.text,
            adviceOptions: normalizeOptions(advice.options, MAX_ADVICE_OPTIONS, ADVICE_OPTION_LENGTH),
            source: typeof advice.source === 'string' ? advice.source : null,
            round, history,
          }
        })
      }

      function openNoteAdvice(todo) {
        setEditor(null)
        setMemoryOpen(false)
        setFontMenuOpen(false)
        setLangMenuOpen(false)
        setViewMenuOpen(false)
        const id = String(todo.id)
        // v1.7.0: a stored thread resumes instead of starting over; the fresh path keeps the
        // existing three-round conversation behaviour.
        const thread = threadOf(memory, id)
        const storedAdvice = thread && thread.advice && typeof thread.advice.text === 'string' && thread.advice.text !== ''
          ? thread.advice
          : null
        const history = threadHistory(thread)
        if (storedAdvice !== null) {
          setAdviceDialog({
            id,
            title: String(todo.text ?? ''),
            history,
            phase: 'advice',
            question: '',
            options: [],
            answer: '',
            adviceText: storedAdvice.text,
            adviceOptions: [],
            source: typeof storedAdvice.source === 'string' ? storedAdvice.source : null,
            round: history.length,
            busy: false,
            error: null,
            resumed: true,
          })
          return
        }
        const dialog = {
          id,
          title: String(todo.text ?? ''),
          history,
          phase: null,
          question: '',
          options: [],
          answer: '',
          adviceText: '',
          adviceOptions: [],
          source: null,
          round: history.length,
          busy: true,
          error: null,
          resumed: false,
        }
        setAdviceDialog(dialog)
        void requestNoteAdvice(dialog.id, history)
      }

      /** 继续聊聊: re-request the coach using the stored Q&A rounds as history. */
      function continueAdviceThread() {
        if (adviceDialog === null || adviceDialog.busy) return
        const history = Array.isArray(adviceDialog.history) ? adviceDialog.history : []
        setAdviceDialog((previous) => (previous === null ? previous : { ...previous, busy: true, error: null }))
        void requestNoteAdvice(adviceDialog.id, history)
      }

      function changeAdviceAnswer(event) {
        const value = event.target.value
        setAdviceDialog((previous) => (previous === null ? previous : { ...previous, answer: value }))
      }

      function changeAdviceText(event) {
        const value = event.target.value
        setAdviceDialog((previous) => (previous === null ? previous : { ...previous, adviceText: value }))
      }

      /** Picking a Host-proposed answer fills the (still editable) answer box. */
      function pickAdviceAnswer(option) {
        if (typeof option !== 'string') return
        setAdviceDialog((previous) => (previous === null ? previous : { ...previous, answer: option }))
      }

      /** Picking a Host-proposed alternative replaces the editable suggestion text. */
      function pickAdviceAlternative(option) {
        if (typeof option !== 'string') return
        setAdviceDialog((previous) => (previous === null ? previous : { ...previous, adviceText: option }))
      }

      /** Submit the edited answer and ask the Host for the next round (max three questions). */
      function submitAdviceAnswer() {
        if (adviceDialog === null || adviceDialog.phase !== 'question' || adviceDialog.busy) return
        const answer = String(adviceDialog.answer ?? '').trim()
        if (answer === '') return
        const history = [...adviceDialog.history, { question: adviceDialog.question, answer }]
        if (history.length > MAX_ADVICE_ROUNDS) return
        setAdviceDialog((previous) => (previous === null ? previous : { ...previous, busy: true, error: null }))
        void requestNoteAdvice(adviceDialog.id, history)
      }

      /** Append the (possibly edited) suggestion to the note's details. */
      async function appendAdviceToNote() {
        if (adviceDialog === null) return
        const text = String(adviceDialog.adviceText ?? '').trim()
        if (text === '') return
        const todo = todoById.get(String(adviceDialog.id))
        const existing = todo && typeof todo.note === 'string' ? todo.note.trim() : ''
        const note = existing === '' ? text : `${existing}\n\n${text}`
        setAdviceDialog((previous) => (previous === null ? previous : { ...previous, busy: true, error: null }))
        const updated = await mutate('update', { id: adviceDialog.id, note })
        if (updated === null) {
          if (mountedRef.current) {
            setAdviceDialog((previous) => (previous === null ? previous : { ...previous, busy: false }))
          }
          return
        }
        putNote(updated)
        closeAdviceDialog()
        pushToast(t('advice.appended'), 'ok')
      }

      async function removeNote(todo) {
        const removed = await mutate('remove', { id: todo.id })
        if (removed === null) return
        setSnapshot((previous) => previous === null ? previous : {
          ...previous,
          todos: (previous.todos || []).filter((item) => item.id !== todo.id),
        })
        setEditor((current) => (current !== null && current.id === String(todo.id) ? null : current))
        setAdviceDialog((current) => (current !== null && current.id === String(todo.id) ? null : current))
        setExpandedId((current) => (current === String(todo.id) ? null : current))
      }

      /** First press arms the button, second press deletes. */
      function askDelete(todo) {
        if (armedId !== todo.id) {
          setArmedId(todo.id)
          return
        }
        setArmedId(null)
        void removeNote(todo)
      }

      async function quickRemind(todo) {
        const remindAt = new Date(Date.now() + QUICK_REMIND_MS).toISOString()
        const updated = await mutate('update', { id: todo.id, remindAt })
        if (updated === null) return
        putNote(updated)
        pushToast(t('toast.reminderSet', { time: formatDateTime(remindAt, activeLocale) }), 'ok')
      }

      function focusNote(todo) {
        const id = String(todo.id)
        setFocusedId(id)
        const node = nodesRef.current.get(id)
        if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }

      /**
       * 交给 DSH: build the prompt for this note and put it into the DSH chat draft without
       * sending anything. Uses the optional `uiWorkspace` client service; falls back to the
       * clipboard, and never throws or blocks the panel.
       */
      function handoffNote(todo) {
        let prompt = ''
        try {
          prompt = buildHandoffPrompt(todo, { t, localeId: activeLocale, language: effectiveLanguage })
        } catch {
          if (mountedRef.current) pushToast(tRef.current('note.handoffFailed'), 'error')
          return
        }
        const workspace = resolveUiWorkspace()
        if (workspace !== null && typeof workspace.startSession === 'function') {
          try {
            const pending = workspace.startSession(undefined, { prompt, whenDraftExists: 'append' })
            if (pending && typeof pending.then === 'function') {
              pending.then(
                () => {
                  if (mountedRef.current) pushToast(tRef.current('note.handoffDraft'), 'ok')
                },
                () => copyHandoffPrompt(prompt),
              )
              return
            }
            if (mountedRef.current) pushToast(tRef.current('note.handoffDraft'), 'ok')
            return
          } catch {
            /* fall through to the clipboard fallback */
          }
        }
        copyHandoffPrompt(prompt)
      }

      /** Clipboard fallback for the handoff when the uiWorkspace service is unavailable. */
      async function copyHandoffPrompt(prompt) {
        try {
          const clipboard = typeof navigator !== 'undefined' && navigator !== null ? navigator.clipboard : null
          if (!clipboard || typeof clipboard.writeText !== 'function') {
            if (mountedRef.current) pushToast(tRef.current('note.handoffFailed'), 'error')
            return
          }
          await clipboard.writeText(prompt)
          if (mountedRef.current) pushToast(tRef.current('note.handoffCopied'), 'ok')
        } catch {
          if (mountedRef.current) pushToast(tRef.current('note.handoffFailed'), 'error')
        }
      }

      async function clearCompleted() {
        const removed = await mutate('clearCompleted', {})
        if (removed === null) return
        setSnapshot((previous) => previous === null ? previous : {
          ...previous,
          todos: (previous.todos || []).filter((item) => !item.done),
        })
        pushToast(t('toast.cleared', { count: Number(removed?.removed ?? 0) }), 'ok')
      }

      /** Only ever called from a click, so the permission prompt follows a user gesture. */
      async function requestPermission() {
        if (typeof Notification === 'undefined') return
        try {
          const result = await Notification.requestPermission()
          if (mountedRef.current) setPermission(result)
          pushToast(t(result === 'granted' ? 'toast.desktopOn' : 'toast.desktopDenied'), result === 'granted' ? 'ok' : 'error')
        } catch {
          pushToast(t('toast.desktopDenied'), 'error')
        }
      }

      async function runAi(action) {
        setAiError(null)
        setAiBusy(action)
        const result = await apiPost(action, {})
        if (mountedRef.current) setAiBusy(null)
        if (!result.ok) {
          // An old Host (started before v1.1.0) answers `aiTag` with `unknown_action`; a short
          // restart hint is friendlier than the raw protocol error.
          const unknownAction = result.error?.code === 'unknown_action'
          if (mountedRef.current) {
            setAiError({
              text: unknownAction ? tRef.current('ai.needRestart') : (result.error?.message || tRef.current('error.generic')),
              hint: unknownAction,
            })
          }
          return
        }
        if (action === 'aiPlan') {
          setAiView({ kind: 'plan', plan: result.data?.plan ?? null })
          setSnapshot((previous) => previous !== null && Array.isArray(result.data?.todos)
            ? { ...previous, todos: sortTodos(result.data.todos) }
            : previous)
          return
        }
        if (action === 'aiTag') {
          setAiView({ kind: 'tag', tagResult: result.data?.tagResult ?? null })
          setSnapshot((previous) => previous !== null && Array.isArray(result.data?.todos)
            ? { ...previous, todos: sortTodos(result.data.todos) }
            : previous)
          return
        }
        setAiView(null)
        setSnapshot((previous) => previous !== null && Array.isArray(result.data?.todos)
          ? { ...previous, todos: sortTodos(result.data.todos) }
          : previous)
        pushToast(t('toast.planCleared'), 'ok')
      }

      /* ------------------------------------------------------------- render */

      function renderHeader() {
        const doneButton = doneCount > 0
          ? h('button', { type: 'button', className: 'stk-btn', disabled: busy, onClick: () => void clearCompleted() },
              t('action.clearCompleted', { count: doneCount }))
          : null
        const desktop = permission === 'default'
          ? h('button', { type: 'button', className: 'stk-btn', onClick: () => void requestPermission() }, `🔔 ${t('action.enableDesktop')}`)
          : permission === 'granted' ? h('span', { className: 'stk-hint' }, `🔔 ${t('action.desktopOn')}`) : null
        const createButton = h('button', {
          type: 'button', className: 'stk-btn stk-btn--primary stk-create', onClick: openCreateEditor,
        }, h('span', { className: 'stk-create-glyph', 'aria-hidden': 'true' }, '＋'), t('action.create'))
        const fontMenu = fontMenuOpen
          ? h('div', { className: 'stk-font-menu', role: 'menu', 'aria-label': t('font.title') },
              h('div', { className: 'stk-font-hint' }, t('font.hint')),
              FONT_PRESETS.map((preset) => h('button', {
                key: preset, type: 'button', role: 'menuitemradio', 'aria-checked': font === preset,
                className: 'stk-font-item', onClick: () => applyFont(preset),
              }, h('span', { className: 'stk-font-check' }, font === preset ? '✓' : ''), t(`font.${preset}`))))
          : null
        const fontButton = h('div', { className: 'stk-font' },
          h('button', {
            type: 'button', className: 'stk-btn', 'aria-haspopup': 'menu', 'aria-expanded': fontMenuOpen,
            title: t('font.title'), 'aria-label': t('font.title'),
            onClick: () => {
              setFontMenuOpen((open) => !open)
              setLangMenuOpen(false)
              setViewMenuOpen(false)
            },
          }, `Aa ${t('action.font')}`),
          fontMenu)
        const langMenu = langMenuOpen
          ? h('div', { className: 'stk-font-menu stk-lang-menu', role: 'menu', 'aria-label': t('lang.title') },
              h('div', { className: 'stk-font-hint' }, t('lang.hint')),
              LANG_MODES.map((mode) => h('button', {
                key: mode, type: 'button', role: 'menuitemradio', 'aria-checked': lang === mode,
                className: 'stk-font-item', onClick: () => applyLang(mode),
              }, h('span', { className: 'stk-font-check' }, lang === mode ? '✓' : ''),
                 mode === 'auto' ? t('lang.autoFollow') : t(`lang.${mode}`))))
          : null
        const langButton = h('div', { className: 'stk-lang' },
          h('button', {
            type: 'button', className: 'stk-btn stk-lang-btn', 'aria-haspopup': 'menu', 'aria-expanded': langMenuOpen,
            title: t('lang.title'), 'aria-label': t('lang.title'),
            onClick: () => {
              setLangMenuOpen((open) => !open)
              setFontMenuOpen(false)
              setViewMenuOpen(false)
            },
          }, `🌐 ${t(`lang.${lang}`)}`),
          langMenu)
        const viewMenu = viewMenuOpen
          ? h('div', { className: 'stk-font-menu stk-view-menu', role: 'menu', 'aria-label': t('view.label') },
              h('div', { className: 'stk-font-hint' }, t('view.hint')),
              VIEW_MODES.map((mode) => h('button', {
                key: mode, type: 'button', role: 'menuitemradio', 'aria-checked': view === mode,
                className: 'stk-font-item', onClick: () => applyView(mode),
              }, h('span', { className: 'stk-font-check' }, view === mode ? '✓' : ''), t(`view.${mode}`))))
          : null
        const viewButton = h('div', { className: 'stk-view' },
          h('button', {
            type: 'button', className: 'stk-btn stk-view-btn', 'aria-haspopup': 'menu', 'aria-expanded': viewMenuOpen,
            title: t('view.label'), 'aria-label': t('view.label'),
            onClick: () => {
              setViewMenuOpen((open) => !open)
              setFontMenuOpen(false)
              setLangMenuOpen(false)
            },
          }, `${view === 'list' ? '☰' : '▤'} ${t(`view.${view}`)}`),
          viewMenu)
        const memoryButton = h('button', {
          type: 'button', className: 'stk-btn stk-memory-btn',
          title: t('memory.button'), 'aria-label': t('memory.button'), onClick: openMemory,
        }, `🧠 ${t('memory.button')}`)
        return h('header', { className: 'stk-header' },
          h('div', { className: 'stk-heading' },
            h('div', { className: 'stk-title' }, t('panel.title')),
            h('div', { className: 'stk-sub' }, t('panel.subtitle', { open: openCount, done: doneCount }))),
          h('div', { className: 'stk-grow' }),
          h('div', { className: 'stk-toolbar' },
            createButton,
            fontButton,
            langButton,
            viewButton,
            memoryButton,
            h('button', { type: 'button', className: 'stk-btn', disabled: busy || loading, onClick: () => void refresh() }, t('action.refresh')),
            doneButton,
            desktop))
      }

      function renderErrorBar() {
        if (error === null) return null
        return h('div', { className: 'stk-error', role: 'alert' },
          h('span', null, error),
          h('button', { type: 'button', className: 'stk-btn stk-btn--ghost', onClick: () => void refresh() }, t('action.retry')))
      }

      function renderBanner() {
        if (!Array.isArray(reminders) || reminders.length === 0) return null
        return h('section', { className: 'stk-banner', role: 'status' },
          h('div', { className: 'stk-banner-head' },
            h('span', { 'aria-hidden': 'true' }, '⏰'),
            h('span', null, t('reminder.title')),
            h('span', { className: 'stk-hint' }, t('reminder.body', { count: reminders.length }))),
          h('ul', { className: 'stk-banner-list' },
            reminders.map((item) => h('li', { className: 'stk-banner-item', key: String(item.id) },
              h('span', { className: 'stk-banner-text', title: String(item.text ?? '') }, String(item.text ?? '')),
              h('span', null, item.remindAt ? formatDateTime(item.remindAt, activeLocale) : '')))),
          h('div', { className: 'stk-banner-actions' },
            permission === 'default'
              ? h('button', { type: 'button', className: 'stk-btn', onClick: () => void requestPermission() }, t('action.enableDesktop'))
              : null,
            h('button', {
              type: 'button',
              className: 'stk-btn stk-btn--primary',
              onClick: () => void acknowledge(reminders.map((item) => String(item.id))),
            }, t('reminder.ack'))))
      }

      const renderSourceChip = (source) =>
        h('span', { className: 'stk-chip stk-chip--plan' }, t(source === 'fallback' ? 'ai.source.fallback' : 'ai.source.model'))

      function renderPlan(plan) {
        const items = Array.isArray(plan?.items) ? plan.items : []
        return h('div', { className: 'stk-ai-result' },
          h('div', { className: 'stk-ai-result-head' },
            h('span', { className: 'stk-ai-summary' }, plan?.summary ? String(plan.summary) : t('ai.noSummary')),
            renderSourceChip(plan?.source)),
          items.length === 0
            ? h('div', { className: 'stk-hint' }, t('ai.noItems'))
            : h('ul', { className: 'stk-ai-list' },
                items.map((item) => {
                  const note = todoById.get(String(item?.id))
                  return h('li', { className: 'stk-ai-item', key: String(item?.id) },
                    h('span', { className: 'stk-ai-time' }, formatDateTime(item?.planAt, activeLocale)),
                    h('span', { className: 'stk-ai-text' }, note ? String(note.text) : t('ai.unknownNote')),
                    item?.note ? h('span', { className: 'stk-ai-note' }, `— ${String(item.note)}`) : null)
                })))
      }

      /** v1.1.0 `aiTag` result: summary line plus the resulting tag list with note counts. */
      function renderTagResult(tagResult) {
        const items = Array.isArray(tagResult?.items) ? tagResult.items : []
        const stats = countTags(items.map((item) => todoTags({ tags: item?.tags })))
        return h('div', { className: 'stk-ai-result' },
          h('div', { className: 'stk-ai-result-head' },
            h('span', { className: 'stk-ai-summary' }, tagResult?.summary ? String(tagResult.summary) : t('ai.noSummary')),
            renderSourceChip(tagResult?.source)),
          stats.length === 0
            ? h('div', { className: 'stk-hint' }, t('ai.noTagItems'))
            : h('div', { className: 'stk-ai-order-wrap' },
                h('div', { className: 'stk-hint' }, t('ai.tagList')),
                h('ul', { className: 'stk-ai-order' },
                  stats.map((entry) => h('li', { className: 'stk-ai-order-item', key: entry.key },
                    h('span', { className: 'stk-ai-order-index' }, '#'),
                    h('span', null, entry.tag),
                    h('span', { className: 'stk-ai-tag-count' }, String(entry.count)))))))
      }

      function renderAi() {
        const busyKey = aiBusy === 'aiPlan' ? 'ai.loadingPlan'
          : aiBusy === 'aiTag' ? 'ai.loadingTag'
          : 'ai.loadingClear'
        const result = aiView === null
          ? null
          : aiView.kind === 'tag' ? renderTagResult(aiView.tagResult) : renderPlan(aiView.plan)
        return h('section', { className: 'stk-ai', 'aria-label': t('ai.title') },
          h('div', { className: 'stk-ai-head' },
            h('span', { className: 'stk-ai-mark', 'aria-hidden': 'true' }, '✦'),
            h('span', { className: 'stk-ai-title' }, t('ai.title')),
            h('span', { className: 'stk-hint', title: ai?.reason ? String(ai.reason) : undefined },
              t(ai?.available ? 'ai.ready' : 'ai.unavailable')),
            h('div', { className: 'stk-ai-actions' },
              h('button', { type: 'button', className: 'stk-btn', disabled: aiBusy !== null, onClick: () => void runAi('aiPlan') }, t('ai.plan')),
              h('button', { type: 'button', className: 'stk-btn', disabled: aiBusy !== null, onClick: () => void runAi('aiTag') }, t('ai.tag')),
              hasPlan ? h('button', { type: 'button', className: 'stk-btn stk-btn--ghost', disabled: aiBusy !== null, onClick: () => void runAi('aiClearPlan') }, t('ai.clear')) : null,
              aiView === null ? null : h('button', {
                type: 'button', className: 'stk-btn stk-btn--ghost',
                'aria-label': t('action.dismiss'), title: t('action.dismiss'), onClick: () => setAiView(null),
              }, '×'))),
          aiBusy === null ? null : h('div', { className: 'stk-ai-loading' },
            h('span', { className: 'stk-spinner', 'aria-hidden': 'true' }), t(busyKey)),
          aiError === null ? null : h('div', {
            className: `stk-ai-error${aiError.hint ? ' stk-ai-error--hint' : ''}`, role: 'alert',
          }, aiError.text),
          result)
      }

      /**
       * Tag filter row above the board, plus the 分组 / 平铺 toggle once tags exist.
       * Grouping is a sticky-board concept only, so the toggle is hidden in minimal-list mode.
       */
      function renderFilterRow() {
        if (tagStats.length === 0) return null
        const toggle = view === 'list'
          ? null
          : h('div', { className: 'stk-layout-toggle', role: 'group', 'aria-label': t('group.label') },
              h('button', {
                type: 'button', className: 'stk-chip stk-chip--filter',
                'aria-pressed': grouped, onClick: () => setGrouped(true),
              }, t('group.grouped')),
              h('button', {
                type: 'button', className: 'stk-chip stk-chip--filter',
                'aria-pressed': !grouped, onClick: () => setGrouped(false),
              }, t('group.flat')))
        return h('div', { className: 'stk-filter', role: 'group', 'aria-label': t('filter.label') },
          h('span', { className: 'stk-filter-label' }, t('filter.label')),
          h('button', {
            type: 'button', className: 'stk-chip stk-chip--filter',
            'aria-pressed': tagFilter === null,
            onClick: () => setTagFilter(null),
          }, t('filter.all')),
          tagStats.map((entry) => h('button', {
            key: entry.key,
            type: 'button',
            className: 'stk-chip stk-chip--filter',
            'aria-pressed': tagFilter === entry.key,
            title: t('filter.count', { count: entry.count }),
            onClick: () => setTagFilter((current) => (current === entry.key ? null : entry.key)),
          }, h('span', null, `#${entry.tag}`), h('span', { className: 'stk-chip-count' }, String(entry.count)))),
          toggle)
      }

      function renderCards(list, baseDelay = 0) {
        return list.map((todo, index) => h(NoteCard, {
          key: String(todo.id), todo, t, nowIso, localeId: activeLocale, busy,
          delay: baseDelay + index,
          postponeCount: postponeCountOf(memory, todo.id),
          armed: armedId === todo.id,
          focused: focusedId === String(todo.id),
          registerNode,
          onToggle: () => void toggleNote(todo),
          onEdit: () => openNoteEditor(todo),
          onAdvice: () => openNoteAdvice(todo),
          onDelete: () => askDelete(todo),
          onRemind: () => void quickRemind(todo),
          onFocus: () => focusNote(todo),
          onHandoff: () => handoffNote(todo),
          onTagClick: (tag) => setTagFilter((current) => (current === tagKeyOf(tag) ? null : tagKeyOf(tag))),
        }))
      }

      /**
       * Minimal-list rows: the same filtered notes in the board's existing sort order; only one
       * row can be expanded at a time (the panel owns `expandedId`).
       */
      function renderListRows(list) {
        return list.map((todo, index) => h(NoteListRow, {
          key: String(todo.id), todo, t, nowIso, localeId: activeLocale, busy,
          delay: index,
          expanded: expandedId === String(todo.id),
          postponeCount: postponeCountOf(memory, todo.id),
          armed: armedId === todo.id,
          onToggle: () => void toggleNote(todo),
          onActivate: () => setExpandedId((current) => (current === String(todo.id) ? null : String(todo.id))),
          onEdit: () => openNoteEditor(todo),
          onAdvice: () => openNoteAdvice(todo),
          onRemind: () => void quickRemind(todo),
          onDelete: () => askDelete(todo),
          onHandoff: () => handoffNote(todo),
          onTagClick: (tag) => setTagFilter((current) => (current === tagKeyOf(tag) ? null : tagKeyOf(tag))),
        }))
      }

      /**
       * Group the (already filtered) notes by their first tag, preserving the board order inside
       * each section; notes without tags land in a final 未分类 bucket.
       */
      function groupNotes(list) {
        const groups = tagStats.map((entry) => ({ key: entry.key, tag: entry.tag, notes: [] }))
        const byKey = new Map(groups.map((group) => [group.key, group]))
        const untagged = []
        for (const todo of list) {
          const tags = todoTags(todo)
          const firstTag = tags.length > 0 ? tagKeyOf(tags[0]) : null
          const group = firstTag === null ? undefined : byKey.get(firstTag)
          if (group === undefined) untagged.push(todo)
          else group.notes.push(todo)
        }
        return { groups: groups.filter((group) => group.notes.length > 0), untagged }
      }

      function renderBoard() {
        const filterName = tagFilterEntry === null ? (tagFilter ?? '') : tagFilterEntry.tag
        const isList = view === 'list'
        const groupedBoard = !isList && grouped && tagStats.length > 0
        const emptyNodes = []
        if (todos.length === 0 && !loading) {
          emptyNodes.push(h('div', { className: 'stk-empty', key: 'empty' },
            h('div', { className: 'stk-empty-icon', 'aria-hidden': 'true' }, '🗒'),
            h('div', { className: 'stk-empty-text' }, t('empty')),
            h('button', { type: 'button', className: 'stk-btn', onClick: openCreateEditor }, t('action.create'))))
        }
        if (tagFilter !== null && filteredTodos.length === 0 && !loading) {
          emptyNodes.push(h('div', { className: 'stk-empty stk-empty--filter', key: 'filter-empty' },
            h('div', { className: 'stk-empty-icon', 'aria-hidden': 'true' }, '🔍'),
            h('span', { className: 'stk-empty-text' }, t('filter.empty', { tag: String(filterName) })),
            h('button', { type: 'button', className: 'stk-btn stk-btn--ghost', onClick: () => setTagFilter(null) }, t('filter.clear'))))
        }
        let body = null
        if (filteredTodos.length > 0) {
          if (isList) {
            body = h('ul', { className: 'stk-list', 'aria-label': t('view.list') }, renderListRows(filteredTodos))
          } else if (groupedBoard) {
            const { groups, untagged } = groupNotes(filteredTodos)
            let cardOffset = 0
            const sectionNodes = groups.map((group, index) => {
              const baseDelay = cardOffset
              cardOffset += group.notes.length
              return h('section', {
                className: 'stk-board-group',
                key: group.key,
                style: { '--stk-delay': `${Math.min(index, 6) * 36}ms` },
              },
                h('div', { className: 'stk-board-group-head' },
                  h('span', { className: 'stk-group-tag' }, `#${group.tag}`),
                  h('span', { className: 'stk-group-count' }, String(group.notes.length))),
                h('div', { className: 'stk-board-grid' }, renderCards(group.notes, baseDelay)))
            })
            if (untagged.length > 0) {
              const baseDelay = cardOffset
              sectionNodes.push(h('section', {
                className: 'stk-board-group stk-group-untagged',
                key: 'untagged',
                style: { '--stk-delay': `${Math.min(groups.length, 6) * 36}ms` },
              },
                h('div', { className: 'stk-board-group-head' },
                  h('span', { className: 'stk-group-tag' }, t('group.untagged')),
                  h('span', { className: 'stk-group-count' }, String(untagged.length))),
                h('div', { className: 'stk-board-grid' }, renderCards(untagged, baseDelay))))
            }
            body = h(React.Fragment, null, sectionNodes)
          } else {
            body = h('div', { className: 'stk-board-grid' }, renderCards(filteredTodos, 0))
          }
        }
        return h('section', {
          className: `stk-board${isList ? ' stk-board--list' : ''}`, 'aria-label': t('panel.title'),
        }, emptyNodes, body)
      }

      function renderFooter() {
        return h('footer', { className: 'stk-footer' },
          h('span', null, t('footer.count', { total: todos.length, open: openCount })),
          nowIso ? h('span', null, t('footer.updated', { time: formatClock(nowIso, activeLocale) })) : null,
          h('span', { className: 'stk-grow' }),
          h('span', { className: 'stk-hint' }, t('footer.hint')))
      }

      function renderToast() {
        return h('div', { className: 'stk-toast-layer', 'aria-live': 'polite' },
          toast === null ? null : h('div', {
            className: `stk-toast stk-toast--${toast.tone}`, key: toast.id,
            role: toast.tone === 'error' ? 'alert' : 'status',
          },
            h('span', null, toast.text),
            h('button', {
              type: 'button', className: 'stk-toast-dismiss',
              'aria-label': t('action.dismiss'), onClick: () => setToast(null),
            }, '×')))
      }

      function renderEditorDialog() {
        if (editor === null) return null
        return h(NoteDialog, {
          t, mode: editor.mode, draft: editor.draft, closing: editor.closing === true,
          onChange: changeEditorDraft,
          onSubmit: () => void saveEditor(),
          onCancel: closeEditor,
          busy,
        })
      }

      function renderAdviceDialog() {
        if (adviceDialog === null) return null
        return h(AdviceDialog, {
          t, dialog: adviceDialog,
          onClose: closeAdviceDialog,
          onAnswerChange: changeAdviceAnswer,
          onPickAnswer: pickAdviceAnswer,
          onSubmitAnswer: submitAdviceAnswer,
          onAdviceChange: changeAdviceText,
          onPickAlternative: pickAdviceAlternative,
          onAppend: () => void appendAdviceToNote(),
          onContinue: continueAdviceThread,
        })
      }

      function renderMemoryDialog() {
        if (!memoryOpen) return null
        return h(MemoryDialog, {
          t,
          facts: memoryFacts,
          review: memoryReview,
          candidates: memoryCandidates,
          closing: memoryClosing,
          busy: memoryBusy,
          error: memoryError,
          factDraft: factsDraft,
          editingId: factsEditingId,
          editDraft: factsEditDraft,
          clearArmed: memoryArmClear,
          onClose: closeMemory,
          onFactDraftChange: (event) => {
            setFactsDraft(event.target.value)
            setMemoryError(null)
          },
          onRememberFact: () => void rememberFact(),
          onEditFact: startFactEdit,
          onEditDraftChange: (event) => {
            setFactsEditDraft(event.target.value)
            setMemoryError(null)
          },
          onSaveFactEdit: () => void saveFactEdit(),
          onCancelFactEdit: cancelFactEdit,
          onForgetFact: (fact) => void forgetFact(fact),
          onGenerateReview: () => void generateMemoryReview(),
          onFindCandidates: () => void findMemoryCandidates(),
          onRememberCandidate: (candidate, index) => void rememberCandidate(candidate, index),
          onIgnoreCandidate: ignoreCandidate,
          onClearMemory: () => void clearMemory(),
        })
      }

      return h('div', {
        className: 'stk-root',
        style: { '--stk-note-font': FONT_STACKS[font] ?? FONT_STACKS.default },
      },
        h('style', { key: 'stk-style' }, STYLE),
        renderHeader(),
        renderErrorBar(),
        renderBanner(),
        snapshot === null ? null : renderAi(),
        renderFilterRow(),
        loading && snapshot === null ? h('div', { className: 'stk-empty stk-empty--loading' }, t('loading')) : null,
        renderBoard(),
        renderFooter(),
        renderToast(),
        renderEditorDialog(),
        renderAdviceDialog(),
        renderMemoryDialog())
    }

    /* ---------------------------------------------------------------- plugin */

    return {
      inject: ['slots', 'layout', 'locale'],
      apply(ctx) {
        // The panel component lives outside apply(), so remember the client context for optional
        // services such as `uiWorkspace` (the 交给 DSH handoff).
        pluginContext = ctx
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'sticker-todo: dictionaries')
        const t = ctx.locale.bind(NS)

        /** Open the board from a notice or a desktop notification (the key exists while loaded). */
        const openPanel = () => {
          try {
            ctx.layout.selectPanel(PANEL_ID)
          } catch {
            /* the main panel is unregistered only after this plugin unloads */
          }
        }

        /**
         * Acknowledge reminders on the Host. The shared bus is cleared immediately so both the
         * board banner and the global notice disappear together; a failed POST lets the next
         * poll surface them again.
         */
        const acknowledge = async (ids) => {
          const list = (Array.isArray(ids) ? ids : []).map((id) => String(id))
          if (list.length === 0) return
          reminderBus.remove(list)
          const result = await apiPost('ackReminders', { ids: list })
          if (!result.ok) for (const id of list) announcedReminders.delete(id)
        }

        // The plugin-scope watcher and its desktop notifications follow the panel language switch;
        // `auto` keeps using the DSH-bound translator.
        const effectiveT = (key, params) => translatorFor(languageBus.getSnapshot(), t)(key, params)

        // Plugin-scope reminder watcher: runs for as long as the plugin is loaded, whichever
        // panel is selected, and is torn down with the owning effect.
        ctx.effect(() => {
          let cancelled = false
          const poll = async () => {
            if (cancelled) return
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
            const result = await apiGet()
            if (!result.ok || cancelled) return
            const due = Array.isArray(result.data?.dueReminders) ? result.data.dueReminders : []
            surfaceReminders(due, effectiveT, openPanel)
          }
          void poll()
          const interval = typeof window === 'undefined' ? null : window.setInterval(() => void poll(), POLL_MS)
          const onFocus = () => void poll()
          const onVisibility = () => {
            if (typeof document !== 'undefined' && document.visibilityState !== 'hidden') void poll()
          }
          if (typeof window !== 'undefined') window.addEventListener('focus', onFocus)
          if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
          return () => {
            cancelled = true
            if (interval !== null && typeof window !== 'undefined') window.clearInterval(interval)
            if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus)
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
          }
        }, 'sticker-todo: reminder watcher')

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: () => ({
            hooks: { locale: ctx.locale, reminders: reminderBus },
            acknowledge,
          }),
        }, StickerTodoPanel))

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 10,
          label: () => translatorFor(languageBus.getSnapshot(), t)('panel.label'),
          locale: NS,
        }, StickerTodoIcon))

        // Frame-wide reminder card: visible on conversation, plugins, settings, every panel.
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'sticker-todo-notice',
          order: 50,
          locale: NS,
          inject: () => ({
            hooks: { locale: ctx.locale, reminders: reminderBus },
            acknowledge,
            openPanel,
          }),
        }, StickerTodoNotice))
      },
    }
  },
})
