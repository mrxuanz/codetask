import { createHash, randomUUID } from 'crypto'
import { gunzipSync, gzipSync } from 'zlib'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import type { SavedJobPlan } from '../planner/plan-types'
import { buildPlanSummary } from '@shared/plan-mutations'
import {
  designPlanArtifactRelPath as designPlanArtifactRelPathFromDataPaths
} from '../data-paths'

function hashContent(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

export function designPlanArtifactRelPath(designSessionId: string, planRevision: number): string {
  return designPlanArtifactRelPathFromDataPaths(designSessionId, planRevision)
}

export function designPlanArtifactAbsPath(
  dataDir: string,
  designSessionId: string,
  planRevision: number
): string {
  return join(dataDir, designPlanArtifactRelPath(designSessionId, planRevision))
}

export async function putDesignPlanArtifact(input: {
  dataDir: string
  designSessionId: string
  planRevision: number
  plan: SavedJobPlan
}): Promise<{ artifactId: string; summaryJson: string; contentPath: string }> {
  const raw = JSON.stringify(input.plan)
  const artifactId = `dart-${randomUUID()}`
  const relPath = designPlanArtifactRelPath(input.designSessionId, input.planRevision)
  const abs = join(input.dataDir, relPath)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, gzipSync(raw))

  const summary = {
    artifactId,
    planRevision: input.planRevision,
    contentHash: hashContent(raw),
    byteSize: Buffer.byteLength(raw, 'utf8'),
    ...buildPlanSummary(input.plan)
  }

  return {
    artifactId,
    summaryJson: JSON.stringify(summary),
    contentPath: relPath
  }
}

export async function readDesignPlanArtifact(
  dataDir: string,
  contentPath: string
): Promise<SavedJobPlan | null> {
  const normalized = contentPath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (normalized.includes('..')) return null
  try {
    const buf = await readFile(join(dataDir, normalized))
    const raw = gunzipSync(buf).toString('utf8')
    return JSON.parse(raw) as SavedJobPlan
  } catch {
    return null
  }
}
