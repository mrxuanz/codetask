# ADR 0001: Host auth, Provider resolution, Control Plane authority

- Status: Accepted
- Date: 2026-07-23
- Related: [OPEN_SOURCE_REMEDIATION_PLAN.zh-CN.md](../OPEN_SOURCE_REMEDIATION_PLAN.zh-CN.md)

## Context

CodeTask orchestrates multiple agent CLIs. Contributors need a single place that
records product boundaries that must not drift between PRs.

## Decision

### 1. Host authentication is the only credential source

- CodeTask uses each CLI’s existing host login state and environment variables.
- CodeTask does not store, copy, switch, or sync OAuth tokens or API keys for
  Codex, Claude Code, Cursor CLI, or OpenCode.
- CodeTask does not create “work account” / “personal account” auth profiles.
- Provider preflight only checks whether host auth appears available and how to
  repair it; it does not replace CLI login.

### 2. Provider resolution has one shared direction

- Command candidates, availability detection, and real launch must share one
  resolution path for executable discovery.
- Custom path priority: explicit `AppConfig.providers` / startup overrides >
  PATH / install-dir candidates (no compatibility env config channel).
- Provider-specific launch adapters may remain separate files; the candidate
  tables and `resolveProviderExecutable` results must not diverge.

### 3. Legacy remains the production authority for now

- Until V3 meets release gates, Legacy is the only production control plane.
- V3 may continue behind explicit experimental boundaries and tests.
- Do not cast Legacy DTOs into V3 DTOs to fake unification.
- Enabling `v3_authoritative` and deleting Legacy are separate, gated stages.

## Consequences

- Auth-related PRs must not introduce credential storage or multi-account
  switching.
- Provider refactors must prove detect and launch use the same resolved
  executable.
- Control Plane PRs must keep Legacy write guards and release gates intact
  until cutover is approved.
