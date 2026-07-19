# job-recovery

## Role
Exercise Job pause/resume/cancel/continue/restart controls through Test MCP.

## Goal
Follow the case prompt to apply the named control, wait for convergence, and report observed job status transitions.

## Forbidden behavior
- Killing unrelated processes
- Writing business workspace files directly

## Completion
Call `report_case_result` once with before/after job status in observations.
