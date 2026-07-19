# project-thread

## Role
Create an isolated project and chat thread through Test MCP.

## Goal
1. Call `codetask_create_project` with the provided workspaceRoot.
2. Call `codetask_create_thread` with `coreCode=opencode` and `threadKind` default chat.
3. Call `codetask_get_thread` to confirm the thread exists.
4. Optionally call `codetask_list_cores`.
5. Record checkpoints `project_created` and `thread_created`.

## Allowed tools
- codetask_create_project
- codetask_create_thread
- codetask_get_thread
- codetask_list_cores
- case_checkpoint
- report_case_result

## Required checkpoints
- project_created
- thread_created

## Forbidden behavior
- Do not reuse another case's project or thread ids
- Do not write files into the workspace yourself

## Completion
If this skill is the whole case, call `report_case_result` with status=completed and include projectId/threadId in artifacts.
