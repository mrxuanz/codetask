export interface ApplicationEvent {
  readonly type: string
  readonly aggregateId: string
  readonly payload?: unknown
}

export interface EventPublisher {
  publish(event: ApplicationEvent): Promise<void>
}
