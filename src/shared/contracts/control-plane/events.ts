import { Type, type Static } from '@sinclair/typebox'

export const JobChangedEventSchema = Type.Object(
  {
    eventId: Type.Integer({ minimum: 1 }),
    topic: Type.String({ minLength: 1, maxLength: 256 }),
    type: Type.Literal('job.changed'),
    entityId: Type.String({ minLength: 1, maxLength: 128 }),
    revision: Type.Integer({ minimum: 1 }),
    changed: Type.Array(
      Type.Union([
        Type.Literal('state'),
        Type.Literal('tasks'),
        Type.Literal('plan'),
        Type.Literal('failure'),
        Type.Literal('actions')
      ]),
      { minItems: 1, maxItems: 5 }
    )
  },
  { additionalProperties: false }
)

export type JobChangedEvent = Static<typeof JobChangedEventSchema>

export type ChangedField = 'state' | 'tasks' | 'plan' | 'failure' | 'actions'

export function jobChangedEvent(
  jobId: string,
  revision: number,
  changed: ChangedField[]
): JobChangedEvent {
  return {
    eventId: 0,
    topic: `job:${jobId}`,
    type: 'job.changed',
    entityId: jobId,
    revision,
    changed
  }
}
