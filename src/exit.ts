export const EXIT = {
  /** Success: every processed invoice was valid, or there was nothing to do. */
  OK: 0,
  /** At least one invoice failed validation (the CI/Action "document failed" contract). */
  INVALID: 1,
  /** A config or usage problem: missing token/key, bad flag, bad value. */
  USAGE: 2,
  /** A sevDesk or beliq API error (bad key, quota, engine), or an invoice that errored mid-pipeline. */
  API: 3,
  /** A local I/O error: unreadable state file, or an output dir/file that could not be written. */
  IO: 4,
} as const

/** Per-invoice outcome. `error` means the pipeline threw before a verdict (network/API/IO). */
export type Classification = 'valid' | 'invalid' | 'error'

export interface Counts {
  valid: number
  invalid: number
  error: number
}

export function emptyCounts(): Counts {
  return { valid: 0, invalid: 0, error: 0 }
}

/**
 * The run's exit code from the tallied outcomes. An error (we never got a
 * verdict) is worse than an invalid document (a verdict of non-compliant), so it
 * wins: EXIT.API > EXIT.INVALID > EXIT.OK. This is a faithful superset of the
 * CLI/Action contract, where "any invoice failed" maps to a non-zero exit.
 */
export function summaryExitCode(counts: Counts): number {
  if (counts.error > 0) return EXIT.API
  if (counts.invalid > 0) return EXIT.INVALID
  return EXIT.OK
}
