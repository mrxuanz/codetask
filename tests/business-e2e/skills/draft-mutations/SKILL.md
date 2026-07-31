# draft-mutations

## Role
Probe Draft mutation, lock, unlock, section confirm, ability providers, **per-draft executionConfig**, and reference/attachment tools via Test MCP.

## Goal
Exercise the allowlisted Draft mutation tools for the case, including `codetask_update_draft_execution_config`. Prefer real draft message ids when available; otherwise record structured probe failures.

## Forbidden behavior
- raw HTTP
- writing workspace business files directly
- treating `/api/settings/control-plane` as the run authority for planner/verifiers

## Completion
Call `report_case_result` once with probe observations.
