export type SecretMeta = {
  name: string
  backend: 'encrypted' | string
  configured: boolean
}

export interface SecretStore {
  put(name: string, value: string): Promise<void> | void
  get(name: string): Promise<string | null> | string | null
  delete(name: string): Promise<void> | void
  list(): Promise<SecretMeta[]> | SecretMeta[]
  has(name: string): Promise<boolean> | boolean
}
