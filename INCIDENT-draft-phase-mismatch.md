# CodeTask 草案阶段错位与首次创建空草案问题说明

**文档版本：** 2026-07-05  
**状态：** 待修复  
**严重级别：** P1（阻断草案完整生成，需用户手动补全或新建 thread）  
**影响模块：** Create Task Wizard、`conversation-mcp`、`codeteam-manager`、草案占位与 UI 工作区

---

## 1. 问题摘要

| 项 | 内容 |
|----|------|
| **核心现象** | 创建任务时 MCP 工具调用失败；草案只显示标题或部分内容；Agent 称「没有草案」并反复补写仍不完整 |
| **根因类型** | 架构缺陷（MCP 双阶段检查 + 状态竞态 + 占位草案与阶段推进不同步），非单纯「DB 写不进去」 |
| **用户误解** | 「DB 没存进去」——实际是 **存了占位/碎片数据，完整草案从未一次性写入成功** |

---

## 2. 用户侧现象

### 2.1 草案 UI

- 右侧步骤条在「需求收集」或「草案确认」之间不一致
- 草案卡片**只有标题**（如 `New thread`、`Vue Vite 静态博客首页`），Summary / User Flow / 验收标准为空
- 需求合同可能只有 Title、Summary 两节，User Flow 空白
- 列表里**较早的草案正常**，当前新建 thread 异常

### 2.2 对话侧

- Agent 回复：MCP 状态冲突——上下文仍在「需求收集」，工具报已在 `draft_review`
- Agent 称「确实没有（完整）草案」，随后多轮「补全」仍不成功
- 与正常草案对比：**缺少阶段切换类操作记录**（`wizard-handoff`），Agent 侧像「没有此前对话上下文」

---

## 3. 这是不是「DB 没存进去」？

**不完全是。** 分三种情况：

| 情况 | 是否入库 | 说明 |
|------|----------|------|
| 占位草案（仅标题） | ✅ 已存 | `ensureCollectingDraft` 设计即插入空壳 |
| 完整草案 | ❌ 未成功 | `propose_task_draft` 被阶段门禁拦截 |
| 后续「补写」 | ⚠️ 部分存 | `update_task_draft` 可能只写入 title/summary 等 |
| 用户对话 | ✅ 已存 | Agent 可能因阶段过滤「看不见」 |
| 阶段 handoff 日志 | ❌ 通常无 | `advanceWizardPhase` 未成功执行 |

**一句话：** 不是数据库故障，是**正确的写入路径没跑通**，库里留下占位标题和零碎 PATCH。

---

## 4. 生产 / 调试日志（原始数据）

### 4.1 Sandbox 日志（`CODETASK_DEBUG:sandbox`）

**失败回合** — session: `conv-mcp-bf4355c8-c58e-421f-9694-e71585e4cbad`

```
#1  turn plan: role=conversation, mcpToolNames=[..., propose_task_draft, get_task_draft, ...]

#2  mcp_tool_call: propose_task_draft → in_progress
#3  propose_task_draft → FAILED
    Error: Current phase is draft_review; this action is only allowed in collect

#4  mcp_tool_call: get_task_draft → in_progress
#5  get_task_draft → FAILED
    Error: Tool "get_task_draft" is not available in the current phase

#6  mcp_tool_call: request_phase_rollback → in_progress
#7  request_phase_rollback → FAILED
    Error: Tool "request_phase_rollback" is not available in the current phase

#8  turn.completed
```

**conversation-mcp 服务端**

```json
{
  "sessionId": "conv-mcp-bf4355c8-c58e-421f-9694-e71585e4cbad",
  "toolName": "propose_task_draft",
  "message": "Current phase is draft_review; this action is only allowed in collect"
}
{
  "sessionId": "conv-mcp-bf4355c8-c58e-421f-9694-e71585e4cbad",
  "toolName": "get_task_draft",
  "message": "Tool \"get_task_draft\" is not available in the current phase"
}
{
  "sessionId": "conv-mcp-bf4355c8-c58e-421f-9694-e71585e4cbad",
  "toolName": "request_phase_rollback",
  "message": "Tool \"request_phase_rollback\" is not available in the current phase"
}
```

