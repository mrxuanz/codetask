import { join, posix } from 'path'

/**
 * Central path resolver for everything under the app data directory.
 * All writers/readers of data/ subpaths must go through this module.
 */
export function dataPaths(dataDir: string) {
  return {
    dbFile: join(dataDir, 'db', 'app.db'),
    attachments: join(dataDir, 'blobs', 'attachments'),
    artifactsMessages: join(dataDir, 'blobs', 'artifacts', 'messages'),
    artifactsDesigns: join(dataDir, 'blobs', 'artifacts', 'designs'),
    runtimes: join(dataDir, 'runtimes'),
    settingsFile: join(dataDir, 'config', 'settings.json'),
    secretFile: join(dataDir, 'secrets', 'auth-secret'),
    sandboxHome: join(dataDir, 'sandbox-home')
  }
}

/** DB-stored relative paths use POSIX separators. */
export function messageArtifactRelPath(messageId: string, artifactId: string): string {
  return posix.join('blobs', 'artifacts', 'messages', messageId, `${artifactId}.json.gz`)
}

export function designPlanArtifactRelPath(designSessionId: string, planRevision: number): string {
  return posix.join('blobs', 'artifacts', 'designs', designSessionId, `plan-v${planRevision}.json.gz`)
}

export function threadAttachmentsDir(dataDir: string, threadId: string): string {
  return join(dataPaths(dataDir).attachments, threadId)
}

export function attachmentDir(dataDir: string, threadId: string, attachmentId: string): string {
  return join(dataPaths(dataDir).attachments, threadId, attachmentId)
}

export function messageArtifactDir(dataDir: string, messageId: string): string {
  return join(dataPaths(dataDir).artifactsMessages, messageId)
}

export function designArtifactDir(dataDir: string, designSessionId: string): string {
  return join(dataPaths(dataDir).artifactsDesigns, designSessionId)
}

export function threadRuntimeDirPath(dataDir: string, threadId: string): string {
  return join(dataPaths(dataDir).runtimes, threadId)
}

export function jobRuntimeDirPath(dataDir: string, threadId: string, jobId: string): string {
  return join(dataPaths(dataDir).runtimes, threadId, 'jobs', jobId)
}
