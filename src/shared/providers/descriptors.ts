import { SUPPORTED_CORE_CODES, type SupportedCoreCode } from './codes'
import type { ProviderDescriptor } from './descriptor'
import { CLAUDE_DESCRIPTOR } from './descriptors/claude'
import { CODEX_DESCRIPTOR } from './descriptors/codex'
import { CURSOR_DESCRIPTOR } from './descriptors/cursor'
import { OPENCODE_DESCRIPTOR } from './descriptors/opencode'

const DESCRIPTORS: Readonly<Record<SupportedCoreCode, ProviderDescriptor>> = Object.freeze({
  codex: CODEX_DESCRIPTOR,
  'claude-code': CLAUDE_DESCRIPTOR,
  opencode: OPENCODE_DESCRIPTOR,
  cursorcli: CURSOR_DESCRIPTOR
})

export function getProviderDescriptor(code: SupportedCoreCode): ProviderDescriptor {
  return DESCRIPTORS[code]
}

export function listProviderDescriptors(): readonly ProviderDescriptor[] {
  return SUPPORTED_CORE_CODES.map((code) => DESCRIPTORS[code])
}

export function getProviderDescriptors(): Readonly<Record<SupportedCoreCode, ProviderDescriptor>> {
  return DESCRIPTORS
}
