# settings-mcp-probe

## Role
Phase 3: register harness probe MCP into **Settings** for conversation / task / verification (same public API as the Settings UI).

## Not Test MCP
Outer Test MCP only drives `GET/PUT /api/settings/mcp` and `report_case_result`.  
The probe server `business-e2e-probe` is the **user Settings MCP** under test.

## Goal (first cut — required)
1. `codetask_get_mcp_settings` — snapshot.
2. `codetask_put_mcp_settings` — write `business-e2e-probe` for all three roles × active core.
3. Get again — JSON must contain `business-e2e-probe` (round-trip).
4. Attempt reserved name `codeteam-manager` — must fail.
5. Harness may self-call probe `ping_*` and expect:
   - `PROBE_OK_CONVERSATION`
   - `PROBE_OK_TASK`
   - `PROBE_OK_VERIFICATION`
6. Restore prior settings.
7. `report_case_result` with observations (`probeUrl`, `probeHits`, `reservedRejected`).

## Deepen (later — required to claim role-path success)
Start conversation / task / verification turns so the **SUT** invokes the probe; assert probe `calls[]` and assistant/tool observations contain `PROBE_OK_*`.  
Do **not** count Test MCP traffic as “user MCP used by role”.

## Allowed tools
- codetask_get_mcp_settings
- codetask_put_mcp_settings
- case_checkpoint
- report_case_result

## Checkpoints
- mcp_settings_snapshot
- mcp_probe_registered
- mcp_probe_self_ok

## See also
[`docs/business-testing/04-脚本使用与三语言架构.md`](../../../../docs/business-testing/04-脚本使用与三语言架构.md) §3.
