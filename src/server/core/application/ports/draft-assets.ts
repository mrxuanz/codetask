import type { DraftAttachmentRecord } from './persistence'

export interface StoredDraftAsset {
  readonly storageRelativePath: string
  readonly absolutePath: string
}

export interface StagedJobIntakeAsset {
  readonly sourceAttachment: DraftAttachmentRecord
  readonly storageRelativePath: string
}

export interface StagedJobIntakeAssets {
  readonly assets: readonly StagedJobIntakeAsset[]
  cleanup(): Promise<void>
}

export interface DraftAssetStore {
  storeDraftAttachment(input: {
    readonly draftId: string
    readonly attachmentId: string
    readonly displayName: string
    readonly bytes: Uint8Array
  }): Promise<StoredDraftAsset>
  resolveDraftAttachment(storageRelativePath: string): string
  removeDraftAttachment(storageRelativePath: string): Promise<void>
  removeDraft(draftId: string): Promise<void>
  stageJobIntakeAssets(input: {
    readonly handoffId: string
    readonly attachments: readonly DraftAttachmentRecord[]
  }): Promise<StagedJobIntakeAssets>
}
