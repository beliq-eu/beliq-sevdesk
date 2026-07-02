import { describe, it, expect } from 'vitest'
import { notify, type NotifyReport } from '../src/notify.js'
import { recordingLogger, recordingFetch } from './helpers.js'

const SECRET_URL = 'https://hooks.example.com/services/SECRET-TOKEN-123'

function report(over: Partial<NotifyReport> = {}): NotifyReport {
  return {
    ok: false,
    summary: 'processed 2 invoice(s): 1 valid, 1 invalid, 0 error',
    counts: { valid: 1, invalid: 1, error: 0 },
    invoices: [
      { id: '10', invoiceNumber: 'INV-10', classification: 'valid' },
      { id: '11', invoiceNumber: 'INV-11', classification: 'invalid' },
    ],
    polledAt: '2025-06-15T12:00:00.000Z',
    ...over,
  }
}

describe('notify', () => {
  it('POSTs the report as JSON with an abort signal', async () => {
    const { fetch, requests } = recordingFetch({ status: 200 })
    const { log, eventsNamed } = recordingLogger()

    await notify(SECRET_URL, report(), { fetch, log })

    expect(requests).toHaveLength(1)
    const req = requests[0]
    expect(req.url).toBe(SECRET_URL)
    expect(req.method).toBe('POST')
    expect(req.headers['content-type']).toBe('application/json')
    expect(req.hasSignal).toBe(true)
    expect(JSON.parse(req.body)).toEqual(report())
    expect(eventsNamed('notify')).toHaveLength(1)
    expect(eventsNamed('notify.error')).toHaveLength(0)
  })

  it('logs an error (not the secret URL) on a non-2xx response', async () => {
    const { fetch } = recordingFetch({ status: 500 })
    const { log, eventsNamed } = recordingLogger()

    await notify(SECRET_URL, report(), { fetch, log })

    const errs = eventsNamed('notify.error')
    expect(errs).toHaveLength(1)
    expect(errs[0].fields).toMatchObject({ host: 'hooks.example.com', status: 500 })
    // The secret in the URL path must never reach the logs.
    expect(JSON.stringify(errs[0].fields)).not.toContain('SECRET-TOKEN-123')
  })

  it('swallows a network error and never throws', async () => {
    const { fetch } = recordingFetch({ throwErr: new Error('connect ECONNREFUSED') })
    const { log, eventsNamed } = recordingLogger()

    await expect(notify(SECRET_URL, report(), { fetch, log })).resolves.toBeUndefined()
    const errs = eventsNamed('notify.error')
    expect(errs).toHaveLength(1)
    expect(errs[0].fields).toMatchObject({ host: 'hooks.example.com', message: 'connect ECONNREFUSED' })
    expect(JSON.stringify(errs[0].fields)).not.toContain('SECRET-TOKEN-123')
  })
})
