# conversation-create-html

## Role
Drive a single conversation turn that asks the product agent to create an SDK-named HTML file in the project workspace, then report via Test MCP.

## Goal
1. Create project with the provided `workspaceRoot` (empty project fixture).
2. Create thread with `coreCode` matching the active conversation SDK (e.g. `opencode`).
3. `codetask_start_turn` with the user message that requests creating `{sdk}.html` (e.g. `opencode.html`, `cursor.html`).
4. `codetask_wait_turn` until terminal.
5. `codetask_list_messages` to confirm an assistant reply exists.
6. `case_checkpoint` with name `turn_completed`.
7. `report_case_result` with artifacts including `projectId`, `threadId`, `turnId`, and `expectedHtmlFile`.

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

## Completion
Call `report_case_result` once with status=completed.
