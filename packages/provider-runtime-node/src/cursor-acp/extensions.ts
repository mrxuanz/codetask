type CursorAskQuestionOption = {
  id: string
  label: string
}

type CursorAskQuestion = {
  id: string
  prompt: string
  options: CursorAskQuestionOption[]
  allowMultiple?: boolean
}

export type CursorAskQuestionRequest = {
  toolCallId?: string
  title?: string
  questions: CursorAskQuestion[]
}

export function autoAnswerCursorAskQuestion(
  request: CursorAskQuestionRequest
): Record<string, string | string[]> {
  const answers: Record<string, string | string[]> = {}
  for (const question of request.questions ?? []) {
    const first = question.options?.[0]
    if (!first) continue
    answers[question.id] = question.allowMultiple ? [first.id] : first.id
  }
  return answers
}
