/**
 * INTENTIONAL IMPORT-BOUNDARY VIOLATION FIXTURE
 *
 * Proves `core/domain` must not import `adapters` (重构.md §13.4).
 * Not under production scan roots — exercised via:
 *   node scripts/check-import-boundary.mjs --self-test
 *
 * Uses @server alias so the same text is a valid domain→adapters hop
 * when copied under src/server/core/domain/ for the self-test.
 */
import type { SystemClock } from '@server/adapters/clock/system-clock'

export type FixtureProbe = typeof SystemClock
