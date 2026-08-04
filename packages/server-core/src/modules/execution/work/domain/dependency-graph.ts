import type { WorkDependencyRecord } from './work-item.ts'

export function hasCycle(workIds: string[], deps: WorkDependencyRecord[]): boolean {
  const adj = new Map<string, string[]>()
  for (const id of workIds) adj.set(id, [])
  for (const d of deps) {
    adj.get(d.fromWorkId)?.push(d.dependsOnWorkId)
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  function dfs(id: string): boolean {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    for (const next of adj.get(id) ?? []) {
      if (dfs(next)) return true
    }
    visiting.delete(id)
    visited.add(id)
    return false
  }
  for (const id of workIds) {
    if (dfs(id)) return true
  }
  return false
}

export function buildAdjacency(deps: WorkDependencyRecord[]): Map<string, string[]> {
  const adj = new Map<string, string[]>()
  for (const d of deps) {
    const list = adj.get(d.fromWorkId) ?? []
    list.push(d.dependsOnWorkId)
    adj.set(d.fromWorkId, list)
  }
  return adj
}
