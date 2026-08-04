import { Type } from '@sinclair/typebox'
import type { TLiteral, TObject, TSchema, TString } from '@sinclair/typebox'

export const ApiSuccessSchema = <T extends TSchema>(
  data: T
): TObject<{ success: TLiteral<true>; data: T; requestId: TString }> =>
  Type.Object({
    success: Type.Literal(true),
    data,
    requestId: Type.String()
  })

export const ApiFailureSchema = Type.Object({
  success: Type.Literal(false),
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    details: Type.Optional(Type.Record(Type.String(), Type.Unknown()))
  }),
  requestId: Type.String()
})

export type ApiSuccess<T> = {
  success: true
  data: T
  requestId: string
}

export type ApiFailure = {
  success: false
  error: {
    code: string
    message: string
    details?: Record<string, unknown>
  }
  requestId: string
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure
