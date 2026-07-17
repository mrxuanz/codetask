export function isOuterSandboxEnabled(): boolean {
  if (
    process.env.CODETASK_MODE === 'server' &&
    process.env.CODETASK_DISABLE_OUTER_SANDBOX === '1'
  ) {
    console.warn(
      '[sandbox] CODETASK_DISABLE_OUTER_SANDBOX is ignored in server mode; outer sandbox stays enabled'
    )
  }
  if (process.env.CODETASK_MODE === 'server') {
    return true
  }
  return process.env.CODETASK_DISABLE_OUTER_SANDBOX !== '1'
}
