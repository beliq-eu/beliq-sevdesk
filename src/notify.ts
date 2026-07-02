import type { Logger } from './log.js'
import type { Classification, Counts } from './exit.js'

export type NotifyOn = 'failure' | 'always'

export interface InvoiceOutcome {
  id: string
  invoiceNumber?: string
  classification: Classification
}

/** The JSON body POSTed to the notify webhook after a poll. */
export interface NotifyReport {
  /** True when nothing failed (no invalid document, no errored invoice). */
  ok: boolean
  summary: string
  counts: Counts
  invoices: InvoiceOutcome[]
  polledAt: string
}

export interface NotifyDeps {
  fetch: typeof fetch
  log: Logger
}

/**
 * Best-effort webhook timeout. Notify is a side channel; a slow or dead endpoint
 * must never stall the worker or change the run's verdict.
 */
const NOTIFY_TIMEOUT_MS = 10_000

/** Host only, so a webhook that carries a secret in its path is not logged. */
function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'invalid-url'
  }
}

/**
 * POST the poll report to the notify webhook. Best-effort by design: a non-2xx
 * response, a network failure, or a timeout is logged (host only, never the full
 * URL) and swallowed. This function never throws, so the exit code stays a
 * faithful signal of the invoices themselves, not of the notification.
 */
export async function notify(url: string, report: NotifyReport, deps: NotifyDeps): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), NOTIFY_TIMEOUT_MS)
  try {
    const res = await deps.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
      signal: controller.signal,
    })
    if (res.ok) {
      deps.log.info('notify', { host: safeHost(url), status: res.status })
    } else {
      deps.log.error('notify.error', { host: safeHost(url), status: res.status })
    }
  } catch (err) {
    deps.log.error('notify.error', { host: safeHost(url), message: (err as Error).message })
  } finally {
    clearTimeout(timer)
  }
}
