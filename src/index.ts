#!/usr/bin/env node
import { main } from './cli.js'
import { nodeLogger } from './log.js'

// Without a handler SIGTERM ends the process at once, mid-invoice and before the
// state is saved. As PID 1 in a container it would not end the process at all.
const stopping = new AbortController()
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => stopping.abort())
}

main(process.argv.slice(2), nodeLogger(), process.env, stopping.signal).then(
  (code) => {
    process.exitCode = code
  },
  (err) => {
    process.stderr.write(`beliq-sevdesk: fatal: ${(err as Error).message}\n`)
    process.exitCode = 1
  },
)
