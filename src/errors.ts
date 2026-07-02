/** A user-facing config or usage problem (missing token/key, bad flag, bad value). Maps to EXIT.USAGE. */
export class ConfigError extends Error {}

/** A failure reading the state file, creating the output dir, or writing a document. Maps to EXIT.IO. */
export class IoError extends Error {}

/** A non-2xx sevDesk response (after retries) or a response body we could not parse. Maps to EXIT.API. */
export class SevDeskApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'SevDeskApiError'
    this.status = status
  }
}
