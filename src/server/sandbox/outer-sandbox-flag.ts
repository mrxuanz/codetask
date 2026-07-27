export function isOuterSandboxEnabled(): boolean {
  // Security hard constraint: neither Settings, CLI nor host environment may
  // weaken the outer sandbox for a file-capable role.
  return true
}
