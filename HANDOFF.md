# 便利贴待办 · Sticker TODO — 维护者交接

本仓库就是插件包 **`dsh-sticker-todo`** 的根目录（v1.6.0 起从 `@local/dsh-sticker-todo` 改名并发布到
npm；仓库与市场仍用 `dsh-to-do` 这个仓库名）。当前版本 **1.8.1**（扁平化标签样式，待发布）；
npm 上 `latest = 1.8.0`。

## 发布到 npm

- npm 包名：`dsh-sticker-todo`（unscoped）；`package.json` 已去掉 `private`，保留
  `publishConfig.access: public`；`files` 只打包运行所需文件（README 两份 + LICENSE 由 npm 自动带上）。
- **状态：`dsh-sticker-todo@1.8.0` 已上线（2026-11-06），`latest` 指向 1.8.0**；`v1.8.0` tag 与
  GitHub Release 已建，tarball shasum `4de60ab0…` 与本地 `npm pack` 一致（13 个文件，解包 381,869 B）。
  1.7.0（记忆）与 1.8.0（未分类打标签 + 交给 DSH）合并成一个版本发布，1.7.0 没有单独上 npm。
- 后续发版流程：改 `package.json` 版本（并同步 README 版本徽章 / CHANGELOG）→
  `npm publish --otp=<6 位验证码>` → `npm view dsh-sticker-todo version` 确认 → 打 tag / Release。
  DSH 插件中心与 dsh-plugin.org 会在下一轮扫描自动刷新。
- **npm 现在要求发布账号启用 2FA**（新账号首次发布会被 403 拦截：
  `Two-factor authentication or granular access token with bypass 2fa enabled is required`）。
  处理方式：在 npm 网站 Settings → Two-Factor Authentication 启用认证器，然后
  `npm login` + `npm publish --otp=<当前验证码>`；或启用 2FA 后创建带 **Bypass 2FA** 的
  Granular Access Token（Packages: read/write）用于后续自动发布。凭据只放 `~/.npmrc` 或环境变量，
  仓库已把 `.npmrc` 加入 `.gitignore`。
- npm 发布时会先生成一个 `0.0.0-stage` 占位版本（"Temporary package placeholder for staged
  publishing"），`latest` 很快会切到真实版本；`npm view dsh-sticker-todo` 在几秒内可能先看到它，
  属正常现象。想清理这个占位版本可（需要 OTP，且不要动 1.6.0）：
  `npm unpublish dsh-sticker-todo@0.0.0-stage --otp=<code>`，失败也不影响使用。

## README 与插件市场

- 文档分两个文件：`README.md`（**中文，仓库默认展示 / npm 页面**）与 `README.en.md`（英文），顶部互相
  链接；截图放在 `docs/`（示例数据，README 用绝对地址引用以便 npm 页面显示）。两份都刻意保持精简，
  只留安装、特性、使用、数据、验证与文档入口，细节进 `CONTRACT.md` / `docs/MEMORY.md`。
