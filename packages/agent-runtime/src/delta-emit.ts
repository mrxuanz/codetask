/** Upper bound for reply/thinking text accumulated in a single agent turn. */
export const MAX_TURN_TEXT_CHARS = 1_048_576

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
  piece: string,
  options?: { maxChars?: number }
): { text: string; delta: string | null } {
  if (!piece) return { text: previous, delta: null }

  const maxChars = options?.maxChars
  let accepted = piece
  if (maxChars !== undefined) {
    const remaining = maxChars - previous.length
    if (remaining <= 0) return { text: previous, delta: null }
    if (accepted.length > remaining) accepted = accepted.slice(0, remaining)
  }

  if (!accepted) return { text: previous, delta: null }
  return { text: previous + accepted, delta: accepted }
}
