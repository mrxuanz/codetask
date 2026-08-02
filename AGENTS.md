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

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->
