import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadState, saveState } from '../src/state.js'
import { IoError } from '../src/errors.js'

let dir: string
const statePath = () => join(dir, 'state.json')

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'beliq-sevdesk-state-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('state (real filesystem)', () => {
  it('treats a missing file as the first run', async () => {
    expect(await loadState(statePath())).toEqual({ lastInvoiceId: 0 })
  })

  it('round-trips through save and load', async () => {
    await saveState(statePath(), { lastInvoiceId: 42, lastPolledAt: '2026-07-02T00:00:00.000Z' })
    const loaded = await loadState(statePath())
    expect(loaded.lastInvoiceId).toBe(42)
    expect(loaded.lastPolledAt).toBe('2026-07-02T00:00:00.000Z')
  })

  it('writes pretty JSON with a trailing newline', async () => {
    await saveState(statePath(), { lastInvoiceId: 7 })
    const raw = await readFile(statePath(), 'utf8')
    expect(raw.endsWith('}\n')).toBe(true)
    expect(raw).toContain('"lastInvoiceId": 7')
  })

  it('throws IoError on corrupt JSON rather than silently resetting', async () => {
    await writeFile(statePath(), 'not json{')
    await expect(loadState(statePath())).rejects.toBeInstanceOf(IoError)
  })

  it('throws IoError when lastInvoiceId is missing or wrong-typed', async () => {
    await writeFile(statePath(), JSON.stringify({ lastPolledAt: 'x' }))
    await expect(loadState(statePath())).rejects.toBeInstanceOf(IoError)
  })
})
