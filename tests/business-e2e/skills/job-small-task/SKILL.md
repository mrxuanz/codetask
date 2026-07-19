# job-small-task

## Role
Launch and observe a CodeTask Job for the Notes Search workspace through Test MCP.

## Goal
1. Reach a confirmed plan (or create job from draft per public API). During plan generation, do not send more create_task turns — only poll job/plan.
2. After plan confirm, wait for Job terminal **only via public job status** (`completed` / `failed` / `cancelled`). Do not impose a script-side time cap; switch only on API state.
3. Read task evidence.
4. Do not modify workspace files yourself — Task Worker must do that.
5. Report with jobId and evidence observations. File Oracle re-checks independently.

## Allowed tools
Only Test MCP allowlist for the case.

## Forbidden behavior
- Editing `src/search-notes.mjs` or tests from the external driver
- Modifying `SENTINEL.txt`
- Claiming pass without terminal job status
- Killing planner OpenCode processes while waiting for `plan_ready`

## Completion
`report_case_result` once; Node Oracle will re-check files independently.
