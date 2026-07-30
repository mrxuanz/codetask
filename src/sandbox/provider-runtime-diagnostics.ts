/**
 * Stable production-build surface for Provider sandbox diagnostics.
 *
 * Keeping this as an explicit Rollup entry lets diagnostics exercise the code
 * that was actually bundled, without guessing private chunk names or relying
 * on tree-shaken implementation exports.
 */
export { prepareProviderRuntimeProfile } from '../server/sandbox/provider-auth'
export { buildSandboxEnv } from '../server/sandbox/env'
export { createSandboxPolicy } from '../server/sandbox/policy'
export { buildCursorAcpCliArgs } from '../server/providers/cursor/turn-plan'
