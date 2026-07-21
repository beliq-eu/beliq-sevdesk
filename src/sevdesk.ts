import { SevDeskApiError } from './errors.js'

/** The invoice fields the worker reads. sevDesk returns many more; they pass through. */
export interface SevDeskInvoice {
  /** sevDesk's numeric id, as a string (its JSON returns ids as strings). */
  id: string
  invoiceNumber?: string
  status?: string
  [key: string]: unknown
}

export interface ListInvoicesParams {
  /** sevDesk status code, e.g. "200" for Open. */
  status?: string
  /** Unix seconds; only invoices dated at or after this are returned. */
  startDate?: number
  pageSize?: number
}

/** The sevDesk surface the worker depends on. The class satisfies it; tests can inject a fake. */
export interface SevDesk {
  listInvoices(params: ListInvoicesParams): Promise<SevDeskInvoice[]>
  getInvoiceXml(id: string): Promise<Uint8Array>
}

export interface SevDeskClientOptions {
  token: string
  baseUrl: string
  /** Inject a fetch implementation (tests). Defaults to global fetch. */
  fetch?: typeof fetch
  /** Inject a sleep (tests keep backoff instant). Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>
  /** Retries on a 429 / 5xx / network error. Default 4. */
  maxRetries?: number
  /** Base backoff delay; the nth retry waits baseRetryDelayMs * 2^n. Default 500. */
  baseRetryDelayMs?: number
  /** Per-attempt request timeout in ms. A stalled request aborts and retries. Default 30000. */
  requestTimeoutMs?: number
}

/** A hard ceiling on pages walked per poll, so a misconfigured window can't loop forever. */
const MAX_PAGES = 100

/** Per-attempt deadline so a stalled sevDesk connection aborts instead of hanging the poll. */
const REQUEST_TIMEOUT_MS = 30_000

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8')

function looksLikeXml(s: string): boolean {
  return s.trimStart().startsWith('<')
}

/**
 * Pull the XML out of a getXml response. sevDesk's exact envelope for this
 * endpoint is not publicly pinned (the live round-trip that confirms it is
 * operator-gated), so this handles the documented-plausible shapes in one place:
 * a raw XML body, `{ objects: "<xml>" }`, or `{ objects: { content, base64 } }`,
 * with the payload optionally base64-encoded. If a live response differs, this
 * is the single function to adjust.
 */
export function extractXml(contentType: string, text: string): Uint8Array {
  if (contentType.includes('xml') || looksLikeXml(text)) return encoder.encode(text)

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new SevDeskApiError('getXml: response was neither XML nor JSON', 200)
  }

  const envelope = (parsed as { objects?: unknown })?.objects ?? parsed
  let payload: unknown
  let base64Flag = false
  if (typeof envelope === 'string') {
    payload = envelope
  } else if (envelope && typeof envelope === 'object') {
    const o = envelope as Record<string, unknown>
    payload = o.content ?? o.xml ?? o.file
    base64Flag = o.base64 === true
  }
  if (typeof payload !== 'string') {
    throw new SevDeskApiError('getXml: could not locate the XML in the response', 200)
  }

  if (base64Flag) return new Uint8Array(Buffer.from(payload, 'base64'))
  if (looksLikeXml(payload)) return encoder.encode(payload)
  // No explicit flag and it does not look like XML: try base64, accept only if it decodes to XML.
  try {
    const decoded = Buffer.from(payload, 'base64')
    if (looksLikeXml(decoder.decode(decoded))) return new Uint8Array(decoded)
  } catch {
    // fall through to treating the payload as literal text
  }
  return encoder.encode(payload)
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500
}

/** Thin sevDesk REST client over an injectable fetch, with pagination and retry/backoff. */
export class SevDeskClient implements SevDesk {
  readonly #token: string
  readonly #baseUrl: string
  readonly #fetch: typeof fetch
  readonly #sleep: (ms: number) => Promise<void>
  readonly #maxRetries: number
  readonly #baseRetryDelayMs: number
  readonly #requestTimeoutMs: number

