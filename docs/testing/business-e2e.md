# Business end-to-end tests

The black-box harness starts a fresh headless Service and drives it through the public HTTP API and
Test MCP. Every run uses a unique OS temporary directory and removes it after reporting.

## Acceptance layers

1. `conversation` covers bootstrap, setup/login, normal chat, HTML output, and image attachments.
2. `draft-job` covers requirements clarification and the Design draft confirmation flow.
3. `settings-mcp` verifies Provider-specific MCP settings, reserved names, and a live probe call.

## Providers and phases

Use `--providers codex|claude|opencode|cursor|all` to select Provider slots. `--part` selects one or
more layers; `--suite` selects a named matrix. The root `business:e2e:*` scripts are convenient
aliases, while the parameterized command is the canonical interface:

```bash
npm run build:server
npm run business:e2e -- --providers opencode --part conversation,draft-job,settings-mcp
```

The Settings Probe is a user-configured MCP server under test. It is distinct from Test MCP, which
is the outer driver used to control and observe a case. Phase 3 snapshots settings, registers the
probe for conversation/task/verification, verifies the round trip and probe output, then restores
the snapshot.

For the current case catalog, evidence rules, and troubleshooting commands, see the
[Business E2E README](../../tests/business-e2e/README.md).
