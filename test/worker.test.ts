import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../src/config.js'
import type { SevDesk } from '../src/sevdesk.js'
import { SevDeskClient } from '../src/sevdesk.js'
import { pollOnce, runWorker } from '../src/worker.js'
import { EXIT } from '../src/exit.js'
import { IoError, SevDeskApiError } from '../src/errors.js'
import {
  fakeBeliq,
  fakeSevdesk,
  recordingLogger,
  recordingFetch,
  validResult,
  invalidResult,
  sevdeskFetch,
} from './helpers.js'

const dec = new TextDecoder()
const FIXED_NOW = 1_750_000_000_000

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'beliq-sevdesk-worker-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function baseConfig(over: Partial<Config> = {}): Config {
  return {
    sevdeskToken: 'tok',
    sevdeskBaseUrl: 'https://api.example.test/api/v1',
    beliqApiKey: 'key',
    beliqBaseUrl: 'https://api.beliq.eu',
    beliqAuth: 'header',
    targetFormats: ['ubl'],
    targetProfile: undefined,
    status: '200',
    pollWindowDays: 30,
    stateFile: join(dir, 'state.json'),
    outputDir: join(dir, 'out'),
    intervalSeconds: 300,
    pageSize: 100,
    maxRetries: 2,
    once: true,
    dryRun: false,
    notifyOn: 'failure',
    ...over,
  }
}

async function outFiles(): Promise<string[]> {
  try {
    return (await readdir(join(dir, 'out'))).sort()
  } catch {
    return []
  }
}

async function readState(): Promise<{ processedIds: string[]; lastInvoiceId?: number; lastPolledAt?: string }> {
  return JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
}

