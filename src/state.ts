import { readFile, rename, writeFile } from 'node:fs/promises'
import { IoError } from './errors.js'

/** What the worker remembers between polls: which sevDesk invoices are done. */
export interface WorkerState {
  /**
   * Ids of invoices that need no further poll: they got a verdict, or beliq
   * refused the document in a way that asking again cannot change. Never pruned.
   * Dropping an id because one list answer left it out would reprocess the
   * invoice, spend quota and fire the webhook again on the next poll.
   */
  processedIds: Set<string>
  /**
   * The id high-water-mark of a state file written before 0.3.0. The first poll
   * turns it into processedIds and the next save drops it.
   */
  legacyLastInvoiceId?: number
  lastPolledAt?: string
}

function invalid(path: string, what: string): IoError {
  return new IoError(`state file ${path} ${what}; fix or delete it to start fresh`)
}

/**
 * Load the state. A missing file is the first-run case (nothing processed).
 * A present-but-corrupt file throws IoError rather than silently starting
 * empty, which would reprocess the entire account.
 */
export async function loadState(path: string): Promise<WorkerState> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { processedIds: new Set() }
    throw new IoError(`could not read state file ${path}: ${(err as Error).message}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw invalid(path, 'is not valid JSON')
  }
  const { processedIds, lastInvoiceId, lastPolledAt } = (parsed ?? {}) as Record<string, unknown>
  const polledAt = typeof lastPolledAt === 'string' ? lastPolledAt : undefined

  if (processedIds !== undefined) {
    if (!Array.isArray(processedIds) || processedIds.some((id) => typeof id !== 'string')) {
      throw invalid(path, 'has a processedIds that is not a list of id strings')
    }
    return { processedIds: new Set(processedIds as string[]), lastPolledAt: polledAt }
  }
  if (typeof lastInvoiceId !== 'number' || !Number.isFinite(lastInvoiceId) || lastInvoiceId < 0) {
    throw invalid(path, 'has neither processedIds nor a valid lastInvoiceId')
  }
  return { processedIds: new Set(), legacyLastInvoiceId: lastInvoiceId, lastPolledAt: polledAt }
}

export async function saveState(path: string, state: Pick<WorkerState, 'processedIds' | 'lastPolledAt'>): Promise<void> {
  const processedIds = [...state.processedIds].sort((a, b) => Number(a) - Number(b))
  // Written beside the target and renamed over it, so a crash mid-write leaves
  // the previous file whole. A torn state file would stop every later run.
  const partial = `${path}.tmp`
  try {
    await writeFile(partial, `${JSON.stringify({ processedIds, lastPolledAt: state.lastPolledAt }, null, 2)}\n`)
    await rename(partial, path)
  } catch (err) {
    throw new IoError(`could not write state file ${path}: ${(err as Error).message}`)
  }
}
