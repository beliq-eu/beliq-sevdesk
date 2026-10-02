/** A user-facing config or usage problem (missing token/key, bad flag, bad value). Maps to EXIT.USAGE. */
export class ConfigError extends Error {}

/** A failure reading the state file, creating the output dir, or writing a document. Maps to EXIT.IO. */
export class IoError extends Error {}

/** A non-2xx sevDesk response (after retries) or a response body we could not parse. Maps to EXIT.API. */
export class SevDeskApiError extends Error {
  readonly status: number
  /** What sevDesk sent with a non-2xx answer, cut to a loggable length. Empty when it sent nothing. */
  readonly body: string
  constructor(message: string, status: number, body = '') {
    super(message)
    this.name = 'SevDeskApiError'
    this.status = status
    this.body = body
  }
}

/** sevDesk has no XML for this invoice: it was not created as an e-invoice. Nothing to validate or convert. */
export class NotAnEInvoiceError extends SevDeskApiError {
  constructor(message: string, status: number, body = '') {
    super(message, status, body)
    this.name = 'NotAnEInvoiceError'
  }
}
