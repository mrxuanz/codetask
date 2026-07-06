import { getAppContext } from '../bootstrap'
import { SandboxError } from './types'

export function resolveSandboxDataDir(): string {
  const fromEnv = process.env.CODETASK_DATA_DIR?.trim()
  if (fromEnv) return fromEnv
  try {
    return getAppContext().dataDir
  } catch {
    throw new SandboxError(
      'CODETASK_DATA_DIR is not configured',
      'sandbox.bootstrap.data_dir_missing'
    )
  }
}
