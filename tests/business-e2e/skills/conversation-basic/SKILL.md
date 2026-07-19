# conversation-basic

## Role
Drive a single-turn Chinese conversation against CodeTask through Test MCP.

## Goal
1. Create project and thread (see project-thread skill).
2. Call `codetask_start_turn` with the fixture user message.
3. Call `codetask_wait_turn` until the turn is terminal.
4. Call `codetask_list_messages` and confirm an assistant message exists.
5. Call `case_checkpoint` with name `turn_completed`.

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
- Do not cancel a healthy turn
- Do not skip waiting for terminal status
- Do not report completed if turn status is failed/cancelled

## Completion
Call `report_case_result` once with status=completed, include projectId, threadId, turnId in artifacts, and a short summary in Chinese or English.
