export interface IdGenerator {
  newId(): string
  newFenceToken(): string
}
