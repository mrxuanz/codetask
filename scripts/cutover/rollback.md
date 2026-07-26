# Wave 9 rollback runbook

Rollback is a **deployment-level** operation. Restore the previous binary and the
**pre-migration** database / artifact backup. Do **not** reverse-write the old
schema from the new `core_*` database.

## When to roll back

- Data validator fails after offline migration
- New composition root fails smoke / business E2E
- Unexpected production behavior after opening intake

## Procedure

1. **Keep intake closed** (leave `cutover.lock` in place or re-run
   `stop-intake.mjs`).
2. **Stop the new process** if it was started.
3. **Restore pre-migration backup**:
   - Replace the live DB file with the copy under the backup directory produced
     by `backup.mjs` (taken *before* `migrate.mjs`).
   - Restore the artifact manifest (and any blob tree operators mirrored) from
     the same backup directory.
4. **Deploy the previous (old) binary / package** that understands the legacy
   schema.
5. **Do not** attempt to export `core_*` rows back into legacy tables.
6. **Open intake** only after the old binary is healthy:
   `node scripts/cutover/open-intake.mjs --data-dir <path>`.

## Hard rules

| Allowed | Forbidden |
| --- | --- |
| Restore pre-migration SQLite + artifact manifest | Reverse-migrate new schema → old schema |
| Redeploy old binary | Dual-write / online schema rewrite |
| Re-run cutover later from a fresh backup | Mutating the failed post-migration DB in place as “rollback” |

## Notes

- The backup taken by `scripts/cutover/backup.mjs` is the rollback source of
  truth for that cutover attempt.
- If migration partially wrote a target file, discard the target and keep the
  untouched source + backup.
- Fixture rehearsal (`tests/core/cutover/rehearsal.test.ts`) must never use
  real user data directories.
