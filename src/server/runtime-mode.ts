export type RuntimeMode = 'desktop' | 'server'

let runtimeMode: RuntimeMode = 'desktop'

export function configureRuntimeMode(mode: RuntimeMode): void {
  runtimeMode = mode
}

export function getRuntimeMode(): RuntimeMode {
  return runtimeMode
}

export function resetRuntimeMode(): void {
  runtimeMode = 'desktop'
}
