import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../src/config.js'
import { makeBeliqClient } from '../src/beliq.js'
import { pollOnce } from '../src/worker.js'
import { fakeSevdesk, recordingLogger } from './helpers.js'

// The real @beliq/sdk against a local HTTP server that answers the way the beliq
// API does. What is under test is which answers end an invoice for good and
// which leave it for the next poll, so the SDK's own error mapping has to be in
// the loop: a fake client throwing a hand-built error would not prove it.

interface Answer {
  status: number
  body: string
  headers?: Record<string, string>
}

const ok = (data: unknown): Answer => ({
  status: 200,
  body: JSON.stringify({ success: true, data }),
  headers: { 'content-type': 'application/json' },
})
const refuse = (status: number, code: string): Answer => ({
  status,
  body: JSON.stringify({ success: false, error: { code, message: `stub ${code}` } }),
  headers: { 'content-type': 'application/json' },
})
const VALID = ok({ valid: true, errors: [], warnings: [] })
const INVALID = ok({ valid: false, errors: [{ ruleId: 'STUB-1', message: 'stub' }], warnings: [] })
const CONVERTED: Answer = { status: 200, body: '<converted/>', headers: { 'content-type': 'application/xml' } }

let dir: string
let server: Server
let baseUrl: string
let hits: string[]
let answer: (path: string, target: string | null) => Answer

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'beliq-sevdesk-refusal-'))
  hits = []
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub')
    req.resume()
    req.on('end', () => {
      const target = url.searchParams.get('targetFormat')
      hits.push(target ? `${url.pathname}:${target}` : url.pathname)
      const a = answer(url.pathname, target)
      res.writeHead(a.status, a.headers)
      res.end(a.body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve))
  await rm(dir, { recursive: true, force: true })
})

function config(over: Partial<Config> = {}): Config {
  return {
    sevdeskToken: 'tok',
    sevdeskBaseUrl: 'https://api.example.test/api/v1',
    beliqApiKey: 'key',
    beliqBaseUrl: baseUrl,
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

async function poll(cfg = config()) {
  const r = recordingLogger()
  const res = await pollOnce(cfg, {
    sevdesk: fakeSevdesk({ invoices: [{ id: '10' }] }),
    beliq: makeBeliqClient(cfg),
    log: r.log,
  })
  return { ...res, ...r }
}

async function processedIds(): Promise<string[]> {
  try {
    return JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).processedIds
  } catch {
    return []
  }
}

describe('a beliq answer about the document ends the invoice', () => {
  it.each([
    [422, 'VALIDATION_ERROR'],
    [422, 'INVALID_INVOICE'],
    [413, 'VALIDATION_ERROR'],
    [400, 'PARSE_FAILED'],
  ])('validate %i %s is reported once and not asked again', async (status, code) => {
    answer = () => refuse(status, code)

    const first = await poll()
    expect(first.counts).toEqual({ valid: 0, invalid: 0, error: 1, skipped: 0 })
    expect(first.eventsNamed('validate.refused')[0].fields).toMatchObject({ id: '10', status, code })
    expect(await processedIds()).toEqual(['10'])

    hits = []
    const second = await poll()
    expect(hits).toEqual([])
    expect(second.counts).toEqual({ valid: 0, invalid: 0, error: 0, skipped: 0 })
  })

  it('a refused conversion of a valid document is an error, with the verdict kept in the log', async () => {
    answer = (path) => (path === '/v1/validate' ? VALID : refuse(422, 'CONVERSION_LOSSY_FAILCLOSED'))

    const first = await poll()
    expect(hits).toEqual(['/v1/validate', '/v1/convert:ubl'])
    expect(first.counts).toEqual({ valid: 0, invalid: 0, error: 1, skipped: 0 })
    expect(first.eventsNamed('validate')[0].fields).toMatchObject({ id: '10', valid: true })
    expect(first.eventsNamed('convert.refused')[0].fields).toMatchObject({
      id: '10',
      target: 'ubl',
      status: 422,
      code: 'CONVERSION_LOSSY_FAILCLOSED',
    })
    expect(await processedIds()).toEqual(['10'])

    hits = []
    await poll()
    expect(hits).toEqual([])
  })

  it('a refused conversion of an invalid document stays invalid', async () => {
    answer = (path) => (path === '/v1/validate' ? INVALID : refuse(422, 'VALIDATION_ERROR'))

    const first = await poll()
    expect(first.counts).toEqual({ valid: 0, invalid: 1, error: 0, skipped: 0 })
    expect(await processedIds()).toEqual(['10'])
  })

  it('one refused target does not stop the other target from being written', async () => {
    answer = (path, target) => {
      if (path === '/v1/validate') return VALID
      return target === 'cii' ? refuse(422, 'CONVERSION_UNSUPPORTED_PAIR') : CONVERTED
    }

    const first = await poll(config({ targetFormats: ['cii', 'ubl'] }))
    expect(hits).toEqual(['/v1/validate', '/v1/convert:cii', '/v1/convert:ubl'])
    expect(first.counts).toEqual({ valid: 0, invalid: 0, error: 1, skipped: 0 })
    expect(await readdir(join(dir, 'out'))).toEqual(['10-ubl.xml'])
  })
})

describe('a beliq answer about the caller leaves the invoice for the next poll', () => {
  it.each([
    [429, 'QUOTA_EXCEEDED'],
    [403, 'INVALID_API_KEY'],
    [401, 'AUTHENTICATION_REQUIRED'],
    [400, 'VALIDATION_ERROR'],
    [500, 'INTERNAL_ERROR'],
  ])('validate %i %s is retried', async (status, code) => {
    answer = () => refuse(status, code)

    const first = await poll()
    expect(first.counts).toEqual({ valid: 0, invalid: 0, error: 1, skipped: 0 })
    expect(first.eventsNamed('invoice.error')).toHaveLength(1)
    expect(first.eventsNamed('validate.refused')).toHaveLength(0)
    expect(await processedIds()).toEqual([])

    answer = (path) => (path === '/v1/validate' ? VALID : CONVERTED)
    const second = await poll()
    expect(second.counts).toEqual({ valid: 1, invalid: 0, error: 0, skipped: 0 })
    expect(await processedIds()).toEqual(['10'])
  })

  it('a conversion stopped by a spent quota is retried, verdict and all', async () => {
    answer = (path) => (path === '/v1/validate' ? VALID : refuse(429, 'QUOTA_EXCEEDED'))

    const first = await poll()
    expect(first.counts).toEqual({ valid: 0, invalid: 0, error: 1, skipped: 0 })
    expect(await processedIds()).toEqual([])

    hits = []
    answer = (path) => (path === '/v1/validate' ? VALID : CONVERTED)
    const second = await poll()
    expect(hits).toEqual(['/v1/validate', '/v1/convert:ubl'])
    expect(second.counts).toEqual({ valid: 1, invalid: 0, error: 0, skipped: 0 })
    expect(await readdir(join(dir, 'out'))).toEqual(['10-ubl.xml'])
  })
})