**后续回合（阶段部分对齐）** — session: `conv-mcp-4e7d6757-d867-4932-b8c0-a059bbe11161`

```
#10-11  get_task_draft        → OK
#12-13  update_task_draft     → OK
#14-15  get_task_draft        → OK
#16     turn.completed
```

### 4.2 日志解读矩阵

| 工具 | 检查依据 | 失败时隐含状态 |
|------|----------|----------------|
| `propose_task_draft` | DB `resolveWizardPhase()` | DB = **`draft_review`** |
| `get_task_draft` | 冻结的 `session.wizardStage` | Session = **`collect`** |
| `request_phase_rollback` | 冻结的 `session.wizardStage` | Session = **`collect`** |

**三工具连环失败 ⟺ 同一回合内 `session.wizardStage=collect` 且调工具瞬间 DB 为 `draft_review`。**

### 4.3 关键错误原文

```
Mcp error: -32000: Current phase is draft_review; this action is only allowed in collect

Mcp error: -32000: Tool "get_task_draft" is not available in the current phase

Mcp error: -32000: Tool "request_phase_rollback" is not available in the current phase
```

---

## 5. 错误过程时序

### 5.1 三工具连环失败（阶段错位）

```
用户发消息（createTaskMode）
    │
    ├─ getThreadRow → wizardPhase=collect
    ├─ registerConversationMcpSession(wizardStage=collect)  ← 整轮冻结
    ├─ ensureCollectingDraft → 插入占位草案（仅 title）
    │
    ├─ [并行] loadWorkspace → updateThreadContext(activeDraftId)
    │                         → thread.wizardPhase = draft_review（无 handoff）
    │
    └─ Agent 调工具
           ├─ propose_task_draft  → ❌ DB 已是 draft_review
           ├─ get_task_draft      → ❌ session 仍是 collect
           └─ request_phase_rollback → ❌ session 仍是 collect
```

### 5.2 首次创建 → 只有标题 → 补不上

```
T0  新建 thread，进入工作区
T1  用户发第一条需求
    → ensureCollectingDraft：DB 写入占位草案（title only, collecting=true）
    → 右侧立刻显示标题，无合同正文
T2  loadWorkspace 并行
    → updateThreadContext → wizardPhase=draft_review（无 wizard-handoff）
T3  Agent 回合：session=collect，DB 可能已是 draft_review
T4  propose / get / rollback 连环失败
T5  Agent 文字回复「没有完整草案 / 工具冲突」
T6  用户要求补全
T7  新回合 wizardPhase=draft_review，历史过滤掉 collect 阶段消息
T8  Agent 无需求上下文；get 可能仍失败；update 只写部分字段
T9  循环补写，草案始终残缺
```

### 5.3 后续「半成功」回合

阶段对齐后 `get_task_draft` / `update_task_draft` 可用，但若 `requirementsContract.status === 'confirmed'`，锁定字段被跳过，表现为工具成功但内容仍不完整。

---

## 6. 根因分析（代码级）

### 6.1 双阶段检查源（主因）

**文件：** `src/server/conversation/mcp/handler.ts`

| 函数 | 数据来源 | 作用 |
|------|----------|------|
| `assertSessionWizardTool` | `session.wizardStage`（回合初冻结） | 工具白名单 |
| `assertMcpWizardPhase` | `resolveWizardPhase(row)`（实时 DB） | 特定工具阶段断言 |
| `rejectIfWizardToolPhaseAccess` | 两者混用 | 软拒绝 |

`registerConversationMcpSession` 在 `src/server/conversation/service.ts` 写入 `wizardStage` 后**整轮不更新**（`propose_task_draft` 成功后也不刷新）。

### 6.2 阶段工具白名单

**文件：** `src/server/wizard/tools.ts`

```
collect:       propose_task_draft, delete_thread
draft_review:  get_task_draft, update_task_draft, revise_requirements_contract,
               request_phase_rollback, confirm_requirements_contract, ...
```

阶段不一致时，**读和写所需工具可能全部不可用**。

### 6.3 阶段推断 collect 优先

**文件：** `src/server/wizard/phase.ts`

