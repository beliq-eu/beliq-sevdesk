import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../src/config.js'
import { SevDeskClient } from '../src/sevdesk.js'
import { runWorker } from '../src/worker.js'
import { EXIT } from '../src/exit.js'
import { fakeBeliq, recorded, recordingLogger } from './helpers.js'

// The real SevDeskClient over real HTTP, against a local server that replays
// what a sevDesk trial account answered (test/fixtures/sevdesk/). The recorded
// list holds four Open invoices: three e-invoices and one normal invoice.

const NORMAL_INVOICE_ID = '135627289'
const TOKEN = '0123456789abcdef0123456789abcdef'

let dir: string
let server: Server
let baseUrl: string
let requests: { path: string; query: Record<string, string>; authorization?: string }[]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'beliq-sevdesk-contract-'))
  requests = []
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub')
    requests.push({
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorization: req.headers.authorization,
    })
    const answer = (name: string) => {
      const { status, contentType, body } = recorded(name)
      res.writeHead(status, { 'content-type': contentType })
      res.end(JSON.stringify(body))
    }
    if (req.headers.authorization !== TOKEN) return answer('wrong-token')
    if (url.pathname === '/api/v1/Invoice') return answer('list-open')
    const getXml = /^\/api\/v1\/Invoice\/(\d+)\/getXml$/.exec(url.pathname)
    if (!getXml) return answer('getXml-unknown-id')
    return answer(getXml[1] === NORMAL_INVOICE_ID ? 'getXml-not-an-e-invoice' : 'getXml-e-invoice')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
})
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve))
  await rm(dir, { recursive: true, force: true })
})

function config(over: Partial<Config> = {}): Config {
  return {
    sevdeskToken: TOKEN,
    sevdeskBaseUrl: baseUrl,
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
    maxRetries: 0,
    once: true,
    dryRun: false,
    notifyOn: 'failure',
    ...over,
  }
}

function client(cfg: Config): SevDeskClient {
  return new SevDeskClient({ token: cfg.sevdeskToken, baseUrl: cfg.sevdeskBaseUrl, maxRetries: cfg.maxRetries })
}

describe('the worker against recorded sevDesk answers', () => {
  it('validates and converts the three e-invoices and skips the normal invoice', async () => {
    const cfg = config()
    const { client: beliq, calls } = fakeBeliq()
    const { log, summaries } = recordingLogger()

    const code = await runWorker(cfg, { sevdesk: client(cfg), beliq, log, now: () => 1_790_000_000_000 })

    expect(code).toBe(EXIT.OK)
    expect(summaries).toEqual(['processed 4 invoice(s): 3 valid, 0 invalid, 0 error, 1 skipped'])
    // Files carry sevDesk's invoice numbers, which do not follow id order.
    expect((await readdir(join(dir, 'out'))).sort()).toEqual(['RE-1001-ubl.xml', 'RE-1003-ubl.xml', 'RE-1004-ubl.xml'])
    expect(JSON.parse(await readFile(cfg.stateFile, 'utf8')).processedIds).toEqual([
      '135627287',
      '135627289',
      '135627290',
      '135627293',
    ])
    // beliq is handed the XML exactly as sevDesk sent it inside `objects`.
    const xml = recorded('getXml-e-invoice').body.objects
    expect(calls.filter((c) => c.method === 'validate').map((c) => c.doc)).toEqual([xml, xml, xml])
    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/)
    expect(xml).toContain('urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0')
  })

  it('asks sevDesk the way its API expects', async () => {
    const cfg = config()
    await runWorker(cfg, { sevdesk: client(cfg), beliq: fakeBeliq().client, log: recordingLogger().log, now: () => 1_790_000_000_000 })

    const [list, ...xmlCalls] = requests
    expect(list.path).toBe('/api/v1/Invoice')
    expect(list.query).toEqual({ limit: '100', offset: '0', status: '200', startDate: String(1_790_000_000 - 30 * 86_400) })
    expect(xmlCalls.map((r) => r.path)).toEqual([
      '/api/v1/Invoice/135627287/getXml',
      '/api/v1/Invoice/135627289/getXml',
      '/api/v1/Invoice/135627290/getXml',
      '/api/v1/Invoice/135627293/getXml',
    ])
    expect(requests.every((r) => r.authorization === TOKEN)).toBe(true)
  })

  it('stops with an API error on a token sevDesk does not know', async () => {
    const cfg = config({ sevdeskToken: 'ffffffffffffffffffffffffffffffff' })
    await expect(
      runWorker(cfg, { sevdesk: client(cfg), beliq: fakeBeliq().client, log: recordingLogger().log }),
    ).rejects.toMatchObject({ name: 'SevDeskApiError', status: 401 })
  })
})
