#!/usr/bin/env node
// Seeds a sevDesk account with test invoices and records what the API answers.
// Dev-only, never published (package.json "files" is dist only). It WRITES to the
// account behind SEVDESK_API_TOKEN: run it against a trial account, never a real one.
//
// Stdout carries structure only (status, content type, key names, value types,
// ids, status codes, dates). Full bodies go to $CAPTURE_DIR/raw, mode 600, because
// they hold the account's own party data.
//
//   SEVDESK_API_TOKEN="$(< token-file)" CAPTURE_DIR=/abs/dir node scripts/capture-live.mjs <step>
//
// Steps, in order: probe, seed, capture, open <label...>, cycle, pay.
// Request shapes follow https://api.sevdesk.de/openapi.yaml.

import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const BASE_URL = (process.env.SEVDESK_BASE_URL ?? 'https://my.sevdesk.de/api/v1').replace(/\/+$/, '')
const TOKEN = process.env.SEVDESK_API_TOKEN
const CAPTURE_DIR = process.env.CAPTURE_DIR
const REQUEST_TIMEOUT_MS = 30_000
const SECONDS_PER_DAY = 86_400
/** Older than the worker's default 30-day poll window, so the list must leave it out. */
const BACKDATED_DAYS = 45
const ERROR_TEXT_MAX = 300
/** Enough of the document to hold the root element's qualified name. */
const XML_NAME_SCAN_CHARS = 200

/** Fields whose values are safe to print: ids, codes, flags and dates, never party data. */
const PRINTABLE = new Set([
  'id',
  'objectName',
  'status',
  'invoiceType',
  'invoiceNumber',
  'invoiceDate',
  'create',
  'update',
  'sendDate',
  'sendType',
  'enshrined',
  'propertyIsEInvoice',
  'smallSettlement',
  'total',
  'countAll',
])

if (!TOKEN || !CAPTURE_DIR) {
  console.error('SEVDESK_API_TOKEN and CAPTURE_DIR are both required')
  process.exit(2)
}

const rawDir = join(CAPTURE_DIR, 'raw')
const seedFile = join(CAPTURE_DIR, 'seed.json')
let sequence = Date.now()

function shape(value, depth = 0) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return value.length === 0 ? '[]' : [`${value.length}x`, shape(value[0], depth + 1)]
  if (typeof value === 'object') {
    if (depth >= 3) return '{...}'
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v, depth + 1)]))
  }
  return typeof value
}

function printable(obj) {
  if (!obj || typeof obj !== 'object') return undefined
  return Object.fromEntries(Object.entries(obj).filter(([k, v]) => PRINTABLE.has(k) && typeof v !== 'object'))
}

/** The first element of an XML document, without printing any content. */
function xmlRoot(text) {
  let at = 0
  for (;;) {
    at = text.indexOf('<', at)
    if (at < 0) return 'not XML'
    const skip = [
      ['<?', '?>'],
      ['<!--', '-->'],
      ['<!', '>'],
    ].find(([open]) => text.startsWith(open, at))
    if (!skip) break
    const end = text.indexOf(skip[1], at + skip[0].length)
    if (end < 0) return 'not XML'
    at = end + skip[1].length
  }
  const name = /^<([A-Za-z_][\w.:-]*)/.exec(text.slice(at, at + XML_NAME_SCAN_CHARS))
  return name ? name[1] : 'not XML'
}

/** What sevDesk says went wrong. An error text names a field or a rule, not a party. */
function errorText(json) {
  const e = json?.error ?? json
  const message = typeof e === 'string' ? e : (e?.message ?? null)
  return { code: e?.code ?? null, message: typeof message === 'string' ? message.slice(0, ERROR_TEXT_MAX) : null }
}

