import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Config } from './config.js'
import type { BeliqClient } from './beliq.js'
import type { SevDesk, SevDeskInvoice } from './sevdesk.js'
import type { Logger } from './log.js'
import { IoError } from './errors.js'
import { emptyCounts, summaryExitCode, type Classification, type Counts } from './exit.js'
import { loadState, saveState } from './state.js'
import { notify, type InvoiceOutcome, type NotifyReport } from './notify.js'

/** Convert targets that produce a hybrid PDF rather than a standalone XML document. */
const PDF_TARGETS = new Set<string>(['facturx', 'zugferd'])

/** Seconds in a day, for the poll-window date filter. */
const SECONDS_PER_DAY = 86_400

export interface WorkerDeps {
  sevdesk: SevDesk
  beliq: BeliqClient
  log: Logger
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number
  /** Injectable sleep for the daemon loop (tests). Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>
  /** Injectable fetch for the notify webhook (tests). Defaults to global fetch. */
  fetch?: typeof fetch
}

export interface PollResult {
  counts: Counts
  /** The high-water-mark after this poll. */
  processedTo: number
}

function safeName(inv: SevDeskInvoice): string {
  const base = inv.invoiceNumber || inv.id
  return base.replace(/[^A-Za-z0-9._-]/g, '_')
}

async function ensureDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true })
  } catch (err) {
    throw new IoError(`could not create output dir ${dir}: ${(err as Error).message}`)
  }
}

async function writeOutput(dir: string, name: string, bytes: Uint8Array): Promise<void> {
  const path = join(dir, name)
  try {
    await writeFile(path, bytes)
  } catch (err) {
    throw new IoError(`could not write ${path}: ${(err as Error).message}`)
  }
}

/**
 * Run one invoice through the pipeline: pull its XML, convert it to each
 * configured target (writing the bytes out), then validate the source document
 * for an independent authority-pinned verdict sevDesk does not provide. Returns
 * the classification; a throw here is caught by the caller and counted as an
 * error (no verdict), leaving the high-water-mark short of this invoice so it is
 * retried next poll.
 */
async function processInvoice(inv: SevDeskInvoice, config: Config, deps: WorkerDeps): Promise<Classification> {
  const xml = await deps.sevdesk.getInvoiceXml(inv.id)

  for (const target of config.targetFormats) {
    const result = await deps.beliq.convert(xml, {
      targetFormat: target,
      targetProfile: PDF_TARGETS.has(target) ? config.targetProfile : undefined,
    })
    const ext = PDF_TARGETS.has(target) ? 'pdf' : 'xml'
    const file = `${safeName(inv)}-${target}.${ext}`
    const lostElements = result.meta.lostElementsCount ?? 0
    if (config.dryRun) {
      deps.log.info('convert.dryRun', { id: inv.id, target, file, lostElements })
    } else {
      await writeOutput(config.outputDir, file, result.bytes)
      deps.log.info('convert', { id: inv.id, target, file, lostElements })
    }
  }

  const verdict = await deps.beliq.validate(xml, {})
  const classification: Classification = verdict.valid ? 'valid' : 'invalid'
  deps.log.info('validate', {
    id: inv.id,
    number: inv.invoiceNumber,
    valid: verdict.valid,
    errors: verdict.errors?.length ?? 0,
    warnings: verdict.warnings?.length ?? 0,
    classification,
  })
  return classification
}

function formatSummary(counts: Counts, fresh: number, dryRun: boolean): string {
  const prefix = dryRun ? '[dry-run] ' : ''
  return `${prefix}processed ${fresh} invoice(s): ${counts.valid} valid, ${counts.invalid} invalid, ${counts.error} error`
}

/**
 * Poll sevDesk once: fetch invoices in the configured status/window, process
 * only those newer than the high-water-mark (in ascending id order so the mark
 * advances monotonically and dedupes by id), and persist the advanced mark. The
 * mark advances only across the contiguous error-free prefix: an invoice that
 * errors (and every invoice after it in this batch) is left for the next poll,
 * which is safe because reprocessing is idempotent.
 */
export async function pollOnce(config: Config, deps: WorkerDeps): Promise<PollResult> {
  const now = deps.now ?? (() => Date.now())
  if (config.targetFormats.length > 0 && !config.dryRun) {
    await ensureDir(config.outputDir)
  }
  const state = await loadState(config.stateFile)
  const startDate =
    config.pollWindowDays > 0 ? Math.floor(now() / 1000) - config.pollWindowDays * SECONDS_PER_DAY : undefined

  const invoices = await deps.sevdesk.listInvoices({
    status: config.status,
    startDate,
    pageSize: config.pageSize,
  })

  const fresh = invoices
    .map((inv) => ({ inv, idNum: Number(inv.id) }))
    .filter(({ idNum }) => Number.isFinite(idNum) && idNum > state.lastInvoiceId)
    .sort((a, b) => a.idNum - b.idNum)

  deps.log.info('poll', {
    status: config.status,
    since: state.lastInvoiceId,
    listed: invoices.length,
    fresh: fresh.length,
  })

  const counts = emptyCounts()
  const outcomes: InvoiceOutcome[] = []
  let highWater = state.lastInvoiceId
  let blocked = false

  for (const { inv, idNum } of fresh) {
    let classification: Classification
    try {
      classification = await processInvoice(inv, config, deps)
    } catch (err) {
      classification = 'error'
      deps.log.error('invoice.error', {
        id: inv.id,
        number: inv.invoiceNumber,
        message: (err as Error).message,
      })
    }
    counts[classification]++
    outcomes.push({ id: inv.id, invoiceNumber: inv.invoiceNumber, classification })
    if (classification === 'error') blocked = true
    else if (!blocked) highWater = idNum
  }

  if (!config.dryRun && highWater > state.lastInvoiceId) {
    await saveState(config.stateFile, {
      lastInvoiceId: highWater,
      lastPolledAt: new Date(now()).toISOString(),
    })
  }

  const summary = formatSummary(counts, fresh.length, config.dryRun)
  deps.log.summary(summary)
  await maybeNotify(config, deps, counts, outcomes, summary, now)
  return { counts, processedTo: highWater }
}

/**
 * Fire the notify webhook when configured. Skipped in a dry run (a dry run has no
 * side effects). With notifyOn=failure it POSTs only when an invoice failed; with
 * notifyOn=always it POSTs after every poll (a heartbeat, best for --once/cron).
 */
async function maybeNotify(
  config: Config,
  deps: WorkerDeps,
  counts: Counts,
  outcomes: InvoiceOutcome[],
  summary: string,
  now: () => number,
): Promise<void> {
  const url = config.notifyWebhook
  if (!url || config.dryRun) return

  const failed = counts.invalid + counts.error > 0
  if (config.notifyOn === 'failure' && !failed) return

  const report: NotifyReport = {
    ok: !failed,
    summary,
    counts,
    invoices: outcomes,
    polledAt: new Date(now()).toISOString(),
  }
  await notify(url, report, { fetch: deps.fetch ?? fetch, log: deps.log })
}

/**
 * Run the worker. With --once, poll a single time and return the exit code (the
 * CI/cron contract). Otherwise loop forever, polling every interval, until the
 * process is signalled.
 */
export async function runWorker(config: Config, deps: WorkerDeps): Promise<number> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  if (config.once) {
    const { counts } = await pollOnce(config, deps)
    return summaryExitCode(counts)
  }

  for (;;) {
    await pollOnce(config, deps)
    await sleep(config.intervalSeconds * 1000)
  }
}
