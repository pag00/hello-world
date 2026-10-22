// Temporary: lets UI workstreams compile before the data layer lands. Delete when all stores are real.
export function notImplemented(name: string): never {
  throw new Error(`StepTrack: ${name} not implemented yet`)
}
