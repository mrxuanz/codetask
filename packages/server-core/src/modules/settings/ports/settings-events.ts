import type { SettingsChangedEvent } from '@codetask/contracts'

export interface SettingsEventsPort {
  publish(event: SettingsChangedEvent): void | Promise<void>
}
