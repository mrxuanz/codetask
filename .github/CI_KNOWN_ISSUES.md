# CI known business-code issues

CI maintenance must not modify business/runtime code without an explicit user
decision. Findings are recorded here so temporary CI allowances stay visible and
reviewable.

## Status fields

Each BUSINESS entry should include:

- **Status:** `open` | `in_progress` | `resolved` | `wontfix`
- **Target phase:** remediation phase from
  `docs/OPEN_SOURCE_REMEDIATION_PLAN.zh-CN.md` (for example Phase 2 hygiene,
  Phase 5 shared contracts, Phase 6 control plane)
- **Exit criteria:** concrete condition that allows removing the CI allowance or
  closing the finding

## BUSINESS-001: `threadRow` triggers `prefer-const`

- Status: resolved
- Target phase: Phase 2 (engineering hygiene)
- Exit criteria: source uses `const`; ESLint baseline no longer admits this
  file/rule/message/source-line signature.
- Location: `src/server/conversation/service.ts:152`
- Finding: `threadRow` is declared with `let` but is never reassigned.
- Impact: style-only ESLint error; no runtime behavior change is known.
- CI handling: previously admitted by `scripts/ci/check-eslint-baseline.mjs`;
  allowance removed after the source fix in this remediation batch.
- Decision needed: none (resolved by changing `let` to `const`).

## BUSINESS-002: legacy Cursor provider aliases bypass normalization

- Status: resolved (2026-08-04)
- Target phase: Phase 5 (shared contracts and data migration)
- Exit criteria: met. Persisted aliases are normalized to canonical `cursor`
  before capability checks and migration 061 rewrites legacy rows.
- Locations: `src/shared/providers/codes.ts`,
  `packages/agent-runtime/src/index.ts`, and migration 061.
- Resolution: the canonical provider set is `codex | claude | opencode |
cursor`; `cursorcli`, `cursor-cli`, and `cursor-agent` are accepted only by
  boundary normalizers. Regression tests assert canonical settings and registry
  values.
- CI handling: no allowance.
- Decision needed: none.

## Warning baseline

The clean baseline is 0 ESLint errors and 0 warnings. CI fails on any warning or
error; generated runtime data remains excluded explicitly.

## BUSINESS-003: control-plane exact optional property diagnostics

- Status: resolved (2026-08-04)
- Target phase: Phase 6 (control plane convergence)
- Exit criteria: met. The normal Node and Web TypeScript projects compile with
  no diagnostics.
- Resolution: affected optional-property call sites/types were corrected. The
  orphan baseline script was removed because it referenced the already-deleted
  `tsconfig.control-plane.json` and was not called by package scripts or CI.
- CI handling: `npm run typecheck` is the sole, zero-baseline TypeScript gate.
- Decision needed: none.

## BUSINESS-011: `delete-user-draft.test.ts` hangs under `node --test`

- Status: resolved (test fixture)
- Target phase: CI / conversation test hygiene (observed during PRU Batch 13)
- Exit criteria: `tests/conversation/delete-user-draft.test.ts` completes under
  `npm run test:unit` / `test:fast` without force-kill.
- Locations: `tests/conversation/delete-user-draft.test.ts`
- Finding: the “independently published task” case seeded a linked task Job as
  `running`. Deleting the published design session runs
  `advanceExecutionQueue`, which contended with the still-running Job and never
  returned under `node --test` (often accompanied by tight `preflightSandbox`
  / FS scan activity when sandbox debug is enabled).
- Fix: seed the independent task Job as a terminal status (`completed`) so the
  deletion path does not try to resume an in-flight run. Test intent
  (draft aggregate removed; independent task retained) is unchanged.
- CI handling: none; regression covered by the fixed unit test.

## BUSINESS-012: OpenCode external reference read roots

- Status: resolved (2026-08-02)
- Target phase: Provider runtime / sandbox permission integration
- Resolution: preserve `AgentTurnInput.readRoots` through the runner and sandbox
  role-worker boundary, then project each normalized root into OpenCode's config
  and session permission rules as an exact `<root>/**` read allowance. The
  default external-directory rule remains deny, writable profiles explicitly
  deny edits to those external roots, and the outer CodeTask sandbox remains the
  authoritative filesystem boundary.
- Locations: `src/server/agent-runtime/types.ts`,
  `src/server/agent-runtime/runner.ts`,
  `src/server/sandbox/orchestrator-local.ts`, and
  `src/server/agent-runtime/providers/opencode-config.ts`.
