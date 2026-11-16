import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Beliq } from '@beliq/sdk'
import type { Config } from '../src/config.js'
import { makeBeliqClient } from '../src/beliq.js'
import { pollOnce } from '../src/worker.js'
import { loadState } from '../src/state.js'
import { fakeSevdesk, recordingLogger, validResult } from './helpers.js'

// The worker against a real SDK client and a real beliq stand-in on 127.0.0.1.
// sevDesk is the hand-rolled fake: only the beliq side is under test here.

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'beliq-sevdesk-outage-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function config(beliqBaseUrl: string): Config {
  return {
    sevdeskToken: 'tok',
    sevdeskBaseUrl: 'https://api.example.test/api/v1',
    beliqApiKey: 'blq_test_outage',
    beliqBaseUrl,
    beliqAuth: 'header',
    targetFormats: [],
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
    notifyWebhook: undefined,
    notifyOn: 'failure',
  }
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void

async function withApi<T>(handler: Handler, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server: Server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function databaseUnavailable(res: ServerResponse, retryAfterSeconds: number): void {
  res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfterSeconds) })
  res.end(JSON.stringify({ success: false, error: { code: 'DATABASE_UNAVAILABLE', message: 'database unavailable' } }))
}

function valid(res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ success: true, data: validResult() }))
}

describe('a poll during a beliq outage (real SDK, real server)', () => {
  it('rides an outage shorter than the retry budget and checks the invoice', async () => {
    let requests = 0
    const { log, eventsNamed } = recordingLogger()
    const { counts } = await withApi(
      (_req, res) => {
        requests++
        if (requests <= 2) return databaseUnavailable(res, 1)
        valid(res)
      },
      async (baseUrl) => {
        const cfg = config(baseUrl)
        return pollOnce(cfg, { sevdesk: fakeSevdesk({ invoices: [{ id: '10' }] }), beliq: makeBeliqClient(cfg), log })
      },
    )
    expect(requests).toBe(3)
    expect(counts).toMatchObject({ valid: 1, error: 0 })
    expect(eventsNamed('poll.outage')).toEqual([])
    expect([...(await loadState(join(dir, 'state.json'))).processedIds]).toEqual(['10'])
  }, 10_000)

  it('stops the poll once an outage outlasts the budget, and leaves every invoice for the next poll', async () => {
    let requests = 0
    const sevdesk = fakeSevdesk({ invoices: [{ id: '10' }, { id: '11' }] })
    const { log, eventsNamed } = recordingLogger()
    const { counts } = await withApi(
      (_req, res) => {
        requests++
        databaseUnavailable(res, 1)
      },
      async (baseUrl) => {
        // A 2.5-second budget stands in for the default 15 minutes.
        const beliq = new Beliq({ apiKey: 'blq_test_outage', baseUrl, retryBudgetMs: 2_500 })
        return pollOnce(config(baseUrl), { sevdesk, beliq, log })
      },
    )
    expect(requests).toBeGreaterThan(1)
    expect(sevdesk.xmlCalls).toEqual(['10'])
    expect(counts.error).toBe(1)
    expect(eventsNamed('poll.outage').map((e) => e.fields)).toEqual([{ unprocessed: 1 }])
  }, 10_000)

  it('ends a 30-second retry wait at once when told to stop', async () => {
    const stop = new AbortController()
    const { log, eventsNamed } = recordingLogger()
    const started = performance.now()
    const { counts } = await withApi(
      (_req, res) => {
        databaseUnavailable(res, 30)
        setTimeout(() => stop.abort(), 50)
      },
      async (baseUrl) => {
        const cfg = config(baseUrl)
        return pollOnce(cfg, {
          sevdesk: fakeSevdesk({ invoices: [{ id: '10' }] }),
          beliq: makeBeliqClient(cfg),
          log,
          stop: stop.signal,
        })
      },
    )
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(counts).toMatchObject({ valid: 0, error: 0 })
    expect(eventsNamed('poll.stopped').map((e) => e.fields)).toEqual([{ unprocessed: 1 }])
  })
})
