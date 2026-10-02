# sevDesk answers, as recorded

Each file is one answer from a sevDesk trial account, recorded with
`scripts/capture-live.mjs` on 2026-10-01 and 2026-10-02 against
`https://my.sevdesk.de/api/v1`. `status` and `contentType` are what sevDesk sent;
`body` is its body.

No file holds account data. What was changed:

- `exceptionUUID`, a per-request trace id, is set to zeros.
- In `getXml-e-invoice.json` the seller's values (name, contact, address, tax
  number, IBAN, BIC) are replaced one by one. Everything else is byte for byte
  what sevDesk sent, the buyer included: the buyer is a test contact. beliq gives
  the changed document the same verdict as the original: valid, one warning,
  `BR-DE-19`.
- In `list-open.json` every key is kept. A value is kept only if it is an id of
  the invoice, a code, a flag or a date; other strings read `redacted`, and
  linked objects keep their `objectName` with id `0`.

| File | Request | What it shows |
|---|---|---|
| `list-open.json` | `GET /Invoice?status=200` | Four Open invoices: three e-invoices and one normal invoice (`135627289`). An invoice has 75 keys and none marks it as an e-invoice. The list is not in id order, and invoice numbers do not follow ids. |
| `getXml-e-invoice.json` | `GET /Invoice/{id}/getXml` for an Open e-invoice | `{ "objects": "<xml>" }`, the shape sevDesk documents. The XML is CII declaring XRechnung 3.0. |
| `getXml-not-an-e-invoice.json` | `GET /Invoice/{id}/getXml` for an Open invoice that was not created as an e-invoice | sevDesk answers 400 with its own message. Its API documentation lists this 400 as "Invoice was not found". |
| `getXml-unknown-id.json` | `GET /Invoice/1/getXml` | An unknown id is a 404, which the documentation does not list. |
| `wrong-token.json` | `GET /Invoice` with a token sevDesk does not know | A 401 in a different envelope from every other error. |
