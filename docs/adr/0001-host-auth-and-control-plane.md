# ADR 0001: Host auth, Provider resolution, Control Plane authority

- Status: Partially superseded by the 2026-07-26 scope reset
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
- A sandbox turn may materialize a short-lived, filtered credential snapshot
  under that turn's private runtime root. It is not product settings, is never
  written to the application database or logs, and is deleted by the sandbox
  credential manifest lifecycle.
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

### 3. No business control plane exists in the reset baseline

- Legacy, V3 and experimental business control planes were deleted from the
  reset branch.
- The production HTTP surface contains initialization, authentication, health
  and sandbox health only.
- Future Thread/Plan/Job/Task functionality requires a new authority decision
  and implementation; deleted Legacy code must not be restored as a shortcut.

## Consequences

- Auth-related PRs must not introduce credential storage or multi-account
  switching.
- Provider refactors must prove detect and launch use the same resolved
  executable.
- Future business-control-plane PRs must define their authority and release
  gates before exposing routes or creating tables.
