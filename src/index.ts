#!/usr/bin/env node
import { main } from './cli.js'
import { nodeLogger } from './log.js'

main(process.argv.slice(2), nodeLogger()).then(
  (code) => {
    process.exitCode = code
  },
  (err) => {
    process.stderr.write(`beliq-sevdesk: fatal: ${(err as Error).message}\n`)
    process.exitCode = 1
  },
)
