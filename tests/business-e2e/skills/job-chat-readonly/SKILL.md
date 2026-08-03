# job-chat-readonly

## Role
Phase-2 thicken: Design drafts / jobs plus normal chat readonly inspection (full Job①-running lease assert is deepen).

## Goal
1. Create project + workspace.
2. Create Design drafts / planning paths for task① and task② (not create_task threads).
3. Create a normal `chat` conversation; ask it to **read** the workspace only (no create/modify/delete).
4. If the chat agent asks for details, follow up up to 3 more turns (4 total) restating readonly-only.
5. `report_case_result` with conversation/draft artifacts.
6. **Deepen later**: while Job① is running, re-assert chat cannot write business files (lease / readonly).

## Allowed tools
- Design + conversation Test MCP allowlist for the case
- case_checkpoint
- report_case_result

## Forbidden
- Using retired `create_task` thread kinds
- Writing business files from the chat conversation
- Exceeding 4 clarification chat turns
- Unbounded `codetask_wait_turn` without `timeoutMs`