describe('pollOnce pipeline', () => {
  it('processes fresh invoices, writes converted files, records them as processed', async () => {
    const sd = fakeSevdesk({ invoices: [{ id: '11', invoiceNumber: 'INV-11' }, { id: '10', invoiceNumber: 'INV-10' }] })
    const { client, calls } = fakeBeliq()
    const { log } = recordingLogger()

    const res = await pollOnce(baseConfig(), { sevdesk: sd, beliq: client, log, now: () => FIXED_NOW })

    expect(res.counts).toEqual({ valid: 2, invalid: 0, error: 0, skipped: 0 })
    // Converted files, named by invoice number + target, written to the output dir.
    expect(await outFiles()).toEqual(['INV-10-ubl.xml', 'INV-11-ubl.xml'])
    expect(dec.decode(await readFile(join(dir, 'out', 'INV-11-ubl.xml')))).toContain('target="ubl"')
    const state = await readState()
    expect(state.processedIds).toEqual(['10', '11'])
    expect(state.lastPolledAt).toBe(new Date(FIXED_NOW).toISOString())
    // Per invoice in id order: the verdict first, then the conversion.
    expect(calls.map((c) => `${c.method}:${c.doc}`)).toEqual([
      'validate:<invoice id="10"/>',
      'convert:<invoice id="10"/>',
      'validate:<invoice id="11"/>',
      'convert:<invoice id="11"/>',
    ])
  })

  it('dedupes: a second poll against the same state processes nothing new', async () => {
    const invoices = [{ id: '10' }, { id: '11' }]
    const cfg = baseConfig()
    const first = fakeSevdesk({ invoices })
    const b1 = fakeBeliq()
    await pollOnce(cfg, { sevdesk: first, beliq: b1.client, log: recordingLogger().log, now: () => FIXED_NOW })

    const second = fakeSevdesk({ invoices })
    const b2 = fakeBeliq()
    const res = await pollOnce(cfg, { sevdesk: second, beliq: b2.client, log: recordingLogger().log, now: () => FIXED_NOW })

    expect(res.counts).toEqual({ valid: 0, invalid: 0, error: 0, skipped: 0 })
    expect(second.xmlCalls).toEqual([])
    expect(b2.calls).toHaveLength(0)
    expect((await readState()).processedIds).toEqual(['10', '11'])
  })

  it('classifies an invalid document and does not ask about it again', async () => {
    const sd = fakeSevdesk({ invoices: [{ id: '10' }, { id: '11' }] })
    const { client } = fakeBeliq({
      validate: (doc) => (dec.decode(doc).includes('id="11"') ? invalidResult() : validResult()),
    })
    const res = await pollOnce(baseConfig(), { sevdesk: sd, beliq: client, log: recordingLogger().log, now: () => FIXED_NOW })

    expect(res.counts).toEqual({ valid: 1, invalid: 1, error: 0, skipped: 0 })
    expect((await readState()).processedIds).toEqual(['10', '11'])
  })

  it('an errored invoice is retried next poll and does not hold back the ones after it', async () => {
    const invoices = [{ id: '10' }, { id: '11' }, { id: '12' }]
    const sd = fakeSevdesk({ invoices, failXmlFor: new Set(['11']) })
    const { log, eventsNamed } = recordingLogger()

    const res = await pollOnce(baseConfig(), { sevdesk: sd, beliq: fakeBeliq().client, log, now: () => FIXED_NOW })

    expect(res.counts).toEqual({ valid: 2, invalid: 0, error: 1, skipped: 0 })
    expect((await readState()).processedIds).toEqual(['10', '12'])
    expect(eventsNamed('invoice.error')).toHaveLength(1)

    const second = fakeSevdesk({ invoices })
    const again = await pollOnce(baseConfig(), {
      sevdesk: second,
      beliq: fakeBeliq().client,
      log: recordingLogger().log,
      now: () => FIXED_NOW,
    })
    expect(second.xmlCalls).toEqual(['11'])
    expect(again.counts).toEqual({ valid: 1, invalid: 0, error: 0, skipped: 0 })
    expect((await readState()).processedIds).toEqual(['10', '11', '12'])
  })

  it('processes a draft that is opened after a later invoice was processed', async () => {
    const cfg = baseConfig()
    // Invoice 10 exists as a draft, so the Open listing does not show it yet.
    const first = fakeSevdesk({ invoices: [{ id: '11' }] })
    await pollOnce(cfg, { sevdesk: first, beliq: fakeBeliq().client, log: recordingLogger().log, now: () => FIXED_NOW })

    const second = fakeSevdesk({ invoices: [{ id: '10' }, { id: '11' }] })
    const res = await pollOnce(cfg, {
      sevdesk: second,
      beliq: fakeBeliq().client,
      log: recordingLogger().log,
      now: () => FIXED_NOW,
    })

    expect(second.xmlCalls).toEqual(['10'])
    expect(res.counts).toEqual({ valid: 1, invalid: 0, error: 0, skipped: 0 })
  })

  it('keeps processed ids that a later, shorter listing leaves out', async () => {
    const cfg = baseConfig()
    const all = [{ id: '10' }, { id: '11' }]
    await pollOnce(cfg, { sevdesk: fakeSevdesk({ invoices: all }), beliq: fakeBeliq().client, log: recordingLogger().log })
    await pollOnce(cfg, { sevdesk: fakeSevdesk({ invoices: [] }), beliq: fakeBeliq().client, log: recordingLogger().log })

    const third = fakeSevdesk({ invoices: all })
    const res = await pollOnce(cfg, { sevdesk: third, beliq: fakeBeliq().client, log: recordingLogger().log })

    expect(third.xmlCalls).toEqual([])
    expect(res.counts).toEqual({ valid: 0, invalid: 0, error: 0, skipped: 0 })
  })

  it('processes an invoice once when two pages return it', async () => {
    const sd = fakeSevdesk({ invoices: [{ id: '10' }, { id: '11' }, { id: '10' }] })
    const res = await pollOnce(baseConfig(), { sevdesk: sd, beliq: fakeBeliq().client, log: recordingLogger().log })

    expect(sd.xmlCalls).toEqual(['10', '11'])
    expect(res.counts).toEqual({ valid: 2, invalid: 0, error: 0, skipped: 0 })
  })

  it('skips an invoice that is not an e-invoice, once, and does not fail the run', async () => {
    const invoices = [{ id: '10' }, { id: '11' }]
    const sd = fakeSevdesk({ invoices, notEInvoice: new Set(['10']) })
    const { client, calls } = fakeBeliq()
    const { log, eventsNamed, summaries } = recordingLogger()

    const code = await runWorker(baseConfig(), { sevdesk: sd, beliq: client, log, now: () => FIXED_NOW })

    expect(code).toBe(EXIT.OK)
    expect(summaries).toEqual(['processed 2 invoice(s): 1 valid, 0 invalid, 0 error, 1 skipped'])
    expect(eventsNamed('invoice.skipped')[0].fields).toEqual({ id: '10', number: undefined, reason: 'not an e-invoice' })
    // beliq was never asked about the invoice sevDesk holds no XML for.
    expect(calls.every((c) => c.doc.includes('id="11"'))).toBe(true)
    expect(await outFiles()).toEqual(['11-ubl.xml'])
    expect((await readState()).processedIds).toEqual(['10', '11'])

    const second = fakeSevdesk({ invoices, notEInvoice: new Set(['10']) })
    const again = await pollOnce(baseConfig(), { sevdesk: second, beliq: fakeBeliq().client, log: recordingLogger().log })
    expect(second.xmlCalls).toEqual([])
    expect(again.counts).toEqual({ valid: 0, invalid: 0, error: 0, skipped: 0 })
  })

  it('names a converted file by what beliq sent back, not by the target', async () => {
    const enc = new TextEncoder()
    const sd = fakeSevdesk({ invoices: [{ id: '10' }] })
    // From an XML source beliq answers a zugferd conversion with XML; a PDF comes
    // back only for a PDF source.
    const { client } = fakeBeliq({
      convert: (_doc, targetFormat) => ({
        contentType: targetFormat === 'facturx' ? 'application/pdf' : 'application/xml',
        bytes: enc.encode(targetFormat === 'facturx' ? '%PDF-1.7' : '<cii/>'),
        meta: { sourceFormat: 'cii', targetFormat, lostElementsCount: 0 },
      }),
    })
    const { log, eventsNamed } = recordingLogger()

    await pollOnce(baseConfig({ targetFormats: ['zugferd', 'facturx'] }), { sevdesk: sd, beliq: client, log })

    expect(await outFiles()).toEqual(['10-facturx.pdf', '10-zugferd.xml'])
    expect(eventsNamed('convert').map((e) => e.fields?.file)).toEqual(['10-zugferd.xml', '10-facturx.pdf'])
  })

  it('runs validation-only when no target formats are configured', async () => {
    const sd = fakeSevdesk({ invoices: [{ id: '10' }] })
    const { client, calls } = fakeBeliq()
    const res = await pollOnce(baseConfig({ targetFormats: [] }), {
      sevdesk: sd,
      beliq: client,
      log: recordingLogger().log,
      now: () => FIXED_NOW,
    })
    expect(res.counts.valid).toBe(1)
    expect(calls.filter((c) => c.method === 'convert')).toHaveLength(0)
    expect(await outFiles()).toEqual([])
  })

  it('dry-run walks the pipeline but writes no files and persists no state', async () => {
    const sd = fakeSevdesk({ invoices: [{ id: '10' }] })
    const { client, calls } = fakeBeliq()
    const { log, eventsNamed } = recordingLogger()
    const res = await pollOnce(baseConfig({ dryRun: true }), { sevdesk: sd, beliq: client, log, now: () => FIXED_NOW })

    expect(res.counts.valid).toBe(1)
    expect(calls.filter((c) => c.method === 'convert')).toHaveLength(1)
    expect(calls.filter((c) => c.method === 'validate')).toHaveLength(1)
    expect(await outFiles()).toEqual([])
    expect(eventsNamed('convert.dryRun')).toHaveLength(1)
    await expect(readState()).rejects.toBeTruthy() // no state file written
  })

  it('omits the date filter when the poll window is 0', async () => {
    const sd = fakeSevdesk({ invoices: [{ id: '1' }] })
    const { client } = fakeBeliq()
    // pollWindowDays 0 means startDate is undefined; the fake ignores it, but this
    // exercises the branch without a thrown clock dependency.
    const res = await pollOnce(baseConfig({ pollWindowDays: 0 }), {
      sevdesk: sd,
      beliq: client,
      log: recordingLogger().log,
      now: () => FIXED_NOW,
    })
    expect(res.counts.valid).toBe(1)
  })
})

