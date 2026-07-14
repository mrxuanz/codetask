import { fetchBootstrap } from './auth'
import type { BootstrapData } from './types'

export type ControlPlaneGeneration = NonNullable<BootstrapData['controlPlaneGeneration']>

export async function fetchControlPlaneGeneration(): Promise<ControlPlaneGeneration | null> {
  const res = await fetchBootstrap()
  return res.data.controlPlaneGeneration ?? null
}
