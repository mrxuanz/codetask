export function needsVerificationFinalizationRetry(
  kind: 'work' | 'work_validation' | 'slice_validation' | 'milestone_validation',
  reply: string
): boolean {
  return kind !== 'work' && !reply.trim()
}

export function buildVerificationFinalizationPrompt(originalPrompt: string): string {
  return [
    originalPrompt,
    '',
    '<SERVER_FINALIZATION_RETRY>',
    'The previous read-only verification turn completed without a textual result.',
    'Verify the same gate again and return exactly one JSON object matching the server-enforced verification result protocol.',
    'Do not omit the final response or wrap it in prose.',
    'Do not modify any workspace file.',
    '</SERVER_FINALIZATION_RETRY>'
  ].join('\n')
}
