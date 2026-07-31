/**
 * Process-local product/runtime switches.
 * Configured at bootstrap from AppConfig — never from process.env / host env.
 */

export interface SandboxRuntimeFeatures {
  readonly outerSandboxEnabled: boolean
  readonly supervisorEnabled: boolean
  readonly singleFileAllowlist: boolean
  readonly home: string | null
}

export interface DebugRuntimeFeatures {
  readonly memory: boolean
  readonly sandboxTurn: boolean
  readonly plannerSandbox: boolean
}

export interface RuntimeFeatures {
  readonly sandbox: SandboxRuntimeFeatures
  readonly debug: DebugRuntimeFeatures
}

export const DEFAULT_RUNTIME_FEATURES: RuntimeFeatures = Object.freeze({
  sandbox: Object.freeze({
    outerSandboxEnabled: true,
    supervisorEnabled: true,
    singleFileAllowlist: false,
    home: null
  }),
  debug: Object.freeze({
    memory: false,
    sandboxTurn: true,
    plannerSandbox: true
  })
})

let features: RuntimeFeatures = DEFAULT_RUNTIME_FEATURES

export function configureRuntimeFeatures(
  next: Partial<{
    sandbox: Partial<SandboxRuntimeFeatures>
    debug: Partial<DebugRuntimeFeatures>
  }> = {}
): RuntimeFeatures {
  features = Object.freeze({
    sandbox: Object.freeze({
      ...DEFAULT_RUNTIME_FEATURES.sandbox,
      ...next.sandbox
    }),
    debug: Object.freeze({
      ...DEFAULT_RUNTIME_FEATURES.debug,
      ...next.debug
    })
  })
  return features
}

export function getRuntimeFeatures(): RuntimeFeatures {
  return features
}

export function resetRuntimeFeatures(): void {
  features = DEFAULT_RUNTIME_FEATURES
}
