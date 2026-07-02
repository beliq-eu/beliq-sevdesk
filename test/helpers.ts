import type { ConvertResult, ValidationResult } from '@beliq/sdk'
import type { BeliqClient } from '../src/beliq.js'
import type { SevDesk, SevDeskInvoice } from '../src/sevdesk.js'
import { SevDeskApiError } from '../src/errors.js'
import type { Logger } from '../src/log.js'

const enc = new TextEncoder()
const dec = new TextDecoder()

export interface LoggedEvent {
  level: 'info' | 'error'
  event: string
  fields?: Record<string, unknown>
}

/** A recording Logger: captures structured events and the human summary line(s). */
export function recordingLogger(): {
  log: Logger
  events: LoggedEvent[]
  summaries: string[]
  eventsNamed: (name: string) => LoggedEvent[]
} {
  const events: LoggedEvent[] = []
  const summaries: string[] = []
  const log: Logger = {
    info: (event, fields) => events.push({ level: 'info', event, fields }),
    error: (event, fields) => events.push({ level: 'error', event, fields }),
    summary: (line) => summaries.push(line),
  }
  return { log, events, summaries, eventsNamed: (name) => events.filter((e) => e.event === name) }
}

export function validResult(): ValidationResult {
  return {
    valid: true,
    format: 'cii',
    profileDetected: 'xrechnung',
    schematronVersion: '1.3.16',
    errors: [],
    warnings: [],
  } as unknown as ValidationResult
}

export function invalidResult(): ValidationResult {
  return {
    valid: false,
    format: 'cii',
    profileDetected: 'xrechnung',
    schematronVersion: '1.3.16',
    errors: [{ ruleId: 'BR-DE-15', severity: 'error', message: 'Buyer reference (BT-10) is missing.' }],
    warnings: [],
  } as unknown as ValidationResult
}

export interface FakeBeliqOptions {
  /** Decide a document's verdict from its bytes (defaults to valid). */
  validate?: (doc: Uint8Array) => ValidationResult
  /** Produce a convert result for a document + target (defaults to a stub XML). */
  convert?: (doc: Uint8Array, targetFormat: string) => ConvertResult
  /** Ids (matched against a `<invoice id="X"/>` body) whose validate throws. */
  throwValidateFor?: (doc: Uint8Array) => boolean
}

export interface RecordedCall {
  method: 'validate' | 'convert'
  doc: string
  options: any
}

/**
 * A fake @beliq/sdk client that records calls and returns supplied results. The
 * real Beliq satisfies BeliqClient, so worker tests drive the real pipeline,
 * classification, and file writes; only the network is doubled.
 */
export function fakeBeliq(opts: FakeBeliqOptions = {}): { client: BeliqClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const client: BeliqClient = {
    validate: async (doc, options) => {
      const bytes = doc as Uint8Array
      calls.push({ method: 'validate', doc: dec.decode(bytes), options })
      if (opts.throwValidateFor?.(bytes)) throw new Error('validate boom')
      return opts.validate ? opts.validate(bytes) : validResult()
    },
    convert: async (doc, options) => {
      const bytes = doc as Uint8Array
      calls.push({ method: 'convert', doc: dec.decode(bytes), options })
      return opts.convert
        ? opts.convert(bytes, options.targetFormat)
        : {
            contentType: 'application/xml',
            bytes: enc.encode(`<converted target="${options.targetFormat}"/>`),
            meta: { sourceFormat: 'cii', targetFormat: options.targetFormat, lostElementsCount: 0 },
          }
    },
  }
  return { client, calls }
}

export interface FakeInvoice {
  id: string
  invoiceNumber?: string
  status?: string
}

export interface FakeSevdeskOptions {
  invoices: FakeInvoice[]
  xmlFor?: (id: string) => string
  /** Ids whose getInvoiceXml throws (simulates a mid-pipeline failure). */
  failXmlFor?: Set<string>
}

/** A hand-rolled SevDesk that returns a fixed invoice set and records getXml ids. */
export function fakeSevdesk(opts: FakeSevdeskOptions): SevDesk & { xmlCalls: string[]; listCalls: number } {
  const state = { xmlCalls: [] as string[], listCalls: 0 }
  return {
    get xmlCalls() {
      return state.xmlCalls
    },
    get listCalls() {
      return state.listCalls
    },
    listInvoices: async () => {
      state.listCalls++
      return opts.invoices.map((i) => ({ ...i })) as SevDeskInvoice[]
    },
    getInvoiceXml: async (id) => {
      state.xmlCalls.push(id)
      if (opts.failXmlFor?.has(id)) throw new SevDeskApiError(`getXml boom ${id}`, 500)
      return enc.encode(opts.xmlFor ? opts.xmlFor(id) : `<invoice id="${id}"/>`)
    },
  }
}

/**
 * A fetch that mimics the sevDesk REST surface: paginated GET /Invoice and
 * GET /Invoice/{id}/getXml. Lets a test drive the REAL SevDeskClient (its
 * paging, auth header, envelope parsing) with no network.
 */
export function sevdeskFetch(opts: {
  invoices: FakeInvoice[]
  xmlFor?: (id: string) => string
  onRequest?: (url: URL, init: RequestInit | undefined) => void
}): typeof fetch {
  return (async (input: any, init?: RequestInit) => {
    const url = new URL(String(input))
    opts.onRequest?.(url, init)
    const getXml = url.pathname.match(/\/Invoice\/([^/]+)\/getXml$/)
    if (getXml) {
      const id = decodeURIComponent(getXml[1])
      const xml = opts.xmlFor ? opts.xmlFor(id) : `<invoice id="${id}"/>`
      return new Response(JSON.stringify({ objects: { content: xml, base64: false } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const limit = Number(url.searchParams.get('limit') ?? '100')
    const offset = Number(url.searchParams.get('offset') ?? '0')
    const page = opts.invoices.slice(offset, offset + limit)
    return new Response(JSON.stringify({ objects: page }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}