- 已按 [dsh-plugin.org 收录要求](https://dsh-plugin.org/zh/submit) 准备：公开仓库、GitHub topic
  `dsh-plugin`、根目录 `package.json`、插件导出 `apply(ctx)`、README 里有可复制的安装命令
  `dsh plugin --profile web add dsh-sticker-todo`（源码安装为 `github:kevin-qiao/dsh-todo`）。
- 市场提交 Issue：[dshplugin/dsh-plugin-hub#649](https://github.com/dshplugin/dsh-plugin-hub/issues/649)
  （已由维护者关闭并说明自动收录流程）。
- **已收录并验证**：https://dsh-plugin.org/plugins/kevin-qiao/dsh-todo （分类：界面与体验；
  收录时间 2026-11-06）。下一轮扫描会把安装命令刷新成 npm 形式、版本刷到 1.6.0，并出现在 DSH 内置
  插件中心。README 两份都已加 `listed.svg` 徽章。

## AI 协作与署名

本项目的代码、文档与市场提交流程由作者 Kevin 与 AI 助手共同完成。约定：

- 由 AI 助手创建的提交，在 commit message 末尾保留 co-author trailer：

  ```
  Co-authored-by: DeepSeek Harness (deepseek-flash) <noreply@deepseek.com>
  ```

- 对外提交（如 dsh-plugin.org 的市场收录 Issue）同样附上该署名。
- 变更历史里已经存在的旧提交不重写（会触发强推/改写公开历史），署名从约定生效后的提交开始。

## 安装状态（开发机上）

- Profile：`desktop`（`~/.dsh/profiles/desktop`），依赖为 `"dsh-sticker-todo": "link:<本仓库目录>"`，
  `dsh.profile.bundles` 里包含 `dsh-sticker-todo`（改名后已同步；重启 DSH 生效）
- 安装结果：`application: applied`，无警告
- 插件行 id：`sticker-todo`；面板 id / 侧栏 id：`sticker-todo`；前端 locale 命名空间：`stickerTodo`
- 数据文件：`~/.dsh-sticker-todo/todos.json`（可用行内 config `dataFile` 改）

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | Host 入口：store、`sticker_todo` 工具、`/dsh-todo` HTTP API（含 6 个记忆动作） |
| `lib/store.js` | v2 JSON 文档（便签 + 事件流 + 事实 + 建议线程）、校验、排序、提醒筛选、派生统计 |
| `lib/ai.js` | 模型排程、标签分类（v1.8.0 起只给没有标签的未完成便签）、单条便签建议、周复盘、记忆候选 + 本地确定性兜底 + 记忆 prompt 块 |
| `lib/tools.js` | 模型可见的 `sticker_todo` 工具（含 `tag`/`advice`/`remember`/`forget`/`memories`/`review`） |
| `client.js` | 浏览器半边：侧栏图标、新建/编辑弹窗、便签画板、分组/筛选、字体、语言切换、AI 建议、记忆抽屉、改期徽章、交给 DSH、动效 |
| `cordis.patch.yml` | 插入 `sticker-todo` 行的 bundle patch（name = `dsh-sticker-todo`） |
| `locale/en.json`, `locale/zh.json` | 插件管理里的标题与描述（中英双语，已提到 1.7.0 的记忆） |
| `icon.svg` | 插件图标（原始绘制） |
| `verify/` | 离线清单 / 离线 Host 集成 / 客户端渲染冒烟 / 线上 HTTP 冒烟 |
| `CONTRACT.md` | Host/Client 之间的 API 契约（改造时先看这个；Round 7 = v1.7.0 记忆，Round 8 = v1.8.0 打标签 + 交给 DSH） |
| `docs/MEMORY.md` | 记忆功能设计说明：为什么加、四层记忆、红线（模型只读不写）、数据模型、流、迁移 |
| `README.md` / `README.en.md` | 中文（默认）/ 英文项目说明（精简版，互链） |

## 架构要点

- **数据路径**：浏览器半边不直接碰 Host 状态，两边通过一个 prefix 路由 `/dsh-todo` 通信：
  `GET /dsh-todo/state` 读，`POST /dsh-todo/action` 写（`add` / `update` / `toggle` / `remove` /
  `clearCompleted` / `ackReminders` / `aiPlan` / `aiAdvice` / `aiClearPlan` / `aiTag` / `aiNoteAdvice`，
  v1.7.0 起再加 `remember` / `updateFact` / `forget` / `review` / `memoryCandidates` / `clearMemory`）。
- **同一份操作**：面板按钮、HTTP 路由、`sticker_todo` 工具都走 `index.js` 里同一个 `runAction`。
- **全局 AI 建议已从面板移除**（v1.3.0）：AI 卡片只剩「自动安排日程 / 分类打标签 / 清除安排」；
  后端 `aiAdvice` 与工具 `advice` 仍保留给 agent。
- **客户端注册**：`sidebar.panellist`（图标，id `sticker-todo`）、`main`（key `sticker-todo` 面板）、
  `shell.overlay`（全局到点提醒卡，id `sticker-todo-notice`）。
- **提醒**：插件级 watcher（`ctx.effect` 内）每 30 秒读一次 state，任何面板下都会触发；
  点「知道了」才 `ackReminders`。
- **双语**（v1.4.0）：面板头部有 `🌐 自动 / 中文 / English` 切换，存 `localStorage['sticker-todo:lang']`。
  `auto` 继续用 DSH 绑定的 translator（跟随应用语言）；强制语言时用同一份 `TEXT` 字典生成
  zh/en 文本，并把 `Intl` 日期格式切到 `zh-CN` / `en-US`。语言通过模块级 `languageBus` 广播，
  全局提醒卡、桌面通知标题、侧栏标签也跟着切换；切换不发任何 Host 请求。
- **双视图**（v1.5.0）：面板头部有 `▤ 便利贴 / ☰ 极简` 切换，存 `localStorage['sticker-todo:view']`。
  两种视图共用同一份数据与同一套操作：便利贴模式是分组便签墙；极简模式是单行标题列表，
  点行就地展开详情与操作（同时只展开一条），展开态不持久化。视图切换只是呈现，不发 Host 请求。
- **AI**：`lib/ai.js` 用 `ctx.llm.stream()` + `agentDefaultModel.currentSelection()`，严格 JSON 输出，
  失败/超时/未配置模型时降级为本地启发式并标 `source: "fallback"`。v1.8.0 起 `tag()` 在构造 prompt、
  校验模型输出和本地兜底之前，先把看板过滤成「未完成 + 没有任何标签」的便签；已有标签的便签不会被
  覆盖，全部有标签 / 空看板两种空情况直接返回固定 summary（`source: "fallback"`，不调模型、不写盘）。
- **交给 DSH**（v1.8.0，纯客户端）：凭 `ctx.get('uiWorkspace')`（也接受 `ctx.uiWorkspace` 属性形式）拿到
  `dsh-client-ui-workspace` 服务，调 `startSession(undefined, { prompt, whenDraftExists: 'append' })`
  把 prompt 放进新会话草稿（保留用户已有文字/附件，不发送）；服务缺失/不是函数/抛错/拒绝时降级为
  `navigator.clipboard.writeText`，剪贴板也不可用则失败 toast。整个过程不发 `/dsh-todo` 请求、不阻塞面板。
- **单条建议对话**：前端带 `history`（最多 3 轮）调用 `aiNoteAdvice`；question 必带 2–4 个选项
  （无有效选项会被 Host 拒绝并回退成建议），advice 可带 0–3 个备选做法；`round` 始终等于 `history.length`。
  v1.7.0 起 Host 会把这次 `history` 和 advice 存进 `memory.threads[id]`，重新打开时直接续上。

## v1.4.0 改动（对应用户的「改成双语」）

1. **面板内语言切换**：`自动` / `中文` / `English` 三态，按钮 + popover 菜单（键盘可达、Esc/外点关闭），
   当前状态显示在按钮上。
2. **全量翻译**：强制语言时所有可见文案走既有 `zh`/`en` 字典（124 键，两套键集一致），日期时间
   跟随 `zh-CN` / `en-US`；`auto` 恢复跟随 DSH 语言。
3. **持久化**：`localStorage['sticker-todo:lang']`（`auto|zh|en`），读取失败回退 `auto`，写入失败静默。
4. **README**：整篇重写为中英双语、GitHub 风格（徽章、双语目录、特性/安装/配置/使用/数据/架构/
   Agent/HTTP/开发验证/FAQ/许可）。

## v1.5.0 改动（对应用户的「双视图」）

1. **视图切换**：头部在字体/语言旁新增 `▤ 便利贴` / `☰ 极简` 切换（同一个 popover 视觉语言、键盘可达、
   Esc/外点关闭、`menuitemradio`），选择存 `localStorage['sticker-todo:view']`（`notes|list`，
   非法/缺失回退 `notes`，存储失败静默），刷新后恢复；切换不发 Host 请求。
2. **便利贴模式**：即 v1.4.0 的分组便签墙，完全保留（卡片/标签 chip 抽成共享 helper，两种视图同源）。
3. **极简模式**：把筛选后的看板渲染成紧凑 `ul`/`li` 列表 —— 左侧优先级色条 + 完成勾选 + 单行标题（省略号）
   + 有截止时的小到期标记 + 展开箭头；行按钮带 `aria-expanded`/`aria-controls`，点击/Enter/Space 就地展开
   详情、标签 chip、截止/提醒/安排 chip 和四个操作（编辑 / ✦ AI 建议 / 1 小时后提醒 / 两步删除）。
   同时只展开一行，再点收起；展开态不持久化（刷新重置）；保留原有排序；极简模式不做分组（隐藏 分组/平铺
   切换）；筛选、提醒横幅、AI 卡片、新建按钮、两个弹窗、字体/语言切换都照常可用。
4. **动效/i18n**：行入场错峰淡入 + `stk-expand` 展开、箭头旋转，reduced-motion 全关；新增 7 个 i18n 键
   （`view.label/notes/list/hint`、`list.expand/collapse/details`），字典 131 键、中英键集一致。

## v1.7.0 记忆（数据模型 / 清空 / 重置）

> 设计动机与边界见 [`docs/MEMORY.md`](./docs/MEMORY.md)；契约见 `CONTRACT.md` 的
> 「## Round 7 (v1.7.0 — 记忆 / memory)」。这里只记维护者需要动手的部分。

### 数据模型（文档 v2）

`~/.dsh-sticker-todo/todos.json` 从 `{ version: 1, todos }` 变成：

```json
{
  "version": 2,
  "todos": [ /* 形状不变 */ ],
  "events": [ { "at": "…", "kind": "update", "id": "td_x", "text": "写周报",
                "changes": { "dueAt": { "from": "…", "to": "…" } } } ],
  "memory": {
    "facts": [ { "id": "m_ab12cd34", "text": "周报固定在周五 16:00 发",
                 "source": "user", "createdAt": "…", "updatedAt": "…" } ],
    "threads": { "td_x": { "rounds": [ /* ≤3 轮问答 */ ],
                           "advice": { "text": "…", "source": "model|fallback", "at": "…" },
                           "updatedAt": "…" } }
  }
}
```

- 上限：事件 2000（环形丢最旧）、事实 50、线程 200（超了丢 `updatedAt` 最旧）、每便签问答 3 轮。
- `postpones` / 周统计 / `averageOpenAgeDays` / `lastAdvice` 都是**读时派生**，不落盘，可随时从事件流重算。
- 删便签：事件保留、线程删除；`clearCompleted` 同理。只有 `clearMemory` 会清历史。
- 模型只读记忆：唯一由模型产出的是 `memoryCandidates` 的**提议**，必须用户 `remember` 才落盘。
- v1 → v2 迁移：读 v1 文件时补空 `events` / `memory`，下一次写入升到 2；旧插件读 v2 只取 `todos`，
  所以降级安装不会丢便签。

### 如何清空 / 重置

- **只清记忆、保留便签**：面板 `🧠 记忆 → 清空记忆`（两步确认），或
  `POST /dsh-todo/action {"action":"clearMemory"}` → `{cleared:{facts,threads,events}}`。
- **只删一条事实**：面板该条的 ✕，或 `{"action":"forget","id":"m_…"}`。
- **全部重置（连便签）**：退出 DSH 后删除 `~/.dsh-sticker-todo/todos.json`（或用 `dataFile` 指定的文件），
  重启后从空文档开始；卸载插件时删整个 `~/.dsh-sticker-todo/` 目录即可。
- 事件日志目前没有单独清空的动作（`clearMemory` 会一起清）；不要手工改文件的 `events`，否则派生统计
  会跟着变。

### 排障

- 面板没有 `🧠 记忆` 按钮 / 看不到 `改期 N 次`：浏览器端是旧 bundle 或 Host 是旧代码。Host 侧新动作
  在旧进程里会回 `unknown_action`，重启 DSH（Host）并刷新页面（client）。
- 记忆抽屉里「本周复盘」「发现记忆」报错：模型不可用时**不应**报错（有本地兜底）；若报错先看
  `/dsh-todo/action review` 是否返回 `ok:true`，以及日志里的 `sticker-todo:` 行。

## v1.8.0 改动（只给未分类便签打标签 + 交给 DSH）

1. **`aiTag` 契约变更**：只分类 `tags.length === 0` 的未完成便签；已有标签（用户手动打的，或上一次
   pass 打的）不会被覆盖或追加。全部有标签时返回 `所有未完成便签都已经有标签，不用再分类。`，
   空看板返回 `当前没有待办，暂时不用整理标签。`；两种空情况都是 `source: "fallback"`、不调模型、
   不写盘。没有新 HTTP 动作、没有存储变化；面板「分类打标签」与工具 `tag` 共用 `runAction`，行为一致。
   ⚠️ 升级后第一次 `aiTag` 可能只补一小部分便签，这是预期；旧 Host 进程仍是旧行为，重启才生效。
2. **交给 DSH**（纯客户端）：便利贴卡片动作行与极简展开行新增 `↗` 按钮，把便签拼成 prompt 放进
   DSH 主对话框草稿，**不发送**。依赖的可选客户端服务来自 `dsh-client-ui-workspace`：
   `uiWorkspace.startSession(undefined, { prompt, whenDraftExists: 'append' })`（`ctx.get('uiWorkspace')`
   与 `ctx.uiWorkspace` 属性两种取法都支持）。降级顺序：服务缺失 / `startSession` 不是函数 /
   同步抛错 / Promise reject → 用 `navigator.clipboard.writeText` 复制并 toast
   `已复制，粘贴到主对话框即可`；剪贴板也不可用 → toast `无法放入主对话框，请手动复制`。
   prompt 模板见 CONTRACT Round 8（标题、可选详情、截止/优先级/标签中存在的部分、便签 id、结尾指令），
   en 模式输出英文。新增 5 个键：`note.handoff` / `note.handoffHint` / `note.handoffDraft` /
   `note.handoffCopied` / `note.handoffFailed`。
3. **排障**：线上 Host 未重启时 `aiTag` 仍会覆盖已有标签（新断言会 SKIP 而不是失败）；`↗` 在旧 DSH 上
   会走剪贴板。只改 `client.js` 刷新页面即可；改 `lib/ai.js` 必须重启 DSH。

## 改完之后

```bash
node verify/check-static.mjs      # 71 项：清单（含 1.8.0 / 零依赖）、patch、locale、icon、记忆标识、Round 8 标识、语法
node verify/host-actions.mjs      # 49 项离线 Host 集成：HTTP handler、tags、AI（含只给未分类便签打标签）、记忆、工具
node verify/client-render.mjs     # 58 项客户端渲染冒烟：分组/弹窗/字体/AI 建议/动效/语言/双视图/记忆抽屉/改期徽章/交给 DSH/旧 Host
node verify/api-smoke.mjs        # 线上行为（默认 http://127.0.0.1:55609，实际端口会变，传参或设 DSH_WEB_URL）
node verify/api-smoke.mjs http://127.0.0.1:65441
```

- 只改 `client.js`：浏览器刷新页面即可（bundle 是链接安装，不需要重新打包）；开了客户端 HMR 时可能自动热载。
- 改了 Host 侧（`index.js` / `lib/*`）：退出并重启 DSH，或用 plugin_manager 重新安装
  （`install_bundle`，目标为本仓库目录）让新模块加载。Host 模块只在启动时从磁盘加载，
  所以新动作/新字段在重启前不会生效（`api-smoke` 会把对应检查标成 SKIP 而不是失败）。
- 安装/卸载会改 profile 状态，属于审批操作。

## 已知验证边界

已验证（v1.0.0 – v1.3.0）：安装 `applied`、三个 slot live、工具注册、线上 `aiTag`/`aiNoteAdvice` 走真实模型、
提醒生命周期、AI 全部降级路径、动效与 reduced-motion、分组/筛选/字体等。

已验证（v1.4.0，离线）：`check-static` 51/51、`host-actions` 25/25、`client-render` 35/35
（语言切换：默认 auto、三选项、强制中英切换全部文案、持久化与存储失败回退、`Intl` 跟随、零请求）。

已验证（v1.5.0，离线）：`check-static` 51/51、`host-actions` 25/25、`client-render` **41/41**
（双视图：默认便利贴、极简标题列表 + 到期标记、展开详情/操作且单开、持久化与存储失败回退、
筛选/排序、从列表打开编辑与 AI 建议弹窗）；全部 `node --check` 通过；线上 `api-smoke` 24/24。

已验证（v1.7.0，离线 + 线上）：`check-static` **67/67**、`host-actions` **43/43**、
`client-render` **50/50**（记忆：事件记录与改期计数、事实 CRUD/去重/50 条上限、线程持久化与删除便签、
复盘/记忆候选的 fallback 形状与「不写盘」、v1 文档迁移、工具 4 个记忆动作；记忆抽屉中英双语、
六格复盘统计、候选记住/忽略、改期 ≥2 徽章（两种视图）、教练线程续聊、旧 Host 无 `memory` 不崩、
清空记忆两步确认）；线上 `api-smoke` **27/27**（`state.memory`、临时事实 remember/updateFact/forget、
review/memoryCandidates 只读且状态不变；临时事实在清理阶段也会被 forget）。

已验证（v1.8.0，离线 + 线上）：`check-static` **71/71**、`host-actions` **49/49**、
`client-render` **58/58**（aiTag 只分类未打标签的未完成便签、已有标签不被覆盖/不重写、全标签与空看板
两种固定 summary、空情况不调模型、模型输出无法重打已标签便签、工具 `tag` 同行为；交给 DSH 在两种视图和
已完成便签上都有按钮、zh/en prompt 逐字符校验、`startSession(undefined,{prompt,whenDraftExists:'append'})`
调用形状、无 Host 请求、服务缺失/非函数/同步抛错/Promise reject 都降级剪贴板、剪贴板不可用失败 toast、
`ctx.uiWorkspace` 属性形式与异步 resolve）。线上 `api-smoke` 27 通过 + 1 SKIP（当前运行中的 DSH 还是
v1.8.0 之前的 Host，`aiTag` 仍会重分类；重启 DSH 后应为 28/28）。

未验证：浏览器里的最终视觉手感（动效、明暗主题、弹窗、记忆抽屉布局、纸面质感、极简列表间距）、
桌面通知授权弹窗；侧栏标签在语言切换后的即时重绘（依赖 host 下一次渲染，面板/提醒卡/通知是即时的）；
记忆上限（2000 事件 / 50 事实 / 200 线程）只做了 50 事实的边界验证。