```typescript
if (stored === WIZARD_PHASE_COLLECT) {
  return WIZARD_PHASE_COLLECT  // 即使有 activeDraftId
}
if (row.activeDraftId) return WIZARD_PHASE_DRAFT_REVIEW
```

`wizardPhase` 列为 `collect` 时永远推断为 collect，与已有草案内容可能不一致。

### 6.4 UI 与 DB 竞态

**`src/server/threads/service.ts` — `updateThreadContext`**

```typescript
} else if (patch.activeDraftId && !existing.activePlanId) {
  update.wizardPhase = WIZARD_PHASE_DRAFT_REVIEW  // 未检查 collecting 占位
}
```

**`src/renderer/src/composables/useDraftPlanWorkspace.ts` — `loadWorkspace`**

打开工作区时调用 `updateThreadContext(activeDraftId)`，可在 Agent 回合中将 DB 推到 `draft_review` 而不写 `wizard-handoff`。

**`src/server/conversation/draft/collecting.ts` — `ensureCollectingDraft`**

collect 回合将 `wizardPhase` 设回 `collect`，与 `updateThreadContext` 形成拉锯。

### 6.5 占位草案设计（首次只有标题）

**文件：** `src/server/conversation/draft/collecting.ts`

首次 collect 消息触发 `ensureCollectingDraft`，payload 仅含 `title`，`summary` / `requirementsContract.markdown` 均为空，`collecting: true`。

UI（`TaskLaunchDraftCard`）仅在 `requirementsContract.markdown` 非空时展示合同区，故用户只见标题。

### 6.6 Agent 工具暴露过多

**`src/server/conversation/mcp/tools.ts`**

`conversationMcpToolDefinitionsForPhase()` 使用 `allCreateTaskMcpToolNames()`，未按 `toolsForWizardPhase(phase)` 过滤。

**`src/server/conversation/service.ts`**

`mcpToolNames` 同样暴露全部工具名，易在 `draft_review` 误调 `propose_task_draft`。

### 6.7 对话历史按阶段过滤

**文件：** `src/server/conversation/history.ts`

`buildConversationHistoryBlock` 在 createTask 模式下只保留 `message.wizardPhase === 当前阶段` 的消息。

用户在 **collect** 描述的需求，thread 被推到 **draft_review** 后，下一轮 Agent **看不到** collect 消息。

Assistant 消息 `wizardPhase` 在回合结束时用**回合初**阶段打标（`service.ts` L508），不随中途 `propose` 更新，加剧过滤错乱。

### 6.8 左侧聊天隐藏草案消息

**文件：** `src/renderer/src/components/home/ChatMessages.vue`

```typescript
messages.filter((m) => m.kind !== 'task-launch-draft')
```

草案 payload 不进左侧 Agent 上下文；`get_task_draft` 失败时 Agent 完全盲写。

### 6.9 已确认合同导致部分更新

**文件：** `src/server/conversation/draft/status.ts`

`requirementsContract.status === 'confirmed'` 时 `update_task_draft` 跳过合同字段，工具返回成功但内容不完整。

---

## 7. 触发条件

| # | 条件 | 风险 |
|---|------|------|
| T1 | 进工作区后立刻发消息（与 `loadWorkspace` 抢跑） | 高 |
| T2 | `activeDraftId` 存在但仍是 collecting 占位，`updateThreadContext` 推 `draft_review` | 高 |
| T3 | 同回合 `propose` 成功后 session 未刷新再调 `get` | 中 |
| T4 | `draft_review` 下说「重新生成草案」误调 `propose` | 中 |
| T5 | 需求合同已确认后让 Agent 全量重写 | 中（部分更新） |
| T6 | 连发两次相同指令 | 中 |

**三工具全挂必要条件：** T1 或 T2（或 T3）+ session 冻在 collect + 调工具前 DB 变为 draft_review。

---

## 8. 数据状态对照

### 8.1 正常草案（列表第一项 / happy path）