describe('notify webhook', () => {
  const WEBHOOK = 'https://hooks.example.test/beliq'

  it('notifyOn=failure POSTs a failure report when an invoice fails', async () => {
    const sd = fakeSevdesk({ invoices: [{ id: '10', invoiceNumber: 'INV-10' }, { id: '11', invoiceNumber: 'INV-11' }] })
    const { client } = fakeBeliq({
      validate: (doc) => (dec.decode(doc).includes('id="11"') ? invalidResult() : validResult()),
    })
    const { fetch, requests } = recordingFetch()

    await pollOnce(baseConfig({ notifyWebhook: WEBHOOK, notifyOn: 'failure' }), {
      sevdesk: sd,
      beliq: client,
      log: recordingLogger().log,
      now: () => FIXED_NOW,
      fetch,
    })

    expect(requests).toHaveLength(1)
    const body = JSON.parse(requests[0].body)
    expect(body.ok).toBe(false)
    expect(body.counts).toEqual({ valid: 1, invalid: 1, error: 0, skipped: 0 })
    expect(body.invoices).toEqual([
      { id: '10', invoiceNumber: 'INV-10', classification: 'valid' },
      { id: '11', invoiceNumber: 'INV-11', classification: 'invalid' },
    ])
    expect(body.polledAt).toBe(new Date(FIXED_NOW).toISOString())
  })

  it('notifyOn=failure stays silent when every invoice is valid', async () => {
    const sd = fakeSevdesk({ invoices: [{ id: '10' }] })
    const { fetch, requests } = recordingFetch()
    await pollOnce(baseConfig({ notifyWebhook: WEBHOOK, notifyOn: 'failure' }), {
      sevdesk: sd,
      beliq: fakeBeliq().client,
      log: recordingLogger().log,
      now: () => FIXED_NOW,
      fetch,
    })
    expect(requests).toHaveLength(0)
  })

  it('notifyOn=failure stays silent when the only other invoice was skipped', async () => {
    const sd = fakeSevdesk({ invoices: [{ id: '10' }, { id: '11' }], notEInvoice: new Set(['10']) })
    const { fetch, requests } = recordingFetch()
    await pollOnce(baseConfig({ notifyWebhook: WEBHOOK, notifyOn: 'failure' }), {
      sevdesk: sd,
      beliq: fakeBeliq().client,
      log: recordingLogger().log,
      now: () => FIXED_NOW,
      fetch,
    })
    expect(requests).toHaveLength(0)
  })

  it('notifyOn=always POSTs an ok report even when nothing failed', async () => {
    const sd = fakeSevdesk({ invoices: [{ id: '10' }] })
    const { fetch, requests } = recordingFetch()
    await pollOnce(baseConfig({ notifyWebhook: WEBHOOK, notifyOn: 'always' }), {
      sevdesk: sd,
      beliq: fakeBeliq().client,
      log: recordingLogger().log,
      now: () => FIXED_NOW,
      fetch,
    })
    expect(requests).toHaveLength(1)
    expect(JSON.parse(requests[0].body).ok).toBe(true)
  })

  it('does not notify in a dry run', async () => {
    const sd = fakeSevdesk({ invoices: [{ id: '10' }] })
    const { fetch, requests } = recordingFetch()
    await pollOnce(baseConfig({ notifyWebhook: WEBHOOK, notifyOn: 'always', dryRun: true }), {
      sevdesk: sd,
      beliq: fakeBeliq().client,
      log: recordingLogger().log,
      now: () => FIXED_NOW,
      fetch,
    })
    expect(requests).toHaveLength(0)
  })

  it('a failing webhook does not change the exit code', async () => {
    const sd = fakeSevdesk({ invoices: [{ id: '10' }] })
    const { fetch } = recordingFetch({ throwErr: new Error('webhook down') })
    const { log, eventsNamed } = recordingLogger()
    const code = await runWorker(baseConfig({ notifyWebhook: WEBHOOK, notifyOn: 'always' }), {
      sevdesk: sd,
      beliq: fakeBeliq().client,
      log,
      now: () => FIXED_NOW,
      fetch,
    })
    expect(code).toBe(EXIT.OK)
    expect(eventsNamed('notify.error')).toHaveLength(1)
  })
})

