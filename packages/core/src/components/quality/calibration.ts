// Calibration status for the tool registry screen. Same date rule as the execution check
// (stores/registry checkToolIn): the due date itself is still valid, expired from the following day,
// evaluated on the device's local calendar date.
import type { Tool } from '../../domain/types'
import { localDate } from '../../stores/registry'

export type CalibrationStatus = 'ok' | 'due_soon' | 'expired' | 'not_required'

export const DUE_SOON_DAYS = 30

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function dayNumber(ymd: string): number | null {
  const m = DATE_RE.exec(ymd)
  if (!m) return null
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  // reject 2026-02-31 and friends instead of silently rolling over
  const d = new Date(t)
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null
  return t / 86_400_000
}

export function isValidDate(ymd: string): boolean {
  return dayNumber(ymd) !== null
}

/** Calendar days from `today` to `due` (0 = due today, negative = overdue). */
export function daysUntil(due: string, today: Date = new Date()): number | null {
  const d = dayNumber(due)
  const t = dayNumber(localDate(today))
  return d === null || t === null ? null : d - t
}

export function calibrationStatus(tool: Pick<Tool, 'calibration_due'>, today: Date = new Date()): { status: CalibrationStatus; days: number | null } {
  if (!tool.calibration_due) return { status: 'not_required', days: null }
  const days = daysUntil(tool.calibration_due, today)
  // an unparseable due date must never read as "ok"
  if (days === null || days < 0) return { status: 'expired', days }
  if (days <= DUE_SOON_DAYS) return { status: 'due_soon', days }
  return { status: 'ok', days }
}