```json
{
  "thread": {
    "wizardPhase": "draft_review",
    "activeDraftId": "msg-draft-1"
  },
  "draft_payload": {
    "collecting": false,
    "title": "Vue Vite 静态博客首页",
    "summary": "（完整）",
    "userFlow": "（完整）",
    "techStack": "（完整）",
    "requirementsContract": {
      "markdown": "# REQUIREMENTS CONTRACT\n...",
      "status": "pending"
    },
    "abilities": [{ "abilityCode": "frontend-implementation" }]
  },
  "messages_summary": [
    "text/user/collect - 需求描述",
    "text/assistant/collect - 回复",
    "wizard-handoff/draft_review - Phase transition: collect → draft_review",
    "task-launch-draft/draft_review - 完整 payload"
  ]
}
```

| session \ DB | collect | draft_review |
|--------------|---------|--------------|
| collect | 正常 collect 流程 | **本 bug** |
| draft_review | 少见 | propose❌，get✅ |

### 8.2 异常草案（本 incident）

```json
{
  "thread": {
    "wizardPhase": "draft_review",
    "activeDraftId": "msg-placeholder-1"
  },
  "draft_payload": {
    "collecting": true,
    "title": "New thread",
    "summary": "",
    "userFlow": "",
    "techStack": "",
    "requirementsContract": { "markdown": "", "status": "pending" },
    "abilities": []
  },
  "messages_summary": [
    "text/user/collect - 需求（Agent 下轮可能看不到）",
    "text/assistant/collect - MCP 工具失败说明",
    "task-launch-draft/collect - 占位，仅 title"
  ],
  "missing": [
    "wizard-handoff",
    "完整 requirementsContract.markdown",
    "propose_task_draft 一次性写入"
  ]
}
```

### 8.3 部分补写后（仍异常）

```json
{
  "draft_payload": {
    "collecting": false,
    "title": "Vue Vite 静态博客首页",
    "summary": "（有）",
    "userFlow": "",
    "requirementsContract": {
      "markdown": "# REQUIREMENTS CONTRACT\n## Title\n...\n## Summary\n...\n## User Flow\n\n",
      "status": "pending"
    }
  }
}
```

---

## 9. 涉及文件清单

| 模块 | 路径 | 问题点 |
|------|------|--------|
| MCP 调度 | `src/server/conversation/mcp/handler.ts` | 双阶段检查 |
| MCP 工具定义 | `src/server/conversation/mcp/tools.ts` | 未按 phase 过滤 tools/list |
| 对话服务 | `src/server/conversation/service.ts` | session 冻结、全量 mcpToolNames |
| 阶段推断 | `src/server/wizard/phase.ts` | collect 优先 |
| 阶段工具 | `src/server/wizard/tools.ts` | 白名单（逻辑正确，被错误检查源使用） |
| 占位草案 | `src/server/conversation/draft/collecting.ts` | 空壳写入、强制 collect |
| Thread 上下文 | `src/server/threads/service.ts` | 盲目推 draft_review |
| 草案更新 | `src/server/jobs/draft-plan.ts` | 跳过锁定字段 |
| 历史过滤 | `src/server/conversation/history.ts` | 按 wizardPhase 滤掉 collect 消息 |
| 前端工作区 | `src/renderer/src/composables/useDraftPlanWorkspace.ts` | loadWorkspace 改阶段 |
| 聊天展示 | `src/renderer/src/components/home/ChatMessages.vue` | 隐藏 task-launch-draft |

---

## 10. 推荐修复方案

### 设计原则

1. **阶段以 DB `resolveWizardPhase(row)` 为唯一权威**（工具门禁）
2. **`session.wizardStage` 仅用于 MCP 鉴权 token**，不用于工具白名单
3. **collecting 占位 ≠ draft_review**；有内容_finalize 后才进草案确认
4. **Agent 只见当前阶段工具**（`toolsForWizardPhase`）

### 优先级

