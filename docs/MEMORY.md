# 记忆功能设计（v1.7.0）

## 为什么加

v1.6.0 的插件**有状态、没记忆**：

| | 现状 |
|---|---|
| 便签内容 | 存在 `~/.dsh-sticker-todo/todos.json`，但只保存「现在」 |
| 便签怎么变的 | 改期、完成、删除的时间线全部丢失 |
| 4 个 AI 操作 | 每次调用都是无状态的，prompt 只塞当前快照 |
| 单条便签的教练对话 | 只活在浏览器内存里，关掉对话框就消失 |
| 上次为什么这么安排 / 上次建议了什么 | 没有任何记录 |

状态回答「现在有什么」，记忆回答「过去发生了什么、这个人是什么样」。加上记忆后用户能直接
感知到三件事：教练跨会话记得聊过什么、排程按你的作息和习惯而不是模板、面板能给出周复盘
（完成率、改期模式、哪件事反复改期该拆掉）。

## 四层记忆，这一版做哪层

| 层 | 内容 | 作用 | 本版 |
|---|---|---|---|
| ① 会话记忆 | 每条便签的教练问答 + 上次建议 | 重开便签接着聊，不重复问同一个问题 | ✅ |
| ② 事件记忆 | 改期 / 完成 / 删除 / 提醒的事件流 | 「这张便签改期 3 次」→ 建议拆小或删掉；周复盘 | ✅ |
| ③ 偏好记忆 | 用户事实与偏好，注入每个 prompt | 排程时间窗、建议策略、打标词汇表个性化 | ✅ |
| ④ 语义记忆 | 向量 / 相似度检索 | 相似任务召回、自动去重 | ❌ 不引入 |

④ 不做：DSH 没有 embedding 服务（见下），本地做向量要么加依赖要么精度不够，而收益远低于
前三层。留到真有人要的时候再说。

## 关键红线：模型只读记忆，不写记忆

所有写入只来自两类可验证来源：

1. 用户在面板里点「记住」/「删除」，或在聊天里让 agent 调 `remember` / `forget`；
2. 模型通过 `memoryCandidates` **提议**候选记忆 —— 必须由用户点「记住」才落盘。

绝不让模型自己往事实库里塞东西。理由很实际：模型记错一次，之后几周都会拿错的信息去排日程、
给建议，比没有记忆更糟，而且用户根本不知道错从哪来。配套三条硬约束：

- **可见可改可忘记**：记忆面板列出全部事实，能改能删，有「清空记忆」两段式确认；
- **每条事实带来源和时间**（`source: "user"`、`createdAt` / `updatedAt`）；
- **prompt 注入设上限**：最多 12 条事实、一行周统计、单条便签的改期次数，避免 token 膨胀和
  记忆淹没当前任务。

## DSH 侧提供了什么（实测结论）

DSH 里**没有通用记忆子系统**：没有 `ctx.memory`，没有向量库，没有 embedding 端点
（`ctx.llm` 只有 `stream` / `listModels` / `resolveModel`）。它提供的是「上下文」机制，不是记忆：
`dsh-compaction`、`dsh-agent-instructions`、`dsh-skill`。

可复用、但本版**不用**的东西：

- `ctx.storageDomain` —— 真实存在的持久化 KV（desktop profile 里已挂载，底层 json backend 在
  `~/.dsh/storages/`），带 schema、版本号、原子写。**不采用**：我们的 `lib/store.js` 已经是
  零依赖、单写者、原子 rename 的实现，迁过去只会把「数据在 `~/.dsh-sticker-todo/todos.json`
  这一件事」变成两处存储，用户备份和排查都更麻烦，收益只有「少写几十行」。
- `ctx.sessions` / `ctx.sessionQuery` —— 能读历史会话（`dsh-notes` 就是靠它把对话蒸馏成笔记）。
  **本版不做**：把聊天内容读进书签插件是隐私敏感面，而且会引入「模型从闲聊里臆测事实」的
  风险。想从对话里记东西，正确的路径是用户在聊天里明确说「记住……」，由 agent 调工具写入。

一并记下（以后可能有用）：会话日志存在 `~/.dsh/sessions/`，DSH 自身**没有删除 API**，会一直累积；
本插件的记忆只存在自己的数据文件里，`clearMemory` 能一次清空，卸载插件时删目录即可。

## 数据模型（v2）

```json
{
  "version": 2,
  "todos": [ /* 不变 */ ],
  "events": [ { "at": "…", "kind": "update", "id": "td_x", "text": "写周报",
                "changes": { "dueAt": { "from": "…", "to": "…" } } } ],
  "memory": {
    "facts": [ { "id": "m_ab12cd34", "text": "周报固定在周五 16:00 发",
                 "source": "user", "createdAt": "…", "updatedAt": "…" } ],
    "threads": { "td_x": { "rounds": [ { "round": 1, "question": "…", "answer": "…" } ],
                           "advice": { "text": "…", "source": "model", "at": "…" },
                           "updatedAt": "…" } }
  }
}
```

上限：事件 2000 条（环形，丢最旧）、事实 50 条、线程 200 条、每条便签问答 3 轮。
派生值（改期次数、周统计、平均未完成时长）**不落盘**，读的时候从事件流算，改坏了也能重算。

事件是 append-only 的，所以便签被删掉之后，它「曾经存在、被改期 3 次、最后放弃」这件事仍然
留在复盘里 —— 这是「删除」和「从未存在」的区别，也是记忆真正的价值。

## 数据流

```
用户操作 ──► store（写 todos + 追加 event）
                │
GET /state ─────┼──► memory { facts, stats, postpones, threads } ──► 面板（徽章 / 记忆抽屉）
                │
AI 操作 ────────┘──► memoryContext { facts, stats, postpones, lastAdvice } ──► prompt 注入
                                  ▲
用户点「记住」──► remember ───────┘
模型提议 ──────► memoryCandidates（不写）──► 用户点「记住」──► remember
```

## 版本与迁移

- 文档 `version: 1 → 2`；v1 文件读取时补 `events: []`、`memory: { facts: [], threads: {} }`，
  首次写入自动升到 2。旧版本插件读 v2 文件时会忽略多出来的成员（它只读 `todos`），所以降级
  安装不会丢便签。
- 不新增任何依赖，仍然是零依赖 Node 内置模块。
- 新增 API 全部是 `POST /dsh-todo/action` 的动作，旧客户端不认识新动作时会拿到
  `unknown_action`；新客户端在旧 Host 上读到 `data.memory === undefined` 时隐藏相关 UI。

## 验收

- `verify/host-actions.mjs`：事件记录 / 改期计数 / 事实 CRUD 与上限 / 线程持久化 /
  复盘与候选记忆的 fallback 形状 / `clearMemory` / v1 文档迁移。
- `verify/client-render.mjs`：记忆抽屉中英双语渲染、改期徽章、旧 Host（无 `memory`）不崩。
- `verify/check-static.mjs`：版本号、新动作名、零依赖、契约与实现一致。