describe('runWorker --once exit codes', () => {
  const run = (sevdesk: SevDesk, cfg = baseConfig(), beliqOpts = {}) =>
    runWorker(cfg, { sevdesk, beliq: fakeBeliq(beliqOpts).client, log: recordingLogger().log, now: () => FIXED_NOW })

  it('returns OK when every invoice is valid', async () => {
    expect(await run(fakeSevdesk({ invoices: [{ id: '1' }] }))).toBe(EXIT.OK)
  })

  it('returns INVALID when a document fails validation', async () => {
    const code = await run(fakeSevdesk({ invoices: [{ id: '1' }] }), baseConfig(), { validate: () => invalidResult() })
    expect(code).toBe(EXIT.INVALID)
  })

  it('returns API when an invoice errors mid-pipeline', async () => {
    const code = await run(fakeSevdesk({ invoices: [{ id: '1' }], failXmlFor: new Set(['1']) }))
    expect(code).toBe(EXIT.API)
  })

  it('propagates a fatal listing error', async () => {
    const broken: SevDesk = {
      listInvoices: async () => {
        throw new SevDeskApiError('list down', 503)
      },
      getInvoiceXml: async () => new Uint8Array(),
    }
    await expect(
      runWorker(baseConfig(), { sevdesk: broken, beliq: fakeBeliq().client, log: recordingLogger().log }),
    ).rejects.toBeInstanceOf(SevDeskApiError)
  })
})

