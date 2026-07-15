import { join, posix } from 'path'

/**
 * Central path resolver for everything under the app data directory.
 * All writers/readers of data/ subpaths must go through this module.
 */
export function dataPaths(dataDir: string): {
  dbFile: string
  attachments: string
  artifactsMessages: string
  artifactsJobs: string
  runtimes: string
  sandboxHome: string
} {
  return {
    dbFile: join(dataDir, 'db', 'app.db'),
    attachments: join(dataDir, 'blobs', 'attachments'),
    artifactsMessages: join(dataDir, 'blobs', 'artifacts', 'messages'),
    artifactsJobs: join(dataDir, 'blobs', 'artifacts', 'jobs'),
    runtimes: join(dataDir, 'runtimes'),
    sandboxHome: join(dataDir, 'sandbox-home')
  }
}

/** DB-stored relative paths use POSIX separators. */
export function messageArtifactRelPath(messageId: string, artifactId: string): string {
  return posix.join('blobs', 'artifacts', 'messages', messageId, `${artifactId}.json.gz`)
}

export function jobArtifactRelPath(contentHash: string): string {
  return posix.join('blobs', 'artifacts', 'jobs', contentHash.slice(0, 2), `${contentHash}.json.gz`)
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

export function threadRuntimeDirPath(dataDir: string, threadId: string): string {
  return join(dataPaths(dataDir).runtimes, threadId)
}

export function jobRuntimeDirPath(dataDir: string, threadId: string, jobId: string): string {
  return join(dataPaths(dataDir).runtimes, threadId, 'jobs', jobId)
}

export function jobTaskRuntimeDirPath(
  dataDir: string,
  threadId: string,
  jobId: string,
  taskId: string
): string {
  return join(jobRuntimeDirPath(dataDir, threadId, jobId), 'tasks', taskId)
}
