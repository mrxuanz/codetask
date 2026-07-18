import type { Context } from 'hono'
import { AppError } from '../error'

export const MAX_UPLOAD_FILE_BYTES = 8 * 1024 * 1024
export const MAX_UPLOAD_FILES = 20
export const MAX_MULTIPART_BODY_BYTES = 32 * 1024 * 1024

export interface ParsedUploadFile {
  name: string
  mimeType: string
  buffer: Buffer
}

export interface MultipartUploadOptions {
  field?: string
  maxFiles?: number
  maxFileBytes?: number
  minFiles?: number
  emptyErrorCode?: string
  emptyErrorMessage?: string
}

type MultipartFormData = Record<string, unknown>

async function collectUploadFiles(
  form: MultipartFormData,
  options: MultipartUploadOptions
): Promise<ParsedUploadFile[]> {
  const field = options.field ?? 'file'
  const maxFiles = options.maxFiles ?? MAX_UPLOAD_FILES
  const maxFileBytes = options.maxFileBytes ?? MAX_UPLOAD_FILE_BYTES
  const minFiles = options.minFiles ?? 1

  const rawFiles = form[field]
  const entries: unknown[] = Array.isArray(rawFiles)
    ? rawFiles
    : rawFiles !== undefined
      ? [rawFiles]
      : []

  if (entries.length > maxFiles) {
    throw AppError.badRequest(
      `At most ${maxFiles} files allowed per upload`,
      'upload.too_many_files'
    )
  }

  const uploadFiles: ParsedUploadFile[] = []

  for (const entry of entries) {
    if (!(entry instanceof File)) continue
    const blob = entry
    const buffer = Buffer.from(await blob.arrayBuffer())
    if (buffer.length === 0) continue
    if (buffer.length > maxFileBytes) {
      throw AppError.badRequest(
        `File exceeds ${Math.floor(maxFileBytes / (1024 * 1024))}MB limit`,
        'upload.file_too_large'
      )
    }
    uploadFiles.push({
      name: blob.name || 'upload',
      mimeType: blob.type || 'application/octet-stream',
      buffer
    })
  }

  if (uploadFiles.length < minFiles) {
    throw AppError.badRequest(
      options.emptyErrorMessage ?? 'At least one file is required',
      options.emptyErrorCode ?? 'upload.files_required'
    )
  }

  return uploadFiles
}

export async function parseLimitedMultipartFiles(
  c: Context,
  options: MultipartUploadOptions = {}
): Promise<ParsedUploadFile[]> {
  const form = await c.req.parseBody()
  return collectUploadFiles(form, options)
}

export async function parseLimitedMultipartFilesFromForm(
  form: MultipartFormData,
  options: MultipartUploadOptions = {}
): Promise<ParsedUploadFile[]> {
  return collectUploadFiles(form, options)
}