describe('runWorker as a daemon', () => {
  it('logs a poll sevDesk failed and runs the next one', async () => {
    const stop = new AbortController()
    let lists = 0
    const sevdesk: SevDesk = {
      listInvoices: async () => {
        lists++
        if (lists === 1) throw new SevDeskApiError('sevDesk GET /Invoice failed with status 503', 503)
        return [{ id: '10' }]
      },
      getInvoiceXml: async (id) => new TextEncoder().encode(`<invoice id="${id}"/>`),
    }
    let sleeps = 0
    const { log, eventsNamed } = recordingLogger()

    const code = await runWorker(baseConfig({ once: false }), {
      sevdesk,
      beliq: fakeBeliq().client,
      log,
      now: () => FIXED_NOW,
      stop: stop.signal,
      sleep: async () => {
        sleeps++
        if (sleeps === 2) stop.abort()
      },
    })

    expect(code).toBe(EXIT.OK)
    expect(lists).toBe(2)
    expect(eventsNamed('poll.error').map((e) => e.fields)).toEqual([
      { status: 503, message: 'sevDesk GET /Invoice failed with status 503' },
    ])
    expect((await readState()).processedIds).toEqual(['10'])
  })

  it('ends on a local fault that polling again cannot fix', async () => {
    await writeFile(join(dir, 'state.json'), 'not json{')
    await expect(
      runWorker(baseConfig({ once: false }), {
        sevdesk: fakeSevdesk({ invoices: [{ id: '10' }] }),
        beliq: fakeBeliq().client,
        log: recordingLogger().log,
        sleep: async () => {},
      }),
    ).rejects.toBeInstanceOf(IoError)
  })

  it('wakes from the wait between polls when told to stop', async () => {
    const stop = new AbortController()
    const sd = fakeSevdesk({ invoices: [{ id: '10' }] })
    setTimeout(() => stop.abort(), 20)

    const code = await runWorker(baseConfig({ once: false, intervalSeconds: 3600 }), {
      sevdesk: sd,
      beliq: fakeBeliq().client,
      log: recordingLogger().log,
      stop: stop.signal,
    })

    expect(code).toBe(EXIT.OK)
    expect(sd.listCalls).toBe(1)
  })

  it('told to stop mid-poll, finishes the invoice in hand, saves it and leaves the rest', async () => {
    const stop = new AbortController()
    const sd = fakeSevdesk({ invoices: [{ id: '10' }, { id: '11' }] })
    const { client } = fakeBeliq({
      validate: () => {
        stop.abort()
        return validResult()
      },
    })
    const { log, eventsNamed, summaries } = recordingLogger()

    const code = await runWorker(baseConfig({ once: false }), { sevdesk: sd, beliq: client, log, stop: stop.signal })

    expect(code).toBe(EXIT.OK)
    expect(sd.xmlCalls).toEqual(['10'])
    expect(await outFiles()).toEqual(['10-ubl.xml'])
    expect((await readState()).processedIds).toEqual(['10'])
    expect(eventsNamed('poll.stopped').map((e) => e.fields)).toEqual([{ unprocessed: 1 }])
    expect(summaries).toEqual(['processed 1 invoice(s): 1 valid, 0 invalid, 0 error, 0 skipped'])
  })
})

