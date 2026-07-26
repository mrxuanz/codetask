import type { ApplicationEvent } from './event-publisher'

/**
 * Unit of Work: collect domain events during work; publish on successful commit.
 * Implementations must discard enqueued events if `fn` throws.
 */
export interface UnitOfWork {
  enqueueEvent(event: ApplicationEvent): void
  run<T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T>
}
