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

## BUSINESS-002: legacy Cursor core aliases bypass normalization

- Status: open
- Target phase: Phase 5 (shared contracts and data migration)
- Exit criteria: persisted legacy aliases are normalized at the system boundary
  before capability checks; regression tests cover historical `cursor` rows.
- Locations: `src/server/conversation/service.ts:198` and
  `src/server/conversation/cores.ts:45`
- Finding: the capability check casts the persisted `thread.coreCode` directly,
  while the canonical normalizer maps historical `cursor` aliases to
  `cursorcli`.
- Impact: historical rows containing `cursor` may be rejected for read-only chat
  with `provider.capability_unsupported`.
- CI handling: tests now use the canonical `cursorcli` fixture so the workspace
  lease test exercises its intended behavior instead of an unrelated stale
  alias.
- Decision needed: confirm whether persisted legacy aliases must remain
  supported and, if so, choose a business-code normalization/migration strategy.

## Warning baseline

After excluding generated runtime data, the clean baseline contains 459
non-blocking ESLint warnings. CI permits the count to decrease but fails if it
grows above that baseline.

## BUSINESS-003: control-plane exact optional property diagnostics

- Status: open (narrowed during Provider Runtime Unification)
- Target phase: Phase 6 (control plane convergence)
- Exit criteria: control-plane typecheck baseline is empty; callers omit
  undefined optional properties or types explicitly admit `undefined`.
- Locations (remaining):
  - `src/server/agent-runtime/cursor-acp/acp-shared.ts` (`TS2375`)
  - `src/server/agent-runtime/runner.ts` (`TS2379`)
  - `src/server/conversation/service.ts` (`TS2379`)
- Resolved during PRU:
  - `resolveInputCapabilityProfile` now admits `capabilityProfile?: … | undefined`,
    clearing former Claude/Codex/Cursor/OpenCode turn-plan call sites (including
    deleted `cursor-policy.ts`).
  - Provider launch/preflight optionals widened similarly where required.
- Finding: optional values are passed as explicit `undefined` while
  `exactOptionalPropertyTypes` requires omission or an explicitly widened type.
- Impact: the stricter control-plane TypeScript project does not compile cleanly.
- CI handling: `scripts/ci/check-control-plane-typecheck-baseline.mjs` permits
  only these file/error-code/source-line signatures at their exact occurrence
  counts. New diagnostics and stale allowances fail CI, while unrelated line
  movement does not invalidate the baseline.
- Decision needed: choose whether callers should omit undefined properties or
  the receiving types should explicitly admit `undefined`.

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

## BUSINESS-004: macOS Seatbelt tests no longer compile

- Status: open
- Target phase: Phase 7 (open-source release gate / native platform matrix)
- Exit criteria: `cargo test --manifest-path native/Cargo.toml` compiles and
  passes Seatbelt tests on macOS CI or a documented macOS job.
- Locations: `native/codeteam-sandboxing/src/seatbelt_tests.rs:14`, `:84`, and
  `:609`; `native/codeteam-network-proxy/src/lib.rs:43`
- Finding: the macOS-only tests import the public `ConfigReloader` struct as if
  it were the runtime trait, and their package does not declare the
  `async-trait` or `tokio` test dependencies used by the file.
- Impact: `cargo test --manifest-path native/Cargo.toml` fails to compile on
  macOS. The current GitHub Rust jobs run on Ubuntu, where the Seatbelt module is
  excluded by `cfg(target_os = "macos")`.
- CI handling: none. The Ubuntu workspace test remains intact; no package or
  test is excluded to hide the platform-specific failure.
- Decision needed: reconcile the stub/runtime network-proxy API and restore the
  macOS test dependencies when native business code is next in scope.

## BUSINESS-005: inherited-fd PTY tests fail on macOS

- Status: open
- Target phase: Phase 7 (open-source release gate / native platform matrix)
- Exit criteria: the two inherited-fd PTY cases pass on a clean macOS runner
  without skipping or weakening the Ubuntu native suite.
- Locations: `native/codeteam-utils-pty/src/tests.rs:820` and `:1058`
- Finding: the PTY and pipe children both exit with status 1 when the tests ask
  `/bin/sh` to write through a preserved `/dev/fd/<n>` descriptor.
- Impact: after excluding only the separately documented Seatbelt compile
  failure, the macOS workspace test still fails these two cases; the other 100+
  native tests reached in that run pass or are ignored as declared.
- CI handling: none. The GitHub jobs run the complete native workspace on
  Ubuntu, and the CI workflow does not weaken or skip these tests.
- Decision needed: reproduce on a clean macOS runner and decide whether the
  descriptor-preservation implementation or the cross-platform test command
  needs adjustment.

## BUSINESS-006: production bundle has circular chunk ordering risk

- Status: open
- Target phase: Phase 3 (unreachable / packaging hygiene) or Phase 6
- Exit criteria: production build no longer warns about circular chunk ordering
  for the retention/legacy-control-plane cycle; mixed static/dynamic import
  boundaries reviewed.
- Locations: `src/server/retention/lifecycle.ts`,
  `src/server/retention/index.ts`, and
  `src/server/legacy-control-plane/repository.ts`
- Finding: Rollup reports that `onJobStatusTransition` is re-exported through a
  module cycle while the modules are placed in different chunks. The build also
  reports several server modules that are both statically and dynamically
  imported, so those dynamic imports do not create separate chunks.
- Impact: the build succeeds, but Rollup warns that the circular chunk graph can
  produce a broken execution order.
- CI handling: none; this is kept visible here instead of changing business
  imports or hiding bundler warnings.
- Decision needed: import the retention symbol directly or deliberately group
  the cycle in one chunk, then review the mixed static/dynamic import boundaries.

## BUSINESS-007: native test target has an unused import

- Status: open
- Target phase: Phase 2 (engineering hygiene / native)
- Exit criteria: unused import removed or used; Linux/macOS native test compile
  no longer emits `unused_imports` for this site.
- Location: `native/codeteam-sandbox/src/attestation.rs:179`
- Finding: the test module imports `std::path::Path` without using it.
- Impact: Linux-target and macOS native test compilation emits an
  `unused_imports` warning.
- CI handling: none; Rust warnings remain visible and are not globally allowed
  or suppressed.
- Decision needed: remove or use the import when native business code is in
  scope.

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
