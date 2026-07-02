import { BeliqApiError } from '@beliq/sdk'
import { parseArgs } from './args.js'
import { resolveConfig } from './config.js'
import { makeBeliqClient } from './beliq.js'
import { SevDeskClient } from './sevdesk.js'
import { runWorker } from './worker.js'
import { EXIT } from './exit.js'
import { ConfigError, IoError, SevDeskApiError } from './errors.js'
import { HELP, version } from './help.js'
import type { Logger } from './log.js'

/**
 * The entry: parse argv, handle --help / --version, resolve config, build the
 * real sevDesk + beliq clients, run the worker, and map every error class to its
 * exit code (see EXIT). Pure in its logger + env seams so it can be driven from a
 * test without touching real streams. Returns the process exit code.
 */
export async function main(argv: string[], log: Logger, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let config
  try {
    const args = parseArgs(argv)
    if (args.help) {
      log.summary(HELP)
      return EXIT.OK
    }
    if (args.version) {
      log.summary(version())
      return EXIT.OK
    }
    config = resolveConfig(args, env)
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error('usage', { message: err.message })
      return EXIT.USAGE
    }
    throw err
  }

  try {
    const sevdesk = new SevDeskClient({
      token: config.sevdeskToken,
      baseUrl: config.sevdeskBaseUrl,
      maxRetries: config.maxRetries,
    })
    const beliq = makeBeliqClient(config)
    return await runWorker(config, { sevdesk, beliq, log })
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error('usage', { message: err.message })
      return EXIT.USAGE
    }
    if (err instanceof IoError) {
      log.error('io', { message: err.message })
      return EXIT.IO
    }
    if (err instanceof SevDeskApiError) {
      log.error('sevdesk', { status: err.status, message: err.message })
      return EXIT.API
    }
    if (err instanceof BeliqApiError) {
      log.error('beliq', { status: err.status, code: err.code, message: err.message })
      return EXIT.API
    }
    log.error('unexpected', { message: (err as Error).message })
    return 1
  }
}
