# Repository agent instructions

## CI maintenance boundary

- By default, CI maintenance may change `.github/**`, `tests/**`, `scripts/**`, and
  narrow non-runtime tooling configuration required by those paths (for example,
  CI-only `package.json` scripts or lint configuration).
- Do not modify business or runtime implementation under `src/**` or `native/**`
  unless the user explicitly lifts this restriction for a specific task.
- When CI exposes a business-code issue, record it in
  `.github/CI_KNOWN_ISSUES.md`; do not silently repair or rewrite business code.
- CI workflows and test/tooling scripts may be refactored when their behavior is
  misleading, brittle, duplicated, or no longer matches canonical contracts.
- Keep CI meaningful: known-issue baselines must be explicit, narrow, and fail
  on new regressions or stale allowances.
- Before handing off a CI-only change, verify the changed-file list stays within
  this boundary and report any business-code findings separately.
