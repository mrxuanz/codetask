export type HostEnvironmentSnapshot = Readonly<Record<string, string>>

export interface HostEnvironmentSource {
  snapshot(): HostEnvironmentSnapshot
}

export class ProcessHostEnvironmentSource implements HostEnvironmentSource {
  snapshot(): HostEnvironmentSnapshot {
    const snapshot: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') snapshot[key] = value
    }
    return Object.freeze(snapshot)
  }
}

export const processHostEnvironmentSource: HostEnvironmentSource =
  new ProcessHostEnvironmentSource()

/** Redacted presence of a host auth-related environment key — never the value. */
export interface HostAuthKeyPresence {
  readonly key: string
  readonly present: boolean
}

/**
 * Host auth inspection boundary.
 * Returns only whether controlled materials appear present — never secret values.
 */
export interface HostAuthSource {
  inspectEnvironmentKeys(keys: readonly string[]): readonly HostAuthKeyPresence[]
}

export class ProcessHostAuthSource implements HostAuthSource {
  constructor(private readonly envSource: HostEnvironmentSource = processHostEnvironmentSource) {}

  inspectEnvironmentKeys(keys: readonly string[]): readonly HostAuthKeyPresence[] {
    const snapshot = this.envSource.snapshot()
    return keys.map((key) => ({
      key,
      present: Boolean(snapshot[key]?.trim())
    }))
  }
}

export const processHostAuthSource: HostAuthSource = new ProcessHostAuthSource()
