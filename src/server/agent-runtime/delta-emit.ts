export function advanceTextSnapshot(
  previous: string,
  next: string
): { text: string; delta: string | null } {
  if (!next || next === previous) return { text: previous, delta: null }
  if (next.startsWith(previous)) {
    const delta = next.slice(previous.length)
    return { text: next, delta: delta || null }
  }
  return { text: next, delta: next }
}

export function appendTextPiece(
  previous: string,
  piece: string
): { text: string; delta: string | null } {
  if (!piece) return { text: previous, delta: null }
  return { text: previous + piece, delta: piece }
}
