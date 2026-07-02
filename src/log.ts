/**
 * The output seam. Structured events go to stderr as one JSON object per line
 * (for log aggregation); the final human-readable summary goes to stdout (so a
 * `beliq-sevdesk --once | tail -1` gets the verdict while logs stay on stderr).
 * Commands take a Logger so tests inject a recording fake and assert exactly
 * what would be emitted, with no real streams touched.
 */
export interface Logger {
  /** A structured informational event. */
  info(event: string, fields?: Record<string, unknown>): void
  /** A structured error event. */
  error(event: string, fields?: Record<string, unknown>): void
  /** The final one-line, human-readable run summary. */
  summary(line: string): void
}

export function nodeLogger(): Logger {
  const emit = (level: 'info' | 'error', event: string, fields?: Record<string, unknown>): void => {
    process.stderr.write(`${JSON.stringify({ level, event, ...fields })}\n`)
  }
  return {
    info: (event, fields) => emit('info', event, fields),
    error: (event, fields) => emit('error', event, fields),
    summary: (line) => process.stdout.write(`${line}\n`),
  }
}
