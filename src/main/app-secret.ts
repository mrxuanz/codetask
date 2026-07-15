import { existsSync } from 'fs'
import { safeStorage } from 'electron'
import {
  EncryptedFileAppSecretProvider,
  FileAppSecretProvider,
  type AppSecretCipher,
  type AppSecretProvider
} from '../server/auth/secret'
import type { AppMode } from './cli'

function electronSafeStorageCipher(): AppSecretCipher {
  return {
    encrypt: (plaintext) => safeStorage.encryptString(plaintext),
    decrypt: (ciphertext) => safeStorage.decryptString(Buffer.from(ciphertext))
  }
}

export async function loadMainProcessAuthSecret(input: {
  mode: AppMode
  bootstrapSecretPath: string
}): Promise<{ value: string; provider: AppSecretProvider }> {
  const credentialPath = process.env.CODETASK_AUTH_SECRET_FILE?.trim()
  let provider: AppSecretProvider

  if (input.mode === 'server' && credentialPath) {
    if (!existsSync(credentialPath)) {
      throw new Error(`CODETASK_AUTH_SECRET_FILE does not exist: ${credentialPath}`)
    }
    provider = new FileAppSecretProvider(credentialPath, 'credential_file')
  } else if (input.mode === 'desktop' && safeStorage.isEncryptionAvailable()) {
    provider = new EncryptedFileAppSecretProvider(
      input.bootstrapSecretPath,
      electronSafeStorageCipher()
    )
  } else {
    provider = new FileAppSecretProvider(input.bootstrapSecretPath, 'fallback_file')
    console.warn(
      `[security] OS secret storage unavailable; auth secret uses a 0600 Bootstrap Root fallback file (${input.mode})`
    )
  }

  const value = await provider.loadOrCreateAuthSecret()
  return { value: Buffer.from(value).toString('hex'), provider }
}
