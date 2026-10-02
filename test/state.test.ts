import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, writeFile, readFile } from 'node:fs/promises'
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
    const state = await loadState(statePath())
    expect([...state.processedIds]).toEqual([])
    expect(state.legacyLastInvoiceId).toBeUndefined()
  })

  it('round-trips through save and load', async () => {
    await saveState(statePath(), { processedIds: new Set(['42', '7']), lastPolledAt: '2026-07-02T00:00:00.000Z' })
    const loaded = await loadState(statePath())
    expect([...loaded.processedIds].sort()).toEqual(['42', '7'])
    expect(loaded.lastPolledAt).toBe('2026-07-02T00:00:00.000Z')
    expect(loaded.legacyLastInvoiceId).toBeUndefined()
  })

  it('writes pretty JSON, ids in numeric order, with a trailing newline', async () => {
    await saveState(statePath(), { processedIds: new Set(['100', '9', '20']) })
    const raw = await readFile(statePath(), 'utf8')
    expect(raw.endsWith('}\n')).toBe(true)
    expect(JSON.parse(raw).processedIds).toEqual(['9', '20', '100'])
  })

  it('leaves no partial file behind', async () => {
    await saveState(statePath(), { processedIds: new Set(['1']) })
    expect(await readdir(dir)).toEqual(['state.json'])
  })

  it('keeps the previous file whole when a write fails', async () => {
    await saveState(statePath(), { processedIds: new Set(['1']) })
    // A directory where the partial file goes makes the write fail before the rename.
    await mkdir(`${statePath()}.tmp`)

    await expect(saveState(statePath(), { processedIds: new Set(['1', '2']) })).rejects.toBeInstanceOf(IoError)

    expect([...(await loadState(statePath())).processedIds]).toEqual(['1'])
  })

  it('reads a pre-0.3.0 file as a legacy mark with nothing processed yet', async () => {
    await writeFile(statePath(), JSON.stringify({ lastInvoiceId: 42, lastPolledAt: '2026-07-02T00:00:00.000Z' }))
    const state = await loadState(statePath())
    expect(state.legacyLastInvoiceId).toBe(42)
    expect([...state.processedIds]).toEqual([])
    expect(state.lastPolledAt).toBe('2026-07-02T00:00:00.000Z')
  })

  it('throws IoError on corrupt JSON rather than silently resetting', async () => {
    await writeFile(statePath(), 'not json{')
    await expect(loadState(statePath())).rejects.toBeInstanceOf(IoError)
  })

  it('throws IoError when the file has neither processedIds nor a legacy mark', async () => {
    await writeFile(statePath(), JSON.stringify({ lastPolledAt: 'x' }))
    await expect(loadState(statePath())).rejects.toBeInstanceOf(IoError)
  })

  it('throws IoError when processedIds is not a list of strings', async () => {
    await writeFile(statePath(), JSON.stringify({ processedIds: [1, 2] }))
    await expect(loadState(statePath())).rejects.toBeInstanceOf(IoError)
    await writeFile(statePath(), JSON.stringify({ processedIds: '1,2' }))
    await expect(loadState(statePath())).rejects.toBeInstanceOf(IoError)
  })

  it('throws IoError on a truncated file', async () => {
    await writeFile(statePath(), '{"processedIds": ["1", "2"')
    await expect(loadState(statePath())).rejects.toBeInstanceOf(IoError)
  })
})
