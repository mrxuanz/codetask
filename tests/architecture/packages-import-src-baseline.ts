/**
 * Explicit allowlist of packages/** files that still import @server/@shared/src.
 * New violations fail; removing a path from disk without updating this list also fails.
 * Shrink this list as Batch 7 clears reverse dependencies.
 */
export const PACKAGES_IMPORT_SRC_BASELINE: readonly string[] = []
