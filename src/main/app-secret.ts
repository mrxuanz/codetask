import { safeStorage } from 'electron'
import {
  EncryptedFileAppSecretProvider,
  FileAppSecretProvider,
  inspectStoredAppSecret,
  resolveAppSecretStorageKind,
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

function secureOsStorageAvailable(): boolean {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false
    // Electron's Linux basic_text backend uses a hard-coded plaintext password and therefore does
    // not provide the OS-backed protection this provider promises.
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
      return false
    }
    return true
  } catch {
    return false
  }
}

export async function loadMainProcessAuthSecret(input: {
  mode: AppMode
  bootstrapSecretPath: string
  credentialPath?: string | undefined
}): Promise<{ value: string; provider: AppSecretProvider }> {
  const credentialPath = input.credentialPath?.trim()
  const secretPath = credentialPath || input.bootstrapSecretPath
  const storedFormat = inspectStoredAppSecret(secretPath)
  if (credentialPath) {
    if (storedFormat === 'missing') {
      throw new Error(`Configured auth secret file does not exist: ${credentialPath}`)
    }
    if (storedFormat !== 'plaintext') {
      throw new Error(`Configured auth secret file is not a valid plaintext credential`)
    }
    const provider = new FileAppSecretProvider(credentialPath, 'credential_file')
    const value = await provider.loadOrCreateAuthSecret()
    return { value: Buffer.from(value).toString('hex'), provider }
  }

  const osStorageAvailable = secureOsStorageAvailable()
  const storageKind = resolveAppSecretStorageKind(storedFormat, osStorageAvailable)
  let provider: AppSecretProvider

  if (storageKind === 'os_store') {
    provider = new EncryptedFileAppSecretProvider(secretPath, electronSafeStorageCipher())
  } else {
    provider = new FileAppSecretProvider(secretPath, 'fallback_file')
    const reason =
      storedFormat === 'plaintext' && osStorageAvailable
        ? 'preserving an existing shared plaintext format'
        : 'OS secret storage unavailable'
    console.warn(`[security] ${reason}; auth secret uses a 0600 fallback file (${input.mode})`)
  }

  const value = await provider.loadOrCreateAuthSecret()
  return { value: Buffer.from(value).toString('hex'), provider }
}
