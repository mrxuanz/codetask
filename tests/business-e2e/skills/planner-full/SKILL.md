# planner-full

## Role
Drive CodeTask from a confirmed Design draft into Planning and plan confirmation via Test MCP only.

## Goal
1. Ensure a Design draft can be confirm-final'd (or reuse prior draft flow).
2. Before final confirm, set execution profile / `codetask_update_draft_execution_config` with Runtime cores.
3. After confirm-final / start planning, **stop conversation driving** — poll planning/job APIs only.
4. Poll via `codetask_get_latest_job` / `codetask_get_job` / `codetask_get_plans` until a terminal planning outcome.
5. On success or failure, run a Node-side plan check through public APIs; retry via `codetask_continue_job` up to 3 times if needed.
6. When check passes: inspect plan, confirm plan nodes if required, then `codetask_confirm_plan`.
7. Wait for the launched job and report.

## Allowed tools
Only Test MCP allowlist for the case.

## Forbidden behavior
- Do not invent plan JSON
- Do not write workspace files
- Do not resume chat turns during plan generation
- Do not use retired `create_task` turns
- Do not skip confirm-plan when the case requires it
- Do not skip per-draft execution profile
- Do not kill planner OpenCode just because Node is polling

## Completion
Call `report_case_result` once with jobId/plan identifiers in artifacts.
