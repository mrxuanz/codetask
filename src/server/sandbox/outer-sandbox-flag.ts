import { getRuntimeFeatures } from '../config/runtime-features'
import { getRuntimeMode } from '../runtime-mode'

export function isOuterSandboxEnabled(): boolean {
  const mode = getRuntimeMode()
  // Server mode always keeps outer sandbox on — desktop may disable via AppConfig.
  if (mode === 'server') {
    return true
  }
  return getRuntimeFeatures().sandbox.outerSandboxEnabled
}
