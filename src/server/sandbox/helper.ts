import { loadSandboxNative } from './native'
import type { CodeteamSandboxNative } from './types'

export function loadSandboxAddon(): CodeteamSandboxNative {
  return loadSandboxNative()
}

export function helperProtocolVersion(): 1 {
  return 1
}
