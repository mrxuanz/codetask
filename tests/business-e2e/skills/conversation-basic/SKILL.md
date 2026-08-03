# conversation-basic

## Role
Drive a short Chinese conversation against CodeTask through Test MCP (1–4 turns if the model asks for clarification).

## Goal
1. Create project and thread (see project-thread skill).
2. Call `codetask_start_turn` with the fixture user message.
3. Wait until the turn is terminal using **sliced** `codetask_wait_turn`:
   - Always pass `timeoutMs: 30000` (or lower).
   - On `timeout:turn_*` or `fetch failed`, call again with the same turnId.
   - Never use a single unbounded `codetask_wait_turn` (Node undici headersTimeout ~300s will kill it).
   - Optionally poll `codetask_get_turn` between slices.
4. Call `codetask_list_messages` and confirm an assistant message exists.
5. **Clarification loop (max 4 turns total = 1 initial + up to 3 follow-ups):**
   - If the assistant asks for more details instead of answering, send one follow-up:
     `不需要更多细节。请直接用中文只回复数字答案，不要解释、不要追问。`
   - Stop as soon as the reply looks like a final answer (e.g. a number), or after 4 turns.
6. Call `case_checkpoint` with name `turn_completed`.

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
- Do not call unbounded `codetask_wait_turn` without `timeoutMs`
- Do not exceed 4 conversation turns
- Do not keep clarifying after a final numeric answer

## Completion
Call `report_case_result` once with status=completed, include projectId, threadId, turnId (or turnIds) in artifacts, and a short summary in Chinese or English.
