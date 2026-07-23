import type { SupportedCoreCode } from '../../shared/providers/codes'
import { SUPPORTED_CORE_CODES } from '../../shared/providers/codes'
import type { ProviderDescriptor } from '../../shared/providers/descriptor'
import type { ProviderDriver } from './driver'

export class ProviderRegistry {
  private readonly drivers: ReadonlyMap<SupportedCoreCode, ProviderDriver>

  constructor(drivers: readonly ProviderDriver[]) {
    const entries = new Map<SupportedCoreCode, ProviderDriver>()
    for (const driver of drivers) {
      const code = driver.descriptor.code
      if (entries.has(code)) throw new Error(`Duplicate ProviderDriver registration: ${code}`)
      entries.set(code, driver)
    }
    const missing = SUPPORTED_CORE_CODES.filter((code) => !entries.has(code))
    if (missing.length > 0) {
      throw new Error(`Missing ProviderDriver registrations: ${missing.join(', ')}`)
    }
    this.drivers = entries
  }

  get(code: SupportedCoreCode): ProviderDriver {
    const driver = this.drivers.get(code)
    if (!driver) throw new Error(`Unknown ProviderDriver: ${code}`)
    return driver
  }

  has(code: SupportedCoreCode): boolean {
    return this.drivers.has(code)
  }

  list(): readonly ProviderDriver[] {
    return SUPPORTED_CORE_CODES.map((code) => this.get(code))
  }

  descriptors(): readonly ProviderDescriptor[] {
    return this.list().map((driver) => driver.descriptor)
  }

  withOverrides(overrides: readonly ProviderDriver[]): ProviderRegistry {
    const byCode = new Map(this.list().map((driver) => [driver.descriptor.code, driver]))
    for (const driver of overrides) byCode.set(driver.descriptor.code, driver)
    return new ProviderRegistry([...byCode.values()])
  }
}
