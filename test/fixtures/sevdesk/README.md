# sevDesk answers, as recorded

Each file is one answer from a sevDesk trial account, recorded with
`scripts/capture-live.mjs` on 2026-10-01 against `https://my.sevdesk.de/api/v1`.
`status` and `contentType` are what sevDesk sent; `body` is its body. The only
edit is `exceptionUUID`, a per-request trace id, set to zeros.

| File | Request | What it shows |
|---|---|---|
| `getXml-not-an-e-invoice.json` | `GET /Invoice/{id}/getXml` for an Open invoice that was not created as an e-invoice | sevDesk answers 400 with its own message. Its API documentation lists this 400 as "Invoice was not found". |
| `getXml-unknown-id.json` | `GET /Invoice/1/getXml` | An unknown id is a 404, which the documentation does not list. |
| `wrong-token.json` | `GET /Invoice` with a token sevDesk does not know | A 401 in a different envelope from every other error. |
