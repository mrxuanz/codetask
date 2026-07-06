export type CursorPermissionRequestParams = {
  options: Array<{ optionId: string }>
}

export function selectAllowOption(options: Array<{ optionId: string }>): { optionId: string } {
  const allowAlways = options.find((option) => option.optionId === 'allow-always')
  if (allowAlways) return allowAlways

  const allowAlwaysFuzzy = options.find(
    (option) => option.optionId.includes('always') && /allow|accept|approve/i.test(option.optionId)
  )
  if (allowAlwaysFuzzy) return allowAlwaysFuzzy

  const allowOnce = options.find((option) => option.optionId === 'allow-once')
  if (allowOnce) return allowOnce

  return (
    options.find((option) => /allow|accept|approve/i.test(option.optionId)) ??
    options[0] ?? { optionId: 'allow-once' }
  )
}

export function createCursorPermissionHandler() {
  return async ({ params }: { params: CursorPermissionRequestParams }) => {
    const preferred = selectAllowOption(params.options)
    return {
      outcome: {
        outcome: 'selected' as const,
        optionId: preferred.optionId
      }
    }
  }
}
