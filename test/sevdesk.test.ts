import { describe, it, expect } from 'vitest'
import { SevDeskClient, extractXml } from '../src/sevdesk.js'
import { SevDeskApiError } from '../src/errors.js'

const noSleep = async () => {}
const dec = new TextDecoder()

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function client(fetchImpl: typeof fetch, over: Partial<ConstructorParameters<typeof SevDeskClient>[0]> = {}) {
  return new SevDeskClient({
    token: 'tok-123',
    baseUrl: 'https://api.example.test/api/v1',
    fetch: fetchImpl,
    sleep: noSleep,
    maxRetries: 3,
    baseRetryDelayMs: 1,
    ...over,
  })
}

describe('SevDeskClient.listInvoices', () => {
  it('returns a single page and normalizes ids to strings', async () => {
    const c = client((async () => json({ objects: [{ id: 5, invoiceNumber: 100, status: 200 }] })) as any)
    const invoices = await c.listInvoices({ status: '200' })
    expect(invoices).toHaveLength(1)
    expect(invoices[0].id).toBe('5')
    expect(invoices[0].invoiceNumber).toBe('100')
    expect(invoices[0].status).toBe('200')
  })

  it('sends the token and query params', async () => {
    let seenUrl = ''
    let seenAuth: string | null = null
    const fetchImpl = (async (url: any, init: any) => {
      seenUrl = String(url)
      seenAuth = new Headers(init.headers).get('authorization')
      return json({ objects: [] })
    }) as any
    await client(fetchImpl).listInvoices({ status: '200', startDate: 1700000000, pageSize: 50 })
    expect(seenAuth).toBe('tok-123')
    expect(seenUrl).toContain('/Invoice?')
    expect(seenUrl).toContain('status=200')
    expect(seenUrl).toContain('startDate=1700000000')
    expect(seenUrl).toContain('limit=50')
  })

  it('walks pages until a short page ends it', async () => {
    const offsets: number[] = []
    const fetchImpl = (async (url: any) => {
      const u = new URL(String(url))
      const offset = Number(u.searchParams.get('offset'))
      offsets.push(offset)
      // 3 total across a page size of 2: [0,1], [2] -> stop.
      const all = [{ id: 1 }, { id: 2 }, { id: 3 }]
      return json({ objects: all.slice(offset, offset + 2) })
    }) as any
    const invoices = await client(fetchImpl).listInvoices({ pageSize: 2 })
    expect(invoices.map((i) => i.id)).toEqual(['1', '2', '3'])
    expect(offsets).toEqual([0, 2])
  })
})

describe('SevDeskClient retry/backoff', () => {
  it('retries a 429 then succeeds', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return calls < 3 ? json({ error: 'rate' }, 429) : json({ objects: [{ id: 9 }] })
    }) as any
    const invoices = await client(fetchImpl).listInvoices({})
    expect(calls).toBe(3)
    expect(invoices[0].id).toBe('9')
  })

  it('does not retry a 400 and throws SevDeskApiError', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return json({ error: 'bad' }, 400)
    }) as any
    await expect(client(fetchImpl).listInvoices({})).rejects.toBeInstanceOf(SevDeskApiError)
    expect(calls).toBe(1)
  })

  it('retries a network error then throws after exhausting attempts', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      throw new Error('ECONNRESET')
    }) as any
    await expect(client(fetchImpl, { maxRetries: 2 }).listInvoices({})).rejects.toBeInstanceOf(SevDeskApiError)
    expect(calls).toBe(3) // initial + 2 retries
  })

  it('throws when the list envelope has no objects array', async () => {
    const fetchImpl = (async () => json({ nope: true })) as any
    await expect(client(fetchImpl).listInvoices({})).rejects.toBeInstanceOf(SevDeskApiError)
  })
})

describe('SevDeskClient.getInvoiceXml', () => {
  it('reads XML from an { objects: { content } } envelope', async () => {
    const fetchImpl = (async () => json({ objects: { content: '<invoice id="7"/>', base64: false } })) as any
    const bytes = await client(fetchImpl).getInvoiceXml('7')
    expect(dec.decode(bytes)).toBe('<invoice id="7"/>')
  })

  it('decodes a base64 payload', async () => {
    const b64 = Buffer.from('<invoice id="8"/>').toString('base64')
    const fetchImpl = (async () => json({ objects: { content: b64, base64: true } })) as any
    const bytes = await client(fetchImpl).getInvoiceXml('8')
    expect(dec.decode(bytes)).toBe('<invoice id="8"/>')
  })

  it('encodes the id into the path', async () => {
    let seen = ''
    const fetchImpl = (async (url: any) => {
      seen = String(url)
      return json({ objects: '<x/>' })
    }) as any
    await client(fetchImpl).getInvoiceXml('12 34')
    expect(seen).toContain('/Invoice/12%2034/getXml')
  })
})

describe('extractXml', () => {
  it('handles a raw XML body by content-type', () => {
    expect(dec.decode(extractXml('application/xml', '<a/>'))).toBe('<a/>')
  })

  it('handles a JSON envelope whose objects is the XML string', () => {
    expect(dec.decode(extractXml('application/json', JSON.stringify({ objects: '<b/>' })))).toBe('<b/>')
  })

  it('auto-detects base64 without an explicit flag', () => {
    const b64 = Buffer.from('<c/>').toString('base64')
    expect(dec.decode(extractXml('application/json', JSON.stringify({ objects: { content: b64 } })))).toBe('<c/>')
  })

  it('throws when no XML can be located', () => {
    expect(() => extractXml('application/json', JSON.stringify({ objects: { note: 'x' } }))).toThrow(SevDeskApiError)
  })
})
