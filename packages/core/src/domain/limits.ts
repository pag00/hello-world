import { compareDecimal, isDecimal } from './decimal'
import type { NumberInput } from './types'

/**
 * §4 rule 3: bounds inclusive, missing bound = unbounded. A value that is not a decimal at all is
 * treated as out of tolerance — an unreadable measurement must never pass silently.
 */
export function isOutOfTolerance(value: unknown, input: Pick<NumberInput, 'min' | 'max'>): boolean {
  if (!isDecimal(value)) return true
  if (input.min != null && isDecimal(input.min) && compareDecimal(value, input.min) < 0) return true
  if (input.max != null && isDecimal(input.max) && compareDecimal(value, input.max) > 0) return true
  return false
}
