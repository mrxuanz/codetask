export type SecretMeta = {
  name: string
  backend: 'encrypted' | string
  configured: boolean
}

export interface SecretStore {
  put(name: string, value: string): void
  get(name: string): string | null
  delete(name: string): void
  list(): SecretMeta[]
  has(name: string): boolean
}
