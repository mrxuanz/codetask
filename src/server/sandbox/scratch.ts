import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Ephemeral OS-temp scratch for outer-sandbox attestation / worker IPC only.
 * Not CodeTask product storage — SDK/ACP durable data stays on host defaults.
 */
export function createSandboxScratchDir(label = 'turn'): string {
  return mkdtempSync(join(tmpdir(), `codetask-sandbox-${label}-`))
}

export function removeSandboxScratchDir(scratchRoot: string | undefined): void {
  if (!scratchRoot?.trim()) return
  try {
    rmSync(scratchRoot, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup; OS tmp reclaim handles leftovers.
  }
}