  constructor(options: SevDeskClientOptions) {
    if (!options.token) throw new Error('sevdesk: token is required')
    const fetchImpl = options.fetch ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') {
      throw new Error('sevdesk: no global fetch available; pass options.fetch')
    }
    this.#token = options.token
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.#fetch = fetchImpl
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.#maxRetries = options.maxRetries ?? 4
    this.#baseRetryDelayMs = options.baseRetryDelayMs ?? 500
    this.#requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
  }

  async listInvoices(params: ListInvoicesParams): Promise<SevDeskInvoice[]> {
    const limit = params.pageSize && params.pageSize > 0 ? params.pageSize : 100
    const all: SevDeskInvoice[] = []
    for (let page = 0; page < MAX_PAGES; page++) {
      const query: Record<string, string | number> = { limit, offset: page * limit }
      if (params.status) query.status = params.status
      if (params.startDate !== undefined) query.startDate = params.startDate
      const { text } = await this.#request('GET', '/Invoice', query)
      const objects = this.#parseObjects(text)
      for (const o of objects) all.push(normalizeInvoice(o))
      if (objects.length < limit) break
    }
    return all
  }

  async getInvoiceXml(id: string): Promise<Uint8Array> {
    const { text, contentType } = await this.#request('GET', `/Invoice/${encodeURIComponent(id)}/getXml`)
    return extractXml(contentType, text)
  }

  #parseObjects(text: string): Record<string, unknown>[] {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new SevDeskApiError('sevDesk list response was not JSON', 200)
    }
    const objects = (parsed as { objects?: unknown })?.objects
    if (!Array.isArray(objects)) {
      throw new SevDeskApiError('sevDesk list response had no "objects" array', 200)
    }
    return objects as Record<string, unknown>[]
  }

  async #request(
    method: string,
    path: string,
    query?: Record<string, string | number>,
  ): Promise<{ status: number; text: string; contentType: string }> {
    const url = new URL(this.#baseUrl + path)
    if (query) {
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v))
    }

    let lastError: Error | undefined
    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.#requestTimeoutMs)
      let res: Response
      let text = ''
      try {
        res = await this.#fetch(url.toString(), {
          method,
          headers: { Authorization: this.#token, Accept: 'application/json' },
          signal: controller.signal,
        })
        // Read the body under the same deadline so a stalled stream also aborts.
        if (res.ok) text = await res.text()
      } catch (err) {
        lastError = controller.signal.aborted
          ? new Error(`timed out after ${this.#requestTimeoutMs}ms`)
          : (err as Error)
        if (attempt < this.#maxRetries) {
          await this.#backoff(attempt)
          continue
        }
        throw new SevDeskApiError(`sevDesk ${method} ${path} network error: ${lastError.message}`, 0)
      } finally {
        clearTimeout(timer)
      }

      if (res.ok) {
        return {
          status: res.status,
          text,
          contentType: res.headers.get('content-type') ?? '',
        }
      }

      if (isRetryable(res.status) && attempt < this.#maxRetries) {
        await this.#backoff(attempt)
        continue
      }
      throw new SevDeskApiError(`sevDesk ${method} ${path} failed with status ${res.status}`, res.status)
    }
    // Unreachable: the loop either returns or throws. Satisfies noImplicitReturns.
    throw new SevDeskApiError(`sevDesk ${method} ${path} exhausted retries`, 0)
  }

  #backoff(attempt: number): Promise<void> {
    return this.#sleep(this.#baseRetryDelayMs * 2 ** attempt)
  }
}

function normalizeInvoice(raw: Record<string, unknown>): SevDeskInvoice {
  return {
    ...raw,
    id: String(raw.id),
    invoiceNumber: raw.invoiceNumber != null ? String(raw.invoiceNumber) : undefined,
    status: raw.status != null ? String(raw.status) : undefined,
  }
}