async function call(label, method, path, { query, body, token = TOKEN } = {}) {
  const url = new URL(BASE_URL + path)
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let res
  let text
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: token,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    text = await res.text()
  } finally {
    clearTimeout(timer)
  }

  const contentType = res.headers.get('content-type') ?? ''
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  const file = join(rawDir, `${sequence++}-${label}.json`)
  await writeFile(
    file,
    JSON.stringify(
      {
        label,
        request: { method, path, query: query ?? null, body: body ?? null },
        status: res.status,
        headers: Object.fromEntries([...res.headers].filter(([name]) => name !== 'set-cookie')),
        body: json ?? text,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  )
  console.log(
    JSON.stringify({
      label,
      method,
      path,
      status: res.status,
      contentType,
      bytes: Buffer.byteLength(text),
      sha256: createHash('sha256').update(text).digest('hex').slice(0, 16),
      rateHeaders: [...res.headers.keys()].filter((h) => /rate|retry|limit/i.test(h)),
      shape: json === undefined ? `non-JSON, root ${xmlRoot(text)}` : shape(json),
      ...(res.ok ? {} : { error: errorText(json) }),
    }),
  )
  return { status: res.status, contentType, text, json }
}

function objects(res) {
  const o = res.json?.objects
  return Array.isArray(o) ? o : o ? [o] : []
}

async function must(label, method, path, options) {
  const res = await call(label, method, path, options)
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${label}: ${method} ${path} answered ${res.status}; the body is in ${rawDir}`)
  }
  return res
}

async function loadSeed() {
  try {
    return JSON.parse(await readFile(seedFile, 'utf8'))
  } catch {
    throw new Error(`no ${seedFile}; run the seed step first`)
  }
}

/** Read-only: is the account reachable, and which reference ids does a seed need? */
async function probe() {
  await call('version', 'GET', '/Tools/bookkeepingSystemVersion')
  for (const path of ['/SevUser', '/Unity', '/PaymentMethod', '/CommunicationWayKey', '/StaticCountry']) {
    const res = await call(`ref${path.replace('/', '-')}`, 'GET', path, { query: { limit: 5 } })
    console.log(JSON.stringify({ ref: path, ids: objects(res).map((o) => o.id) }))
  }
  await call('ref-Category-ContactAddress', 'GET', '/Category', { query: { objectType: 'ContactAddress' } })
  const list = await call('list-all', 'GET', '/Invoice', { query: { limit: 100, offset: 0 } })
  console.log(JSON.stringify({ invoices: objects(list).map(printable) }))
}

async function firstId(label, path, query) {
  const res = await must(label, 'GET', path, { query })
  const id = objects(res)[0]?.id
  if (id === undefined) throw new Error(`${path} returned no object, so the seed has no ${label}`)
  return String(id)
}

/** sevDesk takes an invoice's recipient address from the contact's billing address. */
async function billingAddressCategory() {
  const res = await must('addressCategory', 'GET', '/Category', { query: { objectType: 'ContactAddress' } })
  const billing = objects(res).find((c) => c.name === 'Rechnungsanschrift')
  if (!billing) throw new Error('/Category has no Rechnungsanschrift, so the seed has no address category')
  return String(billing.id)
}

/**
 * The tax rule the account may invoice under. sevDesk's API overview lists rule 1
 * (Umsatzsteuerpflichtige Umsaetze, rates 0, 7, 19) for a regular account and
 * rule 11 (Steuer nicht erhoben nach §19 UStG, rate 0) for a small business,
 * whose invoices "must not contain any vat".
 */
async function taxSetup() {
  const res = await must('sevClient', 'GET', '/SevClient')
  const smallSettlement = objects(res)[0]?.smallSettlement === '1'
  return smallSettlement
    ? { smallSettlement, rule: '11', rate: 0, text: 'Steuer nicht erhoben nach §19 UStG' }
    : { smallSettlement, rule: '1', rate: 19, text: 'Umsatzsteuer 19%' }
}

async function createContact(label, withBuyerReference, refs) {
  const contact = await must(`contact-${label}`, 'POST', '/Contact', {
    body: {
      name: `beliq Testkunde ${label} GmbH`,
      status: 1000,
      category: { id: 3, objectName: 'Category' },
      ...(withBuyerReference ? { buyerReference: 'BELIQ-TEST-REF-1' } : {}),
    },
  })
  const id = String((contact.json.objects ?? contact.json).id)
  const ref = { id, objectName: 'Contact' }
  await must(`contact-${label}-address`, 'POST', '/ContactAddress', {
    body: {
      contact: ref,
      street: 'Teststrasse 1',
      zip: '10115',
      city: 'Berlin',
      country: { id: refs.country, objectName: 'StaticCountry' },
      category: { id: refs.addressCategory, objectName: 'Category' },
    },
  })
  await must(`contact-${label}-email`, 'POST', '/CommunicationWay', {
    body: {
      contact: ref,
      type: 'EMAIL',
      value: 'buyer@example.com',
      key: { id: refs.communicationKey, objectName: 'CommunicationWayKey' },
      main: true,
    },
  })
  return id
}

async function createInvoice(label, { contactId, eInvoice, daysBack = 0 }, refs) {
  const invoiceDate = Math.floor(Date.now() / 1000) - daysBack * SECONDS_PER_DAY
  const res = await call(`invoice-${label}-create`, 'POST', '/Invoice/Factory/saveInvoice', {
    body: {
      invoice: {
        objectName: 'Invoice',
        mapAll: true,
        contact: { id: contactId, objectName: 'Contact' },
        contactPerson: { id: refs.user, objectName: 'SevUser' },
        invoiceDate,
        deliveryDate: invoiceDate,
        header: `beliq capture ${label}`,
        status: '100',
        discount: 0,
        timeToPay: 14,
        addressStreet: 'Teststrasse 1',
        addressZip: '10115',
        addressCity: 'Berlin',
        addressCountry: { id: refs.country, objectName: 'StaticCountry' },
        paymentMethod: { id: refs.paymentMethod, objectName: 'PaymentMethod' },
        taxRate: 0,
        taxRule: { id: refs.tax.rule, objectName: 'TaxRule' },
        taxText: refs.tax.text,
        taxType: 'default',
        smallSettlement: refs.tax.smallSettlement,
        invoiceType: 'RE',
        currency: 'EUR',
        propertyIsEInvoice: eInvoice,
      },
      invoicePosSave: [
        {
          objectName: 'InvoicePos',
          mapAll: true,
          quantity: 1,
          price: 100,
          name: 'Testposition',
          unity: { id: refs.unity, objectName: 'Unity' },
          taxRate: refs.tax.rate,
        },
      ],
    },
  })
  const id = (res.json?.objects ?? res.json)?.invoice?.id
  console.log(JSON.stringify({ seeded: label, created: res.status, id: id ?? null }))
  return id === undefined ? null : String(id)
}

async function openInvoice(label, id) {
  const res = await call(`invoice-${label}-open`, 'PUT', `/Invoice/${id}/sendBy`, {
    body: { sendType: 'VPR', sendDraft: false },
  })
  console.log(JSON.stringify({ opened: label, status: res.status, now: printable(res.json?.objects) }))
}

async function seed() {
  const refs = {
    user: await firstId('user', '/SevUser'),
    unity: await firstId('unity', '/Unity'),
    paymentMethod: await firstId('paymentMethod', '/PaymentMethod'),
    communicationKey: await firstId('communicationKey', '/CommunicationWayKey'),
    addressCategory: await billingAddressCategory(),
    country: '1',
    tax: await taxSetup(),
  }
  const withRef = await createContact('mit-Referenz', true, refs)
  const withoutRef = await createContact('ohne-Referenz', false, refs)

  // Creation order is the point: D gets a lower id than E and is opened after it.
  const plan = [
    ['A', { contactId: withRef, eInvoice: true }, true],
    ['B', { contactId: withoutRef, eInvoice: true }, true],
    ['C', { contactId: withRef, eInvoice: false }, true],
    ['D', { contactId: withRef, eInvoice: true }, false],
    ['E', { contactId: withRef, eInvoice: true }, true],
    ['F', { contactId: withRef, eInvoice: true, daysBack: BACKDATED_DAYS }, false],
  ]
  const invoices = {}
  for (const [label, spec, open] of plan) {
    const id = await createInvoice(label, spec, refs)
    invoices[label] = id
    if (id && open) await openInvoice(label, id)
  }
  await writeFile(seedFile, JSON.stringify({ refs, contacts: { withRef, withoutRef }, invoices }, null, 2), {
    mode: 0o600,
  })
  console.log(JSON.stringify({ seedFile, invoices }))
}

async function capture() {
  const { invoices } = await loadSeed()
  const now = Math.floor(Date.now() / 1000)
  const windowStart = now - 30 * SECONDS_PER_DAY

  const lists = [
    ['list-open', { status: 200, limit: 100, offset: 0 }],
    ['list-open-window30', { status: 200, startDate: windowStart, limit: 100, offset: 0 }],
    ['list-draft', { status: 100, limit: 100, offset: 0 }],
    ['list-draft-window30', { status: 100, startDate: windowStart, limit: 100, offset: 0 }],
    ['list-open-page1', { status: 200, limit: 2, offset: 0 }],
    ['list-open-page2', { status: 200, limit: 2, offset: 2 }],
    ['list-open-countAll', { status: 200, limit: 2, offset: 0, countAll: true }],
  ]
  for (const [label, query] of lists) {
    const res = await call(label, 'GET', '/Invoice', { query })
    console.log(JSON.stringify({ [label]: objects(res).map(printable) }))
  }

  for (const [label, id] of Object.entries(invoices)) {
    if (!id) continue
    const one = await call(`invoice-${label}-get`, 'GET', `/Invoice/${id}`)
    console.log(JSON.stringify({ [label]: objects(one).map(printable) }))
    const xml = await call(`invoice-${label}-getXml`, 'GET', `/Invoice/${id}/getXml`)
    const payload = typeof xml.json?.objects === 'string' ? xml.json.objects : xml.text
    console.log(JSON.stringify({ [label]: 'getXml', status: xml.status, objectsType: typeof xml.json?.objects, root: xmlRoot(payload) }))
  }

  await call('getXml-unknown-id', 'GET', '/Invoice/1/getXml')
  await call('list-garbage-token', 'GET', '/Invoice', {
    query: { limit: 1 },
    token: '00000000000000000000000000000000',
  })
}

async function open(labels) {
  const { invoices } = await loadSeed()
  for (const label of labels) {
    if (!invoices[label]) throw new Error(`no seeded invoice ${label}`)
    await openInvoice(label, invoices[label])
    const one = await call(`invoice-${label}-get-after-open`, 'GET', `/Invoice/${invoices[label]}`)
    console.log(JSON.stringify({ [label]: objects(one).map(printable) }))
  }
}

/** Open, back to draft, edited, open again: what does a poller see change? */
async function cycle() {
  const { invoices, refs } = await loadSeed()
  const id = invoices.A
  const read = async (stage) => {
    const one = await call(`cycle-${stage}-get`, 'GET', `/Invoice/${id}`)
    const xml = await call(`cycle-${stage}-getXml`, 'GET', `/Invoice/${id}/getXml`)
    console.log(JSON.stringify({ stage, invoice: objects(one).map(printable), getXml: xml.status }))
  }
  await read('before')
  await call('cycle-resetToDraft', 'PUT', `/Invoice/${id}/resetToDraft`)
  await read('draft')
  await call('cycle-edit', 'POST', '/Invoice/Factory/saveInvoice', {
    body: {
      invoice: { id, objectName: 'Invoice', mapAll: true },
      invoicePosSave: [
        {
          objectName: 'InvoicePos',
          mapAll: true,
          quantity: 1,
          price: 50,
          name: 'Nachtrag',
          unity: { id: refs.unity, objectName: 'Unity' },
          taxRate: refs.tax.rate,
        },
      ],
    },
  })
  await openInvoice('A-reopen', id)
  await read('reopened')
}

/** Does booking a payment move `update`? It decides whether `update` can mark an edit. */
async function pay() {
  const { invoices } = await loadSeed()
  const id = invoices.E
  const before = await call('pay-before-get', 'GET', `/Invoice/${id}`)
  console.log(JSON.stringify({ before: objects(before).map(printable) }))
  const account = await firstId('checkAccount', '/CheckAccount')
  await call('pay-bookAmount', 'PUT', `/Invoice/${id}/bookAmount`, {
    body: {
      amount: 10,
      date: Math.floor(Date.now() / 1000),
      type: 'N',
      checkAccount: { id: account, objectName: 'CheckAccount' },
    },
  })
  const after = await call('pay-after-get', 'GET', `/Invoice/${id}`)
  console.log(JSON.stringify({ after: objects(after).map(printable) }))
  const open = await call('pay-list-open', 'GET', '/Invoice', { query: { status: 200, limit: 100, offset: 0 } })
  console.log(JSON.stringify({ stillListedAsOpen: objects(open).some((o) => String(o.id) === String(id)) }))
}

const steps = { probe, seed, capture, open, cycle, pay }
const [step, ...rest] = process.argv.slice(2)
if (!steps[step]) {
  console.error(`usage: capture-live.mjs <${Object.keys(steps).join('|')}>`)
  process.exit(2)
}

await mkdir(rawDir, { recursive: true, mode: 0o700 })
await chmod(rawDir, 0o700)
try {
  await steps[step](rest)
} catch (err) {
  console.error(err.message)
  process.exit(1)
}
