# Wave 9 cutover runbook

Atomic cutover tooling for the kernel refactor (`重构.md` §15.11). Scripts live
under `scripts/cutover/` and operate on **explicit paths** only.

**Do not run these against live user data unless you are performing a planned
production cutover.** Prefer the fixture rehearsal test first.

## Ordered steps

| # | Step | Command |
| --- | --- | --- |
| 1 | Stop intake | `node scripts/cutover/stop-intake.mjs --data-dir <dataDir>` |
| 2 | Drain / terminate active work | Operator judgment (wait or cancel in-flight jobs) |
| 3 | Backup DB + artifact manifest | `node scripts/cutover/backup.mjs --db <app.db> --artifacts <manifest> --out <backupDir>` |
| 4 | Offline migrate | `node scripts/cutover/migrate.mjs --source <legacy.db> --target <core.db>` |
| 5 | Validate | `node scripts/cutover/validate.mjs --db <core.db>` |
| 6 | Boot new composition root (smoke) | `node scripts/cutover/boot-new.mjs` |
| 7 | Smoke + business E2E | Run package/desktop smoke and `npm run business:e2e` (or CI equivalents) against the new binary + migrated DB |
| 8 | Open intake | `node scripts/cutover/open-intake.mjs --data-dir <dataDir>` |

## Script details

### `stop-intake.mjs`

Writes `<dataDir>/cutover.lock` (JSON). Data dir from `--data-dir` or
`CODETASK_DATA_DIR`.

### `backup.mjs`

Copies `--db` and `--artifacts` into `--out`, writes `backup-manifest.json` with
sha256 for file sources. This backup is the **only** supported rollback payload
for the attempt.

### `migrate.mjs`

Thin wrapper: spawns tsx → `migrateLegacyToCore({ sourcePath, targetPath })`.
Target is replaced if it already exists.

### `validate.mjs`

Opens the core DB read-only and runs `validateCoreDb`. Non-zero exit if orphans
are present.

### `boot-new.mjs`

Imports `createApplication({ mode: 'memory' })` from the composition root and prints
`{ ok: true, ... }`. Does not bind HTTP or open production DBs.

### `soak-core-stub.mjs` (R4 stub — not production soak)

`npm run soak:core:stub` — temp sqlite `createApplication`, ~32 job
create/save/get cycles, loose `heapUsed` / DB size asserts. Documents that
§17.4 flood/OOM and 100-workflow rows remain unchecked.

### `open-intake.mjs`

Removes `<dataDir>/cutover.lock`.

## Rollback

See [`rollback.md`](./rollback.md): restore old binary + pre-migration backup;
never reverse-write old schema from new.

## Fixture rehearsal

```bash
node --import ./tests/tsx-tsconfig.mjs --import tsx --test tests/core/cutover/rehearsal.test.ts
```

The test runs stop → backup → migrate (empty + tiny fixture) → validate →
boot smoke → open on temp dirs, then archives a sample report under
`docs/refactor/fixtures/cutover/rehearsal-report.md`.

## Wave 10 / Phase D — gated legacy delete

Import-gate needles are **0/0/0**. Narrow purge removed obsolete `http/v3` and
the old V3-authority flip CLI. Live control-plane code was **relocated** to
`src/server/control-plane` (not deleted); compatibility mappers and
`cutover-state` remain.

```bash
# Expect exit 0 — gate clear
node scripts/cutover/delete-legacy.mjs
node scripts/cutover/delete-legacy.mjs --json
node --import ./tests/tsx-tsconfig.mjs --import tsx --test \
  tests/core/cutover/delete-legacy-gate.test.ts
```

See `docs/refactor/legacy-import-graph.md` and `docs/refactor/gates/wave10.md`.

## Gate

See `docs/refactor/gates/wave9.md` (cutover rehearsal) and
`docs/refactor/gates/wave10.md` (gated delete + governance).