| 优先级 | 任务 | 文件 |
|--------|------|------|
| **P0** | 工具门禁统一读 DB phase | `mcp/handler.ts`, `wizard/edit-guard.ts` |
| **P0** | `propose_task_draft` 成功后更新 `session.wizardStage` | `mcp/handler.ts` |
| **P0** | `inferWizardPhase`：非 collecting 草案不永远返回 collect | `wizard/phase.ts` |
| **P1** | `updateThreadContext` 检查 `isCollectingDraftPayload` | `threads/service.ts` |
| **P1** | `ensureCollectingDraft` 不覆盖 finalized 草案 | `draft/collecting.ts` |
| **P1** | 注册 MCP session 前重读 `getThreadRow` | `conversation/service.ts` |
| **P2** | `toolsForWizardPhase` 用于 tools/list 与 mcpToolNames | `mcp/tools.ts`, `service.ts` |
| **P2** | 回合末 assistant 消息按最新 DB 阶段打标 | `conversation/service.ts` |
| **P2** | draft_review prompt 禁止 regenerate 时调用 propose | `wizard/prompts.ts` |
| **P3** | Workflow 回归测试 + phase mismatch 日志 | `tests/workflow/` |
| **P3** | UI：工作区 loading 完成前禁用发送 | `CreateTaskPage.vue` |

### 不建议

- 只改 prompt 不改后端
- 允许 `propose_task_draft` 在 `draft_review` 复用
- 每调工具更换 MCP URL / capability token

---

## 11. 复现步骤（QA）

1. 新建 Create Task thread，选择工作目录
2. 进入工作区后**立即**在左侧发送需求（不等待右侧加载完成）
3. 或在草案确认阶段发送「重新生成草案」
4. 查看 sandbox 日志是否出现 propose/get/rollback 三连失败
5. 查 DB：
   - `threads.wizard_phase` vs 首轮注册时的 session 阶段
   - `payload_json` 中 `collecting`、`summary`、`requirementsContract.markdown`
   - 是否存在 `kind=wizard-handoff` 消息

**期望（修复后）：** 不应出现 session/DB 阶段不一致；`draft_review` 下应能 `get` + `update`；首次创建应经一次成功 `propose` 得到完整 payload。

---

## 12. 开发自查 SQL（示意）

```sql
-- 1. 线程阶段与 activeDraftId
SELECT id, wizard_phase, active_draft_id, active_plan_id
FROM threads WHERE id = '<threadId>';

-- 2. 草案 payload 是否占位/残缺
SELECT id, kind, wizard_phase,
       json_extract(payload_json, '$.collecting') AS collecting,
       json_extract(payload_json, '$.title') AS title,
       json_extract(payload_json, '$.summary') AS summary,
       length(json_extract(payload_json, '$.requirementsContract.markdown')) AS contract_len
FROM thread_messages
WHERE id = '<activeDraftId>';

-- 3. 是否有阶段切换 handoff
SELECT id, kind, wizard_phase, created_at, substr(content, 1, 120) AS content_preview
FROM thread_messages
WHERE thread_id = '<threadId>' AND kind = 'wizard-handoff'
ORDER BY created_at;

-- 4. 消息阶段分布（历史过滤问题）
SELECT wizard_phase, role, kind, COUNT(*) AS cnt
FROM thread_messages
WHERE thread_id = '<threadId>'
GROUP BY wizard_phase, role, kind
ORDER BY wizard_phase, kind;
```

**异常特征：**

- `collecting = 1` 且 `summary` 为空，但 `threads.wizard_phase = 'draft_review'`
- `wizard-handoff` 行数为 0
- 大量 `wizard_phase = 'collect'` 的 user 消息，thread 已是 `draft_review`

---

## 13. 用户临时规避（非代码修复）

1. 等右侧草案面板加载完成后再发消息
2. 不要在 Agent 运行时连发「重新生成草案」
3. 合同未确认：右侧手动补全 User Flow 后点「确认需求合同」
4. 合同已确认：先解锁需求合同再改
5. 过乱则从草案列表「新建」thread，一次性描述需求

---

## 14. 附录：session / DB 阶段不一致矩阵

| session \ DB | collect | draft_review |
|--------------|---------|--------------|
| **collect** | 正常 | **本 bug：propose❌ get❌ rollback❌** |
| **draft_review** | 少见 | propose❌，get✅（仅误调 propose） |

---

## 15. 相关测试参考

- `tests/conversation/collecting-draft.test.ts` — collecting 与 phase 推断
- `tests/workflow/01-entry-thread.test.ts` — collect → propose → draft_review happy path
- 待补充：loadWorkspace 与 sendMessage 竞态、session/DB 不一致回归

---

**维护：** 修复 PR 合并后请更新本文档状态，并链接对应 issue/PR。