- Validation: real OpenCode runs passed `chat-image-attachment`
  (`20260801-144525Z-0edc522a`), `draft-chat-image-attachment`
  (`20260801-144547Z-1e2b8fd1`), and the full image + external local-corpus
  Planner/Job path (`20260801-160208Z-76669d5d`). Fixtures stayed outside the
  project workspace and expected OCR/reference content was not injected into
  prompts.
- CI handling: none; strict runtime, permission, and business-oracle regression
  tests cover the repaired path.
- Decision needed: none.

## BUSINESS-004: macOS Seatbelt tests no longer compile

- Status: resolved (2026-08-04)
- Target phase: Phase 7 (open-source release gate / native platform matrix)
- Exit criteria: met. `cargo test --manifest-path native/Cargo.toml` passes on
  macOS, and CI/release packaging now execute the macOS-native test path.
- Locations: `native/codeteam-sandboxing/src/seatbelt_tests.rs`,
  `.github/workflows/ci.yml`, and `.github/workflows/build.yml`
- Resolution: the test now exercises the active disabled managed-proxy stub
  instead of importing the unreachable full proxy runtime API. Metadata
  carveout assertions verify protected paths and behavior rather than relying
  on incidental `-D...EXCLUDED_n` ordering. The `dot_codex_canonical` variable
  that actually pointed to `.codeteam` was renamed.
- Validation: the sandboxing crate passes 63/63 tests, and the full native
  workspace passes on macOS with serialized execution.
- CI handling: a `macos-15` Rust job runs on pushes/PRs; both macOS release
  targets run the native workspace before packaging.
- Decision needed: none.

## BUSINESS-005: inherited-fd PTY tests fail on macOS

- Status: resolved (2026-08-04)
- Target phase: Phase 7 (open-source release gate / native platform matrix)
- Exit criteria: met. Both cases pass without skipping or changing the fd
  preservation implementation.
- Locations: `native/codeteam-utils-pty/src/tests.rs:820` and `:1058`
- Finding: fd inheritance worked, but macOS `/bin/sh` rejected reopening the
  already-inherited descriptor through `/dev/fd/<n>`. That tested a filesystem
  alias, not the promised exec inheritance contract.
- Resolution: the child shell now writes through direct descriptor duplication
  (`>&"$PRESERVED_FD"`). The PTY and pipe paths still have to preserve the fd
  across exec for the assertions to pass.
- Validation: `codeteam-utils-pty` passes 16/16 tests and the full native
  workspace passes on macOS.
- CI handling: covered by the macOS CI and release-native jobs added with
  BUSINESS-004.
- Decision needed: none.

## BUSINESS-006: production bundle has circular chunk ordering risk

- Status: resolved (2026-08-04)
- Target phase: Phase 3 (unreachable / packaging hygiene) or Phase 6
- Exit criteria: met. The legacy control-plane module was removed and the
  production build no longer emits a circular chunk ordering warning.
- Validation: `npm run build` completes. Rollup still reports non-fatal mixed
  static/dynamic-import optimization notices for `bootstrap.ts` and the Web
  Design client; these no longer describe a broken execution-order cycle.
- CI handling: package smoke and all release builds execute the production
  build, so unresolved entries and renderer parse errors fail the workflow.
- Decision needed: none for correctness; remaining chunk optimization is a
  release-polish item.

## BUSINESS-007: native test target has an unused import

- Status: resolved (2026-08-04)
- Target phase: Phase 2 (engineering hygiene / native)
- Exit criteria: met; the import is compiled only on Windows where it is used.
- Location: `native/codeteam-sandbox/src/attestation.rs:179`
- Resolution: added `#[cfg(windows)]` to the test-only `Path` import.
- Validation: `cargo check --manifest-path native/Cargo.toml --release` passes.
- CI handling: none; Rust warnings remain visible and are not globally allowed
  or suppressed.
- Decision needed: none.

## BUSINESS-008: Rust cache cannot parse several native manifests

- Status: open
- Target phase: Phase 1 (dev environment / packaging) or Phase 7
- Exit criteria: `Swatinem/rust-cache` parses all `native/*/Cargo.toml` without
  BOM-related fallback annotations.
- Locations: multiple `native/*/Cargo.toml` manifests
- Finding: `Swatinem/rust-cache` reports TOML parse errors and falls back to
  caching each entire manifest file. Several manifests contain a leading UTF-8
  byte-order mark, which is a likely cause of the parser mismatch.
