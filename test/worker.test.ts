import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../src/config.js'
import type { SevDesk } from '../src/sevdesk.js'
import { SevDeskClient } from '../src/sevdesk.js'
import { pollOnce, runWorker } from '../src/worker.js'
import { EXIT } from '../src/exit.js'
import { SevDeskApiError } from '../src/errors.js'
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

async function readState(): Promise<{ lastInvoiceId: number; lastPolledAt?: string }> {
  return JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
}

describe('pollOnce pipeline', () => {
  it('processes fresh invoices, writes converted files, advances the mark', async () => {
    const sd = fakeSevdesk({ invoices: [{ id: '11', invoiceNumber: 'INV-11' }, { id: '10', invoiceNumber: 'INV-10' }] })
    const { client, calls } = fakeBeliq()
    const { log } = recordingLogger()

    const res = await pollOnce(baseConfig(), { sevdesk: sd, beliq: client, log, now: () => FIXED_NOW })

    expect(res.counts).toEqual({ valid: 2, invalid: 0, error: 0 })
    expect(res.processedTo).toBe(11)
    // Converted files, named by invoice number + target, written to the output dir.
    expect(await outFiles()).toEqual(['INV-10-ubl.xml', 'INV-11-ubl.xml'])
    expect(dec.decode(await readFile(join(dir, 'out', 'INV-11-ubl.xml')))).toContain('target="ubl"')
    // State persisted at the high-water-mark.
    const state = await readState()
    expect(state.lastInvoiceId).toBe(11)
    expect(state.lastPolledAt).toBe(new Date(FIXED_NOW).toISOString())
    // One convert + one validate per invoice.
    expect(calls.filter((c) => c.method === 'convert')).toHaveLength(2)
    expect(calls.filter((c) => c.method === 'validate')).toHaveLength(2)
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

    expect(res.counts).toEqual({ valid: 0, invalid: 0, error: 0 })
    expect(second.xmlCalls).toEqual([])
    expect(b2.calls).toHaveLength(0)
    expect((await readState()).lastInvoiceId).toBe(11)
  })

  it('classifies an invalid document but still advances past it', async () => {
    const sd = fakeSevdesk({ invoices: [{ id: '10' }, { id: '11' }] })
    const { client } = fakeBeliq({
      validate: (doc) => (dec.decode(doc).includes('id="11"') ? invalidResult() : validResult()),
    })
    const res = await pollOnce(baseConfig(), { sevdesk: sd, beliq: client, log: recordingLogger().log, now: () => FIXED_NOW })

    expect(res.counts).toEqual({ valid: 1, invalid: 1, error: 0 })
    expect((await readState()).lastInvoiceId).toBe(11)
  })

  it('an errored invoice blocks the mark so it (and later ones) are retried', async () => {
    const sd = fakeSevdesk({ invoices: [{ id: '10' }, { id: '11' }, { id: '12' }], failXmlFor: new Set(['11']) })
    const { client } = fakeBeliq()
    const { log, eventsNamed } = recordingLogger()

    const res = await pollOnce(baseConfig(), { sevdesk: sd, beliq: client, log, now: () => FIXED_NOW })

    // 10 and 12 got verdicts; 11 errored.
    expect(res.counts).toEqual({ valid: 2, invalid: 0, error: 1 })
    expect(sd.xmlCalls.sort()).toEqual(['10', '11', '12'])
    // Mark stops before the first error, so 11 and 12 come back next poll.
    expect(res.processedTo).toBe(10)
    expect((await readState()).lastInvoiceId).toBe(10)
    expect(eventsNamed('invoice.error')).toHaveLength(1)
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
    expect(body.counts).toEqual({ valid: 1, invalid: 1, error: 0 })
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
    expect((await readState()).lastInvoiceId).toBe(3)
  })
})
