import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Config } from './config.js'
import { isDocumentRefusal, type BeliqClient } from './beliq.js'
import type { SevDesk, SevDeskInvoice } from './sevdesk.js'
import type { Logger } from './log.js'
import { IoError, NotAnEInvoiceError } from './errors.js'
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
}

interface InvoiceResult {
  classification: Classification
  /** False when a later poll may get a different answer, so the invoice is tried again. */
  final: boolean
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
 * Run one invoice through the pipeline: pull its XML, validate it for an
 * independent authority-pinned verdict sevDesk does not provide, then convert it
 * to each configured target and write the bytes out. Validation runs first so a
 * conversion beliq refuses cannot cost the verdict.
 *
 * An invoice sevDesk holds no XML for is skipped for good. A refusal about the
 * document itself is final too: the same bytes get the same answer next poll. Anything else that throws (sevDesk, the network, a spent
 * quota, a full disk) propagates, and the caller leaves the invoice for the
 * next poll.
 */
async function processInvoice(inv: SevDeskInvoice, config: Config, deps: WorkerDeps): Promise<InvoiceResult> {
  let xml: Uint8Array
  try {
    xml = await deps.sevdesk.getInvoiceXml(inv.id)
  } catch (err) {
    if (!(err instanceof NotAnEInvoiceError)) throw err
    deps.log.info('invoice.skipped', { id: inv.id, number: inv.invoiceNumber, reason: 'not an e-invoice' })
    return { classification: 'skipped', final: true }
  }

  let valid: boolean
  try {
    const verdict = await deps.beliq.validate(xml, {})
    valid = verdict.valid
    deps.log.info('validate', {
      id: inv.id,
      number: inv.invoiceNumber,
      valid,
      errors: verdict.errors?.length ?? 0,
      warnings: verdict.warnings?.length ?? 0,
      classification: valid ? 'valid' : 'invalid',
    })
  } catch (err) {
    if (!isDocumentRefusal(err)) throw err
    deps.log.error('validate.refused', {
      id: inv.id,
      number: inv.invoiceNumber,
      status: err.status,
      code: err.code,
      message: err.message,
    })
    return { classification: 'error', final: true }
  }

  let refused = false
  for (const target of config.targetFormats) {
    let result
    try {
      result = await deps.beliq.convert(xml, {
        targetFormat: target,
        targetProfile: PDF_TARGETS.has(target) ? config.targetProfile : undefined,
      })
    } catch (err) {
      if (!isDocumentRefusal(err)) throw err
      refused = true
      deps.log.error('convert.refused', { id: inv.id, target, status: err.status, code: err.code, message: err.message })
      continue
    }
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

  // An invalid document keeps its verdict. A valid one that beliq would not
  // convert is an error: the file the operator asked for does not exist.
  if (!valid) return { classification: 'invalid', final: true }
  return { classification: refused ? 'error' : 'valid', final: true }
}

function formatSummary(counts: Counts, fresh: number, dryRun: boolean): string {
  const prefix = dryRun ? '[dry-run] ' : ''
  return `${prefix}processed ${fresh} invoice(s): ${counts.valid} valid, ${counts.invalid} invalid, ${counts.error} error, ${counts.skipped} skipped`
}

/**
 * Poll sevDesk once: fetch invoices in the configured status/window and process
 * every one whose id is not yet in the processed set, in ascending id order.
 * Each invoice stands alone: one that errors is left out of the set and comes
 * back next poll, and the invoices after it are still processed.
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

  const processed = new Set(state.processedIds)
  const legacyMark = state.legacyLastInvoiceId
  if (legacyMark !== undefined) {
    // A pre-0.3.0 state file holds one number. Every listed invoice at or below
    // it counts as done, which includes drafts the old worker skipped: the mark
    // cannot tell the two apart.
    for (const inv of invoices) {
      if (Number(inv.id) <= legacyMark) processed.add(inv.id)
    }
  }
  const known = processed.size

  // Keyed by id: offset paging can hand back one invoice on two pages.
  const fresh = [...new Map(invoices.map((inv) => [inv.id, inv])).values()]
    .filter((inv) => !processed.has(inv.id))
    .sort((a, b) => Number(a.id) - Number(b.id))

  deps.log.info('poll', {
    status: config.status,
    known,
    listed: invoices.length,
    fresh: fresh.length,
  })

  const counts = emptyCounts()
  const outcomes: InvoiceOutcome[] = []

  for (const inv of fresh) {
    let result: InvoiceResult
    try {
      result = await processInvoice(inv, config, deps)
    } catch (err) {
      result = { classification: 'error', final: false }
      deps.log.error('invoice.error', {
        id: inv.id,
        number: inv.invoiceNumber,
        message: (err as Error).message,
      })
    }
    counts[result.classification]++
    outcomes.push({ id: inv.id, invoiceNumber: inv.invoiceNumber, classification: result.classification })
    if (result.final) processed.add(inv.id)
  }

  if (!config.dryRun && (processed.size > state.processedIds.size || legacyMark !== undefined)) {
    await saveState(config.stateFile, {
      processedIds: processed,
      lastPolledAt: new Date(now()).toISOString(),
    })
  }

  const summary = formatSummary(counts, fresh.length, config.dryRun)
  deps.log.summary(summary)
  await maybeNotify(config, deps, counts, outcomes, summary, now)
  return { counts }
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