describe('runWorker with the real SevDeskClient (injected fetch)', () => {
  it('walks pages and getXml through the real client', async () => {
    const invoices = [{ id: '1' }, { id: '2' }, { id: '3' }]
    const fetchImpl = sevdeskFetch({ invoices })
    const sevdesk = new SevDeskClient({
      token: 'tok',
      baseUrl: 'https://api.example.test/api/v1',
      fetch: fetchImpl,
      sleep: async () => {},
    })
    const cfg = baseConfig({ pageSize: 2 })
    const code = await runWorker(cfg, {
      sevdesk,
      beliq: fakeBeliq().client,
      log: recordingLogger().log,
      now: () => FIXED_NOW,
    })
    expect(code).toBe(EXIT.OK)
    expect(await outFiles()).toEqual(['1-ubl.xml', '2-ubl.xml', '3-ubl.xml'])
    expect((await readState()).processedIds).toEqual(['1', '2', '3'])
  })
})

describe('a normal invoice through the real SevDeskClient', () => {
  it('turns sevDesk\'s recorded getXml answer into a skip, not an error', async () => {
    const sevdesk = new SevDeskClient({
      token: 'tok',
      baseUrl: 'https://api.example.test/api/v1',
      fetch: sevdeskFetch({ invoices: [{ id: '1' }, { id: '2' }], notEInvoice: new Set(['1']) }),
      sleep: async () => {},
    })
    const { log, summaries } = recordingLogger()

    const code = await runWorker(baseConfig(), { sevdesk, beliq: fakeBeliq().client, log, now: () => FIXED_NOW })

    expect(code).toBe(EXIT.OK)
    expect(summaries).toEqual(['processed 2 invoice(s): 1 valid, 0 invalid, 0 error, 1 skipped'])
    expect(await outFiles()).toEqual(['2-ubl.xml'])
    expect((await readState()).processedIds).toEqual(['1', '2'])
  })
})

describe('a state file written before 0.3.0', () => {
  const writeLegacy = (lastInvoiceId: number) =>
    writeFile(join(dir, 'state.json'), JSON.stringify({ lastInvoiceId, lastPolledAt: '2026-09-01T00:00:00.000Z' }))

  it('counts listed invoices at or below the mark as processed and rewrites the file', async () => {
    await writeLegacy(11)
    const sd = fakeSevdesk({ invoices: [{ id: '10' }, { id: '11' }, { id: '12' }] })

    const res = await pollOnce(baseConfig(), { sevdesk: sd, beliq: fakeBeliq().client, log: recordingLogger().log, now: () => FIXED_NOW })

    expect(sd.xmlCalls).toEqual(['12'])
    expect(res.counts).toEqual({ valid: 1, invalid: 0, error: 0, skipped: 0 })
    const state = await readState()
    expect(state.processedIds).toEqual(['10', '11', '12'])
    expect(state.lastInvoiceId).toBeUndefined()
  })

  it('rewrites the file even when the first poll finds nothing new', async () => {
    await writeLegacy(11)
    const sd = fakeSevdesk({ invoices: [{ id: '10' }, { id: '11' }] })

    await pollOnce(baseConfig(), { sevdesk: sd, beliq: fakeBeliq().client, log: recordingLogger().log, now: () => FIXED_NOW })

    expect(sd.xmlCalls).toEqual([])
    const state = await readState()
    expect(state.processedIds).toEqual(['10', '11'])
    expect(state.lastInvoiceId).toBeUndefined()
  })

  it('after the migration, processes a lower id that was not listed at the time', async () => {
    await writeLegacy(11)
    const cfg = baseConfig()
    await pollOnce(cfg, { sevdesk: fakeSevdesk({ invoices: [{ id: '11' }] }), beliq: fakeBeliq().client, log: recordingLogger().log })

    const second = fakeSevdesk({ invoices: [{ id: '9' }, { id: '11' }] })
    await pollOnce(cfg, { sevdesk: second, beliq: fakeBeliq().client, log: recordingLogger().log })

    expect(second.xmlCalls).toEqual(['9'])
  })

  it('a dry run applies the mark but leaves the file as it was', async () => {
    await writeLegacy(11)
    const sd = fakeSevdesk({ invoices: [{ id: '10' }, { id: '12' }] })

    await pollOnce(baseConfig({ dryRun: true }), { sevdesk: sd, beliq: fakeBeliq().client, log: recordingLogger().log })

    expect(sd.xmlCalls).toEqual(['12'])
    expect((await readState()).lastInvoiceId).toBe(11)
  })
})
