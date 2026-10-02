import { Beliq, BeliqApiError } from '@beliq/sdk'
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

const HTTP_PAYLOAD_TOO_LARGE = 413
const HTTP_UNPROCESSABLE = 422

/**
 * True when beliq refused the document itself, so the same bytes get the same
 * answer on every later poll. On /v1/validate and /v1/convert that is a 422
 * (unprocessable document, or a conversion the engine will not do), a 413 (the
 * document is over the size cap) and PARSE_FAILED, which also arrives as a 400.
 * The status decides, not the code: VALIDATION_ERROR is a 400 for a rejected
 * request and a 422 for a rejected document. Every other 4xx is about the
 * caller (INVALID_API_KEY 403, QUOTA_EXCEEDED and RATE_LIMITED 429) and clears
 * without the document changing. Codes and statuses per route:
 * https://api.beliq.eu/openapi.json
 */
export function isDocumentRefusal(err: unknown): err is BeliqApiError {
  if (!(err instanceof BeliqApiError)) return false
  return err.status === HTTP_UNPROCESSABLE || err.status === HTTP_PAYLOAD_TOO_LARGE || err.code === 'PARSE_FAILED'
}
