# CI known business-code issues

CI maintenance must not modify business/runtime code without an explicit user
decision. Findings are recorded here so temporary CI allowances stay visible and
reviewable.

## BUSINESS-001: `threadRow` triggers `prefer-const`

- Location: `src/server/conversation/service.ts:152`
- Finding: `threadRow` is declared with `let` but is never reassigned.
- Impact: style-only ESLint error; no runtime behavior change is known.
- CI handling: `scripts/ci/check-eslint-baseline.mjs` admits only this exact
  error. The baseline fails if the error changes, disappears without cleanup, or
  another ESLint error is introduced.
- Decision needed: change business code to `const`, or retain the explicit
  baseline.

## BUSINESS-002: legacy Cursor core aliases bypass normalization

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

After excluding generated runtime data and the tracked temporary query helper,
the clean baseline contains 459 non-blocking ESLint warnings. CI permits the
count to decrease but fails if it grows above that baseline.

## BUSINESS-003: control-plane exact optional property diagnostics

- Locations:
  - `src/server/agent-runtime/cursor-acp/acp-shared.ts:206` (`TS2375`)
  - `src/server/agent-runtime/providers/claude-sdk.ts:36` (`TS2379`)
  - `src/server/agent-runtime/providers/codex-policy.ts:57` (`TS2379`)
  - `src/server/agent-runtime/providers/cursor-policy.ts:41` (`TS2379`)
  - `src/server/agent-runtime/providers/opencode-sdk.ts:58` and `:390` (`TS2379`)
  - `src/server/agent-runtime/runner.ts:252` (`TS2379`)
  - `src/server/conversation/service.ts:372` (`TS2379`)
- Finding: optional values are passed as explicit `undefined` while
  `exactOptionalPropertyTypes` requires omission or an explicitly widened type.
- Impact: the stricter control-plane TypeScript project does not compile cleanly.
- CI handling: `scripts/ci/check-control-plane-typecheck-baseline.mjs` permits
  only these exact file/line/error-code tuples. New diagnostics and stale
  allowances fail CI.
- Decision needed: choose whether callers should omit undefined properties or
  the receiving types should explicitly admit `undefined`.

## BUSINESS-004: macOS Seatbelt tests no longer compile

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

- Location: `native/codeteam-sandbox/src/attestation.rs:179`
- Finding: the test module imports `std::path::Path` without using it.
- Impact: Linux-target and macOS native test compilation emits an
  `unused_imports` warning.
- CI handling: none; Rust warnings remain visible and are not globally allowed
  or suppressed.
- Decision needed: remove or use the import when native business code is in
  scope.

## BUSINESS-008: Rust cache cannot parse several native manifests

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
