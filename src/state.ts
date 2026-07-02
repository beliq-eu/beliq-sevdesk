import { readFile, writeFile } from 'node:fs/promises'
import { IoError } from './errors.js'

/** The persisted poll cursor: the highest sevDesk invoice id already processed. */
export interface WorkerState {
  lastInvoiceId: number
  lastPolledAt?: string
}

const EMPTY: WorkerState = { lastInvoiceId: 0 }

/**
 * Load the high-water-mark. A missing file is the first-run case (start from 0).
 * A present-but-corrupt file throws IoError rather than silently resetting to 0,
 * which would reprocess the entire account.
 */
export async function loadState(path: string): Promise<WorkerState> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY }
    throw new IoError(`could not read state file ${path}: ${(err as Error).message}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new IoError(`state file ${path} is not valid JSON; fix or delete it to start fresh`)
  }
  const lastInvoiceId = (parsed as { lastInvoiceId?: unknown })?.lastInvoiceId
  if (typeof lastInvoiceId !== 'number' || !Number.isFinite(lastInvoiceId) || lastInvoiceId < 0) {
    throw new IoError(`state file ${path} has no valid lastInvoiceId; fix or delete it to start fresh`)
  }
  const lastPolledAt = (parsed as { lastPolledAt?: unknown }).lastPolledAt
  return { lastInvoiceId, lastPolledAt: typeof lastPolledAt === 'string' ? lastPolledAt : undefined }
}

export async function saveState(path: string, state: WorkerState): Promise<void> {
  try {
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`)
  } catch (err) {
    throw new IoError(`could not write state file ${path}: ${(err as Error).message}`)
  }
}
