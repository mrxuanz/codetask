import {
  FileAppSecretProvider,
  inspectStoredAppSecret,
  type AppSecretProvider
} from '../server/auth/secret'
import type { AppMode } from '../main/cli'

/** Node-only auth-secret adapter. It never imports or initializes Electron safeStorage. */
export async function loadNodeAuthSecret(
  input: {
    mode: AppMode
    bootstrapSecretPath: string
  },
  options: {
    credentialPath?: string | null
  } = {}
): Promise<{ value: string; provider: AppSecretProvider }> {
  const credentialPath =
    options.credentialPath === undefined ? undefined : options.credentialPath?.trim() || undefined
  const secretPath = credentialPath || input.bootstrapSecretPath
  const storedFormat = inspectStoredAppSecret(secretPath)

  if (credentialPath) {
    if (storedFormat === 'missing') {
      throw new Error(`Configured auth secret file does not exist: ${credentialPath}`)
    }
    if (storedFormat !== 'plaintext') {
      throw new Error(`Configured auth secret file is not a valid plaintext credential`)
    }
  } else if (storedFormat === 'encrypted') {
    throw new Error(
      'The shared auth secret is protected by Electron OS storage and cannot be opened by the standalone Node server. Start the server with --auth-secret-file pointing to an operator-managed 0600 secret.'
    )
  } else if (storedFormat === 'invalid') {
    throw new Error(`Auth secret file format is invalid: ${secretPath}`)
  }

  const provider = new FileAppSecretProvider(
    secretPath,
    credentialPath ? 'credential_file' : 'fallback_file'
  )
  if (!credentialPath) {
    console.warn(`[security] auth secret uses a 0600 fallback file (${input.mode})`)
  }
  const value = await provider.loadOrCreateAuthSecret()
  return { value: Buffer.from(value).toString('hex'), provider }
}
