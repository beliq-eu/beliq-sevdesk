import { Beliq } from '@beliq/sdk'
import type { Config } from './config.js'

/**
 * The subset of the @beliq/sdk client the worker uses. The real `Beliq`
 * satisfies it; tests inject a fake that records its calls and returns recorded
 * results, so the worker exercises real input-mapping and classification rather
 * than a mock returning what it was told.
 */
export type BeliqClient = Pick<Beliq, 'validate' | 'convert'>

export function makeBeliqClient(config: Config): BeliqClient {
  return new Beliq({ apiKey: config.beliqApiKey, baseUrl: config.beliqBaseUrl, auth: config.beliqAuth })
}
