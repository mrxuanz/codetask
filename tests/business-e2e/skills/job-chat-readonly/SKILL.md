# job-chat-readonly

## Role
Phase-2 thicken: dual create_task threads + normal chat readonly inspection (full Job①-running lease assert is deepen).

## Goal
1. Create project + workspace.
2. Create create_task thread for task① and task②.
3. Create a normal `chat` thread; ask it to **read** the workspace only (no create/modify/delete).
4. `report_case_result` with thread artifacts.
5. **Deepen later**: while Job① is running, re-assert chat cannot write business files (lease / readonly).

## Allowed tools
- codetask_create_project
- codetask_create_thread
- codetask_get_thread
- codetask_start_turn
- codetask_wait_turn
- codetask_list_messages
- codetask_get_latest_job
- codetask_get_job
- case_checkpoint
- report_case_result

## Forbidden
- Outer harness must not write business deliverables to fake a pass.
- Do not skip reporting thread ids.

## See also
[`docs/business-testing/04-脚本使用与三语言架构.md`](../../../../docs/business-testing/04-脚本使用与三语言架构.md) §2.5 / §3.3.
