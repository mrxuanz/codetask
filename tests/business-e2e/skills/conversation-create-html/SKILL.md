# conversation-create-html

## Role
Drive a conversation (1–4 turns) that asks the product agent to create an SDK-named HTML file in the project workspace, then report via Test MCP.

## Goal
1. Create project with the provided `workspaceRoot` (empty project fixture).
2. Create thread with `coreCode` matching the active conversation SDK (e.g. `opencode`).
3. `codetask_start_turn` with the user message that requests creating `{sdk}.html` (e.g. `opencode.html`, `cursor.html`).
4. Wait until terminal with **sliced** `codetask_wait_turn` (`timeoutMs: 30000`, retry on timeout/fetch failed). Never omit `timeoutMs` on a long wait.
5. `codetask_list_messages` and inspect the latest assistant reply.
6. **Clarification loop (max 4 turns total = 1 initial + up to 3 follow-ups):**
   - If the assistant asks for more details / clarification instead of creating the file, send one follow-up turn that restates: exact filename, marker `BUSINESS_E2E_CHAT_HTML`, “不要追问，直接创建”.
   - Repeat only while the assistant is still clarifying and turns used < 4.
   - If the file already exists in workspace root, stop early and proceed to report.
7. `case_checkpoint` with name `turn_completed`.
8. `report_case_result` with artifacts including `projectId`, `threadId`, last `turnId` (or `turnIds`), and `expectedHtmlFile`.

## File naming
- conversation core `opencode` → `opencode.html`
- conversation core `cursor` / `cursoracp` → `cursor.html`
- other cores → `{core}.html`

The HTML body must include the marker text `BUSINESS_E2E_CHAT_HTML`. A Node file oracle checks the workspace after MCP report.

## Allowed tools
- codetask_create_project
- codetask_create_thread
- codetask_get_thread
- codetask_list_cores
- codetask_start_turn
- codetask_get_turn
- codetask_wait_turn
- codetask_list_messages
- case_checkpoint
- report_case_result

## Required checkpoints
- project_created
- thread_created
- turn_completed

## Forbidden behavior
- Do not invent a different filename than the SDK mapping
- Do not skip waiting for terminal turn status
- Do not report completed if the turn failed
- Do not call unbounded `codetask_wait_turn` without `timeoutMs`
- Do not exceed 4 conversation turns
- Do not start a follow-up when the assistant already finished (or the HTML file exists)

## Completion
Call `report_case_result` once with status=completed.
