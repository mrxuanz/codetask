export function defaultBrowsePath(): string {
  return '~'
}

export function pathSeparator(path: string): string {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/'
}

export function withTrailingSeparator(path: string): string {
  const trimmed = path.trim()
  if (!trimmed || /[\\/]$/.test(trimmed)) return trimmed
  return `${trimmed}${pathSeparator(trimmed)}`
}

export function joinChildPath(base: string, child: string): string {
  const trimmedBase = base.trim()
  const trimmedChild = child.trim().replace(/^[/\\]+|[/\\]+$/g, '')
  if (!trimmedBase || !trimmedChild) return ''
  const separator = pathSeparator(trimmedBase)
  return `${trimmedBase.replace(/[/\\]+$/, '')}${separator}${trimmedChild}`
}

export function workspaceRootsMatch(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    value
      .trim()
      .replace(/[\\/]+$/, '')
      .toLowerCase()
  const a = normalize(left)
  const b = normalize(right)
  return a.length > 0 && a === b
}