- Impact: Rust tests and builds succeed, but cache invalidation is broader and
  the jobs emit repeated annotations.
- CI handling: none; cache fallback remains enabled and visible.
- Decision needed: normalize the manifest encodings when native build files are
  in scope, then verify the cache parser warnings disappear.

## BUSINESS-009: Linux sandbox integration tests use contention-sensitive timeouts

- Status: open
- Target phase: Phase 7 (open-source release gate / native platform matrix)
- Exit criteria: flaky contention failures identified from authenticated logs and
  fixed via platform-aware timeouts or explicit serialization; suite is stable
  on CI.
- Location: `native/codeteam-linux-sandbox/tests/suite/landlock.rs:20-34`
- Finding: the Linux sandbox integration suite launches many Bubblewrap and
  network subprocesses in parallel with 5-second command timeouts. Source
  comments already note CI timeouts, and the nominal ARM64 timeout values are
  currently identical to the non-ARM64 values despite the adjacent note that
  ARM64 needs longer timeouts. CI run 25 failed the unchanged Rust suite after
  run 24 passed it, so runner contention is the leading explanation; the public
  unauthenticated Actions view does not expose the individual failing test log.
- Impact: the full native workspace test can fail nondeterministically without a
  Rust source change.
- CI handling: Rust workspace tests run serially and with `--no-fail-fast` so
  every test still executes while avoiding subprocess contention and retaining
  complete failure diagnostics. No test is skipped or baselined.
- Decision needed: use a future authenticated failure log to identify the exact
  test, then choose platform-aware per-test timeouts or explicit test-level
  serialization in native test code.

## BUSINESS-010: Codex internal HTTP MCP can disappear without failing the turn

- Status: resolved
- Target phase: Phase 4 / runtime hardening (already landed)
- Exit criteria: required internal MCP startup failures surface as
  `plan.mcp_unavailable` / `conversation.mcp_unavailable`; live Codex probe uses
  production NO_PROXY loopback exclusions.
- Locations: `src/server/agent-runtime/mcp.ts`,
  `src/server/agent-runtime/env.ts`,
  `src/server/providers/codex/turn-plan.ts`, and
  `src/server/agent-runtime/providers/codex-sdk.ts`
- Finding: live Codex probes for both the read-only Planner role and the
  full-access task-worker role completed without making any request to the
  configured loopback Streamable HTTP MCP server. A direct CLI diagnostic
  reported HTTP 502 during MCP initialization, while the Codex process still
  exited successfully. Adding `127.0.0.1,localhost,::1` to both `NO_PROXY` and
  `no_proxy` made initialize, tools/list, and tools/call succeed. The internal
  `codeteam-manager` MCP entry was not marked `required`, so the original startup
  failure is not surfaced before the model turn.
- Impact: Planner has no `register_plan_outline`, `register_task_context`, or
  `finalize_plan` tools and the job is later misclassified as
  `draft.plan_not_ready` instead of an MCP/provider infrastructure failure.
- CI handling: business E2E now verifies that the persisted thread core matches
  the selected provider, but no runtime failure is baselined or hidden.
- Resolution: the Codex child environment now merges the loopback exclusions
  into both proxy-variable casings whenever the internal MCP URL is configured;
  the internal MCP entry is required; and required-MCP startup failures map to
  `plan.mcp_unavailable` or `conversation.mcp_unavailable` before the role is
  treated as healthy. The live Codex probe consumes these production settings
  directly so a regression cannot be masked by diagnostic-only overrides.

## BUSINESS-013: business-e2e draft-job G4–G8 Fake/OpenCode rewrite onto Design

- Status: resolved (2026-08-02)
- Target phase: Architecture 03 follow-up
- Exit criteria: create_task-era G4–G8 / DRAFT-\* / JOB-CHAT-RO cases removed from
  catalog; draft-job defaults to Design smoke; no ARCH03 skip stubs remain.
- Resolution: permanently deleted retired create_task catalog entries and Fake/
  OpenCode stubs. Friendly CLI aliases (`notes-search`, `draft-multiturn`, …)
  resolve to `DESIGN-DRAFT-001`. Draft-job depth beyond Design smoke is covered by
  `tests/design` + `tests/execution` unit gates, not legacy e2e case IDs.
- Locations: `tests/business-e2e/cases/catalog.ts`,
  `tests/business-e2e/cases/selection.ts`, `tests/business-e2e/drivers/*`
- CI handling: `--part draft-job` / `--case design-draft`; prefer design/execution
  unit tests for merge gates.
- Decision needed: none.
