import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { recorded } from './helpers.js'

// The built worker as a real process, in daemon mode, against a local server
// that plays sevDesk. Signal handling lives in the entry file, so only a real
// process can show it. `npm test` builds dist first.

const ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url))
const HOUR_SECONDS = '3600'

let dir: string
let server: Server
let baseUrl: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'beliq-sevdesk-daemon-'))
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub')
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/api/v1/Invoice') return send(200, { objects: [{ id: '1', status: '200' }] })
    // A normal invoice: the worker skips it and needs no beliq call.
    const { status, body } = recorded('getXml-not-an-e-invoice')
    return send(status, body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
})
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve))
  await rm(dir, { recursive: true, force: true })
})

describe('the daemon as a process', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)('on %s it exits 0 with its state saved', async (signal) => {
    expect(existsSync(ENTRY), 'dist/index.js is missing; run npm run build').toBe(true)
    const stateFile = join(dir, 'state.json')
    const child = spawn(process.execPath, [ENTRY], {
      env: {
        PATH: process.env.PATH,
        SEVDESK_API_TOKEN: 'tok',
        BELIQ_API_KEY: 'key',
        SEVDESK_BASE_URL: baseUrl,
        SEVDESK_STATE_FILE: stateFile,
        SEVDESK_POLL_INTERVAL_SECONDS: HOUR_SECONDS,
        SEVDESK_MAX_RETRIES: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    const firstPoll = new Promise<void>((resolve) => {
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
        if (stdout.includes('processed 1 invoice(s)')) resolve()
      })
    })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on('exit', (code, sig) => resolve({ code, signal: sig }))
    })

    // The first poll is done and the daemon is in its hour-long wait.
    await firstPoll
    child.kill(signal)

    expect(await exited).toEqual({ code: 0, signal: null })
    expect(stdout.trim()).toBe('processed 1 invoice(s): 0 valid, 0 invalid, 0 error, 1 skipped')
    expect(JSON.parse(await readFile(stateFile, 'utf8')).processedIds).toEqual(['1'])
  })
})
